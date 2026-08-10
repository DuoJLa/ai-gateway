import { Context } from 'hono'
import { getCachedProvider, getCachedProviders } from './cache'
import { KV_KEYS, KEY_HEALTH_COOLDOWN_MS, KEY_HEALTH_MAX_FAILURES, RATE_LIMIT_DEFAULT_COOLDOWN_MS, RATE_LIMIT_MAX_COOLDOWN_MS, STREAM_IDLE_TIMEOUT_MS, SYNC_TIMEOUT_MS, TOTAL_BUDGET_MS } from './config'
import type { KeyHealth } from './config'
import type { Env, ProxyRequestBody } from './types'
import { isOpenCodeProvider, proxyOpenCodeRequest, resolveOpenCodeUrls } from './opencode'

type HealthMap = Record<string, KeyHealth>

const HEALTH_KEY = (providerId: string): string => KV_KEYS.KEY_HEALTH_PREFIX + providerId

async function readHealth(env: Env, providerId: string): Promise<HealthMap> {
  const raw = await env.KV.get(HEALTH_KEY(providerId))
  return raw ? JSON.parse(raw) : {}
}

async function writeHealth(env: Env, providerId: string, health: HealthMap): Promise<void> {
  // 只保存有失败/限流记录的 key，避免 KV 膨胀
  const filtered: HealthMap = {}
  for (const [k, v] of Object.entries(health)) {
    if (v.failures > 0 || v.rateLimitedUntil) filtered[k] = v
  }
  if (Object.keys(filtered).length > 0) {
    await env.KV.put(HEALTH_KEY(providerId), JSON.stringify(filtered))
  } else {
    await env.KV.delete(HEALTH_KEY(providerId)).catch(() => {})
  }
}

/**
 * 优化项 #2 + #5: 合并客户端取消信号 + 超时信号 + 总预算
 * 原因：原代码只用独立超时信号，客户端断连后 Worker 继续占用上游连接。
 *   固定 60s × N Key 顺序重试导致用户最多等 N×60s。
 * 方案：AbortSignal.any() 合并三路信号——客户端取消、超时、总预算。
 */
function createUpstreamSignal(clientSignal: AbortSignal | undefined, timeoutMs: number, budgetSignal: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signals: AbortSignal[] = [timeoutSignal, budgetSignal]
  if (clientSignal) signals.push(clientSignal)
  return AbortSignal.any(signals)
}

/** 判断 abort 是否来自客户端取消（非超时/预算）——不记为 Key 不健康 */
function isClientCancelled(clientSignal: AbortSignal | undefined): boolean {
  return clientSignal?.aborted === true
}

/**
 * 优化项 #7: 从 429 响应中提取限流冷却时长
 * 优先读 Retry-After 头，否则用默认值；上限 RATE_LIMIT_MAX_COOLDOWN_MS
 */
function extract429Cooldown(response: Response): number {
  const retryAfter = response.headers.get('retry-after')
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10)
    if (!isNaN(seconds) && seconds > 0) return Math.min(seconds * 1000, RATE_LIMIT_MAX_COOLDOWN_MS)
  }
  return Math.min(RATE_LIMIT_DEFAULT_COOLDOWN_MS, RATE_LIMIT_MAX_COOLDOWN_MS)
}

/**
 * 优化项 #9: 响应头白名单透传
 * 原因：原代码只保留 Content-Type + Cache-Control，丢失 x-request-id 等上游元数据。
 *   "透传全部"会带入 hop-by-hop 头导致问题。
 * 方案：白名单透传，排除 hop-by-hop 头。
 */
const HOP_BY_HOP_HEADERS = new Set([
  'content-length', 'connection', 'transfer-encoding',
  'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'upgrade', 'host',
])

function buildPassthroughHeaders(upstreamHeaders: Headers): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of upstreamHeaders.entries()) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      result[key] = value
    }
  }
  result['Cache-Control'] = 'no-store'
  return result
}

/** 解析模型 ID，如 "deepseek/deepseek-chat" → { providerId, modelId } */
function parseModelId(model: string): { providerId: string; modelId: string } | null {
  const slashIndex = model.indexOf('/')
  if (slashIndex === -1) return null
  return {
    providerId: model.substring(0, slashIndex),
    modelId: model.substring(slashIndex + 1),
  }
}

