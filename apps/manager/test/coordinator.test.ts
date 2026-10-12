import assert from "node:assert/strict"
import test from "node:test"
import http from "node:http"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import type { Duplex } from "node:stream"
import { CoordinatorRegistry, type WorkerRegistration } from "../src/coordinator/registry.js"
import { buildCoordinatorApp } from "../src/coordinator/app.js"
import { deriveWorkerKey, workerProof } from "../src/coordinator/identity.js"
import { SeparateRequestAuthenticator } from "../src/auth.js"
import type { ManagedInstance } from "@omw/contracts"

const secret = "fixture-registration-master-not-live"
const origin = "https://manager.example.test"
const basic = `Basic ${Buffer.from("human:fixture-human-password").toString("base64")}`
const headers = { host: "manager.example.test", authorization: basic, origin, "x-omw-csrf": "1" }
const registration = (id = "one", generation = "uid-1", address = "127.118.1.2") => ({ id, generation, kind: "task" as const,
  address, nativeOrigin: `https://omw-job-${id}-code.example.test`, browser: { username: "worker", password: "fixture-worker-password" } })

// 此檔保留 127.118.1.x；registry regression 使用 127.118.2.x，避免 Node 跨檔平行 bind collision。
// 檔內 case 預設循序、finally 等待 owned listener close；同時存活的 Worker 用不同 alias，正式 ports 不變。
async function fakeWorker(address = "127.118.1.2", id = "one", observe?: (path: string, change: number) => void) {
  let generation = "uid-1"
  let health = "ok"
  let metadata = "ok"
  let starts = 0
  let seen: http.IncomingHttpHeaders = {}
  let instances: ManagedInstance[] = []
  let metadataGate: Promise<void> | undefined
  let metadataEntered: (() => void) | undefined
  let proofGate: Promise<void> | undefined
  let proofEntered: (() => void) | undefined
  const server = http.createServer((request, response) => {
    seen = request.headers
    const url = new URL(request.url!, "http://fixture")
    observe?.(url.pathname, 1)
    let observed = true
    const finish = () => { if (observed) { observed = false; observe?.(url.pathname, -1) } }
    response.once("finish", finish); response.once("close", finish)
    if (url.pathname === "/api/v1/worker/identity") {
      if (health === "offline") { response.writeHead(503).end(); return }
      if (health === "hang") { response.writeHead(200, { "content-type": "application/json" }); response.write('{"id":'); return }
      if (health === "redirect") { response.writeHead(302, { location: "http://127.0.0.1:1/secret" }).end(); return }
      const nonce = url.searchParams.get("nonce")!
      response.setHeader("content-type", "application/json")
      const body = JSON.stringify(health === "fake" ? { status: "ok" } : { id, generation, nonce,
        proof: workerProof(deriveWorkerKey(secret, health === "wrong" ? "other" : id), nonce, id, generation) })
      if (proofGate) { proofEntered?.(); void proofGate.then(() => response.end(body)) }
      else if (health === "slow") setTimeout(() => response.end(body), 20)
      else response.end(body)
    } else if (url.pathname === "/api/v1/overview") {
      if (metadata === "offline") { response.writeHead(503).end(); return }
      metadataEntered?.()
      const body = JSON.stringify({ shortcuts: [], instances })
      if (metadataGate) void metadataGate.then(() => response.end(body))
      else response.end(body)
    } else if (url.pathname === "/api/v1/worker/capacity") response.end(JSON.stringify({ state: "available", maxInstances: 5 }))
    else if (url.pathname === "/api/v1/instances" && request.method === "POST") {
      starts++; request.resume()
      if (metadata === "lost") return
      response.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ accepted: true, query: url.search }))
    } else response.writeHead(404).end()
  })
  server.requestTimeout = 1_000
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(4174, address, resolve) })
  const lifetime = setTimeout(() => { server.closeAllConnections(); server.close() }, 9_000)
  lifetime.unref()
  return { server, setGeneration(value: string) { generation = value }, setHealth(value: string) { health = value },
    setInstances(value: ManagedInstance[]) { instances = value }, blockMetadata(gate: Promise<void>, entered: () => void) { metadataGate = gate; metadataEntered = entered },
    blockProof(gate: Promise<void>, entered: () => void) { proofGate = gate; proofEntered = entered },
    setMetadata(value: string) { metadata = value }, get starts() { return starts }, get seen() { return seen },
    async close() { clearTimeout(lifetime); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) } }
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "omw-coordinator-"))
  const config = { publicOrigin: origin, nativeHostSuffix: "example.test", allowedCidrs: ["127.0.0.0/8"],
    registrationSecret: secret, dataDirectory: directory, healthTimeoutMs: 100, healthIntervalMs: 15_000, failureThreshold: 2 }
  const registry = await CoordinatorRegistry.open(config)
  const app = buildCoordinatorApp({ registry, publicOrigin: origin, port: 4174, mutationTimeoutMs: 100, proxyTimeoutMs: 100,
    authenticator: new SeparateRequestAuthenticator({ manager: { username: "human", password: "fixture-human-password" }, launcherToken: "unused" }) })
  const register = (payload: WorkerRegistration = registration(), key = deriveWorkerKey(secret, payload.id)) => app.inject({ method: "POST",
    url: "/api/v1/coordinator/register", headers: { host: headers.host, authorization: `Bearer ${key}` }, payload })
  return { directory, config, registry, app, register,
    async close() { await app.close(); await rm(directory, { recursive: true, force: true }) } }
}

