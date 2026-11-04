import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { HistoryItem, LlmConfig, SiteItem } from './types'

const uid = () => Math.random().toString(36).slice(2, 9)

/** 日志按行的类型上色，扫一眼就知道哪一步在调工具、哪一步出错 */
function lineClass(line: string) {
  const t = line.trim()
  if (!t) return 'l-blank'
  if (t.startsWith('▶')) return 'l-user'
  if (t.startsWith('[')) return 'l-tool'
  if (t.startsWith('完成')) return 'l-done'
  if (t.startsWith('出错') || t.startsWith('失败') || t.includes('失败：')) return 'l-error'
  if (t.startsWith('——') || t.startsWith('（')) return 'l-meta'
  return 'l-text'
}

const welcome = [
  '欢迎使用 Moka 桌面版。',
  '· 右上「配置 LLM」：填中转站地址、Key、模型，可先点「测试连接」确认通不通。',
  '· 「连接网站」：驱动本机 Chrome（自动开 9222 调试端口），可同时连多个网站。',
  '· 「连接手机」：插着数据线可一键直连；无线则填 IP 和端口，首次再填配对端口 + 6 位码。',
  '· 配置、对话、已连网站都存在 ~/.moka/state.json，重启不丢。',
  '',
].join('\n')

/** 一次任务在日志里长这样：`▶ 任务` 开头，`—— 用时 ——` 或 `出错：` 收尾。
 *  这里把它切回「对话」：一条用户消息 + 一张可折叠的执行卡片。 */
type Turn = { task: string; notes: string[]; lines: string[]; state: 'run' | 'ok' | 'fail' }

function parseTurns(raw: string): { intro: string[]; turns: Turn[] } {
  const intro: string[] = []
  const turns: Turn[] = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (t.startsWith('▶ ')) {
      turns.push({ task: t.slice(2).trim(), notes: [], lines: [], state: 'run' })
      continue
    }
    const cur = turns[turns.length - 1]
    const note = t.match(/^（已追加要求：(.*)）$/)
    if (note && cur) {
      cur.notes.push(note[1])
      continue
    }
    if (!cur) {
      intro.push(line)
      continue
    }
    if (t.startsWith('—— 用时')) cur.state = 'ok'
    else if (t.startsWith('出错') || t.startsWith('失败')) cur.state = 'fail'
    cur.lines.push(line)
  }
  return { intro, turns }
}

/** 折叠时只露一行：成功给结论，失败给错误，跑着给当前在干什么 */
function summarize(tn: Turn) {
  if (tn.state === 'fail') {
    const err = tn.lines.find((l) => /^(出错|失败)/.test(l.trim()))
    return err ? err.trim().slice(0, 100) : '执行失败'
  }
  // 还在跑：绝不能回落到「已完成」，否则折叠条会自相矛盾（左「已完成」右「运行中」）
  if (tn.state === 'run') {
    const steps = tn.lines.filter((l) => l.trim().startsWith('[')).length
    return steps ? `执行中（${steps} 步）` : '执行中…'
  }
  const last = [...tn.lines].reverse().find((l) => {
    const t = l.trim()
    return t && !t.startsWith('[') && !t.startsWith('（') && !t.startsWith('——')
  })
  if (last) return last.trim().slice(0, 100)
  const steps = tn.lines.filter((l) => l.trim().startsWith('[')).length
  return steps ? `已完成（${steps} 步）` : '已完成'
}

