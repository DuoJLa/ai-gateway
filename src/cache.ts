/**
 * Worker isolate 内存热缓存 —— 优化项 #4: 每请求 2-3 次串行 KV 读 → 热实例 0 次
 *
 * 原因：Cloudflare Workers KV 单次读取延迟 10-50ms，每个 /v1/* 请求
 * 需要读 providers + proxy:keys + health，串行 3 次直接加到 TTFT 前。
 * isolate 内存变量在同实例存活期内可跨请求复用，TTL 10s 后回源 KV。
 *
 * 写穿失效：管理端写入时同步清空缓存，保证同 isolate 内立即生效。
 * 跨 isolate 不一致窗口 ≤ TTL（个人网关可接受）。
 */

import type { Env, Provider, ProxyKey } from './types'

/** 缓存条目：数据 + 写入时间戳 */
interface CacheEntry<T> {
  data: T
  ts: number
}

const CACHE_TTL_MS = 10_000 // 10 秒 TTL

let providersCache: CacheEntry<Provider[]> | null = null
let proxyKeysCache: CacheEntry<ProxyKey[]> | null = null

/**
 * 获取 providers —— 优先内存缓存，过期回源 KV
 * 优化项 #4: 消除每请求 getProviders 的 KV 读取
 */
export async function getCachedProviders(env: Env): Promise<Provider[]> {
  if (providersCache && Date.now() - providersCache.ts < CACHE_TTL_MS) {
    return providersCache.data
  }
  const data = await env.KV.get('providers')
  const parsed: Provider[] = data ? JSON.parse(data) : []
  providersCache = { data: parsed, ts: Date.now() }
  return parsed
}

/**
 * 获取单个 provider —— 复用 providers 缓存，避免 O(n) KV 读
 * 优化项 #4 + #11: 单 Key 场景不再额外读 health
 */
export async function getCachedProvider(env: Env, id: string): Promise<Provider | null> {
  const providers = await getCachedProviders(env)
  return providers.find((p) => p.id === id) ?? null
}

/**
 * 获取 proxy keys —— 优先内存缓存
 * 优化项 #4: 消除鉴权中间件每请求 getProxyKeys 的 KV 读取
 */
export async function getCachedProxyKeys(env: Env): Promise<ProxyKey[]> {
  if (proxyKeysCache && Date.now() - proxyKeysCache.ts < CACHE_TTL_MS) {
    return proxyKeysCache.data
  }
  const data = await env.KV.get('proxy:keys')
  const parsed: ProxyKey[] = data ? JSON.parse(data) : []
  proxyKeysCache = { data: parsed, ts: Date.now() }
  return parsed
}

/**
 * 验证转发 Key —— 直接走缓存，避免每请求全量加载
 * 优化项 #4: 鉴权路径从 O(n) KV 读降为内存查找
 */
export async function validateProxyKeyCached(env: Env, key: string): Promise<boolean> {
  const keys = await getCachedProxyKeys(env)
  return keys.some((item) => {
    if (item.key !== key || !item.enabled) return false
    if (item.expiresAt && Date.now() >= new Date(item.expiresAt).getTime()) return false
    return true
  })
}

/** 写穿失效：管理端 setProviders 后调用，清空 providers 缓存 */
export function invalidateProvidersCache(): void {
  providersCache = null
}

/** 写穿失效：管理端 setProxyKeys 后调用，清空 proxy keys 缓存 */
export function invalidateProxyKeysCache(): void {
  proxyKeysCache = null
}