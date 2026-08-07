export default {
  async fetch(request) {
    const url = new URL(request.url)
    const target = new URL(`https://opencode.ai${url.pathname}${url.search}`)
    return fetch(target, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    })
  }
}