import http, { type IncomingMessage, type ServerResponse } from "node:http"
import type { Duplex } from "node:stream"

function runtimeHeaders(request: IncomingMessage, port: number, password: string): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = cleanHeaders(request.headers)
  for (const name of Object.keys(headers)) {
    if (["cookie", "origin", "proxy-authorization", "forwarded"].includes(name) || name.startsWith("x-forwarded-")) delete headers[name]
  }
  // 最後設定 authority/auth，不能讓 client 的 Connection: authorization 把內部認證刪除。
  headers.host = `127.0.0.1:${port}`
  headers.authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  return headers
}

function cleanHeaders(source: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { ...source }
  const nominated = (source.connection ?? "").split(",").map((name) => name.trim().toLowerCase())
  for (const name of [...nominated, "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]) delete headers[name]
  return headers
}

// Streaming 直接在 execution plane 完成；Manager 的生命週期不持有原生 Web 或 SSE 連線。
export function proxyRuntime(request: IncomingMessage, response: ServerResponse, port: number, pathname: string, password: string): void {
  const headers = runtimeHeaders(request, port, password)
  let result: IncomingMessage | undefined
  let failed = false
  const dispose = () => {
    if (failed) return
    failed = true
    clearTimeout(connectionDeadline)
    request.unpipe(upstream)
    result?.unpipe(response)
    result?.destroy()
    upstream.destroy()
  }
  const cancel = () => { dispose(); response.destroy() }
  const fail = () => {
    if (failed) return
    dispose()
    if (response.destroyed || response.writableEnded) return
    // Partial HTTP/SSE 不可用 end() 偽裝完成，必須讓 client 看見連線中斷。
    if (response.headersSent) response.destroy()
    else { response.writeHead(502); response.end() }
  }
  const upstream = http.request({ hostname: "127.0.0.1", port, path: pathname, method: request.method, headers }, (peer) => {
    result = peer
    peer.on("error", fail)
    peer.once("aborted", fail)
    peer.once("close", () => { if (!peer.complete) fail() })
    if (failed || response.destroyed) { peer.destroy(); return }
    const responseHeaders = cleanHeaders(peer.headers)
    delete responseHeaders["set-cookie"]
    delete responseHeaders.authorization
    if (typeof responseHeaders.location === "string") {
      try {
        const location = new URL(responseHeaders.location)
        if (location.origin === `http://127.0.0.1:${port}`) responseHeaders.location = `${location.pathname}${location.search}${location.hash}`
      } catch { /* relative redirect 保留 */ }
    }
    response.writeHead(peer.statusCode ?? 502, responseHeaders)
    peer.pipe(response)
  })
  // 只限制建立 TCP 連線；SSE 可長時間沒有事件，不可套用 socket idle timeout。
  const connectionDeadline = setTimeout(fail, 5_000)
  upstream.once("socket", (socket) => {
    if (socket.connecting) socket.once("connect", () => clearTimeout(connectionDeadline))
    else clearTimeout(connectionDeadline)
  })
  upstream.on("error", fail)
  response.once("close", dispose)
  response.on("error", cancel)
  request.once("aborted", cancel)
  request.on("error", cancel)
  request.pipe(upstream)
}

export function proxyRuntimeUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, port: number, password: string): void {
  if (request.headers.upgrade?.toLowerCase() !== "websocket") { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); return }
  const upstream = http.request({ hostname: "127.0.0.1", port, path: request.url ?? "/", method: "GET", headers: { ...runtimeHeaders(request, port, password), connection: "Upgrade", upgrade: "websocket" } })
  const deadline = setTimeout(() => { upstream.destroy(); socket.destroy() }, 5_000)
  socket.once("close", () => { clearTimeout(deadline); upstream.destroy() })
  upstream.on("upgrade", (response, peer, upstreamHead) => {
    clearTimeout(deadline)
    peer.setTimeout(0)
    if (response.headers.upgrade?.toLowerCase() !== "websocket") { peer.destroy(); socket.destroy(); return }
    const headers = cleanHeaders(response.headers)
    delete headers["set-cookie"]
    delete headers.authorization
    headers.connection = "Upgrade"
    headers.upgrade = "websocket"
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n`)
    if (head.length) peer.write(head)
    if (upstreamHead.length) socket.write(upstreamHead)
    peer.on("error", () => socket.destroy())
    socket.on("error", () => peer.destroy())
    socket.on("close", () => peer.destroy())
    peer.on("close", () => socket.destroy())
    socket.pipe(peer).pipe(socket)
  })
  upstream.on("response", (response) => { clearTimeout(deadline); response.resume(); socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n") })
  upstream.on("error", () => { clearTimeout(deadline); socket.destroy() })
  socket.on("error", () => upstream.destroy())
  upstream.end()
}