/** 检测是否为流式请求 */
function isStreamRequest(body: ProxyRequestBody): boolean {
  return body.stream === true
}

/** 测试模型连接，发送最小请求验证 */
export async function testModelConnection(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  apiType?: 'openai' | 'anthropic'
): Promise<{ success: boolean; message: string; statusCode?: number }> {
  try {
    const cleanBase = baseUrl.replace(/\/$/, '')
    const endpoint = apiType === 'anthropic' ? 'messages' : 'chat/completions'
    const url = `${cleanBase}/${endpoint}`

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (apiType === 'anthropic') {
      headers['x-api-key'] = apiKey
      headers['anthropic-version'] = '2023-06-01'
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(15000),
    })

    if (response.ok) {
      return { success: true, message: '连接成功', statusCode: response.status }
    }

    let errorBody = ''
    try {
      const errorData = await response.json() as { error?: { message?: string } }
      errorBody = errorData?.error?.message || JSON.stringify(errorData)
    } catch {
      errorBody = await response.text()
    }

    return {
      success: false,
      message: `HTTP ${response.status}: ${errorBody.substring(0, 200)}`,
      statusCode: response.status,
    }
  } catch (err) {
    const error = err as Error
    return {
      success: false,
      message: `连接失败: ${error.message?.substring(0, 200) || '未知错误'}`,
    }
  }
}

