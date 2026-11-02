const { execFile, spawn } = require('node:child_process')

/**
 * 手机通道 = 通过 adb 操作安卓手机（USB 线 或 无线调试）。
 *
 * 这里踩过一个坑，务必保留这段逻辑：
 * 安卓无线调试有「两个不同端口」——
 *   · 连接端口：无线调试主页上写的「IP 地址和端口」，adb connect 用它；
 *   · 配对端口：「使用配对码配对设备」弹窗里显示的端口，只在 adb pair 时用一次，配对完就关闭。
 * 把配对端口拿去 connect，必然得到 "cannot connect ... 由于目标计算机积极拒绝(10061)"。
 */

const ADB = process.env.ADB_PATH || 'adb'

function run(args, { timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    execFile(ADB, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout ?? ''}${stderr ?? ''}`.trim()
      if (err && !out) resolve(`adb 执行失败（是否装了 platform-tools 并在 PATH 里？）：${err.message}`)
      else resolve(out)
    })
  })
}

function runBuffer(args) {
  return new Promise((resolve) => {
    const p = spawn(ADB, args, { windowsHide: true })
    const chunks = []
    p.stdout.on('data', (c) => chunks.push(c))
    p.on('error', () => resolve(null))
    p.on('close', () => resolve(Buffer.concat(chunks)))
  })
}

// 读屏自愈：瞬时空屏（界面没加载完）重试几次；彻底读不到（图片 / 分身空间 App）就附截图让模型看画面
const READ_RETRIES = 3
const READ_RETRY_DELAY_MS = 1200
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function parseTexts(xml) {
  const texts = [...xml.matchAll(/(?:text|content-desc)="([^"]*)"/g)]
    .map((m) => m[1].trim())
    .filter((t) => t.length > 0)
  return [...new Set(texts)]
}

const VALID_STATES = new Set(['device', 'offline', 'unauthorized', 'recovery', 'sideload', 'bootloader', 'connecting'])

class PhoneChannel {
  constructor() {
    this.preferred = null // 最近一次手动连接成功的 serial
  }

  async devices() {
    const out = await run(['devices', '-l'])
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('List of devices') && !l.startsWith('*') && !l.startsWith('adb server'))
      .map((l) => {
        const parts = l.split(/\s+/)
        return { serial: parts[0] || '', state: parts[1] || '', rest: parts.slice(2).join(' ') }
      })
      .filter((d) => VALID_STATES.has(d.state) || d.state.startsWith('no permissions'))
  }

  async currentSerial() {
    const list = await this.devices()
    const ready = list.filter((d) => d.state === 'device').map((d) => d.serial)
    if (this.preferred && ready.includes(this.preferred)) return this.preferred
    return ready[0] || null
  }

  /**
   * 改手机系统里的「设备名称」——就是「无线调试」页面顶部那个 REDMI K90。
   * 改完配对列表、蓝牙名、热点名都会跟着变。不需要 root，adb shell 即可。
   */
  async setDeviceName(name, serial = null) {
    const n = String(name || '').trim()
    if (!n) return { ok: false, msg: '名字不能为空' }
    const s = serial || (await this.currentSerial())
    const pre = s ? ['-s', s] : []
    await run([...pre, 'shell', 'settings', 'put', 'global', 'device_name', n], { timeout: 15000 })
    const back = (await run([...pre, 'shell', 'settings', 'get', 'global', 'device_name'], { timeout: 15000 })).trim()
    const ok = back === n
    return { ok, msg: ok ? `手机设备名已改为「${n}」` : `改完读回是「${back}」，可能没生效（部分机型需重启开发者选项）` }
  }

  async summary() {
    const list = await this.devices()
    if (!list.length) return '未发现设备（手机需与电脑同一 Wi-Fi，且已开无线调试）'
    return list.map((d) => `${d.serial} [${d.state}]`).join('；')
  }

  /** 从 adb mdns 发现里找「连接端口」（_adb-tls-connect._tcp） */
  async mdnsConnectPort(host, skip = []) {
    const out = await run(['mdns', 'services'], { timeout: 5000 })
    const hit = out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.includes('_adb-tls-connect._tcp') && l.includes(host))
      .map((l) => Number(l.slice(l.lastIndexOf(':') + 1)))
      .filter((p) => Number.isInteger(p) && p > 0 && !skip.includes(p))[0]
    return hit || null
  }

  /**
   * 连接手机。
   * @param {string} hostPort 「IP:端口」或纯 IP 或 USB 序列号
   * @param {string} pairPort 配对端口（可选，仅首次配对用）
   * @param {string} pairCode 6 位配对码（可选）
   */
  async connect(hostPort, pairPort = '', pairCode = '') {
    const log = []
    let hp = String(hostPort || '')
      .trim()
      .replace(/^adb connect\s+/i, '')
      .split('://')
      .pop()
      .trim()

    // 情况 1：USB 序列号（不含冒号）
    if (!hp.includes(':')) {
      const list = await this.devices()
      const hit = list.find((d) => d.serial === hp)
      if (hit) {
        this.preferred = hp
        const ok = hit.state === 'device'
        const log = [`已选中 USB 设备 ${hp} [${hit.state}]，无需 adb connect`]
        if (!ok) {
          log.push('设备在线但未授权：请在手机屏幕上点「允许 USB 调试」，再回来点一次连接')
        }
        return { ok, log, serial: hp }
      }
      if ((hp.match(/\./g) || []).length === 3) {
        // 只给了 IP：先问 mdns，问不到再试默认端口
        const found = await this.mdnsConnectPort(hp)
        hp = `${hp}:${found || 5555}`
        log.push(found ? `mdns 发现连接端口 ${found}，用 ${hp}` : `只给了 IP，先试默认端口 ${hp}`)
      } else {
        return {
          ok: false,
          log: [`没找到序列号为 ${hp} 的设备。`, `当前 adb 看到：${await this.summary()}`],
        }
      }
    }

    const host = hp.slice(0, hp.lastIndexOf(':'))
    const typedPort = Number(hp.slice(hp.lastIndexOf(':') + 1)) || null
    const pairPortNum = Number(String(pairPort || '').trim().split(':').pop()) || null

    let paired = false
    if (pairPortNum && pairCode) {
      const pairTarget = `${host}:${pairPortNum}`
      const pairOut = await run(['pair', pairTarget, String(pairCode).trim()], { timeout: 18000 })
      log.push(`配对 ${pairTarget} → ${pairOut}`)
      paired = /Successfully paired/i.test(pairOut)
      if (!paired) log.push('（配对失败：确认配对码没过期；配对弹窗一关就作废，重开会换新端口和新码）')
    }

    let target = hp
    // 关键：把配对端口当成连接地址 → 自动改找真正的连接端口
    if (paired && pairPortNum && typedPort === pairPortNum) {
      const real = await this.mdnsConnectPort(host, [pairPortNum])
      if (real) {
        target = `${host}:${real}`
        log.push(`配对端口 ${pairPortNum} 不能用来连接，已自动改用连接端口 ${real}`)
      } else {
        log.push(
          `⚠ ${hp} 是「配对端口」，配对完就关了，不能拿来连接。\n` +
            '   请回手机「无线调试」主页，用「IP 地址和端口」那一行的端口（和弹窗里的不一样）再连一次。',
        )
      }
    }

    let out = await run(['connect', target], { timeout: 12000 })
    log.push(`连接 ${target} → ${out}`)

    // 端口被系统轮换（关了再开无线调试就变）→ 自动再找一次
    if (/failed|refused|拒绝/i.test(out)) {
      const real = await this.mdnsConnectPort(host, [typedPort, pairPortNum].filter(Boolean))
      if (real) {
        const retry = `${host}:${real}`
        const out2 = await run(['connect', retry], { timeout: 12000 })
        log.push(`用发现的端口重试 ${retry} → ${out2}`)
        if (/connected to/i.test(out2)) {
          target = retry
          out = out2
        }
      }
    }

    if (/connected to/i.test(out) && !/failed/i.test(out)) this.preferred = target

    const list = await this.devices()
    const ready = list.filter((d) => d.state === 'device')
    if (ready.length) {
      if (!this.preferred || !ready.some((d) => d.serial === this.preferred)) this.preferred = ready[0].serial
      log.push(`已就绪设备：${ready.map((d) => d.serial).join('；')}`)
      // 无线没连上、但插着数据线的情况：说清楚，别让用户以为失败了
      if (/failed|refused|拒绝/i.test(out) && !ready.some((d) => d.serial === target)) {
        log.push(`（无线端口没连上，但设备 ${ready[0].serial} 已经在线——多半是插着 USB 线，直接用它就行，不用再折腾无线）`)
      }
      return { ok: true, log, serial: this.preferred }
    }

    log.push('仍未发现就绪设备。可能原因：')
    if (paired) {
      log.push('· 已配对成功但连接被拒：多半填的是配对端口，请用无线调试主页面的 IP:端口')
    } else {
      log.push('· 手机没开「无线调试」或不在同一 Wi-Fi')
      log.push('· 首次连接要配对码（Android 11+）：填配对端口 + 6 位码')
    }
    log.push('· 端口被系统轮换：回手机看「无线调试」页当前端口')
    log.push('· 部分机型锁屏会断连，先解锁手机')
    log.push(`当前列表：${await this.summary()}`)
    return { ok: false, log }
  }

  async disconnect() {
    if (!this.preferred) return '没有手动连接过的无线设备'
    const out = await run(['disconnect', this.preferred])
    this.preferred = null
    return out
  }

  async adb(args, opts) {
    const s = await this.currentSerial()
    return run(s ? ['-s', s, ...args] : args, opts)
  }

  /** 截屏，返回 base64 png（给界面显示 / 给模型看） */
  async screencap() {
    const s = await this.currentSerial()
    if (!s) return null
    let buf = await runBuffer(['-s', s, 'exec-out', 'screencap', '-p'])
    if (!buf || buf.length < 200) {
      // 最常见的失败原因是息屏：先唤醒、过锁屏界面（无密码时有效）再截一次
      await run(['-s', s, 'shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], { timeout: 8000 })
      await run(['-s', s, 'shell', 'wm', 'dismiss-keyguard'], { timeout: 8000 })
      await new Promise((r) => setTimeout(r, 700))
      buf = await runBuffer(['-s', s, 'exec-out', 'screencap', '-p'])
    }
    if (!buf || buf.length < 200) return null
    return buf.toString('base64')
  }

  /** 手机是否还在线（给上层判断「是掉线了还是息屏了」） */
  async online() {
    const s = await this.currentSerial()
    return Boolean(s)
  }

  /**
   * 启动 App。
   * 重要：小米/HyperOS、大部分国产机的「应用双开 / 分身」用的不是另一个包名，
   * 而是 Android 多用户机制（分身空间 user 999）。同一个 com.tencent.mm
   * 在 user 0 是主微信、在 user 999 是分身微信，必须带 --user 才能起对那个。
   */
  async launch(app, user = 0) {
    const u = Number(user) || 0
    const tag = u ? `（分身空间 user ${u}）` : ''
    const pre = u ? ['--user', String(u)] : []

    // 1) 先解析出启动 Activity，比 monkey 可靠（monkey 对分身无效）
    const resolved = await run(['shell', 'cmd', 'package', 'resolve-activity', '--brief', ...pre, app])
    const comp = (resolved.match(/\b([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*\/[A-Za-z0-9_.$]+)/) || [])[1]
    if (comp) {
      const out = await run(['shell', 'am', 'start', ...pre, '-n', comp], { timeout: 20000 })
      if (!/Error type|does not exist|Permission Denial|not exist/i.test(out)) {
        const front = /brought to the front/i.test(out) ? '（已在运行，已切到前台）' : ''
        return `已启动 ${app}${tag} → ${comp}${front}`
      }
    }

    // 2) 兜底 monkey
    const out = await run(['shell', 'monkey', '-p', app, '-c', 'android.intent.category.LAUNCHER', '1', ...(u ? ['--user', String(u)] : [])], { timeout: 20000 })
    if (/No activities found/i.test(out)) {
      return `启动失败：${u ? `分身空间 user ${u} 里` : '当前空间'}没有可启动的 ${app}`
    }
    return `已启动 ${app}${tag}`
  }

  /** 列出已安装 App 的包名，可按关键词过滤；user=999 列出分身空间里的 */
  async apps(keyword = '', user = 0) {
    const u = Number(user) || 0
    const out = await run(['shell', 'pm', 'list', 'packages', ...(u ? ['--user', String(u)] : [])])
    const list = out
      .split('\n')
      .map((l) => l.replace(/^package:/, '').trim())
      .filter(Boolean)
    const k = String(keyword || '').toLowerCase().trim()
    const hit = k ? list.filter((p) => p.toLowerCase().includes(k)) : list
    if (!hit.length) return `没有匹配「${keyword}」的包（${u ? `user ${u}` : '主空间'}）`
    return hit.slice(0, 120).join('\n')
  }

  async tap(x, y) {
    await this.adb(['shell', 'input', 'tap', String(x), String(y)])
    return `已点击 (${x},${y})`
  }

  async type(text) {
    // adb input text 不支持中文；纯 ASCII 直接输入，含中文时给出提示
    const out = await this.adb(['shell', 'input', 'text', String(text).replace(/ /g, '%s')])
    if (out) return `输入返回：${out}（若中文没上屏，需改用剪贴板方案）`
    return `已输入：${text}`
  }

  /**
   * 读当前屏幕文字。
   * 踩坑：`uiautomator dump /dev/tty` 在 HyperOS / 部分机型上只会回一行
   * "UI hierchary dumped to: /dev/tty"，拿不到 XML。必须 dump 到文件再 cat。
   * 自愈：抽不到文字时先重试几次（界面可能还在加载）；多次仍为空（图片界面 / 分身空间 App
   * 这类 uiautomator 永远读不到文字的场景）就附一张截图，让带视觉的模型直接看画面继续，
   * 而不是丢一句「看不到文字」让模型自己收尾。
   */
  async readScreen() {
    let lastDump = ''
    for (let attempt = 1; attempt <= READ_RETRIES; attempt++) {
      const tmp = '/sdcard/moka_ui.xml'
      const dump = await this.adb(['shell', 'uiautomator', 'dump', tmp], { timeout: 40000 })
      let xml = await this.adb(['shell', 'cat', tmp], { timeout: 20000 })
      if (!/<hierarchy/i.test(xml)) {
        // 兜底：exec-out 直出
        xml = await run(['exec-out', 'uiautomator', 'dump', '/dev/tty'], { timeout: 40000 })
      }
      if (!/<hierarchy/i.test(xml)) {
        // uiautomator 真报错（不是空屏），重试无意义
        lastDump = /dumped to/i.test(dump) ? dump.trim() : 'uiautomator 没有返回 XML'
        if (attempt < READ_RETRIES) { await sleep(READ_RETRY_DELAY_MS); continue }
        return `读屏失败：${lastDump}（可改用 phone_shot 截图让人看）`
      }
      const uniq = parseTexts(xml)
      if (uniq.length) return uniq.slice(0, 200).join(' | ')
      // 抽不到文字：先当界面没加载完，等一下再读；都失败就走截图兜底
      lastDump = 'empty'
      if (attempt < READ_RETRIES) { await sleep(READ_RETRY_DELAY_MS); continue }
    }
    // 多次仍读不到：多半是图片界面 / 分身空间 App，直接上截图让模型看见画面
    const img = await this.screencap()
    if (img) {
      return {
        __image: img,
        __mime: 'image/png',
        __text:
          '屏幕上看不到文字（界面可能是图片，或分身空间 App），已附当前截图，请直接看图判断界面内容与可点击位置，需要操作时给出真实像素坐标。',
      }
    }
    return '屏幕上看不到文字（可能是图片界面，且截图也失败）'
  }
}

module.exports = { PhoneChannel }
