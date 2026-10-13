import http, { type IncomingMessage, type ServerResponse } from "node:http"
import type { Duplex } from "node:stream"
import { managerHeaders, type WorkerTarget } from "./transport.js"

const hopHeaders = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]
function clean(source: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const headers = { ...source }
  for (const name of [...hopHeaders, ...(source.connection ?? "").split(",").map((name) => name.trim().toLowerCase())]) delete headers[name]
  return headers
}
function outgoing(request: IncomingMessage, target: WorkerTarget, publicOrigin: string, native: boolean) {
  // 明列 browser 協定需要的 headers；gateway identity、incoming auth 與不明 credential headers 一律不傳。
  const headers: http.OutgoingHttpHeaders = {}
  const allowed = ["accept", "accept-language", "accept-encoding", "content-type", "content-length", "if-none-match", "if-modified-since",
    "range", "last-event-id", "sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions"]
  const source = clean(request.headers)
  for (const name of allowed) if (source[name] !== undefined) headers[name] = source[name]
  Object.assign(headers, managerHeaders(target, publicOrigin))
  if (native) {
    headers.host = new URL(target.nativeOrigin).host
    if (request.headers.origin === undefined) delete headers.origin
    else headers.origin = target.nativeOrigin
    delete headers["x-omw-csrf"]
  }
  return headers
}
function responseHeaders(source: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const headers = clean(source)
  for (const name of Object.keys(headers)) {
    if (["authorization", "www-authenticate", "set-cookie", "location", "server"].includes(name)
      || name.startsWith("x-forwarded-") || name.startsWith("x-pomerium-")) delete headers[name]
  }
  return headers
}

function nativeRedirect(location: string | undefined, target: WorkerTarget): string | undefined {
  if (!location) return undefined
  try {
    const url = new URL(location, target.nativeOrigin)
    if (url.username || url.password || ![target.nativeOrigin, `http://${target.address}:4180`].includes(url.origin)) return undefined
    return `${target.nativeOrigin}${url.pathname}${url.search}${url.hash}`
  } catch { return undefined }
}

export class CoordinatorProxy {
  private readonly shutdown = new AbortController()
  private readonly sockets = new Set<Duplex>()
  close(): void { this.shutdown.abort(); for (const socket of this.sockets) socket.destroy(); this.sockets.clear() }

