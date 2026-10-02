import assert from "node:assert/strict"
import http, { type IncomingMessage, type ServerResponse } from "node:http"
import type { Socket } from "node:net"
import test from "node:test"
import { proxyRuntime } from "../src/worker/proxy.js"

async function bounded<T>(work: Promise<T>, milliseconds = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("proxy fixture deadline exceeded")), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}

function signal() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

// 每次 fixture 自有 fresh port/socket binding；失敗與 deadline 都只清理本次資源。
async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const sockets = new Set<Socket>()
  const clients = new Set<http.ClientRequest>()
  const upstream = http.createServer(handler)
  const proxy = http.createServer((request, response) => {
    proxyRuntime(request, response, port(upstream), request.url ?? "/", "fixture-password-only")
  })
  const servers = [upstream, proxy]
  for (const server of servers) server.on("connection", (socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })
  const stop = () => {
    for (const client of clients) client.destroy()
    for (const socket of sockets) socket.destroy()
    for (const server of servers) server.closeAllConnections()
  }
  const lifetime = setTimeout(() => {
    stop()
    for (const server of servers) server.close()
  }, 15_000)
  const close = async () => {
    clearTimeout(lifetime)
    stop()
    await bounded(Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve())
    }))))
  }
  try {
    for (const server of servers) await bounded(new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve() })
    }))
  } catch (error) { await close(); throw error }
  return {
    upstreamPort: port(upstream),
    request(options: http.RequestOptions = {}) {
      const client = http.request({ hostname: "127.0.0.1", port: port(proxy), path: "/event", agent: false, ...options })
      clients.add(client)
      client.on("error", () => {})
      client.once("close", () => clients.delete(client))
      return client
    },
    close,
  }
}

function port(server: http.Server): number {
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  return address.port
}

function collect(client: http.ClientRequest) {
  return bounded(new Promise<{ status: number | undefined; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    client.once("error", reject)
    client.once("response", (response) => {
      let body = ""
      response.on("error", reject)
      response.on("data", (chunk) => { body += chunk })
      response.once("end", () => resolve({ status: response.statusCode, headers: response.headers, body }))
    })
  }))
}

test("proxy closes a partial SSE response when upstream disconnects after the first chunk", { timeout: 10_000 }, async () => {
  const upstreamClosed = signal()
  const firstChunk = signal()
  const downstreamClosed = signal()
  let peer!: ServerResponse
  let upstreamEnded = false
  let downstreamEnded = false
  let completed = false
  let body = ""
  const app = await fixture((_request, response) => {
    peer = response
    response.once("close", () => { upstreamEnded = true; upstreamClosed.resolve() })
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write("data: first\n\n")
  })
  try {
    const client = app.request()
    client.once("response", (response) => {
      response.on("error", () => {})
      response.on("data", (chunk) => { body += chunk; firstChunk.resolve() })
      response.once("end", () => { completed = true })
      response.once("close", () => { downstreamEnded = true; downstreamClosed.resolve() })
    })
    client.end()
    await bounded(firstChunk.promise)
    peer.destroy()
    await bounded(upstreamClosed.promise)
    await bounded(downstreamClosed.promise, 500).catch(() => {})
    assert.deepEqual({ upstreamClosed: upstreamEnded, downstreamEnded }, { upstreamClosed: true, downstreamEnded: true })
    assert.equal(completed, false, "partial response must not masquerade as a complete HTTP body")
    assert.equal(body, "data: first\n\n")
  } finally { await app.close() }
})

test("proxy cancels an incomplete upstream upload when the client aborts", { timeout: 10_000 }, async () => {
  const received = signal()
  const upstreamClosed = signal()
  let complete = true
  const app = await fixture((request, _response) => {
    request.on("error", () => {})
    request.once("data", () => received.resolve())
    request.once("close", () => { complete = request.complete; upstreamClosed.resolve() })
    request.resume()
  })
  try {
    const client = app.request({ method: "POST", headers: { "content-length": "1000000" } })
    client.write("partial-upload")
    await bounded(received.promise)
    client.destroy()
    await bounded(upstreamClosed.promise)
    assert.equal(complete, false)
  } finally { await app.close() }
})

