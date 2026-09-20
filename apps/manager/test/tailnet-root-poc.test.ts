import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { createServer as createHttpServer, type Server as HttpServer } from "node:http"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { prepareIsolatedEnvironment } from "../src/isolation.js"
import type { InstanceRecord } from "../src/repository.js"
import { OpenCodeRuntime, type LaunchResult } from "../src/runtime.js"

const enabled = process.env.OMW_REAL_OPENCODE_TEST === "1"

test("two root-per-port mappings do not cross routes or Basic credentials", async () => {
  const firstBackend = createCredentialBackend("first-user", "first-test-password", "instance-first")
  const secondBackend = createCredentialBackend("second-user", "second-test-password", "instance-second")
  const firstPort = await listenHttp(firstBackend)
  const secondPort = await listenHttp(secondBackend)
  let firstProxy: LoopbackProxy | null = null
  let secondProxy: LoopbackProxy | null = null
  try {
    firstProxy = await startLoopbackProxy(firstPort)
    secondProxy = await startLoopbackProxy(secondPort)
    assert.equal(await identifiedFetch(firstProxy.port, "first-user", "first-test-password"), "instance-first")
    assert.equal(await identifiedStatus(firstProxy.port, "second-user", "second-test-password"), 401)
    assert.equal(await identifiedFetch(secondProxy.port, "second-user", "second-test-password"), "instance-second")
    assert.equal(await identifiedStatus(secondProxy.port, "first-user", "first-test-password"), 401)
  } finally {
    await firstProxy?.close()
    await secondProxy?.close()
    await closeHttp(firstBackend)
    await closeHttp(secondBackend)
  }
})

