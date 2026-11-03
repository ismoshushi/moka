const { app, BrowserWindow, ipcMain, shell, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { Agent } = require('./lib/agent')
const { Llm, describeError } = require('./lib/llm')
const { PhoneChannel } = require('./lib/phone')
const { WebChannel } = require('./lib/web')
const { STATE_DIR, STATE_FILE, loadState, saveState } = require('./lib/store')

// 状态常驻内存，退出/变更时落盘（等价于 Kotlin 版的 state.json 缓存）
let state = loadState()
let agent = null
let running = false
let win = null

const LOG_FILE = path.join(STATE_DIR, 'desktop.log')

// 两个通道独立于 LLM 存在：没配模型也能先连手机看画面、连网站截图
const phone = new PhoneChannel()
const web = new WebChannel((line) => send('agent:log', line))

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

/** 出任何异常都写文件，不要静默退出（旧版「闪一下就没了」就是缺这一步） */
function logToFile(line) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`)
  } catch {}
}

process.on('uncaughtException', (e) => logToFile(`uncaught: ${(e && e.stack) || e}`))
process.on('unhandledRejection', (e) => logToFile(`unhandled: ${(e && e.stack) || e}`))

function persist() {
  const r = saveState(state)
  if (!r.ok) logToFile(`saveState failed: ${r.error}`)
  return r
}

/**
 * 给模型看的手机截图：缩到宽 480 的 JPEG。
 * 原始 PNG 约 600KB，base64 后 800KB，直接丢给模型既慢又贵；缩完约 40-60KB。
 * 顺带把两套尺寸带回去：w/h 是屏幕实际像素（phone_tap 要按这个算），
 * sentW/sentH 是模型真正看到的图有多大——不给这两个数，模型会拿图上坐标直接去点。
 */
async function shrinkShot() {
  const b64 = await phone.screencap()
  if (!b64) return null
  try {
    const img = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'))
    const size = img.getSize()
    if (!size.width) return { mime: 'image/png', data: b64 }
    const out = size.width > 480 ? img.resize({ width: 480 }) : img
    const sent = out.getSize()
    return {
      mime: 'image/jpeg',
      data: out.toJPEG(72).toString('base64'),
      w: size.width,
      h: size.height,
      sentW: sent.width,
      sentH: sent.height,
    }
  } catch {
    return { mime: 'image/png', data: b64 }
  }
}

/**
 * 会话上下文：sessionId → 上一轮的完整消息链。
 * 只放内存（含工具调用链，结构必须完整），落盘时用 compactContext 瘦身。
 */
const contexts = new Map()

/** 去掉图片 base64、截断工具结果，避免上下文无限膨胀 */
function compactContext(messages) {
  return messages.map((m) => {
    if (m.role === 'user' && Array.isArray(m.content)) {
      const text = m.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join(' ')
        .trim()
      return { role: 'user', content: text || '（手机截图）' }
    }
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.tool_call_id, content: String(m.content ?? '').slice(0, 600) }
    }
    return m
  })
}

function buildAgent() {
  const c = state.llm
  if (!c || !c.base || !c.model) return null
  const llm = new Llm({
    base: c.base,
    key: c.key,
    model: c.model,
    onRetry: (i, reason) => send('agent:log', `网络抖动，第 ${i} 次重试（${reason}）`),
  })
  return new Agent({ llm, onLog: (line) => send('agent:log', line), web, phone, shot: shrinkShot })
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0e1116',
    title: 'Moka',
    // 窗口图标：打包后任务栏 / Alt-Tab 显示的就是它
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.once('ready-to-show', () => win.show())

  win.webContents.on('render-process-gone', (_e, d) => logToFile(`renderer gone: ${JSON.stringify(d)}`))
  win.webContents.on('did-fail-load', (_e, code, desc, url) => logToFile(`did-fail-load ${code} ${desc} ${url}`))

  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) win.loadURL(devUrl)
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))

  // 外链走系统浏览器，别在应用窗口里跳走
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

app.whenReady().then(() => {
  agent = buildAgent()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  persist()
  app.quit()
})

app.on('before-quit', () => persist())

// ---------- IPC ----------

ipcMain.handle('state:get', () => ({
  llm: state.llm,
  sites: state.sites,
  history: state.history,
  phone: state.phone,
  deviceNames: state.deviceNames ?? {},
  statePath: STATE_FILE,
  logPath: LOG_FILE,
  ready: Boolean(state.llm && state.llm.base && state.llm.model),
}))

ipcMain.handle('state:saveLlm', (_e, cfg) => {
  state.llm = {
    base: String((cfg && cfg.base) || '').trim(),
    key: String((cfg && cfg.key) || '').trim(),
    model: String((cfg && cfg.model) || '').trim(),
  }
  agent = buildAgent()
  const r = persist()
  return { ...r, ready: Boolean(agent) }
})

ipcMain.handle('state:savePhone', (_e, p) => {
  state.phone = p || null
  return persist()
})

/** 前端点「新对话」时先建记录，避免第一轮跑起来时列表里还没有它 */
ipcMain.handle('session:ensure', (_e, { id, title }) => {
  if (!Array.isArray(state.history)) state.history = []
  const sid = String(id || '').trim()
  if (!sid) return { ok: false, error: '缺少会话 id' }
  logToFile(`ensure id=${sid} title=${String(title || '').slice(0, 20)} exists=${state.history.some((h) => h.id === sid)}`)
  if (!state.history.some((h) => h.id === sid)) {
    state.history.push({ id: sid, title: String(title || '新对话').slice(0, 26), log: '', turns: 0, at: Date.now() })
    persist()
  }
  return { ok: true }
})

ipcMain.handle('state:clearHistory', () => {
  state.history = []
  contexts.clear() // 会话删了，上下文也跟着清，否则新会话会「记得」旧内容
  return persist()
})

ipcMain.handle('chat:test', async (_e, cfg) => {
  const t0 = Date.now()
  try {
    const llm = new Llm({ base: cfg.base, key: cfg.key, model: cfg.model })
    const r = await llm.chat({
      system: '你是连通性测试助手，回答要极短。',
      messages: [{ role: 'user', content: 'ping' }],
      tools: [],
      attempts: 1,
    })
    return { ok: true, msg: `连通正常（${Date.now() - t0}ms）：${String(r.text).slice(0, 60)}` }
  } catch (e) {
    return { ok: false, msg: `失败（${Date.now() - t0}ms）：${e && e.message}｜${describeError(e)}` }
  }
})

ipcMain.handle('agent:run', async (_e, payload) => {
  const task = String((payload && payload.task) || '').trim()
  const sessionId = String((payload && payload.sessionId) || 'default')
  if (!task) return { ok: false, error: '任务为空' }
  if (running) return { ok: false, error: '正在执行上一个任务' }
  if (!agent) agent = buildAgent()
  if (!agent) return { ok: false, error: '请先配置 LLM' }

  running = true
  logToFile(`run  session=${sessionId} task=${task.slice(0, 30)} ctx=${(contexts.get(sessionId) || []).length}`)

  // 会话记录只由主进程维护：前端负责「新建」，这里负责「追加日志 + 轮数」
  if (!Array.isArray(state.history)) state.history = []
  let entry = state.history.find((h) => h.id === sessionId)
  if (!entry) {
    entry = { id: sessionId, title: task.slice(0, 26), log: '', turns: 0 }
    state.history.push(entry)
  }
  entry.turns = (entry.turns || 0) + 1

  let lastSave = 0
  const append = (line) => {
    entry.log = ((entry.log || '') + line + '\n').slice(-30000)
    send('agent:log', line)
    const now = Date.now()
    if (now - lastSave > 1500) {
      lastSave = now
      persist()
    }
  }

  // 关键：同一会话把上一轮的完整消息链带回来，模型才有上下文
  const history = contexts.get(sessionId) || []
  if (history.length) append(`（接着上文，已带 ${history.length} 条历史消息）`)

  const t0 = Date.now()
  try {
    const r = await agent.run(task, append, history)
    contexts.set(sessionId, compactContext(r.messages))
    append(`—— 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s ——`)
    return { ok: true, answer: r.answer, turns: entry.turns }
  } catch (e) {
    const msg = `出错：${(e && e.message) || e}｜${describeError(e)}`
    append(msg)
    return { ok: false, error: msg }
  } finally {
    running = false
    persist()
    send('agent:done')
  }
})

ipcMain.handle('agent:cancel', () => {
  if (agent) agent.cancel()
  return true
})

ipcMain.handle('agent:pause', () => {
  if (agent) agent.pause()
  return true
})

ipcMain.handle('agent:resume', () => {
  if (agent) agent.resume()
  return true
})

/** 运行中追加要求：下一步会把它当作新的用户消息接进上下文 */
ipcMain.handle('agent:supplement', (_e, text) => {
  if (!agent) return { ok: false, error: '还没有正在运行的任务' }
  const ok = agent.supplement(text)
  if (ok) logToFile(`supplement: ${String(text).slice(0, 60)}`)
  return { ok }
})

ipcMain.handle('phone:connect', async (_e, cfg) => {
  const r = await phone.connect(cfg.hostPort, cfg.pairPort, cfg.pairCode)
  if (r.ok) {
    state.phone = cfg.hostPort
    persist()
  }
  return r
})

ipcMain.handle('phone:frame', async () => {
  try {
    return await phone.screencap()
  } catch {
    return null
  }
})

ipcMain.handle('phone:devices', () => phone.summary())

/** 把名字同步改成手机系统里的「设备名称」（无线调试页、配对列表显示的那个） */
ipcMain.handle('phone:setDeviceName', async (_e, { serial, name }) => {
  return phone.setDeviceName(name, serial || null)
})

/** 给设备起别名（只存本地，不动机器上的任何设置） */
ipcMain.handle('phone:rename', (_e, { serial, name }) => {
  const key = String(serial || '').trim()
  if (!key) return { ok: false, error: '缺少设备序列号' }
  if (!state.deviceNames) state.deviceNames = {}
  const n = String(name || '').trim().slice(0, 24)
  if (n) state.deviceNames[key] = n
  else delete state.deviceNames[key]
  const r = persist()
  return { ...r, deviceNames: state.deviceNames }
})

ipcMain.handle('web:open', async (_e, url) => {
  try {
    const r = await web.openSite(url)
    state.sites = [...new Set([...state.sites, url])].slice(-20)
    persist()
    return { ok: true, targetId: r.targetId, image: r.image }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
})

ipcMain.handle('web:shot', async (_e, targetId) => {
  try {
    const t = await web.tab(targetId)
    return await t.screenshot()
  } catch {
    return null
  }
})

ipcMain.handle('app:openStateDir', () => shell.openPath(STATE_DIR))
