const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** 与 Kotlin 版共用同一个缓存文件，配置一次两边都能用。 */
const STATE_DIR = path.join(os.homedir(), '.moka')
const STATE_FILE = path.join(STATE_DIR, 'state.json')
/** 改名前（Mika 时期）的目录，只用来做一次性搬迁 */
const LEGACY_DIR = path.join(os.homedir(), '.mika')

/**
 * 第一次以新名字启动时，把旧目录里的 state.json 搬过来。
 * 只搬一次、旧目录原样留着（里面可能有旧版本还在用），失败了也不影响启动。
 */
function migrateLegacy() {
  try {
    if (fs.existsSync(STATE_FILE)) return
    const old = path.join(LEGACY_DIR, 'state.json')
    if (!fs.existsSync(old)) return
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.copyFileSync(old, STATE_FILE)
  } catch {}
}

migrateLegacy()

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    return {
      llm: s.llm ?? null,
      sites: Array.isArray(s.sites) ? s.sites : [],
      history: Array.isArray(s.history)
        ? s.history.map((h) => ({
            id: String(h.id ?? ''),
            title: String(h.title ?? h.task ?? ''),
            log: String(h.log ?? ''),
            turns: Number(h.turns ?? 1) || 1,
            at: Number(h.at ?? 0) || 0,
          }))
        : [],
      phone: s.phone ?? null,
      deviceNames: s.deviceNames && typeof s.deviceNames === 'object' ? s.deviceNames : {},
    }
  } catch {
    return { llm: null, sites: [], history: [], phone: null, deviceNames: {} }
  }
}

function saveState(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    const trimmed = {
      llm: state.llm ?? null,
      sites: (state.sites ?? []).slice(0, 50),
      // 会话最多 100 个，单条日志最多 3 万字，避免文件无限长
      history: (state.history ?? []).slice(-100).map((h) => ({
        id: String(h.id ?? ''),
        title: String(h.title ?? h.task ?? ''), // 兼容旧版只有 task 的记录
        log: String(h.log ?? '').slice(-30000),
        turns: Number(h.turns ?? 1) || 1,
        at: Number(h.at ?? 0) || 0,
      })),
      phone: state.phone ?? null,
      // 给设备起的别名：{ "0123456789abcdef": "主力机" }，纯本地，方便自己认
      deviceNames: state.deviceNames ?? {},
    }
    const tmp = STATE_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(trimmed, null, 2), 'utf8')
    fs.renameSync(tmp, STATE_FILE) // 原子替换：写一半崩了也不会毁掉旧文件
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

module.exports = { STATE_DIR, STATE_FILE, loadState, saveState }