  http(request: IncomingMessage, response: ServerResponse, options: {
    target: WorkerTarget; publicOrigin: string; pathname: string; native: boolean; timeoutMs: number; retired: AbortSignal
  }): void {
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, this.shutdown.signal, options.retired])
    let peer: IncomingMessage | undefined
    let ended = false
    const mutation = !["GET", "HEAD", "OPTIONS"].includes(request.method ?? "GET")
    const dispose = () => {
      if (ended) return
      ended = true; clearTimeout(deadline); request.unpipe(upstream); peer?.unpipe(response); peer?.destroy(); controller.abort()
    }
    const fail = () => {
      if (ended) return
      dispose()
      if (response.destroyed || response.writableEnded) return
      if (response.headersSent) { response.destroy(); return }
      response.writeHead(504, { "content-type": "application/json", "cache-control": "no-store" })
      response.end(JSON.stringify({ error: { code: mutation ? "WORKER_OPERATION_UNKNOWN" : "WORKER_PROXY_UNAVAILABLE",
        message: mutation ? "操作結果未知，請重新檢查 Worker；不要重送操作。" : "Worker 暫時無法連線。" } }))
    }
    const upstream = http.request({ hostname: options.target.address, port: options.native ? 4180 : 4174, path: options.pathname,
      method: request.method, headers: outgoing(request, options.target, options.publicOrigin, options.native), signal, agent: false }, (result) => {
      peer = result
      result.on("error", fail); result.once("aborted", fail)
      if (ended || response.destroyed) { result.destroy(); return }
      const status = result.statusCode ?? 502
      const location = options.native ? nativeRedirect(result.headers.location, options.target) : undefined
      if (status >= 300 && status !== 304 && !([301, 302, 303, 307, 308].includes(status) && location)) {
        // 不發布 Worker challenge、redirect 或任意 backend error body（可能包含 privateIP／credentials）。
        dispose()
        response.writeHead(status >= 400 && status <= 599 ? status : 502, { "content-type": "application/json", "cache-control": "no-store" })
        response.end(JSON.stringify({ error: { code: status >= 500 && mutation ? "WORKER_OPERATION_UNKNOWN" : "WORKER_REQUEST_REJECTED",
          message: status >= 500 && mutation ? "操作結果未知，請重新檢查 Worker；不要重送操作。" : "Worker 無法處理此請求。" } }))
        return
      }
      // Header 等待有 deadline；只有確認 SSE 後移除 total timer，永不套 socket idle timeout。
      if (String(result.headers["content-type"]).startsWith("text/event-stream")) clearTimeout(deadline)
      response.writeHead(status, { ...responseHeaders(result.headers), ...(location ? { location } : {}) })
      result.once("end", () => { clearTimeout(deadline) })
      result.pipe(response)
    })
    const deadline = setTimeout(fail, options.timeoutMs)
    upstream.once("error", fail)
    response.once("close", dispose)
    response.once("error", dispose)
    request.once("aborted", () => { dispose(); response.destroy() })
    request.once("error", () => { dispose(); response.destroy() })
    // onRequest 尚未經 Fastify body parser；原始 JSON／stream 完整傳給既有 ManagerService route。
    request.pipe(upstream)
  }

  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer, options: {
    target: WorkerTarget; publicOrigin: string; retired: AbortSignal
  }): void {
    if (request.method !== "GET" || request.headers.upgrade?.toLowerCase() !== "websocket") { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); return }
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, this.shutdown.signal, options.retired])
    const upstream = http.request({ hostname: options.target.address, port: 4180, path: request.url ?? "/", method: "GET", signal, agent: false,
      headers: { ...outgoing(request, options.target, options.publicOrigin, true), connection: "Upgrade", upgrade: "websocket" } })
    this.sockets.add(socket)
    let peer: Duplex | undefined
    const deadline = setTimeout(() => { controller.abort(); socket.destroy() }, 10_000)
    const dispose = () => { clearTimeout(deadline); controller.abort(); peer?.destroy(); this.sockets.delete(socket) }
    socket.once("close", dispose); socket.once("error", dispose)
    signal.addEventListener("abort", () => socket.destroy(), { once: true })
    upstream.once("upgrade", (result, stream, upstreamHead) => {
      clearTimeout(deadline); peer = stream; stream.setTimeout(0)
      if (result.headers.upgrade?.toLowerCase() !== "websocket") { stream.destroy(); socket.destroy(); return }
      const headers = { ...responseHeaders(result.headers), connection: "Upgrade", upgrade: "websocket" }
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n`)
      if (head.length) stream.write(head)
      if (upstreamHead.length) socket.write(upstreamHead)
      stream.once("error", () => socket.destroy()); stream.once("close", () => socket.destroy())
      socket.pipe(stream).pipe(socket)
    })
    upstream.once("response", (result) => { result.resume(); dispose(); socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n") })
    upstream.once("error", () => { dispose(); socket.destroy() })
    upstream.end()
  }
}

/** allowlist 是既有 OMW 公開 routes/methods；不能把 generic catch-all 變成任意內網 proxy。 */
export function managerProxyAllowed(method: string, pathname: string): boolean {
  const id = "[A-Za-z0-9_-]+"
  const routes: Array<[string[], string]> = [
    [["GET", "HEAD"], "(?:overview|connectivity|directories|worker/capacity|instances/history)"],
    [["POST"], "(?:instances|shortcuts)"],
    [["PATCH", "DELETE"], `shortcuts/${id}`],
    [["GET", "HEAD", "DELETE"], `instances/${id}`],
    [["POST"], `instances/${id}/(?:stop|recheck|resume|tracking|open-url|primary-session)`],
    [["GET", "HEAD", "POST"], `instances/${id}/sessions`],
    [["GET", "HEAD"], `instances/${id}/primary-todos`],
    [["GET", "HEAD"], `instances/${id}/sessions/${id}/children`],
  ]
  return routes.some(([methods, suffix]) => methods.includes(method) && new RegExp(`^/api/v1/${suffix}$`).test(pathname))
}
