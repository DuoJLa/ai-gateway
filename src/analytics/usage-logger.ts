import type { Context } from 'hono'
import type { AppEnv, Env } from '../types'
import type { AnalyticsContext, AnalyticsEventOptions, UsageMetrics } from './types'
import { getStatusFamily } from './types'

const EMPTY_USAGE: UsageMetrics = {
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  totalTokens: 0,
}

const getDatasetName = (env: Env): string => {
  const configured = env.USAGE_ANALYTICS_DATASET
  return configured && /^[A-Za-z_][A-Za-z0-9_]*$/.test(configured) ? configured : 'ai_gateway_usage'
}

export const writeAnalyticsEvent = (
  c: Context<AppEnv>,
  options: AnalyticsEventOptions,
): void => {
  const dataset = c.env.USAGE_ANALYTICS
  if (!dataset) return

  const usage = options.usage || EMPTY_USAGE
  const status = options.upstreamStatus || 0
  const context = options.context
  const latencyMs = Math.max(0, Date.now() - context.startedAt)

  try {
    dataset.writeDataPoint({
      indexes: [context.tokenHash],
      blobs: [
        context.route,
        context.tokenName,
        context.providerId,
        context.providerName,
        context.providerType,
        context.requestedModel,
        context.upstreamModel,
        options.result,
        context.streamMode,
        options.errorCode || '',
        getStatusFamily(status),
        context.requestId,
        context.traceId,
        context.clientIp,
        context.userAgent,
        context.country,
        context.region,
        context.city,
        context.colo,
        (options.errorSummary || '')
          .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer ***')
          .replace(/sk[-_][A-Za-z0-9_-]{8,}/gi, 'sk_***')
          .replace(/\s+/g, ' ')
          .slice(0, 200),
      ],
      doubles: [
        usage.promptTokens,
        usage.completionTokens,
        usage.cachedTokens,
        usage.totalTokens,
        latencyMs,
        context.retryCount,
        status,
        options.result === 'success' ? 1 : 0,
      ],
    })
  } catch (error) {
    console.error(`[analytics] 写入数据集 ${getDatasetName(c.env)} 失败`, error)
  }
}

/**
 * 解析 SSE 流中的 usage 指标。
 *
 * 优化要点：
 * 1. 滑动窗口 buffer：every flush 后只保留未终止的尾局段，避免 buffer 单调增长。
 * 2. 快速跳过：对于不含 'usage' 关键字的 chunk（占流式输出的绝大多数），
 *    字符串级判断后直接跳过 JSON.parse，大幅减少 V8 CPU 压力。
 */
export const observeStreamUsage = async (
  stream: ReadableStream<Uint8Array>,
  providerType: string,
  onUsage: (usage: UsageMetrics) => void,
): Promise<void> => {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })

      // 将 buffer 按换行拆分，只保留未终止的尾部段（滑动窗口）
      const newlineIdx = buffer.lastIndexOf('\n')
      if (newlineIdx === -1) continue // 整个 buffer 都是未终止段，等待更多数据

      const completeLines = buffer.slice(0, newlineIdx)
      buffer = buffer.slice(newlineIdx + 1) // 只保留尾部未终止居

      for (const line of completeLines.split(/\r?\n/)) {
        const raw = line.replace(/^data:\s*/, '').trim()
        if (!raw || raw === '[DONE]') continue
        // 快速跳过无 usage 的普通 delta chunk（占流式响应的绝大多数）
        if (!raw.includes('"usage"')) continue
        try {
          const parsed: unknown = JSON.parse(raw)
          const usage = providerType === 'anthropic'
            ? normalizeStreamMessageUsage(parsed)
            : normalizeStreamUsage(parsed)
          if (usage) onUsage(usage)
        } catch {
          // SSE 允许包含非 JSON 注释行，解析失败时跳过而不影响客户端流。
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

const normalizeStreamUsage = (value: unknown): UsageMetrics | null => {
  if (!value || typeof value !== 'object') return null
  const record = value as { usage?: unknown; response?: unknown }
  const usage = record.usage || (record.response && typeof record.response === 'object'
    ? (record.response as { usage?: unknown }).usage
    : undefined)
  if (!usage || typeof usage !== 'object') return null
  const item = usage as Record<string, unknown>
  const promptTokens = Number(item.prompt_tokens ?? item.input_tokens ?? 0)
  const completionTokens = Number(item.completion_tokens ?? item.output_tokens ?? 0)
  const cachedTokens = Number(
    (item.prompt_tokens_details as { cached_tokens?: unknown } | undefined)?.cached_tokens
      ?? (item.input_tokens_details as { cached_tokens?: unknown } | undefined)?.cached_tokens
      ?? 0,
  )
  return {
    promptTokens,
    completionTokens,
    cachedTokens,
    totalTokens: Number(item.total_tokens || promptTokens + completionTokens),
  }
}

const normalizeStreamMessageUsage = (value: unknown): UsageMetrics | null => {
  if (!value || typeof value !== 'object') return null
  const record = value as {
    message?: { usage?: Record<string, unknown> }
    usage?: Record<string, unknown>
  }
  const usage = record.message?.usage || record.usage
  if (!usage) return null
  const promptTokens = Number(usage.input_tokens || 0)
  const completionTokens = Number(usage.output_tokens || 0)
  const cachedTokens = Number(usage.cache_read_input_tokens || 0)
  return {
    promptTokens,
    completionTokens,
    cachedTokens,
    totalTokens: promptTokens + completionTokens + cachedTokens,
  }
}
