const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const WebSocket = require('ws')

/**
 * 网页通道 = 通过 Chrome DevTools Protocol 操作本机 Chrome。
 *
 * 需要 Chrome 带 --remote-debugging-port=9222 启动（脚本会自动帮你起一个，不影响日常用的 Chrome）。
 * 新开标签用 Target.createTarget + attachToTarget(flatten)，这样多个网站各有一条独立会话。
 */

const PORT = 9222

async function jget(p, timeoutMs = 3000) {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { signal: AbortSignal.timeout(timeoutMs) })
  return res.json()
}

async function chromeAlive() {
  try {
    const v = await jget('/json/version')
    return Boolean(v && v.webSocketDebuggerUrl)
  } catch {
    return false
  }
}

/**
 * 各平台 Chrome 的默认安装位置。
 * mac 上是 .app 包里的可执行文件本身，不是 .app 目录——传 .app 给 spawn 会起不来。
 */
function chromeCandidates() {
  if (process.platform === 'darwin') {
    const home = os.homedir()
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]
  }
  if (process.platform === 'linux') {
    return [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
    ]
  }
  return [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path2(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ]
}

async function ensureChrome(log = () => {}) {
  if (await chromeAlive()) return true
  const candidates = chromeCandidates()
  const exe = candidates.find((p) => p && fs.existsSync(p))
  if (!exe) {
    log('没找到 Chrome/Edge。请自行用 --remote-debugging-port=9222 启动浏览器后再试。')
    return false
  }
  log(`正在启动浏览器：${exe}`)
  // 独立配置目录，不碰你日常浏览器的登录态；Windows 的 TEMP 在 mac 上不存在，统一用 os.tmpdir()
  const profile = path.join(os.tmpdir(), 'moka-chrome')
  spawn(exe, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run'], {
    detached: true,
    stdio: 'ignore',
  }).unref()
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 300))
    if (await chromeAlive()) {
      log('浏览器调试端口已就绪（9222）')
      return true
    }
  }
  log('浏览器启动后仍连不上 9222 端口。')
  return false
}

function path2(a, b) {
  if (!a) return null
  return `${a.replace(/\\/g, '/')}/${b}`
}

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.ws = null
    this.id = 0
    this.pending = new Map()
    this.listeners = new Set()
  }

  open() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl, { perMessageDeflate: false, handshakeTimeout: 8000 })
      this.ws = ws
      ws.once('open', resolve)
      ws.once('error', reject)
      ws.on('message', (raw) => {
        let msg
        try {
          msg = JSON.parse(raw.toString())
        } catch {
          return
        }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: ok, reject: bad } = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          msg.error ? bad(new Error(String(msg.error.message))) : ok(msg.result)
        } else {
          for (const fn of this.listeners) fn(msg)
        }
      })
      ws.on('close', () => this.pending.clear())
    })
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.ws.send(JSON.stringify(payload))
      } catch (e) {
        this.pending.delete(id)
        reject(e)
      }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`${method} 超时`))
        }
      }, 30000)
    })
  }

  on(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  close() {
    try {
      this.ws && this.ws.close()
    } catch {}
  }
}

/** 一个已打开的标签页会话 */
class Tab {
  constructor(cdp, sessionId, targetId, url) {
    this.cdp = cdp
    this.sessionId = sessionId
    this.targetId = targetId
    this.url = url
  }

  async eval(expression) {
    const r = await this.cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      this.sessionId,
    )
    if (r && r.exceptionDetails) throw new Error(r.exceptionDetails.text || '页面脚本执行出错')
    return r && r.result ? r.result.value : undefined
  }

  async navigate(url) {
    await this.cdp.send('Page.enable', {}, this.sessionId)
    const loaded = new Promise((resolve) => {
      const off = this.cdp.on((msg) => {
        if (msg.method === 'Page.loadEventFired' && msg.sessionId === this.sessionId) {
          off()
          resolve(true)
        }
      })
      setTimeout(() => {
        off()
        resolve(false)
      }, 15000)
    })
    await this.cdp.send('Page.navigate', { url }, this.sessionId)
    await loaded
    await new Promise((r) => setTimeout(r, 800)) // 等首屏脚本跑完，截图才有内容
    this.url = url
  }

  async text() {
    const t = await this.eval('document.body ? document.body.innerText : ""')
    return String(t ?? '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .join('\n')
      .slice(0, 6000)
  }

  async click(selector) {
    const ok = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.scrollIntoView({block:'center'}); el.click(); return true;
    })()`)
    if (!ok) throw new Error(`找不到元素：${selector}`)
    return true
  }

  async type(selector, text) {
    const ok = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, ${JSON.stringify(text)}); else el.value = ${JSON.stringify(text)};
      el.dispatchEvent(new Event('input', {bubbles:true}));
      el.dispatchEvent(new Event('change', {bubbles:true}));
      return true;
    })()`)
    if (!ok) throw new Error(`找不到输入框：${selector}`)
    return true
  }

  async screenshot() {
    const r = await this.cdp.send('Page.captureScreenshot', { format: 'png' }, this.sessionId)
    return (r && r.data) || null
  }
}

class WebChannel {
  constructor(log = () => {}) {
    this.log = log
    this.cdp = null
    this.tabs = new Map() // targetId -> Tab
  }

  async ensure() {
    if (this.cdp && this.cdp.ws && this.cdp.ws.readyState === WebSocket.OPEN) return this.cdp
    if (!(await ensureChrome(this.log))) throw new Error('浏览器调试端口不可用（9222）')
    const v = await jget('/json/version')
    const cdp = new Cdp(v.webSocketDebuggerUrl)
    await cdp.open()
    this.cdp = cdp
    return cdp
  }

  /** 打开一个网站，返回截图(base64 png) */
  async openSite(url) {
    const cdp = await this.ensure()
    const { targetId } = await cdp.send('Target.createTarget', { url })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    const tab = new Tab(cdp, sessionId, targetId, url)
    await cdp.send('Page.enable', {}, sessionId)
    await new Promise((r) => setTimeout(r, 1500))
    this.tabs.set(targetId, tab)
    const image = await tab.screenshot().catch(() => null)
    return { targetId, url, image }
  }

  async tab(targetId) {
    await this.ensure()
    const t = this.tabs.get(targetId)
    if (!t) throw new Error('这个标签页已失效，请重新连接网站')
    return t
  }

  /** 给 Agent 用：优先最近打开的那个标签；一个都没有就自己开一个空白标签 */
  async firstTab() {
    await this.ensure()
    let tab = [...this.tabs.values()].pop()
    if (!tab) {
      const r = await this.openSite('about:blank')
      tab = this.tabs.get(r.targetId)
      this.log('Agent 自动开了一个空白标签（你也可以先点「连接网站」指定起点）')
    }
    if (!tab) throw new Error('打不开浏览器标签，请检查 Chrome 是否正常')
    return tab
  }

  async navigate(url) {
    const tab = await this.firstTab()
    await tab.navigate(url)
    this.log(`已打开 ${url}`)
    return `已打开 ${url}`
  }

  async read() {
    const tab = await this.firstTab()
    const t = await tab.text()
    return t || '（页面没有可见文字）'
  }

  async click(selector) {
    const tab = await this.firstTab()
    await tab.click(selector)
    return `已点击 ${selector}`
  }

  async type(selector, text) {
    const tab = await this.firstTab()
    await tab.type(selector, text)
    return `已在 ${selector} 输入：${text}`
  }
}

module.exports = { WebChannel, ensureChrome, chromeAlive }
