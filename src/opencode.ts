import type { ApiKeyEntry, Env } from './types'
import { STREAM_IDLE_TIMEOUT_MS, SYNC_TIMEOUT_MS } from './config'

export const OPENCODE_PROVIDER_ID = 'opencode'

const OPENCODE_VERSION = '1.17.8'
// 优化项 #8: 失败体限量读取，避免大错误体全量读入内存
const MAX_ERROR_BODY_BYTES = 8_192

interface OpenCodeRequestOptions {
  baseUrl: string
  apiKeys: ApiKeyEntry[]
  method: string
  subPath: string
  mirrorUrls: string[]
  search?: string
  body?: string
  /** 是否为流式请求，影响超时策略 */
  streaming?: boolean
  /** 优化项 #1: 客户端取消信号，合并到上游 fetch */
  clientSignal?: AbortSignal
  fetcher?: typeof fetch
  random?: () => number
}

interface StoredFailure {
  status: number
  statusText: string
  headers: Headers
  // 优化项 #8: 错误体限量存储为 Uint8Array（前 8KB），不全量 arrayBuffer
  body: Uint8Array
}

export interface OpenCodeTestResult {
  success: boolean
  message: string
  statusCode?: number
  data?: unknown
}

export function isOpenCodeProvider(providerId: string): boolean {
  return providerId === OPENCODE_PROVIDER_ID
}

export function filterOpenCodeModels<T extends { id?: unknown }>(models: T[]): T[] {
  return models.filter((model) => (
    typeof model.id === 'string'
    && /^[A-Za-z0-9._:/-]+$/.test(model.id)
    && (model.id === 'big-pickle' || model.id.endsWith('-free'))
  ))
}

/**
 * 优化项 #14: 镜像 URL 解析缓存
 * 原因：环境变量运行时不变，但每次请求都重新分割/去重。
 * 缓存后同 isolate 内只解析一次。
 */
let mirrorUrlsCache: { raw: string; urls: string[] } | null = null

export function resolveOpenCodeUrls(env: Env): string[] {
  const raw = env.OPENCODE_MIRRORS_URL || ''
  // 缓存命中：raw 未变则直接返回已解析结果
  if (mirrorUrlsCache?.raw === raw) return mirrorUrlsCache.urls
  const parts = raw.split('\n').flatMap(s => s.split(',')).map(s => s.trim()).filter(Boolean)
  const urls = [...new Set(parts)]
  mirrorUrlsCache = { raw, urls }
  return urls
}

function getMirrorOrder(urls: string[], random: () => number): string[] {
  if (urls.length === 0) return []
  const start = Math.floor(random() * urls.length)
  return [
    ...urls.slice(start),
    ...urls.slice(0, start),
  ]
}

function buildUrl(baseUrl: string, subPath: string, search = ''): string {
  return `${baseUrl.replace(/\/+$/, '')}/${subPath.replace(/^\/+/, '')}${search}`
}

function createOpenCodeId(prefix: string): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const random = btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
    .slice(0, 16)
  return `${prefix}_${Date.now().toString(16)}${random}`
}

function createRequestHeaders(apiKey: string, requestId: string, sessionId: string): Headers {
  return new Headers({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    'User-Agent': `opencode/${OPENCODE_VERSION} ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13`,
    'x-opencode-client': 'cli',
    'x-opencode-project': 'global',
    'x-opencode-request': requestId,
    'x-opencode-session': sessionId,
  })
}

/**
 * 优化项 #8: 失败体限量读取
 * 原因：原代码 await response.arrayBuffer() 完整读入内存，
 *   大错误体或慢速结束的失败连接会拖慢回退。
 * 方案：只读前 MAX_ERROR_BODY_BYTES 字节，保留诊断信息足够。
 */
async function storeFailure(response: Response): Promise<StoredFailure> {
  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  if (reader) {
    try {
      while (totalBytes < MAX_ERROR_BODY_BYTES) {
        const { done, value } = await reader.read()
        if (done || !value) break
        chunks.push(value)
        totalBytes += value.length
      }
    } catch { /* 读取失败保留已读部分 */ }
    reader.cancel().catch(() => undefined)
  }
  const body = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length }
  return {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
    body,
  }
}

function restoreFailure(failure: StoredFailure): Response {
  return new Response(failure.body, {
    status: failure.status,
    statusText: failure.statusText,
    headers: failure.headers,
  })
}