test("worker key and proof match independently fixed HMAC bytes, not HTTP 200 identity", () => {
  assert.equal(deriveWorkerKey("key", "one"), "DPGpqHO9eZB07O9wmcY531hZ4MG-20DQplwD--y1Duo")
  assert.equal(workerProof("worker-key", "nonce", "one", "uid-1"), "1hx2xuz0RssZytVL8K7nOStDBeLqeM3fyRkYQ4V3BPY")
  assert.equal(deriveWorkerKey("synthetic-registration-secret-000001", "example-a"), "3xFLZb_ZURLNMuDgww-5cJIpQx6vxMgGwQZ59jWmsQU")
})

test("busy old-generation renewal cannot cancel a verified replacement admission; new generation renews after the reservation releases", { timeout: 10_000 }, async () => {
  const oldWorker = await fakeWorker()
  const newWorker = await fakeWorker("127.118.1.3")
  const f = await fixture()
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const began = new Promise<void>((resolve) => { entered = resolve })
  try {
    await f.register()
    newWorker.setGeneration("uid-2"); newWorker.blockProof(gate, entered)
    const replacement = f.register(registration("one", "uid-2", "127.118.1.3"))
    await began
    assert.equal((await f.register()).statusCode, 429, "same-ID admission is bounded, including an old Pod renewal")
    release()
    assert.equal((await replacement).statusCode, 200)
    assert.equal(f.registry.overview().workers[0]?.generation, "uid-2")
    assert.equal((await f.register()).statusCode, 409)
    assert.equal((await f.register(registration("one", "uid-2", "127.118.1.3"))).statusCode, 200)
  } finally { release(); await f.close(); await oldWorker.close(); await newWorker.close() }
})

test("bounded poll lanes isolate one unavailable Worker from seven healthy registrations and global overview", { timeout: 10_000 }, async () => {
  const f = await fixture()
  const workers: Awaited<ReturnType<typeof fakeWorker>>[] = []
  let proofs = 0
  let maximumProofs = 0
  const observe = (url: string, change: number) => {
    if (url !== "/api/v1/worker/identity") return
    proofs += change; maximumProofs = Math.max(maximumProofs, proofs)
  }
  try {
    for (let i = 0; i < 8; i++) workers.push(await fakeWorker(`127.118.1.${10 + i}`, `worker-${i}`, observe))
    await Promise.all(workers.map((worker, i) => {
      worker.setHealth("slow")
      return f.registry.register(registration(`worker-${i}`, "uid-1", `127.118.1.${10 + i}`), deriveWorkerKey(secret, `worker-${i}`))
    }))
    workers[0]!.setHealth("offline")
    await Promise.all(workers.map((_, i) => f.registry.check(`worker-${i}`, "uid-1")))
    await f.registry.check("worker-0", "uid-1")
    const overview = await f.app.inject({ url: "/api/v1/coordinator/overview", headers })
    assert.equal(overview.statusCode, 200)
    assert.equal(overview.json().workers.filter((w: { health: string }) => w.health === "online").length, 7)
    assert.equal(overview.json().workers[0].health, "offline")
    assert.ok(maximumProofs > 1 && maximumProofs <= 4, `proof lane maximum was ${maximumProofs}`)
    assert.equal((await f.app.inject({ url: "/", headers: { ...headers, host: "omw-job-worker-0-code.example.test" } })).statusCode, 503)
  } finally { await f.close(); await Promise.all(workers.map((worker) => worker.close())) }
})