function TurnList(props: {
  turns: Turn[]
  intro: string[]
  running: boolean
  onRetry: (task: string) => void
  onEdit: (task: string) => void
}) {
  const { turns, intro, running, onRetry, onEdit } = props
  // 默认只展开最后一条（正在跑或刚失败的就在那儿），点标题栏手动折叠/展开
  const [open, setOpen] = useState<Record<number, boolean>>({})
  const boxRef = useRef<HTMLDivElement | null>(null)

  // 新内容进来滚到底，和原来的日志行为一致
  useEffect(() => {
    const el = boxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns])

  if (!turns.length) {
    return (
      <div className="log">
        {intro
          .filter((l, i, a) => !(i === a.length - 1 && l === ''))
          .map((line, i) => (
            <div key={i} className={`log-line ${lineClass(line)}`}>
              {line || '\u00a0'}
            </div>
          ))}
      </div>
    )
  }

  return (
    <div className="turns" ref={boxRef}>
      {turns.map((tn, i) => {
        const isOpen = open[i] ?? i === turns.length - 1
        const dur = tn.lines.map((l) => l.trim()).find((l) => l.startsWith('—— 用时'))
        const steps = tn.lines.filter((l) => l.trim().startsWith('[')).length
        return (
          <div className="turn" key={i}>
            <div className="bubble me">
              <span className="who">你</span>
              <p>{tn.task}</p>
            </div>
            {tn.notes.map((n, k) => (
              <div className="bubble note" key={k}>
                ＋ 追加：{n}
              </div>
            ))}

            <div className={`turn-card ${tn.state}`}>
              <button className="turn-head" onClick={() => setOpen((p) => ({ ...p, [i]: !isOpen }))}>
                <i className="st" />
                <span className="sum">{summarize(tn)}</span>
                <span className="meta">
                  {dur ? dur.replace(/[——\s]/g, '') : tn.state === 'run' ? '运行中' : steps ? `${steps} 步` : ''}
                </span>
                <span className="chev">{isOpen ? '收起' : '详情'}</span>
              </button>

              {isOpen && (
                <div className="turn-detail">
                  {tn.lines.length ? (
                    tn.lines.map((l, k) => (
                      <div key={k} className={`log-line ${lineClass(l)}`}>
                        {l || '\u00a0'}
                      </div>
                    ))
                  ) : (
                    <div className="log-line l-meta">（这一步还没有输出）</div>
                  )}
                </div>
              )}

              {tn.state === 'fail' && (
                <div className="turn-actions">
                  <button className="mini primary" disabled={running} onClick={() => onRetry(tn.task)}>
                    重试这条
                  </button>
                  <button className="mini" onClick={() => onEdit(tn.task)}>
                    改一改
                  </button>
                  {running && <span className="mini-hint">正在跑，先停一下</span>}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default function App() {
  const [llm, setLlm] = useState<LlmConfig | null>(null)
  const [statePath, setStatePath] = useState('')
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [log, setLog] = useState(welcome)
  const [sites, setSites] = useState<SiteItem[]>([])
  const [tab, setTab] = useState<'log' | 'sites'>('log')
  // 运行记录两种看法：对话（默认，可折叠）/ 原文（排查时用）
  const [view, setView] = useState<'chat' | 'raw'>('chat')
  const [input, setInput] = useState('')
  const [status, setStatus] = useState('未连接')
  const [busy, setBusy] = useState(false)
  const [paused, setPaused] = useState(false)
  const [frame, setFrame] = useState<string | null>(null)
  const [phoneOn, setPhoneOn] = useState(false)
  const [deviceNames, setDeviceNames] = useState<Record<string, string>>({})
  const [activeSerial, setActiveSerial] = useState<string>('')

  const [showSettings, setShowSettings] = useState(false)
  const [showSite, setShowSite] = useState(false)
  const [showPhone, setShowPhone] = useState(false)
  const [zoom, setZoom] = useState(false)

  const activeRef = useRef<string | null>(null)
  activeRef.current = activeId
  const logRef = useRef<HTMLDivElement | null>(null)

  // 启动：读缓存
  useEffect(() => {
    window.moka.getState().then((s) => {
      setLlm(s.llm)
      setStatePath(s.statePath)
      setHistory(
        s.history.map((h) => ({
          id: h.id || uid(),
          title: h.title || '（未命名对话）',
          log: h.log || '',
          turns: h.turns || 1,
        }))
      )
      setSites(s.sites.map((url) => ({ url, targetId: '', image: null })))
      setDeviceNames(s.deviceNames ?? {})
      setStatus(s.llm?.base ? '已就绪' : '未配置 LLM')
      // 打开就回到上一次的对话，不然历史里的失败记录根本看不见
      const last = s.history[s.history.length - 1]
      if (last) {
        setActiveId(last.id)
        setLog(last.log || welcome)
      }
    })
  }, [])

  // 运行日志流
  useEffect(() => {
    const off = window.moka.onLog((line) => {
      setLog((prev) => (prev + line + '\n').slice(-20000))
      const id = activeRef.current
      if (id) {
        setHistory((prev) => prev.map((h) => (h.id === id ? { ...h, log: (h.log + line + '\n').slice(-20000) } : h)))
      }
    })
    const offDone = window.moka.onDone(() => setBusy(false))
    return () => {
      off()
      offDone()
    }
  }, [])

  // 日志自动滚到底
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log])

  // Esc 关闭手机大图
  useEffect(() => {
    if (!zoom) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setZoom(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoom])

  // 手机实时画面：连上后每秒抓一帧
  useEffect(() => {
    if (!phoneOn) return
    let alive = true
    const tick = async () => {
      const b64 = await window.moka.phoneFrame()
      if (!alive) return
      if (b64) setFrame(`data:image/png;base64,${b64}`)
    }
    tick()
    const timer = setInterval(tick, 1200)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [phoneOn])

  const submit = useCallback(async (text: string) => {
    const task = text.trim()
    if (!task || busy) return
    if (!llm?.base) {
      setStatus('请先配置 LLM')
      setShowSettings(true)
      return
    }

    // 有当前对话就接着聊；没有才新建。这是「一个对话一直聊下去」的关键。
    const isNew = !activeId
    let sid = activeId
    if (!sid) {
      sid = uid()
      const title = task.slice(0, 26)
      setHistory((prev) => [...prev, { id: sid!, title, log: '', turns: 0 }])
      setActiveId(sid)
      await window.moka.ensureSession(sid, title)
    }

    const header = `${isNew ? '' : '\n'}▶ ${task}\n`
    setLog((prev) => ((isNew ? '' : prev) + header).slice(-30000))
    setHistory((prev) => prev.map((h) => (h.id === sid ? { ...h, log: (h.log + header).slice(-30000) } : h)))
    setInput('')
    setBusy(true)
    setPaused(false)
    setStatus('运行中…')
    setTab('log')
    setView('chat')

    const r = await window.moka.run({ task, sessionId: sid })
    setBusy(false)
    setPaused(false)
    setStatus(r.ok ? '已完成' : '出错（见日志）')
    if (r.turns) setHistory((prev) => prev.map((h) => (h.id === sid ? { ...h, turns: r.turns! } : h)))
  }, [busy, llm, activeId])

  const send = useCallback(() => submit(input), [submit, input])

  /** 失败条目上的「重试这条」：同一对话里把同一条任务再跑一遍 */
  const retry = useCallback((task: string) => submit(task), [submit])

  /** 「改一改」：把原任务捞回输入框，改完再发 */
  const editTask = useCallback((task: string) => {
    setInput(task)
    setStatus('已把任务放回输入框，改完按 Enter')
  }, [])

  const { intro, turns } = useMemo(() => parseTurns(log), [log])

  /** 运行中追加要求：不打断当前任务，下一步会带上 */
  const supplement = useCallback(async () => {
    const text = input.trim()
    if (!text) return
    const r = await window.moka.supplement(text)
    if (r.ok) {
      setInput('')
      setLog((p) => `${p}（已追加要求：${text}）\n`)
    } else {
      setStatus(r.error || '追加失败')
    }
  }, [input])

  /** 暂停 / 继续 */
  const togglePause = useCallback(async () => {
    if (paused) {
      await window.moka.resume()
      setPaused(false)
      setStatus('已继续')
    } else {
      await window.moka.pause()
      setPaused(true)
      setStatus('正在暂停（当前这步跑完就停住）')
    }
  }, [paused])

  /** 开一个新对话（不删旧的，旧的还在左边） */
  const newChat = useCallback(() => {
    setActiveId(null)
    setLog(welcome)
    setInput('')
    setStatus(llm?.base ? '已就绪' : '未配置 LLM')
  }, [llm])

  const openSite = async (url: string) => {
    setStatus(`正在连接 ${url}…`)
    const r = await window.moka.openSite(url)
    if (!r.ok) {
      setStatus(`连接失败：${r.error ?? ''}`)
      setLog((p) => `${p}连接网站失败：${r.error ?? ''}\n`)
      return
    }
    setSites((prev) => {
      const exists = prev.find((s) => s.url === url)
      const item: SiteItem = { url, targetId: r.targetId!, image: r.image ?? null }
      return exists ? prev.map((s) => (s.url === url ? item : s)) : [...prev, item]
    })
    setStatus(`已连接 ${url}`)
    setTab('sites')
  }

  const refreshShot = async (s: SiteItem) => {
    if (!s.targetId) return
    const b64 = await window.moka.siteShot(s.targetId)
    if (b64) setSites((prev) => prev.map((x) => (x.url === s.url ? { ...x, image: b64 } : x)))
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="dot" /> Moka
        </div>

        <div className="sidebar-head">
          <span>对话</span>
          <div className="head-actions">
            <button className="link primary-link" onClick={newChat}>
              ＋ 新对话
            </button>
            <button
              className="link"
              disabled={!history.length}
              onClick={async () => {
                await window.moka.clearHistory()
                setHistory([])
                setActiveId(null)
                setLog('对话记录已清空（缓存同步）\n')
              }}
            >
              清空
            </button>
          </div>
        </div>

        <div className="history">
          {history.length === 0 && <p className="empty">还没有对话，底部发一句就开始</p>}
          {history.map((h) => (
            <button
              key={h.id}
              className={`history-item ${h.id === activeId ? 'active' : ''}`}
              onClick={() => {
                setActiveId(h.id)
                setLog(h.log || '（这个对话还没有日志）')
                setTab('log')
              }}
              title={h.title}
            >
              <span className="h-title">{h.title}</span>
              <span className="h-meta">{h.turns || 1} 轮</span>
            </button>
          ))}
        </div>

        <div className="sidebar-foot">
          <span className="foot-label" title={statePath || '~/.moka/state.json'}>
            本地缓存 · state.json
          </span>
          <button className="link" onClick={() => window.moka.openStateDir()}>
            打开
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="status">
            <span className={`pill ${llm?.base ? 'ok' : 'warn'}`}>{llm?.model || '未配置模型'}</span>
            <span className={`run-state ${busy ? (paused ? 'is-paused' : 'is-busy') : ''}`}>
              <i />
              {status}
            </span>
          </div>
          <div className="actions">
            <button className="ghost" onClick={() => setShowSettings(true)}>
              配置 LLM
            </button>
            <button className="ghost" onClick={() => setShowSite(true)}>
              连接网站
            </button>
            <button className="ghost" onClick={() => setShowPhone(true)}>
              连接手机
            </button>
            {busy && (
              <button className="danger" onClick={() => window.moka.cancel()}>
                停止
              </button>
            )}
          </div>
        </header>

        <section className="stage">
          <div className="phone-pane">
            <div className="pane-head">
              <div className="pane-title">
                手机画面
                {phoneOn && <span className="pill ok small">实时</span>}
              </div>
              <div className="pane-tools">
                <span className="device-name" title={activeSerial || ''}>
                  {activeSerial
                    ? deviceNames[activeSerial]
                      ? `${deviceNames[activeSerial]} · ${activeSerial}`
                      : activeSerial
                    : '未连接'}
                </span>
                {frame && (
                  <button className="link" onClick={() => setZoom(true)}>
                    放大
                  </button>
                )}
              </div>
            </div>

            <div className="phone-screen" onClick={() => (frame ? setZoom(true) : setShowPhone(true))}>
              {frame ? (
                <img src={frame} alt="phone" />
              ) : (
                <div className="placeholder clickable">
                  <div className="ph-icon" />
                  <p className="ph-title">点这里连接手机</p>
                  <p className="muted small">插着数据线可一键直连；无线填 IP 和端口</p>
                  <span className="ph-btn">连接手机</span>
                </div>
              )}
            </div>

            <div className="phone-foot">
              {phoneOn ? '每秒自动刷新 · 点击画面放大查看' : '连上后这里会实时显示手机屏幕'}
            </div>
          </div>

          <div className="log-pane">
            <div className="pane-head">
              <div className="tabs">
                <button className={tab === 'log' ? 'on' : ''} onClick={() => setTab('log')}>
                  运行日志
                </button>
                <button className={tab === 'sites' ? 'on' : ''} onClick={() => setTab('sites')}>
                  已连网站<span className="count">{sites.length}</span>
                </button>
              </div>
              <div className="pane-tools">
                {tab === 'log' ? (
                  <>
                    <button
                      className="link"
                      onClick={() => setView(view === 'chat' ? 'raw' : 'chat')}
                      title="对话视图按任务折叠；原文视图是原始的逐行日志"
                    >
                      {view === 'chat' ? '原文' : '对话'}
                    </button>
                    <button className="link" onClick={() => navigator.clipboard?.writeText(log)}>
                      复制
                    </button>
                    <button className="link" onClick={() => setLog('')}>
                      清屏
                    </button>
                  </>
                ) : (
                  <button className="link" onClick={() => setShowSite(true)}>
                    ＋ 连接
                  </button>
                )}
              </div>
            </div>

            {tab === 'log' ? (
              log.trim() ? (
                view === 'chat' ? (
                  <TurnList turns={turns} intro={intro} running={busy} onRetry={retry} onEdit={editTask} />
                ) : (
                  <div className="log" ref={logRef}>
                    {log
                      .split('\n')
                      .filter((l, i, a) => !(i === a.length - 1 && l === ''))
                      .slice(-800)
                      .map((line, i) => (
                        <div key={i} className={`log-line ${lineClass(line)}`}>
                          {line || '\u00a0'}
                        </div>
                      ))}
                  </div>
                )
              ) : (
                <div className="log-empty">日志已清空，在下面发一条任务试试</div>
              )
            ) : (
              <div className="sites">
                {sites.length === 0 && <p className="empty">还没有连接网站，点右上「连接网站」</p>}
                {sites.map((s) => (
                  <div key={s.url} className="site">
                    <div className="site-head">
                      <span title={s.url}>{s.url}</span>
                      <button className="link" onClick={() => refreshShot(s)}>
                        刷新截图
                      </button>
                    </div>
                    {s.image ? (
                      <img src={`data:image/png;base64,${s.image}`} alt={s.url} />
                    ) : (
                      <div className="site-empty">历史记录：点「刷新截图」重新打开</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <footer className="composer">
          <div className="composer-box">
            <textarea
              value={input}
              rows={3}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  if (busy) supplement()
                  else send()
                }
              }}
              placeholder={
                busy
                  ? '运行中还能补要求：写在这里按 Enter 追加，下一步就带上'
                  : '输入任务，例如：在百度搜索今天北京天气，一句话告诉我'
              }
            />
            <div className="composer-side">
              {busy ? (
                <>
                  <button className="primary" onClick={supplement} disabled={!input.trim()}>
                    追加
                  </button>
                  <button onClick={togglePause}>{paused ? '继续' : '暂停'}</button>
                </>
              ) : (
                <button className="primary send" onClick={send} disabled={!input.trim()}>
                  发送
                </button>
              )}
            </div>
          </div>
          <div className="composer-foot">
            <span className="muted">
              {busy
                ? paused
                  ? '已暂停 · 点「继续」接着跑'
                  : '运行中 · 输入框写补充要求，Enter 追加'
                : 'Enter 发送 · Shift+Enter 换行'}
            </span>
            <span className="muted">
              {phoneOn ? '手机实时' : '手机未连'}
              {sites.length ? ` · 已连 ${sites.length} 个网站` : ''}
            </span>
          </div>
        </footer>
      </main>

      {showSettings && (
        <SettingsDialog
          initial={llm ?? { base: '', key: '', model: 'gpt-4o-mini' }}
          onClose={() => setShowSettings(false)}
          onSaved={(cfg) => {
            setLlm(cfg)
            setStatus('已就绪（配置已保存）')
          }}
        />
      )}

      {showSite && (
        <SiteDialog
          onClose={() => setShowSite(false)}
          onOpen={(url) => {
            setShowSite(false)
            openSite(url)
          }}
        />
      )}

      {showPhone && (
        <PhoneDialog
          initial={''}
          devNames={deviceNames}
          onNamesChanged={(n) => setDeviceNames(n)}
          onSerial={(s) => setActiveSerial(s)}
          onClose={() => setShowPhone(false)}
          onConnected={(ok) => {
            setShowPhone(false)
            setPhoneOn(ok)
            setStatus(ok ? '手机已连接' : '手机未连上（看运行日志）')
          }}
        />
      )}

      {zoom && frame && (
        <div className="zoom-mask" onClick={() => setZoom(false)}>
          <img src={frame} alt="phone-full" onClick={(e) => e.stopPropagation()} />
          <button className="zoom-close" onClick={() => setZoom(false)}>
            关闭（Esc）
          </button>
        </div>
      )}
    </div>
  )
}

/* ---------------- 弹窗 ---------------- */

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  )
}

function SettingsDialog({
  initial,
  onClose,
  onSaved,
}: {
  initial: LlmConfig
  onClose: () => void
  onSaved: (cfg: LlmConfig) => void
}) {
  const [base, setBase] = useState(initial.base)
  const [key, setKey] = useState(initial.key)
  const [model, setModel] = useState(initial.model)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null)

  return (
    <Modal title="配置 LLM（OpenAI 兼容）" onClose={onClose}>
      <label>Base URL（到 /v1）</label>
      <input value={base} onChange={(e) => setBase(e.target.value)} placeholder="https://api.xxx.com/v1" />
      <label>API Key</label>
      <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-..." />
      <label>Model</label>
      <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="gpt-4o-mini / deepseek-chat" />
      {result && <p className={result.ok ? 'good' : 'bad'}>{result.msg}</p>}
      <div className="modal-actions">
        <button
          disabled={testing || !base || !model}
          onClick={async () => {
            setTesting(true)
            setResult(null)
            const r = await window.moka.testLlm({ base, key, model })
            setResult(r)
            setTesting(false)
          }}
        >
          {testing ? '测试中…' : '测试连接'}
        </button>
        <span className="spacer" />
        <button onClick={onClose}>取消</button>
        <button
          className="primary"
          onClick={async () => {
            const cfg = { base: base.trim(), key: key.trim(), model: model.trim() }
            await window.moka.saveLlm(cfg)
            onSaved(cfg)
            onClose()
          }}
        >
          保存
        </button>
      </div>
    </Modal>
  )
}

function SiteDialog({ onClose, onOpen }: { onClose: () => void; onOpen: (url: string) => void }) {
  const [url, setUrl] = useState('https://www.baidu.com')
  return (
    <Modal title="连接网站（驱动本机 Chrome）" onClose={onClose}>
      <label>网址（可同时连多个）</label>
      <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.baidu.com" />
      <p className="muted small">会自动启动带 9222 调试端口的 Chrome，不影响你平时用的浏览器。</p>
      <div className="modal-actions">
        <span className="spacer" />
        <button onClick={onClose}>取消</button>
        <button className="primary" onClick={() => url.trim() && onOpen(url.trim())}>
          打开
        </button>
      </div>
    </Modal>
  )
}

function PhoneDialog({
  initial,
  devNames,
  onNamesChanged,
  onSerial,
  onClose,
  onConnected,
}: {
  initial: string
  devNames: Record<string, string>
  onNamesChanged: (n: Record<string, string>) => void
  onSerial: (s: string) => void
  onClose: () => void
  onConnected: (ok: boolean) => void
}) {
  // IP 与端口分开两栏；粘整串 "IP:端口" 会自动拆开，不必自己切
  const initIp = (initial || '').includes(':') ? (initial || '').split(':')[0] : (initial || '')
  const initPort = (initial || '').includes(':') ? (initial || '').split(':').slice(1).join(':') : ''
  const [ip, setIp] = useState(initIp)
  const [port, setPort] = useState(initPort)
  const [pairPort, setPairPort] = useState('')
  const [pairCode, setPairCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [paused, setPaused] = useState(false)
  const [lines, setLines] = useState<string[]>([])
  const [usb, setUsb] = useState<string[]>([])
  const [alias, setAlias] = useState('')

  // 打开就查一次：有没有插着 USB、已授权可用的设备（有的话根本不用折腾无线）
  useEffect(() => {
    window.moka
      .phoneDevices()
      .then((d) => {
        const ser = String(d || '')
          .split('；')
          .map((s) => s.trim())
          .filter((s) => s.includes('[device]'))
          .map((s) => s.split(' ')[0])
        setUsb(ser)
        if (ser[0]) setAlias(devNames[ser[0]] ?? '')
      })
      .catch(() => setUsb([]))
  }, [])

  /** 两栏拼成 adb 认的 IP:端口；只填 IP 时后端会补默认 5555 */
  const target = () => {
    const a = ip.trim()
    const b = port.trim()
    if (!a) return ''
    return b ? `${a}:${b}` : a
  }

  /** 起个自己看得懂的名字，只存在本地 state.json 里 */
  const saveAlias = async (serial: string) => {
    if (!serial) return
    const r = await window.moka.renamePhone(serial, alias.trim())
    if (r?.ok && r.deviceNames) onNamesChanged(r.deviceNames)
    return r
  }

  const doConnect = async (hostPort: string, pp = '', pc = '') => {
    if (busy) return
    if (!hostPort.trim()) {
      setLines(['先填手机上的 IP 和端口，或者插上数据线点上面的「用 USB 设备连接」'])
      return
    }
    const addr = hostPort.trim()
    // 先把名字存了（USB 序列号才有意义）
    if (usb.includes(addr)) await saveAlias(addr)
    setBusy(true)
    const notes: string[] = []
    // 端口空着但填的是 IP：无线调试端口不是固定值，提醒一下别白等
    if (/^\d+\.\d+\.\d+\.\d+$/.test(addr)) {
      notes.push('没填端口，会按默认 5555 试一次（无线调试几乎都不是这个，多半连不上）；建议照手机上「无线调试」页显示的端口填')
    }
    setLines([...notes, '正在连接…（无线配对最坏要等 20 秒，请不要重复点）'])
    try {
      const r = await window.moka.connectPhone({ hostPort: addr, pairPort: pp, pairCode: pc })
      setLines(r.log ?? [])
      if (r.ok) {
        onSerial(r.serial || addr)
        setTimeout(() => onConnected(true), 500)
      }
    } catch (e: any) {
      setLines([`连接出错：${e?.message || e}`])
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="连接手机（USB 或无线）" onClose={onClose}>
      {busy && <div className="busy-bar">正在连接，请稍等…（无线配对最坏 20 秒）</div>}

      {usb.length > 0 && (
        <div className="usb-tip">
          <div>
            检测到你已插着数据线：
            <code>{usb[0]}</code>
            {devNames[usb[0]] && <span className="pill ok small">{devNames[usb[0]]}</span>}
            <div className="muted small">USB 直接就能用，比无线稳，不用填任何端口</div>
          </div>
          <button className="primary" disabled={busy} onClick={() => doConnect(usb[0])}>
            用 USB 设备连接
          </button>
        </div>
      )}

      <div className="alias-row">
        <div className="alias-field">
          <label>设备名字（本地别名；也可直接改成手机上的名字）</label>
          <input
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            placeholder={usb[0] ? '例如：小米14、备用机' : '先插上数据线或填好 IP'}
            maxLength={24}
          />
        </div>
        <button disabled={busy || !usb[0]} onClick={() => saveAlias(usb[0])}>
          只存本地
        </button>
        <button
          className="primary"
          disabled={busy || !usb[0] || !alias.trim()}
          onClick={async () => {
            await saveAlias(usb[0])
            setBusy(true)
            const r = await window.moka.setPhoneDeviceName(usb[0], alias.trim())
            setBusy(false)
            setLines([r.msg])
          }}
        >
          同时改手机名
        </button>
      </div>
      <div className="hint">
        <p>
          <b>第一步（连接端口）</b>：手机「设置 → 开发者选项 → 无线调试」主页，那里写「IP 地址和端口」，形如{' '}
          <code>192.168.1.20:37125</code>：冒号<b>前</b>面填 IP 栏，冒号<b>后</b>面填端口栏（整串粘到 IP 栏也会自动拆开）。
        </p>
        <p className="warn-text">
          ⚠ 配对弹窗里也有一行「IP 地址和端口」，那个是<b>配对端口</b>，只在配对时用一次，<b>不能拿来连接</b>——填错就会出现
          「目标计算机积极拒绝(10061)」。
        </p>
        <p>
          <b>首次连接</b>：点手机上的「使用配对码配对设备」，把弹窗里的端口和 6 位码填到下面两栏（配对成功后弹窗会自己关掉，
          上面的连接端口不会变）。
        </p>
      </div>

      <div className="row ip-port">
        <div>
          <label>IP 地址</label>
          <input
            value={ip}
            onChange={(e) => {
              const v = e.target.value
              // 粘了整串 "192.168.1.20:37125"：冒号前留给 IP 栏，冒号后自动进端口栏
              const i = v.indexOf(':')
              if (i >= 0) {
                setIp(v.slice(0, i).replace(/\s/g, ''))
                const tail = v.slice(i + 1).replace(/[^0-9]/g, '').slice(0, 5)
                if (tail) setPort(tail)
              } else {
                setIp(v)
              }
            }}
            placeholder="192.168.1.20"
            inputMode="numeric"
          />
        </div>
        <div>
          <label>端口</label>
          <input
            value={port}
            onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, '').slice(0, 5))}
            placeholder="37125"
            inputMode="numeric"
          />
        </div>
      </div>

      <div className="row">
        <div>
          <label>配对端口（仅首次）</label>
          <input value={pairPort} onChange={(e) => setPairPort(e.target.value)} placeholder="36447" />
        </div>
        <div>
          <label>6 位配对码（仅首次）</label>
          <input value={pairCode} onChange={(e) => setPairCode(e.target.value)} placeholder="123456" />
        </div>
      </div>

      {lines.length > 0 && (
        <pre className="mini-log">{lines.join('\n')}</pre>
      )}

      <div className="modal-actions">
        <button onClick={() => window.moka.phoneDevices().then((d) => setLines([`当前设备：${d}`]))}>看当前设备</button>
        <span className="spacer" />
        <button onClick={onClose}>取消</button>
        <button className="primary" disabled={busy} onClick={() => doConnect(target(), pairPort, pairCode)}>
          {busy ? '连接中…' : '连接'}
        </button>
      </div>
    </Modal>
  )
}
