import type { Context } from 'hono'
import { getProvider, getProviders } from './storage'
import { KV_KEYS, KEY_HEALTH_COOLDOWN_MS, KEY_HEALTH_MAX_FAILURES } from './config'
import type { AppEnv, Env, Provider, ProxyRequestBody } from './types'
import { isOpenCodeProvider, proxyOpenCodeRequest, resolveOpenCodeUrls } from './opencode'
import { createAnalyticsContext, normalizeAnthropicUsage, normalizeChatUsage, normalizeResponsesUsage, summarizeError } from './analytics/types'
import type { AnalyticsContext, UsageMetrics } from './analytics/types'
import { observeStreamUsage, writeAnalyticsEvent } from './analytics/usage-logger'

interface KeyHealth {
  failures: number
  lastFailed: boolean
  demotedAt?: number
}

type HealthMap = Record<string, KeyHealth>

const HEALTH_KEY = (providerId: string): string => KV_KEYS.KEY_HEALTH_PREFIX + providerId

const readHealth = async (env: Env, providerId: string): Promise<HealthMap> => {
  const raw = await env.KV.get(HEALTH_KEY(providerId))
  return raw ? JSON.parse(raw) : {}
}

const writeHealth = async (env: Env, providerId: string, health: HealthMap): Promise<void> => {
  const filtered: HealthMap = {}
  for (const [key, value] of Object.entries(health)) {
    if (value.failures > 0) filtered[key] = value
  }
  if (Object.keys(filtered).length > 0) await env.KV.put(HEALTH_KEY(providerId), JSON.stringify(filtered))
  else await env.KV.delete(HEALTH_KEY(providerId)).catch(() => undefined)
}

const parseModelId = (model: string): { providerId: string; modelId: string } | null => {
  const slashIndex = model.indexOf('/')
  if (slashIndex <= 0 || slashIndex === model.length - 1) return null
  return { providerId: model.slice(0, slashIndex), modelId: model.slice(slashIndex + 1) }
}