test("native Upgrade authenticates exact active host/Origin, preserves bytes and aborts owned sockets on generation retirement", { timeout: 10_000 }, async () => {
  const worker = await fakeWorker()
  const f = await fixture()
  const sockets = new Set<Duplex>()
  let seen: http.IncomingHttpHeaders = {}
  let seenPath = ""
  const native = http.createServer()
  native.on("upgrade", (request, socket, head) => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.on("error", () => undefined)
    seen = request.headers; seenPath = request.url!
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    if (head.length) socket.write(head)
    socket.on("data", (bytes: Buffer) => socket.write(bytes))
  })
  await new Promise<void>((resolve) => native.listen(4180, "127.118.1.2", resolve))
  const lifetime = setTimeout(() => { for (const socket of sockets) socket.destroy(); native.close() }, 9_000); lifetime.unref()
  let client: Duplex | undefined
  try {
    await f.register(); await f.app.listen({ host: "127.0.0.1", port: 0 })
    const address = f.app.server.address() as { port: number }
    const h = { ...headers, host: "omw-job-one-code.example.test", origin: registration().nativeOrigin,
      connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" }
    client = await new Promise<Duplex>((resolve, reject) => {
      const request = http.request({ hostname: "127.0.0.1", port: address.port, path: "/root/socket?x=1", headers: h })
      request.on("upgrade", (_response, socket) => resolve(socket)); request.on("response", (response) => { response.resume(); reject(new Error(`unexpected ${response.statusCode}`)) })
      request.on("error", reject); request.end()
    })
    assert.equal(seenPath, "/root/socket?x=1"); assert.equal(seen.host, h.host); assert.equal(seen.origin, h.origin)
    assert.equal(seen.authorization, `Basic ${Buffer.from("worker:fixture-worker-password").toString("base64")}`)
    const echoed = new Promise<Buffer>((resolve) => client!.once("data", resolve))
    client.write("owned-bytes"); assert.equal((await echoed).toString(), "owned-bytes")
    const closed = new Promise<void>((resolve) => client!.once("close", resolve))
    worker.setGeneration("uid-2"); await f.register(registration("one", "uid-2"))
    await closed
    const rejected = await new Promise<number>((resolve, reject) => {
      const request = http.request({ hostname: "127.0.0.1", port: address.port, path: "/root/socket", headers: { ...h, origin } })
      request.once("response", (response) => { response.resume(); resolve(response.statusCode!) }); request.once("error", reject); request.end()
    })
    assert.equal(rejected, 403)
  } finally {
    client?.destroy(); clearTimeout(lifetime); await f.close(); for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => native.close(() => resolve())); await worker.close()
  }
})

const managedInstance: ManagedInstance = {
  id: "instance-one", kind: "headless", projectName: "fixture", projectDirectory: "/workspace", state: "ready",
  endpoint: "https://omw-job-one-code.example.test", port: 4096, pid: 12, launchedAt: "2026-10-12T00:00:00.000Z", healthVersion: "fixture",
  stopAllowed: true, remoteUrlUnavailableReason: null, error: null,
  summary: { activity: "busy", busySessions: 1, pendingQuestions: 0, pendingPermissions: 0, error: null },
  primarySummary: { scope: "known", activity: "busy", busySessions: 1, retrySessions: 0, pendingQuestions: 0, pendingPermissions: 0, error: null },
  sessions: [], primarySession: { sessionId: "session-one", title: "fixture", source: "activity", boundAt: "2026-10-12T00:00:00.000Z" }, trackingHidden: false,
  recovery: { recheckAllowed: true, resumeAllowed: false, hideAllowed: true, removeAllowed: false },
}

