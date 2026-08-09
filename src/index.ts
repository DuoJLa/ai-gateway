import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import type { AppEnv } from './types'
import { adminAuthMiddleware, proxyKeyAuthMiddleware, handleLogin, handleLogout } from './auth'
import { handleProxy, handleModels } from './proxy'
import {
  handleStatus,
  handleGetProviders,
  handleCreateProvider,
  handleUpdateProvider,
  handleDeleteProvider,
  handleTestModel,
  handleTestKeyNew,
  handleTestModelNew,
  handleGetProxyKeys,
  handleCreateProxyKey,
  handleUpdateProxyKey,
  handleDeleteProxyKey,
} from './admin'
import { renderHomePage, renderLoginPage, renderAdminPage } from './pages'
import { seedInitialData, getSession } from './storage'
import {
  handleAnalyticsOverview,
  handleAnalyticsTrend,
  handleAnalyticsBreakdown,
  handleUsageLogs,
} from './analytics/admin-api'

const app = new Hono<AppEnv>()

// ===== 全局中间件 =====
app.use('*', cors())
app.use('*', logger())

/**
 * 初始化种子数据——改为异步 waitUntil 执行，不阻塞请求热路径。
 *
 * 原因：冷启动时 seedInitialData 最多触发 5 次串行 KV I/O，
 * 在 Workers 平均 KV 延迟 50-200ms 的环境下最多您贵 1s，
 * 直接决定了流式请求是否能在 60s 超时内完成。
 *
 * module-level Promise 缓存：同一 isolate 内并发请求时不会重复执行 seed。
 */
let seedPromise: Promise<void> | null = null
app.use('*', async (c, next) => {
  if (!seedPromise) {
    // 立即执行 next()，不等待 seed 完成
    seedPromise = seedInitialData(c.env).catch((err) => {
      // seed 失败时重置，下次请求再尝试
      console.error('[seed] 初始化失败，将在下次请求重试:', err)
      seedPromise = null
    })
    // 不阻塞：直接将 seed task 挂起并继续处理请求
    c.executionCtx.waitUntil(seedPromise)
  }
  return next()
})

// ===== 首页 =====
app.get('/', async (c) => {
  const { getCookie } = await import('hono/cookie')
  const sessionId = getCookie(c, 'session_id')
  let isLoggedIn = false
  if (sessionId) {
    const session = await getSession(c.env, sessionId)
    isLoggedIn = session !== null
  }
  return renderHomePage(c, isLoggedIn)
})

// ===== 登录/退出 =====
app.get('/admin/login', async (c) => renderLoginPage(c))
app.post('/admin/login', handleLogin)
app.get('/admin/logout', handleLogout)

// ===== 管理后台（需 Session 验证） =====
app.use('/admin/*', adminAuthMiddleware)

app.get('/admin', async (c) => renderAdminPage(c))

// 系统状态
app.get('/admin/api/status', handleStatus)

// 提供商 CRUD
app.get('/admin/api/providers', handleGetProviders)
app.post('/admin/api/providers', handleCreateProvider)
app.put('/admin/api/providers/:id', handleUpdateProvider)
app.delete('/admin/api/providers/:id', handleDeleteProvider)
app.post('/admin/api/providers/:id/test-model', handleTestModel)
app.post('/admin/api/test-key', handleTestKeyNew)
app.post('/admin/api/test-model', handleTestModelNew)

// 转发 Key 管理
app.get('/admin/api/proxy-keys', handleGetProxyKeys)
app.post('/admin/api/proxy-keys', handleCreateProxyKey)
app.delete('/admin/api/proxy-keys/:id', handleDeleteProxyKey)
app.patch('/admin/api/proxy-keys/:id', handleUpdateProxyKey)

// Analytics Engine 总览与详细日志
app.get('/admin/api/analytics/overview', handleAnalyticsOverview)
app.get('/admin/api/analytics/trend', handleAnalyticsTrend)
app.get('/admin/api/analytics/breakdown', handleAnalyticsBreakdown)
app.get('/admin/api/usage-logs', handleUsageLogs)

// ===== API 转发路由（需转发 Key 验证） =====
app.use('/v1/*', proxyKeyAuthMiddleware)
app.get('/v1/models', handleModels)
app.all('/v1/*', handleProxy)

// ===== 404 处理 =====
app.notFound((c) => {
  return c.json({ error: { message: '接口不存在', type: 'not_found' } }, 404)
})

// ===== 错误处理 =====
app.onError((err, c) => {
  console.error('未捕获的错误:', err)
  return c.json({ error: { message: '服务器内部错误', type: 'server_error' } }, 500)
})

export default app