function transportErrorResponse(error: unknown): Response {
  const message = error instanceof Error && error.message ? error.message : 'OpenCode 上游请求失败'
  return new Response(JSON.stringify({
    error: { message, type: 'proxy_error' },
  }), {
    status: 502,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

async function requestUpstream(
  fetcher: typeof fetch,
  url: string,
  apiKey: string,
  options: OpenCodeRequestOptions,
  requestId: string,
  sessionId: string
): Promise<Response> {
  // 优化项 #2: 流式用 STREAM_IDLE_TIMEOUT，非流式用 SYNC_TIMEOUT
  const timeoutMs = options.streaming ? STREAM_IDLE_TIMEOUT_MS : SYNC_TIMEOUT_MS
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  // 优化项 #1: 合并客户端取消信号与超时信号
  const signals: AbortSignal[] = [timeoutSignal]
  if (options.clientSignal) signals.push(options.clientSignal)
  const signal = AbortSignal.any(signals)
  return fetcher(url, {
    method: options.method,
    headers: createRequestHeaders(apiKey, requestId, sessionId),
    body: options.method === 'GET' || options.method === 'HEAD' ? undefined : options.body,
    signal,
  })
}

export async function proxyOpenCodeRequest(options: OpenCodeRequestOptions): Promise<Response> {
  const fetcher = options.fetcher ?? fetch
  const random = options.random ?? Math.random
  const requestId = createOpenCodeId('msg')
  const sessionId = createOpenCodeId('ses')
  let officialFailure: StoredFailure | null = null
  let mirrorFailure: StoredFailure | null = null
  let lastTransportError: unknown = null

  const enabledKeys = options.apiKeys.filter((entry) => entry.enabled && entry.key)
  const officialUrl = buildUrl(options.baseUrl, options.subPath, options.search)

  for (const entry of enabledKeys) {
    // 优化项 #1: 客户端取消时停止重试
    if (options.clientSignal?.aborted) break
    try {
      const response = await requestUpstream(
        fetcher,
        officialUrl,
        entry.key,
        options,
        requestId,
        sessionId
      )
      if (response.ok) return response

      officialFailure = await storeFailure(response)
      if (response.status !== 401 && response.status !== 403 && response.status !== 429) break
    } catch (error) {
      if (options.clientSignal?.aborted) break
      lastTransportError = error
      break
    }
  }

  for (const mirror of getMirrorOrder(options.mirrorUrls, random)) {
    // 优化项 #1: 客户端取消时停止镜像轮询
    if (options.clientSignal?.aborted) break
    try {
      const response = await requestUpstream(
        fetcher,
        buildUrl(mirror, options.subPath, options.search),
        'public',
        options,
        requestId,
        sessionId,
      )
      if (response.ok) return response
      mirrorFailure = await storeFailure(response)
    } catch (error) {
      if (options.clientSignal?.aborted) break
      lastTransportError = error
    }
  }

  if (officialFailure) return restoreFailure(officialFailure)
  if (mirrorFailure) return restoreFailure(mirrorFailure)
  return transportErrorResponse(lastTransportError)
}

export async function testOpenCodeModel(
  baseUrl: string,
  apiKeys: ApiKeyEntry[],
  modelId: string,
  mirrorUrls: string[],
  fetcher?: typeof fetch,
): Promise<OpenCodeTestResult> {
  const response = await proxyOpenCodeRequest({
    baseUrl,
    apiKeys,
    mirrorUrls,
    method: 'POST',
    subPath: 'chat/completions',
    streaming: false,
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
    }),
    fetcher,
  })

  if (response.ok) {
    return { success: true, message: '连接成功', statusCode: response.status }
  }

  const body = await response.text()
  return {
    success: false,
    message: `HTTP ${response.status}: ${body.substring(0, 200)}`,
    statusCode: response.status,
  }
}

export async function fetchOpenCodeModels(
  baseUrl: string,
  apiKeys: ApiKeyEntry[],
  mirrorUrls: string[],
  fetcher?: typeof fetch,
): Promise<OpenCodeTestResult> {
  const response = await proxyOpenCodeRequest({
    baseUrl,
    apiKeys,
    mirrorUrls,
    method: 'GET',
    subPath: 'models',
    streaming: false,
    fetcher,
  })

  if (!response.ok) {
    return {
      success: false,
      message: `HTTP ${response.status}: ${(await response.text()).substring(0, 200)}`,
      statusCode: response.status,
    }
  }

  const data = await response.json() as { data?: Array<{ id?: unknown }> }
  return {
    success: true,
    message: '连接成功',
    statusCode: response.status,
    data: {
      ...data,
      data: Array.isArray(data.data) ? filterOpenCodeModels(data.data) : [],
    },
  }
}