test("late metadata cannot resurrect old generation; offline resident retains stale instances without inventing task completion", { timeout: 10_000 }, async () => {
  const worker = await fakeWorker()
  const f = await fixture()
  try {
    await f.register({ ...registration(), kind: "resident" })
    worker.setInstances([managedInstance]); await f.registry.check("one", "uid-1")
    assert.equal(f.registry.overview().instances[0]?.instance.id, "instance-one")
    worker.setHealth("offline"); await f.registry.check("one", "uid-1"); await f.registry.check("one", "uid-1")
    assert.equal(f.registry.overview().workers[0]?.health, "offline")
    assert.equal(f.registry.overview().workers[0]?.endedAt, null)
    assert.equal(f.registry.overview().instances[0]?.freshness, "stale")
    worker.setHealth("ok")
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const began = new Promise<void>((resolve) => { entered = resolve })
    worker.blockMetadata(gate, entered)
    const old = f.registry.check("one", "uid-1")
    await began
    worker.setGeneration("uid-2")
    await f.register({ ...registration("one", "uid-2"), kind: "resident" })
    release(); await old
    assert.equal(f.registry.overview().workers[0]?.generation, "uid-2")
    assert.equal(f.registry.overview().workers[0]?.dataUpdatedAt, null)
    assert.deepEqual(f.registry.overview().instances, [])
  } finally { await f.close(); await worker.close() }
})

test("native flat-host HTTP preserves root path and Origin, safely redirects, streams without idle timeout and retires open streams", { timeout: 10_000 }, async () => {
  const worker = await fakeWorker()
  const f = await fixture()
  const native = http.createServer((request, response) => {
    if (request.url === "/redirect") { response.writeHead(302, { location: "/root?x=1" }).end(); return }
    if (request.url === "/private-redirect") { response.writeHead(302, { location: "http://127.118.1.2:4180/root?x=1" }).end(); return }
    if (request.url === "/error") { response.writeHead(401, { "www-authenticate": "fixture-private-password", "content-type": "application/json" }).end('{"password":"fixture-private-password","url":"http://127.118.1.2:4180"}'); return }
    if (request.url === "/event") { response.writeHead(200, { "content-type": "text/event-stream" }); response.write("data: ready\n\n"); return }
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ url: request.url, host: request.headers.host, origin: request.headers.origin, auth: request.headers.authorization, forwarded: request.headers["x-forwarded-user"] }))
  })
  const nativeOrigin = registration().nativeOrigin
  await new Promise<void>((resolve, reject) => { native.once("error", reject); native.listen(4180, "127.118.1.2", resolve) })
  const lifetime = setTimeout(() => { native.closeAllConnections(); native.close() }, 9_000); lifetime.unref()
  let events: http.IncomingMessage | undefined
  try {
    await f.register()
    const h = { ...headers, host: "omw-job-one-code.example.test", origin: nativeOrigin, "x-forwarded-user": "spoofed" }
    const root = await f.app.inject({ url: "/root?x=1", headers: h })
    assert.equal(root.statusCode, 200, root.body)
    assert.deepEqual(root.json(), { url: "/root?x=1", host: h.host, origin: nativeOrigin, auth: `Basic ${Buffer.from("worker:fixture-worker-password").toString("base64")}` })
    for (const url of ["/redirect", "/private-redirect"]) {
      const redirect = await f.app.inject({ url, headers: h })
      assert.equal(redirect.statusCode, 302, redirect.body)
      assert.equal(redirect.headers.location, `${nativeOrigin}/root?x=1`)
    }
    const error = await f.app.inject({ url: "/error", headers: h })
    assert.equal(error.statusCode, 401); assert.equal(error.headers["www-authenticate"], undefined)
    assert.doesNotMatch(error.body, /fixture-private-password|127\.118\.1\.2/)
    assert.equal((await f.app.inject({ url: "/root", headers: { ...h, origin } })).statusCode, 403)
    assert.equal((await f.app.inject({ method: "POST", url: "/root", headers: { host: h.host, authorization: basic }, payload: {} })).statusCode, 403)
    await f.app.listen({ host: "127.0.0.1", port: 0 })
    const address = f.app.server.address() as { port: number }
    events = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = http.get({ hostname: "127.0.0.1", port: address.port, path: "/event", headers: h }, resolve)
      request.once("error", reject)
    })
    await new Promise<void>((resolve) => events!.once("data", () => resolve()))
    await new Promise((resolve) => setTimeout(resolve, 160))
    assert.equal(events.destroyed, false, "idle SSE must survive non-stream deadline")
    const lost = new Promise<void>((resolve) => { events!.once("aborted", resolve); events!.once("close", resolve) })
    worker.setGeneration("uid-2"); await f.register(registration("one", "uid-2"))
    await lost
    assert.equal(events.complete, false, "retired generation must become unknown, not successful EOF or rerouted")
  } finally {
    events?.destroy(); clearTimeout(lifetime); await f.close(); native.closeAllConnections(); await new Promise<void>((resolve) => native.close(() => resolve())); await worker.close()
  }
})

