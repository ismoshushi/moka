const { WebChannel } = require('./web')
const { PhoneChannel } = require('./phone')

/**
 * Agent 主循环：一个最小的 ReAct（想 → 调工具 → 看结果 → 再想）。
 * 思路沿用原 Moka 项目，但用 JS 重写，逻辑一眼能看完。
 */

const SYSTEM = `你是一个运行在 Windows 桌面上的个人 AI 助理，有两套「手」：
1) 网页通道（操作本机 Chrome）：web_navigate(url) 打开网址；web_read() 读页面可见文字；web_click(selector) 按 CSS 选择器点击；web_type(selector,text) 在输入框里打字。
2) 手机通道（经 adb 操作已连的安卓手机）：phone_apps 查包名；phone_launch(app, user) 启动 App；phone_tap(x,y) 按像素坐标点击；phone_type(text) 输入文字（中文可能不上屏）；phone_read() 读当前屏幕文字。

关于「双开 / 分身」App：国产手机的双开不是换包名，而是多用户空间——同一个 com.tencent.mm 在主空间是主微信，在 user 999 是分身微信。
用户说「分身微信 / 双开微信 / 另一个微信」时，必须 phone_launch(app='com.tencent.mm', user=999)；说主微信时 user 省略（默认 0）。
不确定有哪些空间时，先 phone_apps(keyword='tencent', user=999) 看分身空间里装了什么。
phone_read 读不到文字（返回「屏幕上看不到文字」）时——分身空间 App 就属于这种——改用 phone_shot 截图直接看屏幕，再按图上的位置点。

规则：
- 每次只调用一个工具，看清结果再决定下一步；坐标按手机真实像素给。
- 网页操作前先确认要操作哪个已连接的网站；点不动时用 web_read 看看页面结构再换选择器。
- 任务完成、或无法继续时，调用 done(answer) 给出最终答复，answer 用中文、简短、直接。`

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_navigate',
      description: '在当前网页标签打开一个网址',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    },
  },
  {
    type: 'function',
    function: { name: 'web_read', description: '读取当前网页的可见文字', parameters: { type: 'object', properties: {} } },
  },
  {
    type: 'function',
    function: {
      name: 'web_click',
      description: '按 CSS 选择器点击网页元素',
      parameters: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_type',
      description: '在网页某个输入框里输入文字',
      parameters: {
        type: 'object',
        properties: { selector: { type: 'string' }, text: { type: 'string' } },
        required: ['selector', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'phone_launch',
      description:
        '用包名启动手机 App，例如 com.android.chrome。启动「分身 / 双开」的那个 App 时必须传 user=999（例如分身微信：app=com.tencent.mm, user=999）',
      parameters: {
        type: 'object',
        properties: {
          app: { type: 'string', description: '包名，例如 com.tencent.mm' },
          user: { type: 'integer', description: '0 或省略 = 主空间；999 = 分身空间（应用双开）' },
        },
        required: ['app'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'phone_apps',
      description: '列出手机已安装 App 的包名，可按关键词过滤。传 user=999 可列出分身空间里的 App',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '包名关键词，例如 tencent、wechat' },
          user: { type: 'integer', description: '0 或省略 = 主空间；999 = 分身空间' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'phone_tap',
      description: '点击手机屏幕坐标（像素）',
      parameters: {
        type: 'object',
        properties: { x: { type: 'integer' }, y: { type: 'integer' } },
        required: ['x', 'y'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'phone_type',
      description: '向手机当前焦点输入框输入文字',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
  },
  {
    type: 'function',
    function: { name: 'phone_read', description: '读取手机当前屏幕上的文字', parameters: { type: 'object', properties: {} } },
  },
  {
    type: 'function',
    function: {
      name: 'phone_shot',
      description: '截取手机当前画面并直接看图片。phone_read 读不到文字时（分身空间 App、纯图片界面）必须用它',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'done',
      description: '任务结束，返回最终答复',
      parameters: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
    },
  },
]

class Agent {
  constructor({ llm, onLog = () => {}, web, phone, shot }) {
    this.llm = llm
    this.onLog = onLog
    // 通道由外部注入：这样「连手机看画面」「连网站」不配 LLM 也能用
    this.web = web || new WebChannel(onLog)
    this.phone = phone || new PhoneChannel()
    // 截图压缩函数由主进程注入（用 Electron nativeImage 缩到 480px JPEG），没注入就用原始 PNG
    this.shot = shot || null
    this.cancelled = false
    this.paused = false
    this.inbox = [] // 运行中追加的要求
  }

  cancel() {
    this.cancelled = true
    this.paused = false // 取消时别卡在暂停里
  }

  /** 暂停：在当前这一步（一次模型调用）结束后停住，再点继续就接着跑 */
  pause() {
    this.paused = true
  }

  resume() {
    this.paused = false
  }

  get isPaused() {
    return this.paused
  }

  /** 运行中追加要求：下一步开始前作为新的用户消息插进上下文 */
  supplement(text) {
    const t = String(text || '').trim()
    if (!t) return false
    this.inbox.push(t)
    return true
  }

  /**
   * 跑一轮。
   * @param {string} task 这一轮用户说的话
   * @param {(line:string)=>void} onLog 日志回调
   * @param {Array} history 同一会话之前的消息（多轮对话的关键，不传就是新会话）
   * @returns {{answer:string, messages:Array}} messages 要留着，下一轮原样传回来才能接上上下文
   */
  async run(task, onLog, history = []) {
    const log = onLog || this.onLog
    this.cancelled = false
    this.paused = false
    this.inbox = []
    const messages = [...history, { role: 'user', content: task }]
    let step = 0
    let limit = 20 // 追加要求会给额外步数，避免刚补完就到上限

    while (step < limit) {
      step++
      if (this.cancelled) {
        log('（已取消）')
        return { answer: '', messages }
      }

      // 暂停点：每步之间检查，不打断进行中的模型请求
      if (this.paused) {
        log('（已暂停，点「继续」恢复）')
        while (this.paused && !this.cancelled) await new Promise((r) => setTimeout(r, 250))
        if (this.cancelled) {
          log('（已取消）')
          return { answer: '', messages }
        }
        log('（继续）')
      }

      // 运行中追加的要求：作为新的用户消息接在上下文后面
      if (this.inbox.length) {
        for (const extra of this.inbox.splice(0)) {
          messages.push({ role: 'user', content: extra })
          log(`（已追加要求：${extra}）`)
        }
        limit += 5
      }
      const reply = await this.llm.chat({ system: SYSTEM, messages, tools: TOOLS })

      if (!reply.calls.length) {
        const answer = reply.text.trim()
        log(`完成：${answer || '（模型没有给出文字）'}`)
        messages.push({ role: 'assistant', content: answer })
        return { answer, messages }
      }

      // 助手这一轮的台词 + 工具调用必须原样回传，否则下一轮上下文对不上
      messages.push({
        role: 'assistant',
        content: reply.text || null,
        tool_calls: reply.calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.args },
        })),
      })

      for (const call of reply.calls) {
        if (this.cancelled) break
        let args = {}
        try {
          args = JSON.parse(call.args || '{}')
        } catch {
          args = {}
        }
        if (call.name === 'done') {
          const answer = String(args.answer || '完成')
          log(`完成：${answer}`)
          messages.push({ role: 'assistant', content: answer })
          return { answer, messages }
        }
        let result
        try {
          result = await this.dispatch(call.name, args)
        } catch (e) {
          result = `执行出错：${e?.message ?? e}`
        }
        // 图片类结果：文字走 tool 消息，图片单独作为一条 user 消息（OpenAI 不允许 tool 消息带图）
        if (result && typeof result === 'object' && result.__image) {
          log(`[${call.name}] ${result.__text}`)
          messages.push({ role: 'tool', tool_call_id: call.id, content: result.__text })
          messages.push({
            role: 'user',
            content: [
              { type: 'text', text: '这是手机当前截图。请据此判断界面内容，需要点击时给出真实像素坐标。' },
              { type: 'image_url', image_url: { url: `data:${result.__mime};base64,${result.__image}` } },
            ],
          })
          continue
        }
        log(`[${call.name}] ${String(result).slice(0, 500)}`)
        messages.push({ role: 'tool', tool_call_id: call.id, content: String(result) })
      }
    }
    log('（达到 20 步上限，先停下）')
    return { answer: '', messages }
  }

  async phoneShot() {
    const s = this.shot
      ? await this.shot()
      : { mime: 'image/png', data: await this.phone.screencap() }
    if (!s || !s.data) {
      const on = await this.phone.online()
      throw new Error(
        on
          ? '截图失败：手机可能息屏或停在锁屏页，请点亮屏幕后重试'
          : '截图失败：手机已断开（adb 里看不到设备），请重新插线或用「连接手机」重连'
      )
    }
    return { __image: s.data, __mime: s.mime || 'image/png', __text: '已截图（手机当前画面）' }
  }

  dispatch(name, args) {
    switch (name) {
      case 'web_navigate':
        return this.web.navigate(args.url)
      case 'web_read':
        return this.web.read()
      case 'web_click':
        return this.web.click(args.selector)
      case 'web_type':
        return this.web.type(args.selector, args.text)
      case 'phone_launch':
        return this.phone.launch(args.app, Number(args.user) || 0)
      case 'phone_apps':
        return this.phone.apps(String(args.keyword || ''), Number(args.user) || 0)
      case 'phone_tap':
        return this.phone.tap(Number(args.x) || 0, Number(args.y) || 0)
      case 'phone_type':
        return this.phone.type(args.text)
      case 'phone_read':
        return this.phone.readScreen()
      case 'phone_shot':
        return this.phoneShot()
      default:
        return `未知工具：${name}`
    }
  }
}

module.exports = { Agent }
