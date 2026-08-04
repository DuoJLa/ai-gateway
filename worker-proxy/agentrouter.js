// ============================================================
// ps.air-outer.com 反代 Worker —— 自动注入官方客户端 User-Agent
// 用法:绑定到你的自定义域名(如 api.你的域名.com)
// ZCode/9Router 的 baseURL 填: https://api.你的域名.com  (不用带 /v1)
// ============================================================

const TARGET = "https://ps.air-outer.com";

// 官方客户端的 User-Agent(站点白名单校验)
const OFFICIAL_UA = "Kilo-Code/7.3.50 ai-sdk/provider-utils/4.0.27 runtime/bun/1.3.14";

// 转发时剔除的逐跳(Hop-by-hop)请求头,交给 fetch 自动重建
const HOP_HEADERS = [
  "host", "connection", "keep-alive", "transfer-encoding",
  "upgrade", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "content-length",
];

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // 容错:若客户端 baseURL 带 /v1 且又自动拼 /v1,折叠成单层
    let path = url.pathname;
    if (path.startsWith("/v1/v1")) path = path.replace(/^\/v1\/v1/, "/v1");

    const targetUrl = TARGET + path + url.search;

    // 复制请求头并强制替换 UA
    const headers = new Headers(request.headers);
    headers.set("User-Agent", OFFICIAL_UA);
    for (const h of HOP_HEADERS) headers.delete(h);

    const init = {
      method: request.method,
      headers,
      redirect: "manual",
    };

    // 携带请求体(GET/HEAD 不带)
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
    }

    // 转发并原样返回(Resp.body 是 ReadableStream,SSE 流式不会被打断)
    const resp = await fetch(targetUrl, init);
    const respHeaders = new Headers(resp.headers);
    respHeaders.delete("content-length"); // 流式响应长度由 CF 重建

    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers: respHeaders,
    });
  },
};