test("dynamic registration rejects impersonation, SSRF, redirects and fake health; metadata absence does not block", { timeout: 10_000 }, async () => {
  const worker = await fakeWorker()
  const f = await fixture()
  try {
    assert.equal((await f.register(registration(), deriveWorkerKey(secret, "other"))).statusCode, 401)
    for (const address of ["10.1.2.3", "localhost", "127.1", "http://127.0.0.2", "2130706434"]) {
      assert.equal((await f.register(registration("one", "uid-1", address))).statusCode, 400, address)
    }
    for (const host of ["https://omw-job-one-code.evil.test", "https://omw-job-one.code.example.test", "https://OMW-JOB-one-code.example.test"]) {
      assert.equal((await f.register({ ...registration(), nativeOrigin: host })).statusCode, 400, host)
    }
    for (const failure of ["fake", "wrong", "redirect"]) {
      worker.setHealth(failure)
      assert.equal((await f.register()).statusCode, 503, failure)
      assert.equal(f.registry.overview().workers.length, 0)
    }
    worker.setHealth("hang")
    assert.equal((await f.register()).statusCode, 503, "partial identity body is bounded by the same probe deadline")
    assert.equal((await f.register({ ...registration(), ...{ managerPort: 1 } })).statusCode, 400)
    assert.equal((await f.app.inject({ method: "POST", url: "/api/v1/coordinator/register", headers: { host: headers.host, origin,
      authorization: `Bearer ${deriveWorkerKey(secret, "one")}` }, payload: registration() })).statusCode, 403)
    worker.setHealth("ok"); worker.setMetadata("offline")
    assert.equal((await f.register()).statusCode, 200)
    await f.registry.check("one", "uid-1")
    const w = f.registry.overview().workers[0]!
    assert.equal(w.health, "online"); assert.equal(w.instanceCount, null)
    assert.equal(w.capacity?.maxInstances, 5, "Coordinator must respect future resident capacity")
    assert.equal((await f.register(registration("one", "uid-1", "127.118.1.3"))).statusCode, 409, "same generation cannot move address")
    for (const host of ["omw-job-one-code.example.test:443", "OMW-JOB-one-code.example.test", "omw-job-one.x-code.example.test", "omw-job--code.example.test"]) {
      assert.equal((await f.app.inject({ url: "/", headers: { ...headers, host } })).statusCode, 404, host)
    }
    worker.setMetadata("ok")
    await f.registry.check("one", "uid-1")
    assert.equal(f.registry.overview().workers[0]!.instanceCount, 0)
    assert.doesNotMatch((await f.app.inject({ url: "/api/v1/coordinator/overview", headers })).body, /fixture-worker-password|fixture-registration-master/)
  } finally { await f.close(); await worker.close() }
})