/** 处理 /v1/chat/completions 等 API 转发 */
export async function handleProxy(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const body = await c.req.json<ProxyRequestBody>()
    const model = body.model

    if (!model) {
      return c.json({ error: { message: '缺少 model 参数', type: 'invalid_request_error' } }, 400)
    }

    const parsed = parseModelId(model)
    if (!parsed) {
      return c.json({
        error: {
          message: `模型格式错误 "${model}"，请使用 提供商ID/模型ID 格式`,
          type: 'invalid_request_error',
        },
      }, 400)
    }

    const { providerId, modelId } = parsed
    // 优化项 #4: 走内存缓存读取 provider，消除每请求 KV 读
    const provider = await getCachedProvider(c.env, providerId)

    if (!provider) {
      return c.json({
        error: { message: `提供商 "${providerId}" 不存在`, type: 'invalid_request_error' },
      }, 404)
    }

    if (!provider.enabled) {
      return c.json({
        error: { message: `提供商 "${provider.name}" 已禁用`, type: 'provider_disabled' },
      }, 403)
    }

    const modelConfig = provider.models.find((m) => m.id === modelId)
    if (!modelConfig) {
      return c.json({
        error: { message: `模型 "${modelId}" 未在提供商 "${provider.name}" 中配置`, type: 'invalid_request_error' },
      }, 404)
    }
    if (!modelConfig.enabled) {
      return c.json({
        error: { message: `模型 "${modelId}" 已禁用`, type: 'model_disabled' },
      }, 403)
    }

    const enabledKeys = provider.apiKeys.filter(k => k.enabled)
    // 优化项 #10: 原地修改 model 字段，只序列化一次，重试时复用
    body.model = modelId
    const forwardBodyStr = JSON.stringify(body)
    const url = new URL(c.req.url)
    const subPath = url.pathname.replace(/^\/v1\//, '') || 'chat/completions'
    const streaming = isStreamRequest(body)

    if (isOpenCodeProvider(providerId)) {
      const response = await proxyOpenCodeRequest({
        baseUrl: provider.baseUrl,
        apiKeys: enabledKeys,
        method: c.req.method,
        subPath,
        search: url.search,
        body: forwardBodyStr,
        mirrorUrls: resolveOpenCodeUrls(c.env),
        streaming,
        clientSignal: c.req.raw.signal, // 优化项 #1: 传递客户端取消信号
      })
      // 优化项 #9: 响应头白名单透传
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: buildPassthroughHeaders(response.headers),
      })
    }

    if (enabledKeys.length === 0) {
      return c.json({
        error: { message: `提供商 "${provider.name}" 未配置可用的 API Key`, type: 'configuration_error' },
      }, 500)
    }

    const cleanBase = provider.baseUrl.replace(/\/$/, '')
    const forwardUrl = `${cleanBase}/${subPath}${url.search}`

    // 优化项 #11: 单 Key 时跳过 health 读取，避免浪费 KV 读
    const now = Date.now()
    const healthData: HealthMap = enabledKeys.length > 1 ? await readHealth(c.env, providerId) : {}
    const healthy: number[] = []
    const unhealthy: number[] = []
    const probation: number[] = []
    const demoted: number[] = []
    const rateLimited: number[] = []

    if (enabledKeys.length === 1) {
      healthy.push(0)
    } else {
      for (let i = 0; i < enabledKeys.length; i++) {
        const h = healthData[enabledKeys[i].key]
        // 优化项 #7: 429 限流冷却期内的 Key 排入限流组
        if (h?.rateLimitedUntil && h.rateLimitedUntil > now) {
          rateLimited.push(i)
          continue
        }
        if (h && h.failures >= KEY_HEALTH_MAX_FAILURES) {
          if (!h.demotedAt) h.demotedAt = now
          if (now - h.demotedAt >= KEY_HEALTH_COOLDOWN_MS) {
            probation.push(i)
          } else {
            demoted.push(i)
          }
        } else if (h && h.lastFailed) {
          unhealthy.push(i)
        } else {
          healthy.push(i)
        }
      }
    }

    // Fisher-Yates 洗牌（仅健康 key 且多于 1 个时）—— 优化项 P3-3
    if (healthy.length > 1) {
      for (let i = healthy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [healthy[i], healthy[j]] = [healthy[j], healthy[i]]
      }
    }

    const keyOrder = [...healthy, ...unhealthy, ...probation]

    // 所有 key 都在冷却中时，降级尝试 demoted + rateLimited key
    if (keyOrder.length === 0 && (demoted.length > 0 || rateLimited.length > 0)) {
      keyOrder.push(...demoted, ...rateLimited)
      console.log(`[proxy] ${providerId}: all keys demoted/rate-limited, falling back to ${keyOrder.length} key(s)`)
    }

    // 优化项 #5: 总请求预算，所有 Key 重试共享
    const budgetController = new AbortController()
    const budgetTimer = setTimeout(() => budgetController.abort(), TOTAL_BUDGET_MS)
    const clientSignal = c.req.raw.signal // 优化项 #1: 客户端取消信号

    let lastError: Response | null = null
    let lastErrorStatus = 0
    let lastErrorMessage = '没有可用的 API Key'
    let healthUpdated = false

    for (const keyIndex of keyOrder) {
      // 预算耗尽或客户端取消 → 停止重试
      if (budgetController.signal.aborted || isClientCancelled(clientSignal)) break

      const apiKey = enabledKeys[keyIndex].key
      try {
        const forwardHeaders: Record<string, string> = {
          'Content-Type': 'application/json',
        }
        if (provider.apiType === 'anthropic') {
          forwardHeaders['x-api-key'] = apiKey
          forwardHeaders['anthropic-version'] = '2023-06-01'
        } else {
          forwardHeaders['Authorization'] = `Bearer ${apiKey}`
        }

        // 优化项 #2: 流式用 STREAM_IDLE_TIMEOUT（首包后不限制总时长）
        //   非流式用 SYNC_TIMEOUT；都合并客户端取消信号 + 总预算
        const timeoutMs = streaming ? STREAM_IDLE_TIMEOUT_MS : SYNC_TIMEOUT_MS
        const signal = createUpstreamSignal(clientSignal, timeoutMs, budgetController.signal)

        const response = await fetch(forwardUrl, {
          method: c.req.method,
          headers: forwardHeaders,
          body: forwardBodyStr,
          signal,
        })

        if (response.ok) {
          // 成功：重置健康状态
          if (healthData[apiKey]?.failures > 0 || healthData[apiKey]?.rateLimitedUntil) {
            delete healthData[apiKey]
            healthUpdated = true
          }
          // 优化项 #3: 健康状态异步落盘，不阻塞 TTFT
          if (healthUpdated) {
            c.executionCtx.waitUntil(writeHealth(c.env, providerId, healthData).catch((e) => {
              console.error('[health] 异步写入失败:', e)
            }))
          }
          clearTimeout(budgetTimer)

          // 优化项 #9: 响应头白名单透传
          return new Response(response.body, {
            status: response.status,
            headers: buildPassthroughHeaders(response.headers),
          })
        }

        // 优化项 #7: 429 纳入限流冷却
        if (response.status === 429) {
          const cooldown = extract429Cooldown(response)
          const h = healthData[apiKey] || { failures: 0, lastFailed: false }
          h.rateLimitedUntil = Date.now() + cooldown
          healthData[apiKey] = h
          healthUpdated = true
          lastError = response
          lastErrorStatus = 429
          continue // 切下一个 Key，不 failures++
        }

        // 401/403/5xx 尝试下一个 key（标记失败）
        if (response.status === 401 || response.status === 403 || response.status >= 500) {
          const h = healthData[apiKey] || { failures: 0, lastFailed: false }
          h.failures++
          h.lastFailed = true
          if (h.failures >= KEY_HEALTH_MAX_FAILURES) {
            h.demotedAt = Date.now()
          }
          healthData[apiKey] = h
          healthUpdated = true
          lastError = response
          lastErrorStatus = response.status
          continue
        }

        // 其他错误（400/404 等）直接返回
        const errorData = await response.json().catch(async () => ({ error: { message: await response.text() } }))
        if (healthUpdated) {
          c.executionCtx.waitUntil(writeHealth(c.env, providerId, healthData).catch((e) => {
            console.error('[health] 异步写入失败:', e)
          }))
        }
        clearTimeout(budgetTimer)
        return c.json(errorData, response.status as Parameters<typeof c.json>[1])
      } catch (err) {
        // 优化项 #1: 客户端取消 → 不记失败，直接返回
        if (isClientCancelled(clientSignal)) {
          clearTimeout(budgetTimer)
          return c.json({ error: { message: '客户端取消请求', type: 'client_cancelled' } }, 502)
        }

        // 优化项 #6: 网络错误（非 HTTP 状态码错误）不标记 Key 失败
        // 原因：DNS/TCP/超时等基础设施问题与 Key 无关，不应连累健康 Key 被降权
        const error = err as Error
        lastErrorStatus = 502
        lastErrorMessage = error.message || '请求失败'
        lastError = new Response(JSON.stringify({
          error: { message: lastErrorMessage, type: 'proxy_error' },
        }), { status: 502 })
        // 不做 health.failures++，只记录 lastError 并切下一个 Key
        continue
      }
    }

    clearTimeout(budgetTimer)

    // 优化项 #3: 健康状态异步落盘
    if (healthUpdated) {
      c.executionCtx.waitUntil(writeHealth(c.env, providerId, healthData).catch((e) => {
        console.error('[health] 异步写入失败:', e)
      }))
    }

    // 所有 key 均失败
    if (lastError) {
      const errorBody = await lastError.text().catch(() => lastErrorMessage)
      return c.json({
        error: {
          message: `所有 API Key 已用完，最后一次错误: HTTP ${lastErrorStatus}`,
          type: 'key_exhausted',
          detail: errorBody.substring(0, 500),
        },
      }, (lastErrorStatus || 502) as Parameters<typeof c.json>[1])
    }

    return c.json({
      error: { message: '没有可用的 API Key', type: 'configuration_error' },
    }, 500)
  } catch (err) {
    const error = err as Error
    return c.json({
      error: { message: error.message || '代理转发内部错误', type: 'server_error' },
    }, 500)
  }
}

/** 处理 /v1/models — 返回所有已启用的模型（含提供商前缀） */
export async function handleModels(c: Context<{ Bindings: Env }>): Promise<Response> {
  // 优化项 #4: /v1/models 走内存缓存
  const providers = await getCachedProviders(c.env)

  const models: Array<{
    id: string
    provider: string
    provider_name: string
    object: string
    created: number
    owned_by: string
  }> = []

  for (const provider of providers) {
    if (!provider.enabled) continue
    for (const model of provider.models) {
      if (!model.enabled) continue
      models.push({
        id: `${provider.id}/${model.id}`,
        provider: provider.id,
        provider_name: provider.name,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: provider.id,
      })
    }
  }

  return c.json({
    object: 'list',
    data: models,
  })
}