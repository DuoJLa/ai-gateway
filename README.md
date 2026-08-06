# AI Gateway

基于 Cloudflare Workers + Hono 的 AI 提供商 API 代理网关，统一 `/v1` 接口转发，支持多 Key 轮询、健康检查与自动故障转移。

## 功能与特性

- **统一 API 接口** — 所有 AI 提供商通过 `https://你的域名/v1` 访问，兼容 OpenAI / Anthropic 协议
- **多 Key 轮询 + 健康检查** — 每个提供商可配置多个 API Key，请求随机打乱；失败 Key 自动降权，连续失败 5 次后进入冷却
- **Key 自动恢复** — 降权 Key 冷却 5 分钟后自动获得一次试用机会，成功则恢复权重，失败则重新冷却
- **OpenCode 默认接入** — 默认启用 4 个免费模型，无需配置上游 API Key
- **OpenCode 自动故障转移** — 配置 Key 时优先官方 API，失败后使用公共镜像；无 Key 时直接使用公共镜像
- **多提供商管理** — 默认仅创建 OpenCode，支持自定义添加其他 OpenAI / Anthropic 兼容提供商
- **OpenCode 创建智能填充** — 创建提供商时 ID 输入 `opencode` 自动填充官方 API 地址，API Key 可留空，空 Key 测试时自动走镜像获取可用模型（仅显示 `-free` 和 `big-pickle` 模型）
- **OpenCode 编辑获取模型** — 编辑页可直接从镜像/官方获取模型列表，一键添加到表单
- **两级启用控制** — 提供商级别 + 模型级别的启用/禁用
- **转发 Key 认证** — 生成 `sk_cf_*` 格式的 API Key，支持有效期管理
- **模型连接测试** — 管理后台手动测试模型是否可连接（通过服务端代理，无跨域限制）
- **管理后台** — 卡片式 UI，移动端自适应，无需前端构建

**如需看板及token使用统计功能，可以使用此 Fork 版：[DuoJLa/ai-gateway](https://github.com/DuoJLa/ai-gateway)**

## 技术栈

- **运行时**：Cloudflare Workers
- **框架**：[Hono](https://hono.dev/) v4
- **存储**：Cloudflare Workers KV
- **语言**：TypeScript

## 本地开发

```bash
# 克隆项目
git clone <你的仓库地址>
cd ai-gateway
npm install

# 创建 .dev.vars（已 .gitignore）
echo ADMIN_USERNAME=admin >> .dev.vars
echo ADMIN_PASSWORD=your-password >> .dev.vars
echo OPENCODE_MIRRORS_URL=https://opencode.ai.cmliussss.net/zen/v1 >> .dev.vars

# 启动本地开发服务器
npm run dev
```

## 部署

### 方式一：手动部署

1. 在 Cloudflare Dashboard → **Workers & Pages** → 点击 **创建** → **Workers** → **连接到 Git**
2. 选择你的 GitHub 仓库，在构建设置中使用默认选项，点击**保存并部署**
3. Cloudflare 会自动构建并部署 Worker，同时自动创建 `KV` 命名空间并绑定
4. 部署完成后，进入 Worker 页面 → **Settings** → **Variables**，添加：
  - `ADMIN_USERNAME` — 管理后台登录用户名
  - `ADMIN_PASSWORD` — 管理后台登录密码
  - `OPENCODE_MIRRORS_URL` — OpenCode 镜像地址列表，每行一个 URL或用 `,` 分隔。填写以下三个地址：
  
  ```
  https://opencode.ai.cmliussss.net/zen/v1
  https://opencode.fastly.cmliussss.net/zen/v1
  https://opencode.gcore.cmliussss.net/zen/v1
  ```

  > 以上镜像地址来源于CM大佬，在此表示感谢！

- 建议：绑定一个自定义域名

### 方式二：GitHub Actions 自动部署

1. Fork 或推送代码到你的 GitHub 仓库

2. 在 GitHub 仓库 Settings → **Secrets and variables** → **Actions** 中配置：
   - **Secrets**：`CF_API_TOKEN`（Cloudflare API Token，权限需包含 Workers 编辑）
   - **Variables**：`ADMIN_USERNAME`、`ADMIN_PASSWORD`、`OPENCODE_MIRRORS_URL`（可选，追加额外镜像地址，每行一个，默认已包含上述三个镜像地址）

3. 在 GitHub 仓库 Actions 页面手动触发 **Deploy to Cloudflare Workers** 工作流

> 工作流会在 CI 中自动生成 `wrangler.toml`（含 KV 绑定和 ADMIN 凭据），无需手动配置 Dashboard。

## 使用方法

- **API BASE URL**：`https://你的域名/v1`
- **API KEY**：在管理后台手动生成，格式为：`sk_cf_<KEY>`
- **模型ID**：`提供商ID/模型ID`，默认 OpenCode 模型包括：
  - `opencode/deepseek-v4-flash-free`
  - `opencode/mimo-v2.5-free`
  - `opencode/nemotron-3-ultra-free`
  - `opencode/hy3-free`

OpenCode 默认不需要上游 Key。若在管理后台为 OpenCode 添加 Key，请求会先访问后台配置的官方 API 地址；未成功时再从随机起点依次尝试镜像地址，并使用内置的 `Bearer public`。镜像地址列表通过环境变量 `OPENCODE_MIRRORS_URL` 配置（多行，每行一个 URL），部署脚本默认写入三个公共镜像。用户可在 GitHub Actions Variables 中设置同名变量追加额外地址（全局去重）。已有 KV 数据不会被删除，升级时仅在缺少 OpenCode 的情况下补充该默认提供商。

## 项目结构

```
ai-gateway/
├── src/
│   ├── index.ts       # 入口，路由注册
│   ├── types.ts       # 类型定义
│   ├── config.ts      # 默认配置
│   ├── storage.ts     # KV 存储层
│   ├── auth.ts        # 认证系统
│   ├── proxy.ts       # API 转发核心（Key 轮询 + 健康检查 + 自动恢复）
│   ├── opencode.ts    # OpenCode 官方 API 与公共镜像故障转移
│   ├── admin.ts       # 管理 API（含服务端 Key/模型测试代理）
│   ├── pages.ts       # 前端页面模板
│   ├── pages.css.ts   # 样式
│   └── shared.js.ts   # 共享 JS 工具函数
├── wrangler.toml
├── package.json
├── tsconfig.json
└── .github/workflows/deploy.yml
```

## License

Apache 2.0

## 鸣谢

感谢 [DuoJLa](https://github.com/DuoJLa/ai-gateway) 贡献的前端代码