test("renew cannot erase failure count, task offline means result unknown, restart and retired generations fence stale writes", { timeout: 10_000 }, async () => {
  const worker = await fakeWorker()
  const f = await fixture()
  try {
    assert.equal((await f.register()).statusCode, 200)
    worker.setHealth("offline"); await f.registry.check("one", "uid-1")
    worker.setHealth("ok"); assert.equal((await f.register()).statusCode, 200)
    assert.equal(f.registry.overview().workers[0]!.consecutiveFailures, 1)
    worker.setHealth("offline"); await f.registry.check("one", "uid-1")
    const offline = f.registry.overview().workers[0]!
    assert.equal(offline.health, "offline"); assert.ok(offline.endedAt); assert.equal(offline.diagnosticCode, "WORKER_RESULT_UNKNOWN")
    worker.setHealth("ok"); worker.setGeneration("uid-2")
    assert.equal((await f.register(registration("one", "uid-2"))).statusCode, 200)
    assert.equal((await f.register()).statusCode, 409)
    await assert.rejects(async () => f.registry.check("one", "uid-1"), { code: "WORKER_GENERATION_RETIRED" })
    const stored = await readFile(path.join(f.directory, "coordinator.json"), "utf8")
    assert.doesNotMatch(stored, /fixture-worker-password|fixture-registration-master|browser/)
    await f.registry.close()
    const restarted = await CoordinatorRegistry.open(f.config)
    try {
      await assert.rejects(restarted.register(registration(), deriveWorkerKey(secret, "one")), { code: "WORKER_GENERATION_RETIRED" })
      await restarted.register(registration("one", "uid-2"), deriveWorkerKey(secret, "one"))
      assert.equal(restarted.overview().workers[0]!.generation, "uid-2")
    } finally { await restarted.close() }
  } finally { await f.close(); await worker.close() }
})

test("scoped mutation forwards only Worker Basic and fixed authority once; timeout stays unknown; forbidden and retired targets reject", { timeout: 10_000 }, async () => {
  const worker = await fakeWorker()
  const f = await fixture()
  try {
    await f.register()
    const proxy = "/api/v1/coordinator/workers/one/uid-1/proxy/"
    const result = await f.app.inject({ method: "POST", url: `${proxy}api/v1/instances?q=keep`,
      headers: { ...headers, "x-forwarded-user": "attacker", "x-pomerium-jwt-assertion": "attacker" }, payload: { directory: "/workspace" } })
    assert.equal(result.statusCode, 201, result.body)
    assert.equal(result.json().query, "?q=keep")
    assert.equal(worker.seen.authorization, `Basic ${Buffer.from("worker:fixture-worker-password").toString("base64")}`)
    assert.equal(worker.seen.host, headers.host); assert.equal(worker.seen.origin, origin)
    assert.equal(worker.seen["x-forwarded-user"], undefined); assert.equal(worker.seen["x-pomerium-jwt-assertion"], undefined)
    for (const suffix of ["api/v1/launcher/reservations", "api/v1/settings/credentials", "api/v1/manager/shutdown", "api/v1/connectivity/enable", "api/v1/worker/identity"]) {
      assert.equal((await f.app.inject({ method: "POST", url: proxy + suffix, headers, payload: {} })).statusCode, 403)
    }
    assert.equal((await f.app.inject({ method: "POST", url: proxy + "api/v1/instances", headers: { ...headers, origin: "https://evil.test" }, payload: {} })).statusCode, 403)
    worker.setMetadata("lost")
    const lost = await f.app.inject({ method: "POST", url: proxy + "api/v1/instances", headers, payload: {} })
    assert.equal(lost.statusCode, 504); assert.equal(lost.json().error.code, "WORKER_OPERATION_UNKNOWN")
    assert.equal(worker.starts, 2, "lost mutation must never be retried")
    const info = (await f.app.inject({ url: "/api/v1/connectivity", headers })).json()
    assert.equal(info.mode, "coordinator"); assert.equal(info.capabilities.maxInstances, 0)
    assert.equal((await f.app.inject({ url: "/", headers: { ...headers, host: "omw-job-unknown-code.example.test" } })).statusCode, 404)
  } finally { await f.close(); await worker.close() }
})