const isStreamRequest = (body: ProxyRequestBody): boolean => body.stream === true
const getRoute = (url: URL): string => url.pathname.replace(/^\/v1\//, '') || 'chat/completions'

const normalizeUsage = (route: string, provider: Provider, payload: unknown): UsageMetrics | null => {
  if (route === 'responses') return normalizeResponsesUsage(payload)
  if (route === 'messages' || provider.apiType === 'anthropic') return normalizeAnthropicUsage(payload)
  return normalizeChatUsage(payload)
}

const readErrorResponse = async (response: Response): Promise<{ payload: unknown; summary: string }> => {
  const text = await response.text().catch(() => '')
  try {
    const payload: unknown = JSON.parse(text)
    return { payload, summary: summarizeError(payload) }
  } catch {
    return { payload: { error: { message: text || `HTTP ${response.status}` } }, summary: summarizeError(text || `HTTP ${response.status}`) }
  }
}

const finalizeSuccessfulResponse = async (
  c: Context<AppEnv>,
  response: Response,
  context: AnalyticsContext,
  route: string,
  provider: Provider,
): Promise<Response> => {
  const headers = new Headers(response.headers)
  headers.set('Cache-Control', 'no-store')
  if (!response.body) {
    writeAnalyticsEvent(c, { context, result: 'success', upstreamStatus: response.status })
    return new Response(null, { status: response.status, statusText: response.statusText, headers })
  }

  const [clientStream, observerStream] = response.body.tee()
  c.executionCtx.waitUntil((async () => {
    let usage: UsageMetrics | undefined
    if (context.streamMode === 'stream') {
      await observeStreamUsage(observerStream, provider.apiType || 'openai', (value) => {
        // 中文说明：Anthropic 将输入、输出用量拆在多个事件中，按最大值合并可避免后续事件覆盖输入 Token。
        usage = usage ? {
          promptTokens: Math.max(usage.promptTokens, value.promptTokens),
          completionTokens: Math.max(usage.completionTokens, value.completionTokens),
          cachedTokens: Math.max(usage.cachedTokens, value.cachedTokens),
          totalTokens: Math.max(usage.totalTokens, value.totalTokens),
        } : value
      })
    } else {
      const contentType = headers.get('Content-Type') || ''
      if (contentType.includes('json')) {
        const observerResponse = new Response(observerStream, { headers })
        const payload = await observerResponse.json().catch(() => null) as unknown
        usage = normalizeUsage(route, provider, payload) || undefined
      } else {
        await observerStream.cancel()
      }
    }
    writeAnalyticsEvent(c, { context, result: 'success', usage, upstreamStatus: response.status })
  })().catch((error) => {
    // 中文说明：解析失败仍记录成功请求，避免无 usage 或二进制响应从请求总量中消失。
    writeAnalyticsEvent(c, { context, result: 'success', upstreamStatus: response.status, errorSummary: summarizeError(error) })
  }))

  return new Response(clientStream, { status: response.status, statusText: response.statusText, headers })
}

export async function testModelConnection(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  apiType?: 'openai' | 'anthropic',
): Promise<{ success: boolean; message: string; statusCode?: number }> {
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/${apiType === 'anthropic' ? 'messages' : 'chat/completions'}`
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiType === 'anthropic') {
      headers['x-api-key'] = apiKey
      headers['anthropic-version'] = '2023-06-01'
    } else headers.Authorization = `Bearer ${apiKey}`
    const response = await fetch(url, {
      method: 'POST', headers, body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }), signal: AbortSignal.timeout(15000),
    })
    if (response.ok) return { success: true, message: '连接成功', statusCode: response.status }
    const failure = await readErrorResponse(response)
    return { success: false, message: `HTTP ${response.status}: ${failure.summary}`, statusCode: response.status }
  } catch (error) {
    return { success: false, message: `连接失败: ${summarizeError(error)}` }
  }
}

export async function handleProxy(c: Context<AppEnv>): Promise<Response> {
  const url = new URL(c.req.url)
  const route = getRoute(url)
  const proxyKey = c.get('proxyKey') || null
  const proxyKeyHash = c.get('proxyKeyHash') || ''
  let context = createAnalyticsContext(c, proxyKey, proxyKeyHash, route, '', 'sync')

  const fail = (status: number, code: string, message: string, payload?: unknown): Response => {
    writeAnalyticsEvent(c, { context, result: 'failure', upstreamStatus: status, errorCode: code, errorSummary: message })
    return new Response(JSON.stringify(payload || { error: { message, type: code } }), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
  }

  try {
    const body = await c.req.json<ProxyRequestBody>()
    const model = body.model || ''
    context = createAnalyticsContext(c, proxyKey, proxyKeyHash, route, model, isStreamRequest(body) ? 'stream' : 'sync')
    if (!model) return fail(400, 'invalid_request_error', '缺少 model 参数')

    const parsed = parseModelId(model)
    if (!parsed) return fail(400, 'invalid_request_error', `模型格式错误 "${model}"，请使用 提供商ID/模型ID 格式`)
    const provider = await getProvider(c.env, parsed.providerId)
    if (!provider) {
      context.providerId = parsed.providerId
      return fail(404, 'invalid_request_error', `提供商 "${parsed.providerId}" 不存在`)
    }

    context = createAnalyticsContext(c, proxyKey, proxyKeyHash, route, model, isStreamRequest(body) ? 'stream' : 'sync', provider, parsed.modelId)
    if (!provider.enabled) return fail(403, 'provider_disabled', `提供商 "${provider.name}" 已禁用`)
    const modelConfig = provider.models.find((item) => item.id === parsed.modelId)
    if (!modelConfig) return fail(404, 'invalid_request_error', `模型 "${parsed.modelId}" 未在提供商 "${provider.name}" 中配置`)
    if (!modelConfig.enabled) return fail(403, 'model_disabled', `模型 "${parsed.modelId}" 已禁用`)

    const enabledKeys = provider.apiKeys.filter((entry) => entry.enabled)
    const forwardBody = { ...body, model: parsed.modelId }
    if (isOpenCodeProvider(provider.id)) {
      const response = await proxyOpenCodeRequest({ baseUrl: provider.baseUrl, apiKeys: enabledKeys, method: c.req.method, subPath: route, search: url.search, body: JSON.stringify(forwardBody), mirrorUrls: resolveOpenCodeUrls(c.env), onAttempt: (attemptNumber) => { context.retryCount = Math.max(0, attemptNumber - 1) } })
      if (response.ok) return finalizeSuccessfulResponse(c, response, context, route, provider)
      const failure = await readErrorResponse(response)
      return fail(response.status, `http_${response.status}`, failure.summary, failure.payload)
    }

    if (enabledKeys.length === 0) return fail(500, 'configuration_error', `提供商 "${provider.name}" 未配置可用的 API Key`)
    const healthData = await readHealth(c.env, provider.id)
    const healthy: number[] = []
    const unhealthy: number[] = []
    const probation: number[] = []
    const demoted: number[] = []
    if (enabledKeys.length === 1) healthy.push(0)
    else enabledKeys.forEach((entry, index) => {
      const health = healthData[entry.key]
      if (health?.failures >= KEY_HEALTH_MAX_FAILURES) {
        if (!health.demotedAt) health.demotedAt = Date.now()
        if (Date.now() - health.demotedAt >= KEY_HEALTH_COOLDOWN_MS) probation.push(index)
        else demoted.push(index)
      } else if (health?.lastFailed) unhealthy.push(index)
      else healthy.push(index)
    })
    for (let index = healthy.length - 1; index > 0; index--) {
      const target = Math.floor(Math.random() * (index + 1)); [healthy[index], healthy[target]] = [healthy[target], healthy[index]]
    }
    const keyOrder = [...healthy, ...unhealthy, ...probation]
    if (!keyOrder.length) keyOrder.push(...demoted)

    let lastStatus = 0
    let lastSummary = '没有可用的 API Key'
    let healthUpdated = false
    for (let attempt = 0; attempt < keyOrder.length; attempt++) {
      if (attempt > 0) context.retryCount++
      const apiKey = enabledKeys[keyOrder[attempt]].key
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (provider.apiType === 'anthropic') { headers['x-api-key'] = apiKey; headers['anthropic-version'] = '2023-06-01' }
        else headers.Authorization = `Bearer ${apiKey}`
        const response = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/${route}${url.search}`, { method: c.req.method, headers, body: JSON.stringify(forwardBody), signal: AbortSignal.timeout(60000) })
        lastStatus = response.status
        if (response.ok) {
          if (healthData[apiKey]?.failures) { delete healthData[apiKey]; healthUpdated = true }
          if (healthUpdated) await writeHealth(c.env, provider.id, healthData)
          return finalizeSuccessfulResponse(c, response, context, route, provider)
        }
        const failure = await readErrorResponse(response)
        lastSummary = failure.summary
        if (response.status !== 429 && (response.status === 401 || response.status === 403 || response.status >= 500)) {
          const health = healthData[apiKey] || { failures: 0, lastFailed: false }
          health.failures++; health.lastFailed = true
          if (health.failures >= KEY_HEALTH_MAX_FAILURES) health.demotedAt = Date.now()
          healthData[apiKey] = health; healthUpdated = true
        }
        if (![401, 403, 429].includes(response.status) && response.status < 500) {
          if (healthUpdated) await writeHealth(c.env, provider.id, healthData)
          return fail(response.status, `http_${response.status}`, failure.summary, failure.payload)
        }
      } catch (error) {
        lastStatus = 502
        lastSummary = summarizeError(error)
        const health = healthData[apiKey] || { failures: 0, lastFailed: false }
        health.failures++; health.lastFailed = true
        if (health.failures >= KEY_HEALTH_MAX_FAILURES) health.demotedAt = Date.now()
        healthData[apiKey] = health; healthUpdated = true
      }
    }
    if (healthUpdated) await writeHealth(c.env, provider.id, healthData)
    return fail(lastStatus || 502, 'key_exhausted', `所有 API Key 已用完，最后一次错误：${lastSummary}`)
  } catch (error) {
    return fail(500, 'server_error', summarizeError(error))
  }
}

export async function handleModels(c: Context<AppEnv>): Promise<Response> {
  const providers = await getProviders(c.env)
  const models: Array<{ id: string; provider: string; provider_name: string; object: string; created: number; owned_by: string }> = []
  for (const provider of providers) {
    if (!provider.enabled) continue
    for (const model of provider.models) {
      if (!model.enabled) continue
      models.push({ id: `${provider.id}/${model.id}`, provider: provider.id, provider_name: provider.name, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: provider.id })
    }
  }
  return c.json({ object: 'list', data: models })
}