test("proxy completes normal HTTP and preserves authority, secret filtering and relative redirects", { timeout: 10_000 }, async () => {
  let received!: http.IncomingHttpHeaders
  let upload = ""
  const app = await fixture((request, response) => {
    received = request.headers
    request.on("data", (chunk) => { upload += chunk })
    request.once("end", () => {
      response.writeHead(301, {
        location: `http://127.0.0.1:${app.upstreamPort}/next?view=1#tail`,
        "set-cookie": "fixture=private", authorization: "fixture-response-only",
        connection: "x-upstream-hop", "x-upstream-hop": "private-hop", "x-visible": "public",
        "content-length": "8",
      })
      response.end("complete")
    })
  })
  try {
    const client = app.request({ method: "POST", headers: {
      host: "browser.invalid", authorization: "fixture-client-only",
      connection: "authorization, x-client-hop", "x-client-hop": "private-hop",
      cookie: "fixture=private", origin: "https://browser.invalid", forwarded: "host=browser.invalid",
      "x-forwarded-for": "192.0.2.1", "proxy-authorization": "fixture-proxy-only", "x-visible": "public",
    } })
    const completed = collect(client)
    client.end("upload")
    const response = await completed
    assert.equal(response.status, 301)
    assert.equal(response.body, "complete")
    assert.equal(upload, "upload")
    assert.equal(received.host, `127.0.0.1:${app.upstreamPort}`)
    assert.equal(received.authorization, `Basic ${Buffer.from("opencode:fixture-password-only").toString("base64")}`)
    assert.equal(received["x-visible"], "public")
    for (const header of ["cookie", "origin", "forwarded", "x-forwarded-for", "proxy-authorization", "x-client-hop"]) assert.equal(received[header], undefined)
    assert.equal(response.headers.location, "/next?view=1#tail")
    assert.equal(response.headers["x-visible"], "public")
    for (const header of ["set-cookie", "authorization", "x-upstream-hop"]) assert.equal(response.headers[header], undefined)
  } finally { await app.close() }
})

test("proxy returns a complete 502 if upstream disconnects before sending headers", { timeout: 10_000 }, async () => {
  const app = await fixture((_request, response) => response.destroy())
  try {
    const client = app.request()
    const completed = collect(client)
    client.end()
    const response = await completed
    assert.equal(response.status, 502)
    assert.equal(response.body, "")
  } finally { await app.close() }
})

test("proxy releases the upstream SSE connection when the downstream client disconnects", { timeout: 10_000 }, async () => {
  const firstChunk = signal()
  const upstreamClosed = signal()
  let downstream!: IncomingMessage
  const app = await fixture((_request, response) => {
    response.once("close", upstreamClosed.resolve)
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write("data: first\n\n")
  })
  try {
    const client = app.request()
    client.once("response", (response) => {
      downstream = response
      response.on("error", () => {})
      response.once("data", firstChunk.resolve)
    })
    client.end()
    await bounded(firstChunk.promise)
    downstream.destroy()
    await bounded(upstreamClosed.promise)
    assert.equal(downstream.destroyed, true)
  } finally { await app.close() }
})

test("proxy does not apply its connection deadline as an SSE idle timeout", { timeout: 10_000 }, async () => {
  const firstChunk = signal()
  const completed = signal()
  let peer!: ServerResponse
  let closed = false
  let body = ""
  const app = await fixture((_request, response) => {
    peer = response
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write("data: first\n\n")
  })
  try {
    const client = app.request()
    client.once("response", (response) => {
      response.on("error", () => {})
      response.on("data", (chunk) => { body += chunk; firstChunk.resolve() })
      response.once("end", completed.resolve)
      response.once("close", () => { closed = true })
    })
    client.end()
    await bounded(firstChunk.promise)
    await new Promise<void>((resolve) => setTimeout(resolve, 5_250))
    assert.equal(closed, false, "established SSE survives silence longer than the connection deadline")
    peer.end("data: after-idle\n\n")
    await bounded(completed.promise)
    assert.equal(body, "data: first\n\ndata: after-idle\n\n")
  } finally { await app.close() }
})
