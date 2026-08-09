import { KV_KEYS, DEFAULT_PROVIDERS, PROXY_KEY_PREFIX } from './config'
import type { Env, Provider, ProxyKey, Session } from './types'

// ===== KV key helpers =====

/** 每个 proxy key 的独立索引 KV 键，以 SHA-256 哈希为后缀，实现 O(1) 查找 */
const proxyKeyIndexKey = (hash: string): string => `proxy:key:${hash}`

// ===== 提供商 CRUD =====

export async function getProviders(env: Env): Promise<Provider[]> {
  const data = await env.KV.get(KV_KEYS.PROVIDERS)
  return data ? JSON.parse(data) : []
}

export async function getProvider(env: Env, id: string): Promise<Provider | null> {
  const providers = await getProviders(env)
  return providers.find((p) => p.id === id) ?? null
}

export async function setProviders(env: Env, providers: Provider[]): Promise<void> {
  await env.KV.put(KV_KEYS.PROVIDERS, JSON.stringify(providers))
}

export async function addProvider(env: Env, provider: Provider): Promise<void> {
  const providers = await getProviders(env)
  providers.push(provider)
  await setProviders(env, providers)
}

export async function updateProvider(env: Env, id: string, updates: Partial<Provider>): Promise<Provider | null> {
  const providers = await getProviders(env)
  const index = providers.findIndex((p) => p.id === id)
  if (index === -1) return null
  providers[index] = { ...providers[index], ...updates, updatedAt: new Date().toISOString() }
  await setProviders(env, providers)
  return providers[index]
}

export async function deleteProvider(env: Env, id: string): Promise<boolean> {
  const providers = await getProviders(env)
  const filtered = providers.filter((p) => p.id !== id)
  if (filtered.length === providers.length) return false
  await setProviders(env, filtered)
  return true
}

// ===== Session 管理 =====

export async function createSession(env: Env, username: string, ttlSeconds: number): Promise<string> {
  const sessionId = crypto.randomUUID()
  const session: Session = {
    username,
    expiresAt: Date.now() + ttlSeconds * 1000,
  }
  await env.KV.put(KV_KEYS.SESSION_PREFIX + sessionId, JSON.stringify(session), {
    expirationTtl: ttlSeconds,
  })
  return sessionId
}

export async function getSession(env: Env, sessionId: string): Promise<Session | null> {
  const data = await env.KV.get(KV_KEYS.SESSION_PREFIX + sessionId)
  if (!data) return null
  const session: Session = JSON.parse(data)
  if (session.expiresAt < Date.now()) {
    await deleteSession(env, sessionId)
    return null
  }
  return session
}

export async function deleteSession(env: Env, sessionId: string): Promise<void> {
  await env.KV.delete(KV_KEYS.SESSION_PREFIX + sessionId)
}

// ===== 转发 Key =====

