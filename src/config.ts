import type { Provider } from './types'

// ===== 超时配置 —— 优化项 #2 + #5: 拆分连接超时与总请求预算 =====
// 原因：原代码固定 60s 超时 × N 个 Key 顺序重试，用户最多等待 N×60s。
//   流式请求用固定 60s 也会截断正常的长生成（reasoning 模型生成常超 60s）。
// 方案：三段超时——首包阶段用 CONNECT_TIMEOUT，流式空闲用 STREAM_IDLE_TIMEOUT，
//   所有 Key/镜像重试共享 TOTAL_BUDGET_MS，不能各等 60s。

/** 首包超时：连接 + 首字节等待，超时即切下一个 Key/镜像 */
export const CONNECT_TIMEOUT_MS = 10_000

/** 流式空闲超时：流传输中无数据超过此值才断，不限制正常长生成 */
export const STREAM_IDLE_TIMEOUT_MS = 100_000

/** 总请求预算：所有回退尝试共享，耗尽即返回最后错误 */
export const TOTAL_BUDGET_MS = 30_000

/** 非流式请求总超时（单次 fetch） */
export const SYNC_TIMEOUT_MS = 60_000

export const SITE_CONFIG = {
  title: 'AI Gateway',
  subtitle: '统一的 AI 管理平台',
  author: 'QingYun',
  authorUrl: 'https://github.com/yutian81/ai-gateway',
  blogUrl: 'https://blog.notett.com',
  description: 'AI 提供商 API 代理网关 — 统一 /v1 接口转发',
  favicon: 'https://pan.811520.xyz/icon/ai.webp',
  faCdn: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css',
}

export const SESSION_TTL = 7 * 24 * 60 * 60

export const PROXY_KEY_PREFIX = 'sk_cf_'

export const OPENCODE_DEFAULT_URL = 'https://opencode.ai/zen/v1'

// Key 降权后自动恢复的冷却时间 (毫秒)
export const KEY_HEALTH_COOLDOWN_MS = 5 * 60 * 1000

// 连续失败多少次后降权
export const KEY_HEALTH_MAX_FAILURES = 5

// 429 限流默认冷却时间（毫秒）—— 优化项 #7: 429 不冷却反复被选中
export const RATE_LIMIT_DEFAULT_COOLDOWN_MS = 30_000

// 429 限流冷却上限（毫秒）
export const RATE_LIMIT_MAX_COOLDOWN_MS = 6 * 60 * 60 * 1000

/** Key 健康状态 —— 含 429 限流冷却字段 */
export interface KeyHealth {
  failures: number
  lastFailed: boolean
  demotedAt?: number
  /** 429 限流冷却到期时间戳；优先从 Retry-After 取，否则指数退避 */
  rateLimitedUntil?: number
}

export const KV_KEYS = {
  PROVIDERS: 'providers',
  PROXY_KEYS: 'proxy:keys',
  SESSION_PREFIX: 'admin:session:',
  KEY_HEALTH_PREFIX: 'key:health:',
  OPENCODE_MIGRATION: 'migration:opencode-default:v1',
} as const

// 有效期选项（秒）
export const EXPIRY_OPTIONS: Record<string, number | null> = {
  '30d': 30 * 24 * 60 * 60,
  '90d': 90 * 24 * 60 * 60,
  '180d': 180 * 24 * 60 * 60,
  '1y': 365 * 24 * 60 * 60,
  'forever': null,
}

export const DEFAULT_PROVIDERS: Provider[] = [
  {
    id: 'opencode',
    name: 'OpenCode',
    baseUrl: 'https://opencode.ai/zen/v1',
    apiType: 'openai',
    apiKeys: [],
    models: [
      { id: 'deepseek-v4-flash-free', enabled: true },
      { id: 'mimo-v2.5-free', enabled: true },
      { id: 'nemotron-3-ultra-free', enabled: true },
      { id: 'hy3-free', enabled: true },
    ],
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
]