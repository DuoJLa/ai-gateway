import { Context, Next } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { createSession, getSession, deleteSession, getValidProxyKeyByHash, getValidProxyKey } from './storage'
import { SESSION_TTL } from './config'
import type { AppEnv, Env } from './types'

/** SHA-256 哈希 */
export async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(password)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 管理后台 Session 验证中间件 */
export async function adminAuthMiddleware(c: Context<AppEnv>, next: Next) {
  const sessionId = getCookie(c, 'session_id')

  if (!sessionId) {
    const url = new URL(c.req.url)
    if (url.pathname === '/admin/login') return next()
    if (url.pathname.startsWith('/admin/api/')) {
      return c.json({ success: false, message: '未登录' }, 401)
    }
    return c.redirect('/admin/login')
  }

  const session = await getSession(c.env, sessionId)
  if (!session) {
    deleteCookie(c, 'session_id')
    const url = new URL(c.req.url)
    if (url.pathname.startsWith('/admin/api/')) {
      return c.json({ success: false, message: 'Session 已过期' }, 401)
    }
    return c.redirect('/admin/login')
  }

  c.set('username', session.username)
  return next()
}

/** 管理员登录 */
export async function handleLogin(c: Context<{ Bindings: Env }>) {
  const { username, password } = await c.req.json()
  const adminUser = c.env.ADMIN_USERNAME
  const adminPass = c.env.ADMIN_PASSWORD

  if (!adminUser || !adminPass) {
    return c.json({
      success: false,
      message: '未配置管理员账号，请在 Cloudflare 环境变量中设置 ADMIN_USERNAME 和 ADMIN_PASSWORD',
    }, 500)
  }

  if (!username || !password) {
    return c.json({ success: false, message: '请输入用户名和密码' }, 400)
  }

  if (username !== adminUser) {
    return c.json({ success: false, message: '用户名或密码错误' }, 401)
  }

  const passwordHash = await hashPassword(password)
  const adminPassHash = await hashPassword(adminPass)

  if (passwordHash !== adminPassHash) {
    return c.json({ success: false, message: '用户名或密码错误' }, 401)
  }

  const sessionId = await createSession(c.env, username, SESSION_TTL)
  setCookie(c, 'session_id', sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL,
  })

  return c.json({ success: true, message: '登录成功' })
}

/** 退出登录 */
export async function handleLogout(c: Context<{ Bindings: Env }>) {
  const sessionId = getCookie(c, 'session_id')
  if (sessionId) {
    await deleteSession(c.env, sessionId)
    deleteCookie(c, 'session_id')
  }
  return c.redirect('/')
}

/**
 * 转发 API Key 验证中间件
 *
 * 优化策略：
 * 1. 计算一次 SHA-256(token)，复用于 KV 索引查找和 analytics proxyKeyHash。
 * 2. getValidProxyKeyByHash() 做 O(1) 直接 KV 读取（无需加载全量 keys 数组）。
 * 3. 若索引未命中（迁移前的旧 key），自动回退到 getValidProxyKey() 线性扫描。
 */
export async function proxyKeyAuthMiddleware(c: Context<AppEnv>, next: Next) {
  const authHeader = c.req.header('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({
      error: { message: '缺少或无效的 Authorization 头，格式: Bearer sk_cf_*', type: 'authentication_error' },
    }, 401)
  }

  const token = authHeader.slice(7)

  // 一次 SHA-256，复用于 KV 索引键 和 analytics 哈希字段
  const tokenHash = await hashPassword(token)          // 64 hex chars (SHA-256)
  const shortHash = tokenHash.slice(0, 32)             // 32 chars，用于 analytics

  // O(1) 直接 KV 查找；迁移前旧 key 自动回退线性扫描
  const proxyKey = await getValidProxyKeyByHash(c.env, tokenHash)
  if (!proxyKey) {
    return c.json({
      error: { message: 'API Key 无效或已禁用', type: 'authentication_error' },
    }, 401)
  }

  // 只把令牌对象和不可逆哈希放入请求上下文，观测层绝不持久化原始 sk_cf_*
  c.set('proxyKey', proxyKey)
  c.set('proxyKeyHash', shortHash)
  return next()
}
