export interface LlmConfig {
  base: string
  key: string
  model: string
}

export interface HistoryItem {
  id: string
  title: string
  log: string
  turns: number
}

export interface SiteItem {
  url: string
  targetId: string
  image: string | null
}

declare global {
  interface Window {
    moka: {
      getState: () => Promise<{
        llm: LlmConfig | null
        sites: string[]
        history: { id: string; title: string; log: string; turns: number }[]
        phone: string | null
        deviceNames: Record<string, string>
        statePath: string
        logPath: string
        ready: boolean
      }>
      saveLlm: (llm: LlmConfig) => Promise<{ ok: boolean; ready: boolean }>
      savePhone: (phone: string | null) => Promise<{ ok: boolean }>
      clearHistory: () => Promise<{ ok: boolean }>
      testLlm: (cfg: LlmConfig) => Promise<{ ok: boolean; msg: string }>
      run: (payload: { task: string; sessionId: string }) => Promise<{
        ok: boolean
        answer?: string
        error?: string
        turns?: number
      }>
      ensureSession: (id: string, title: string) => Promise<{ ok: boolean; error?: string }>
      cancel: () => Promise<boolean>
      pause: () => Promise<boolean>
      resume: () => Promise<boolean>
      supplement: (text: string) => Promise<{ ok: boolean; error?: string }>
      onLog: (fn: (line: string) => void) => () => void
      onDone: (fn: () => void) => () => void
      connectPhone: (cfg: { hostPort: string; pairPort: string; pairCode: string }) => Promise<{
        ok: boolean
        log: string[]
        serial?: string
      }>
      renamePhone: (serial: string, name: string) => Promise<{ ok: boolean; deviceNames?: Record<string, string>; error?: string }>
      setPhoneDeviceName: (serial: string, name: string) => Promise<{ ok: boolean; msg: string }>
      phoneFrame: () => Promise<string | null>
      phoneDevices: () => Promise<string>
      openSite: (url: string) => Promise<{ ok: boolean; targetId?: string; image?: string | null; error?: string }>
      siteShot: (targetId: string) => Promise<string | null>
      openStateDir: () => Promise<void>
    }
  }
}