test("root-per-port proxy preserves unauthenticated OpenCode HTTP, SSE, and PTY WebSocket surfaces", { skip: !enabled, timeout: 90_000 }, async () => {
  const executable = process.env.OMW_OPENCODE_EXECUTABLE
  assert.ok(executable, "OMW_OPENCODE_EXECUTABLE is required")
  const sandbox = path.join(tmpdir(), `omw-tailnet-poc-${randomUUID()}`)
  const project = path.join(sandbox, "project")
  const config = path.join(sandbox, "config")
  const data = path.join(sandbox, "data")
  await Promise.all([mkdir(project, { recursive: true }), mkdir(config, { recursive: true }), mkdir(data, { recursive: true })])
  const configFile = path.join(config, "opencode.json")
  await writeFile(configFile, "{\"plugin\":[]}\n", "utf8")
  const isolation = await prepareIsolatedEnvironment({ mode: "test", root: sandbox, configFile, sourceEnvironment: process.env })

  const runtime = new OpenCodeRuntime({
    executable,
    dataDirectory: data,
    environment: isolation.environment,
  })
  const instanceId = randomUUID()
  const upstreamPort = await freePort()
  let launch: LaunchResult | null = null
  let proxy: LoopbackProxy | null = null
  let ptyId: string | null = null

  try {
    launch = await runtime.launch(project, upstreamPort, instanceId)
    await runtime.readiness(launch)
    proxy = await startLoopbackProxy(upstreamPort)
    const origin = `http://127.0.0.1:${proxy.port}`
    const health = await fetch(`${origin}/global/health`, { redirect: "error" })
    assert.equal(health.status, 200)

    const root = await fetch(`${origin}/`, { redirect: "error" })
    assert.equal(root.status, 200)
    const html = await root.text()
    assert.match(html, /<html/i)
    const assetPath = firstAssetPath(html)
    const asset = await fetch(new URL(assetPath, origin), { redirect: "error" })
    assert.equal(asset.status, 200)

    const api = await fetch(`${origin}/path`, { redirect: "error" })
    assert.equal(api.status, 200)
    assert.equal(path.resolve((await api.json() as { directory: string }).directory).toLowerCase(), path.resolve(project).toLowerCase())

    const deepLink = new URL(runtime.openUrl(asRecord(launch, upstreamPort))).pathname
    const deepResponse = await fetch(`${origin}${deepLink}`, { redirect: "error" })
    assert.equal(deepResponse.status, 200)
    assert.match(await deepResponse.text(), /<html/i)

    const sse = await fetch(`${origin}/global/event`, { signal: AbortSignal.timeout(5_000) })
    assert.equal(sse.status, 200)
    assert.match(sse.headers.get("content-type") ?? "", /text\/event-stream/i)
    assert.match(await readSseEvent(sse), /^data:/m)

    const created = await fetch(`${origin}/pty?directory=${encodeURIComponent(project)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        command: process.execPath,
        args: ["-e", "process.stdin.on('data', data => process.stdout.write('echo:' + data)); setTimeout(() => process.exit(0), 15000)"],
        title: "omw-safe-echo",
      }),
    })
    if (created.status !== 200) assert.fail(`PTY create returned HTTP ${created.status}: ${await created.text()}`)
    ptyId = (await created.json() as { id: string }).id

    const tokenResponse = await fetch(`${origin}/pty/${encodeURIComponent(ptyId)}/connect-token?directory=${encodeURIComponent(project)}`, {
      method: "POST",
      headers: { "x-opencode-ticket": "1" },
    })
    if (tokenResponse.status !== 200) assert.fail(`PTY connect-token returned HTTP ${tokenResponse.status}: ${await tokenResponse.text()}`)
    const ticket = (await tokenResponse.json() as { ticket: string }).ticket
    const socketUrl = `ws://127.0.0.1:${proxy.port}/pty/${encodeURIComponent(ptyId)}/connect?directory=${encodeURIComponent(project)}&cursor=-1&ticket=${encodeURIComponent(ticket)}`
    const socket = new WebSocket(socketUrl)
    try {
      await websocketOpen(socket)
      socket.send("proxy-round-trip\n")
      assert.match(await websocketUntil(socket, "proxy-round-trip", 5_000), /proxy-round-trip/)
    } finally {
      socket.close()
    }
  } finally {
    if (ptyId && proxy) {
      await fetch(`http://127.0.0.1:${proxy.port}/pty/${encodeURIComponent(ptyId)}?directory=${encodeURIComponent(project)}`, {
        method: "DELETE",
      }).catch(() => undefined)
    }
    await proxy?.close()
    if (launch) {
      const stopped = await runtime.stop(asRecord(launch, upstreamPort))
      assert.deepEqual(stopped, { stopped: true, reason: null })
      assert.equal(await portReachable(upstreamPort), false)
    }
    else await runtime.cleanupLaunch(instanceId).catch(() => undefined)
    await rm(sandbox, { recursive: true, force: true })
  }
})

interface LoopbackProxy { port: number; close(): Promise<void> }

function createCredentialBackend(username: string, password: string, identity: string): HttpServer {
  const expected = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
  return createHttpServer((request, response) => {
    if (request.headers.authorization !== expected) {
      response.writeHead(401, { "www-authenticate": 'Basic realm="OpenCode"' })
      return response.end()
    }
    response.writeHead(200, { "content-type": "text/plain" })
    return response.end(identity)
  })
}

async function identifiedFetch(port: number, username: string, password: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    headers: { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` },
  })
  assert.equal(response.status, 200)
  return await response.text()
}

async function identifiedStatus(port: number, username: string, password: string): Promise<number> {
  return (await fetch(`http://127.0.0.1:${port}/`, {
    headers: { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` },
  })).status
}

async function startLoopbackProxy(upstreamPort: number): Promise<LoopbackProxy> {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((client) => {
    const upstream = net.createConnection({ host: "127.0.0.1", port: upstreamPort })
    sockets.add(client)
    sockets.add(upstream)
    const remove = (socket: net.Socket) => { sockets.delete(socket) }
    client.once("close", () => remove(client))
    upstream.once("close", () => remove(upstream))
    client.on("error", () => upstream.destroy())
    upstream.on("error", () => client.destroy())
    client.pipe(upstream)
    upstream.pipe(client)
  })
  const port = await listen(server)
  return {
    port,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
}

function firstAssetPath(html: string): string {
  const match = /<(?:script|link)[^>]+(?:src|href)="([^"]+)"/i.exec(html)
  assert.ok(match?.[1], "OpenCode root HTML must reference at least one asset")
  return match[1]
}

function websocketOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true })
    socket.addEventListener("error", () => reject(new Error("PTY WebSocket upgrade failed")), { once: true })
  })
}

async function readSseEvent(response: Response): Promise<string> {
  assert.ok(response.body)
  const reader = response.body.getReader()
  let text = ""
  try {
    while (!/\r?\n\r?\n/.test(text)) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += new TextDecoder().decode(chunk.value, { stream: true })
    }
    return text
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

function websocketUntil(socket: WebSocket, expected: string, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let seen = ""
    const finish = (error?: Error) => {
      clearTimeout(timer)
      socket.removeEventListener("message", onMessage)
      if (error) reject(error)
      else resolve(seen)
    }
    const onMessage = (event: MessageEvent) => {
      void messageText(event.data).then((text) => {
        seen += text
        if (seen.includes(expected)) finish()
      }, (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))))
    }
    const timer = setTimeout(() => finish(new Error(`PTY WebSocket produced no echo within ${timeout} ms; observed ${JSON.stringify(seen.slice(-500))}`)), timeout)
    socket.addEventListener("message", onMessage)
  })
}

async function messageText(value: unknown): Promise<string> {
  if (typeof value === "string") return value
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString("utf8")
  if (value instanceof Blob) return Buffer.from(await value.arrayBuffer()).toString("utf8")
  throw new Error("PTY WebSocket returned an unsupported message type")
}

function asRecord(launch: LaunchResult, port: number): InstanceRecord {
  return {
    id: launch.instanceId,
    projectName: path.basename(launch.directory),
    projectDirectory: launch.directory,
    state: "ready",
    endpoint: launch.endpoint,
    port,
    pid: launch.pid,
    creationTimeUtc: launch.creationTimeUtc,
    creationTimeTicks: launch.creationTimeTicks,
    executable: launch.executable,
    launchedAt: new Date().toISOString(),
    healthVersion: null,
    stoppedAt: null,
    error: null,
    stderrSummary: null,
  }
}

function freePort(): Promise<number> {
  const server = net.createServer()
  return listen(server).then((port) => new Promise<number>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve(port))
  }))
}

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      resolve(typeof address === "object" && address ? address.port : 0)
    })
  })
}

function listenHttp(server: HttpServer): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      resolve(typeof address === "object" && address ? address.port : 0)
    })
  })
}

function closeHttp(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

function portReachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port })
    const finish = (value: boolean) => { socket.destroy(); resolve(value) }
    socket.setTimeout(300)
    socket.once("connect", () => finish(true))
    socket.once("timeout", () => finish(false))
    socket.once("error", () => finish(false))
  })
}
