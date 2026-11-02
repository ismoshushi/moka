/**
 * OpenAI 兼容模型客户端（中转站 / DeepSeek / Kimi / GLM / OpenRouter / 本地 ollama 都行）。
 *
 * 两个关键点：
 * 1) 超时必须放宽。推理模型带 9 个工具 schema 时首个 token 常常 >10s，默认 10s 必然超时。
 * 2) 网络类错误自动重试（请求还没被处理，重试是安全的）；鉴权/额度/限流直接报给界面。
 */

const READ_TIMEOUT_MS = 300_000

class LlmError extends Error {
  constructor(message, kind = 'bad') {
    super(message)
    this.kind = kind // net | auth | quota | rate | model | server | bad
  }
}

function describeError(e) {
  const root = e?.cause ?? e
  const detail = root?.message ?? String(root)
  if (e?.kind === 'net' || root?.name === 'TimeoutError' || /timeout|timed out|aborted/i.test(detail)) {
    return `请求超时或被中断（${detail}）—— 模型太久没回，或网络/代理断了；可换更快的模型`
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(detail)) return `域名解析失败（${detail}）—— 检查地址拼写、DNS、代理开关`
  if (/ECONNREFUSED/i.test(detail)) return `连不上服务器（${detail}）—— 检查网络或代理端口`
  if (/certificate|SSL|TLS|socket hang up/i.test(detail)) return `连接被中断（${detail}）—— 多半是代理/TUN 拦截或系统时间不对`
  return detail
}

function mapHttpError(status, body) {
  const text = String(body ?? '').slice(0, 300)
  if (status === 401 || status === 403) return new LlmError('API Key 无效或没有权限', 'auth')
  if (status === 402 || /insufficient_quota|quota/i.test(text)) return new LlmError('额度已用完', 'quota')
  if (status === 429) return new LlmError('请求太频繁，稍后再试', 'rate')
  if (status === 404) return new LlmError('找不到该模型（检查 Model 名）', 'model')
  if (status === 400 && /context_length|maximum context/i.test(text)) return new LlmError('对话超出模型上下文长度', 'bad')
  if (status >= 500) return new LlmError(`模型服务出错（HTTP ${status}）`, 'server')
  return new LlmError(`HTTP ${status}：${text}`, 'bad')
}

function parseReply(json) {
  const choice = json?.choices?.[0]
  if (!choice) throw new LlmError(`模型返回缺少 choices：${JSON.stringify(json).slice(0, 200)}`)
  const msg = choice.message ?? {}
  const calls = (msg.tool_calls ?? []).map((c) => ({
    id: c.id,
    name: c.function?.name ?? '',
    args: c.function?.arguments ?? '{}',
  }))
  return {
    text: typeof msg.content === 'string' ? msg.content : '',
    calls,
    finish: choice.finish_reason ?? '',
    usage: json.usage ?? null,
  }
}

class Llm {
  constructor({ base, key, model, onRetry }) {
    this.base = String(base ?? '').trim().replace(/\/+$/, '')
    this.key = String(key ?? '').trim()
    this.model = String(model ?? '').trim()
    this.onRetry = onRetry ?? (() => {})
  }

  get endpoint() {
    return `${this.base}/chat/completions`
  }

  /** messages 已是线上格式；tools 为 OpenAI function 数组。 */
  async chat({ system, messages, tools, attempts = 3 }) {
    const payload = {
      model: this.model,
      messages: [{ role: 'system', content: system }, ...messages],
    }
    if (tools && tools.length) payload.tools = tools

    let last
    for (let i = 1; i <= attempts; i++) {
      try {
        const res = await fetch(this.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.key ? { Authorization: `Bearer ${this.key}` } : {}),
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(READ_TIMEOUT_MS),
        })
        const text = await res.text()
        if (!res.ok) throw mapHttpError(res.status, text)
        let json
        try {
          json = JSON.parse(text)
        } catch {
          throw new LlmError(`模型返回了无法解析的内容：${text.slice(0, 200)}`, 'bad')
        }
        return parseReply(json)
      } catch (e) {
        last = e
        const retriable =
          e?.kind === 'server' || e?.kind === 'net' || e?.name === 'TimeoutError' || e?.name === 'TypeError'
        if (!retriable || i === attempts) throw e
        this.onRetry(i, describeError(e))
        await new Promise((r) => setTimeout(r, 800 * i))
      }
    }
    throw last
  }
}

module.exports = { Llm, LlmError, describeError }