/** 计算原始 key 字符串的 SHA-256 十六进制哈希，用作 KV 索引键后缀 */
async function sha256Hex(raw: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function getProxyKeys(env: Env): Promise<ProxyKey[]> {
  const data = await env.KV.get(KV_KEYS.PROXY_KEYS)
  return data ? JSON.parse(data) : []
}

export async function setProxyKeys(env: Env, keys: ProxyKey[]): Promise<void> {
  await env.KV.put(KV_KEYS.PROXY_KEYS, JSON.stringify(keys))
}

/**
 * 新增 proxy key：同时写入列表 JSON 和独立索引 KV 条目。
 * 独立索引以 sha256(rawKey) 为后缀，后续查验 O(1)。
 */
export async function addProxyKey(env: Env, key: ProxyKey): Promise<void> {
  const keys = await getProxyKeys(env)
  keys.push(key)
  const hash = await sha256Hex(key.key)
  await Promise.all([
    setProxyKeys(env, keys),
    env.KV.put(proxyKeyIndexKey(hash), JSON.stringify(key)),
  ])
}

/**
 * 删除 proxy key：同时从列表 JSON 和独立索引中删除。
 */
export async function deleteProxyKey(env: Env, id: string): Promise<boolean> {
  const keys = await getProxyKeys(env)
  const target = keys.find((k) => k.id === id)
  const filtered = keys.filter((k) => k.id !== id)
  if (filtered.length === keys.length) return false
  const ops: Promise<unknown>[] = [setProxyKeys(env, filtered)]
  if (target) {
    const hash = await sha256Hex(target.key)
    ops.push(env.KV.delete(proxyKeyIndexKey(hash)))
  }
  await Promise.all(ops)
  return true
}

/**
 * 更新 proxy key：同步更新列表 JSON 和独立索引。
 * 若 key 字符串本身变化（理论上不应发生），旧索引条目会被清除。
 */
export async function updateProxyKey(env: Env, id: string, updates: Partial<ProxyKey>): Promise<ProxyKey | null> {
  const keys = await getProxyKeys(env)
  const idx = keys.findIndex((k) => k.id === id)
  if (idx === -1) return null
  const oldKey = keys[idx]
  const newKey = { ...oldKey, ...updates }
  keys[idx] = newKey
  const ops: Promise<unknown>[] = [setProxyKeys(env, keys)]
  // 若 raw key 字符串未变，只需覆盖同一索引条目
  const oldHash = await sha256Hex(oldKey.key)
  const newHash = updates.key ? await sha256Hex(updates.key) : oldHash
  if (oldHash !== newHash) ops.push(env.KV.delete(proxyKeyIndexKey(oldHash)))
  ops.push(env.KV.put(proxyKeyIndexKey(newHash), JSON.stringify(newKey)))
  await Promise.all(ops)
  return newKey
}

/**
 * O(1) 查找：直接用 sha256(rawToken) 访问独立索引 KV 条目。
 * 若索引未命中（迁移前的旧 key），回退到全量线性扫描。
 */
export async function getValidProxyKeyByHash(env: Env, tokenHash: string): Promise<ProxyKey | null> {
  // 快速路径：O(1) 直接 KV 读取
  const direct = await env.KV.get(proxyKeyIndexKey(tokenHash))
  if (direct !== null) {
    const key: ProxyKey = JSON.parse(direct)
    if (!key.enabled) return null
    if (key.expiresAt && Date.now() >= new Date(key.expiresAt).getTime()) return null
    return key
  }
  // 慢速回退：兼容迁移前写入的 key（迁移后不再触发）
  return getValidProxyKey(env, tokenHash)
}

/** 旧版线性扫描（保留供 getValidProxyKeyByHash 回退及向后兼容） */
export async function getValidProxyKey(env: Env, key: string): Promise<ProxyKey | null> {
  const keys = await getProxyKeys(env)
  return keys.find((item) => {
    if (item.key !== key || !item.enabled) return false
    if (item.expiresAt && Date.now() >= new Date(item.expiresAt).getTime()) return false
    return true
  }) ?? null
}

/**
 * 一次性迁移：为现有 proxy keys 补写独立索引 KV 条目。
 * 在 seedInitialData 中调用，已通过 waitUntil 异步执行，不阻塞请求。
 * 迁移完成后写入 migration flag，后续不再重复执行。
 */
export async function migrateProxyKeyIndex(env: Env): Promise<void> {
  const migrated = await env.KV.get('proxy:key:index:migrated')
  if (migrated) return
  const keys = await getProxyKeys(env)
  if (keys.length === 0) {
    await env.KV.put('proxy:key:index:migrated', '1')
    return
  }
  await Promise.all(
    keys.map(async (key) => {
      const hash = await sha256Hex(key.key)
      await env.KV.put(proxyKeyIndexKey(hash), JSON.stringify(key))
    }),
  )
  await env.KV.put('proxy:key:index:migrated', '1')
}

// ===== 初始数据填充 =====

export async function seedInitialData(env: Env): Promise<void> {
  const providers = await getProviders(env)
  const migrationCompleted = await env.KV.get(KV_KEYS.OPENCODE_MIGRATION)
  const opencode = DEFAULT_PROVIDERS.find((provider) => provider.id === 'opencode')

  if (!migrationCompleted) {
    if (opencode && !providers.some((provider) => provider.id === opencode.id)) {
      await setProviders(env, [
        ...providers,
        {
          ...opencode,
          apiKeys: opencode.apiKeys.map((key) => ({ ...key })),
          models: opencode.models.map((model) => ({ ...model })),
        },
      ])
    }
    await env.KV.put(KV_KEYS.OPENCODE_MIGRATION, '1')
  }

  // 仅首次运行时创建测试转发 Key
  if (providers.length === 0 && !migrationCompleted) {
    const keys = await getProxyKeys(env)
    if (keys.length === 0) {
      const testKey = {
        id: crypto.randomUUID(),
        key: `${PROXY_KEY_PREFIX}${crypto.randomUUID().replace(/-/g, '').substring(0, 16)}`,
        name: '测试 Key',
        enabled: true,
        createdAt: new Date().toISOString(),
      }
      await addProxyKey(env, testKey)
    }
  }

  // 异步补写旧 key 的独立索引（一次性迁移，已有索引时直接跳过）
  await migrateProxyKeyIndex(env)
}
