import assert from "node:assert/strict"
import test from "node:test"
import http from "node:http"
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { buildCoordinatorApp } from "../src/coordinator/app.js"
import { CoordinatorRegistry } from "../src/coordinator/registry.js"
import { deriveWorkerKey, workerProof } from "../src/coordinator/identity.js"
import { SeparateRequestAuthenticator } from "../src/auth.js"

const secret = "fixture-regression-master-secret-only"
const publicOrigin = "https://manager.example.test"
const headers = { host: "manager.example.test", authorization: `Basic ${Buffer.from("human:fixture-human-password").toString("base64")}`,
  origin: publicOrigin, "x-omw-csrf": "1" }
// 此檔保留 127.118.2.x；coordinator.test 使用 127.118.1.x，避免固定 port 的跨檔平行碰撞。
// case 預設循序並在 finally 等待 owned listener close；同時存在的舊／新 generation 與其他 Worker 分用 alias。
const payload = (id = "one", generation = "uid-1", address = "127.118.2.2") => ({ id, generation, address, kind: "resident",
  nativeOrigin: `https://omw-job-${id}-code.example.test`, browser: { username: "worker", password: "fixture-worker-password" } })
const instance = {
  id: "instance-one", kind: "headless", projectName: "fixture", projectDirectory: "/workspace", state: "ready",
  endpoint: "https://omw-job-one-code.example.test", port: 4096, pid: 12, launchedAt: "2026-10-12T00:00:00.000Z", healthVersion: "fixture",
  stopAllowed: true, remoteUrlUnavailableReason: null, error: null,
  summary: { activity: "busy", busySessions: 1, pendingQuestions: 0, pendingPermissions: 0, error: null },
  primarySummary: { scope: "known", activity: "busy", busySessions: 1, retrySessions: 0, pendingQuestions: 0, pendingPermissions: 0, error: null },
  sessions: [{ id: "session-one", title: "password token 正常 Session 文字", updatedAt: 123 }],
  primarySession: { sessionId: "session-one", title: "fixture", source: "activity", boundAt: "2026-10-12T00:00:00.000Z" }, trackingHidden: false,
  capabilities: { sessions: { state: "supported" }, nativeWeb: { state: "unavailable", reason: "not ready" } },
  recovery: { recheckAllowed: true, resumeAllowed: false, hideAllowed: true, removeAllowed: false },
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function worker(address: string) {
  let data: unknown[] = []
  let capacity: unknown = { state: "available", maxInstances: 5 }
  let proofGate: ReturnType<typeof deferred> | undefined
  let proofEntered: ReturnType<typeof deferred> | undefined
  const proofs: string[] = []
  const server = http.createServer((request, response) => {
    const url = new URL(request.url!, "http://fixture")
    response.setHeader("content-type", "application/json")
    if (url.pathname === "/api/v1/worker/identity") {
      const nonce = url.searchParams.get("nonce")!
      const configured = identities.get(address)!
      proofs.push(configured.id); proofEntered?.resolve()
      const answer = JSON.stringify({ ...configured, nonce, proof: workerProof(deriveWorkerKey(secret, configured.id), nonce, configured.id, configured.generation) })
      if (proofGate) void proofGate.promise.then(() => response.end(answer))
      else response.end(answer)
    } else if (url.pathname === "/api/v1/overview") response.end(JSON.stringify({ shortcuts: [], instances: data }))
    else if (url.pathname === "/api/v1/worker/capacity") response.end(JSON.stringify(capacity))
    else response.writeHead(404).end()
  })
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(4174, address, resolve) })
  const lifetime = setTimeout(() => { proofGate?.resolve(); server.closeAllConnections(); server.close() }, 9_000); lifetime.unref()
  return { proofs, setData(value: unknown[]) { data = value }, setCapacity(value: unknown) { capacity = value },
    blockProof() { proofGate = deferred(); proofEntered = deferred(); return { gate: proofGate, entered: proofEntered } },
    async close() { clearTimeout(lifetime); proofGate?.resolve(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) } }
}
const identities = new Map<string, { id: string; generation: string }>()

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "omw-regression-"))
  const config = { publicOrigin, nativeHostSuffix: "example.test", allowedCidrs: ["127.0.0.0/8"], registrationSecret: secret,
    dataDirectory: directory, healthTimeoutMs: 1_000, healthIntervalMs: 15_000, failureThreshold: 3 }
  const registry = await CoordinatorRegistry.open(config)
  const app = buildCoordinatorApp({ registry, publicOrigin, port: 4174,
    authenticator: new SeparateRequestAuthenticator({ manager: { username: "human", password: "fixture-human-password" }, launcherToken: "unused" }) })
  const register = (body = payload(), key = deriveWorkerKey(secret, body.id)) => app.inject({ method: "POST", url: "/api/v1/coordinator/register",
    headers: { host: headers.host, authorization: `Bearer ${key}` }, payload: body })
  const overview = async () => (await app.inject({ url: "/api/v1/coordinator/overview", headers })).json()
  const lookup = (id: string, generation: string) => app.inject({ url: `/api/v1/coordinator/workers/${id}/${generation}/proxy/api/v1/worker/capacity`, headers })
  return { directory, config, registry, app, register, overview, lookup,
    async close() { await app.close(); await rm(directory, { recursive: true, force: true }); identities.clear() } }
}

test("failed replacement durable write leaves exact old target healthy and retryable; restart sees record and fence together", { timeout: 10_000 }, async () => {
  identities.set("127.118.2.2", { id: "one", generation: "uid-1" }); identities.set("127.118.2.3", { id: "one", generation: "uid-2" })
  const old = await worker("127.118.2.2"); const next = await worker("127.118.2.3"); const f = await fixture()
  const file = path.join(f.directory, "coordinator.json")
  try {
    assert.equal((await f.register()).statusCode, 200)
    await rename(file, file + ".saved"); await mkdir(file)
    const failed = await f.register(payload("one", "uid-2", "127.118.2.3"))
    assert.equal((await f.lookup("one", "uid-1")).statusCode, 200, "failed commit must not retire the old live target")
    assert.equal((await f.overview()).workers[0].health, "online")
    assert.equal(failed.statusCode, 503); assert.equal(failed.json().error.code, "COORDINATOR_STORE_UNAVAILABLE")
    await rm(file, { recursive: true }); await rename(file + ".saved", file)
    assert.equal((await f.register(payload("one", "uid-2", "127.118.2.3"))).statusCode, 200)
    assert.equal((await f.lookup("one", "uid-1")).statusCode, 409)
    const reopened = await CoordinatorRegistry.open(f.config)
    try {
      assert.equal(reopened.overview().workers[0]?.generation, "uid-2")
      await assert.rejects(reopened.register(payload(), deriveWorkerKey(secret, "one")), { code: "WORKER_GENERATION_RETIRED" })
      await reopened.register(payload("one", "uid-2", "127.118.2.3"), deriveWorkerKey(secret, "one"))
    } finally { await reopened.close() }
  } finally { await f.close(); await old.close(); await next.close() }
})

test("metadata projects only public fields recursively and rejects incomplete refresh without losing stale snapshot", { timeout: 10_000 }, async () => {
  identities.set("127.118.2.2", { id: "one", generation: "uid-1" })
  const w = await worker("127.118.2.2"); const f = await fixture()
  try {
    await f.register()
    const injected = { password: "fixture-extra-secret", token: "fixture-extra-token" }
    w.setData([{ ...instance, browser: injected, token: injected.token, summary: { ...instance.summary, ...injected },
      primarySummary: { ...instance.primarySummary, ...injected }, primarySession: { ...instance.primarySession, ...injected },
      sessions: [{ ...instance.sessions[0], ...injected }], recovery: { ...instance.recovery, ...injected },
      capabilities: { sessions: { state: "supported", ...injected }, secret: injected } }])
    w.setCapacity({ state: "available", maxInstances: 5, ...injected })
    await f.registry.check("one", "uid-1")
    const projected = await f.overview()
    assert.doesNotMatch(JSON.stringify(projected), /fixture-extra-secret|fixture-extra-token|"browser"|"token"/)
    assert.equal(projected.instances[0].instance.sessions[0].title, "password token 正常 Session 文字")
    assert.deepEqual(projected.workers[0].capacity, { state: "available", maxInstances: 5 })
    const restarted = await CoordinatorRegistry.open(f.config)
    try { assert.doesNotMatch(JSON.stringify(restarted.overview()), /fixture-extra-secret|fixture-extra-token|"browser"|"token"/) }
    finally { await restarted.close() }
    for (const invalid of [{ id: "bad", state: "ready", summary: instance.summary, primarySummary: instance.primarySummary },
      { ...instance, stopAllowed: "yes" }, { ...instance, sessions: Array.from({ length: 1_001 }, () => instance.sessions[0]) }]) {
      w.setData([invalid]); await f.registry.check("one", "uid-1")
      const stale = await f.overview()
      assert.equal(stale.instances[0].instance.id, "instance-one"); assert.equal(stale.workers[0].freshness, "stale")
    }
  } finally { await f.close(); await w.close() }
})

test("same-ID renewal and replacement retry serialize while another Worker metadata survives the durable checkpoint", { timeout: 10_000 }, async () => {
  identities.set("127.118.2.2", { id: "one", generation: "uid-1" }); identities.set("127.118.2.3", { id: "one", generation: "uid-2" })
  identities.set("127.118.2.4", { id: "other", generation: "uid-1" })
  const old = await worker("127.118.2.2"); const next = await worker("127.118.2.3"); const other = await worker("127.118.2.4"); const f = await fixture()
  try {
    await f.register(); await f.register(payload("other", "uid-1", "127.118.2.4"))
    const renewGate = old.blockProof()
    const renew = f.register()
    await renewGate.entered.promise
    assert.equal((await f.register(payload("one", "uid-2", "127.118.2.3"))).statusCode, 429)
    assert.equal((await f.lookup("one", "uid-1")).statusCode, 200)
    renewGate.gate.resolve(); assert.equal((await renew).statusCode, 200)
    const newGate = next.blockProof()
    const replacement = f.register(payload("one", "uid-2", "127.118.2.3"))
    await newGate.entered.promise
    assert.equal((await f.register(payload("one", "bad-candidate", "127.118.2.5"))).statusCode, 429)
    assert.equal((await f.lookup("one", "uid-1")).statusCode, 200, "unverified candidate cannot revoke old lookup")
    other.setData([{ ...instance, id: "other-fresh", endpoint: "https://omw-job-other-code.example.test" }])
    const refreshed = f.registry.check("other", "uid-1")
    newGate.gate.resolve()
    assert.equal((await replacement).statusCode, 200); await refreshed
    const restart = await CoordinatorRegistry.open(f.config)
    try {
      const data = restart.overview()
      assert.equal(data.workers.find((w) => w.id === "one")?.generation, "uid-2")
      assert.equal(data.instances.find((i) => i.workerId === "other")?.instance.id, "other-fresh")
      await assert.rejects(restart.register(payload(), deriveWorkerKey(secret, "one")), { code: "WORKER_GENERATION_RETIRED" })
    } finally { await restart.close() }
  } finally { await f.close(); await old.close(); await next.close(); await other.close() }
})

test("oversized otherwise-valid durable store is rejected rather than silently restarting with an empty registry", async () => {
  const f = await fixture()
  try {
    await writeFile(path.join(f.directory, "coordinator.json"), '{"version":1,"records":[],"retired":[]}' + " ".repeat(8 * 1024 * 1024))
    await assert.rejects(CoordinatorRegistry.open(f.config), { message: "COORDINATOR_STORE_INVALID" })
  } finally { await f.close() }
})

test("pending admission is bounded per ID and globally without starving authenticated health checks", { timeout: 10_000 }, async () => {
  identities.set("127.118.2.2", { id: "one", generation: "uid-1" }); identities.set("127.118.2.3", { id: "resident", generation: "uid-1" })
  const stalled = await worker("127.118.2.2"); const healthy = await worker("127.118.2.3"); const f = await fixture()
  const pending: Array<Promise<unknown>> = []
  try {
    await f.register(payload("resident", "uid-1", "127.118.2.3"))
    const blocked = stalled.blockProof()
    pending.push(f.register())
    await blocked.entered.promise
    const duplicate = f.register()
    const quick = await Promise.race([duplicate, new Promise<undefined>((resolve) => setTimeout(resolve, 60))])
    pending.push(duplicate)
    assert.equal(quick?.statusCode, 429, "same ID pending registration must reject before joining the probe queue")
    assert.equal(quick?.json().error.code, "WORKER_REGISTRATION_BUSY")
    for (let i = 0; i < 63; i++) pending.push(f.register(payload(`pending-${i}`)))
    await new Promise((resolve) => setImmediate(resolve))
    const full = await f.register(payload("excess"))
    assert.equal(full.statusCode, 503); assert.equal(full.json().error.code, "WORKER_REGISTRATION_BUSY")
    assert.equal((await f.register(payload("unauthorized"), "wrong-key")).statusCode, 401)
    const checked = await f.app.inject({ method: "POST", url: "/api/v1/coordinator/workers/resident/uid-1/check", headers })
    assert.equal(checked.statusCode, 200, checked.body)
    assert.ok(healthy.proofs.length >= 2)
    blocked.gate.resolve(); await Promise.all(pending)
    assert.equal((await f.register()).statusCode, 200, "released per-ID reservation must allow renewal")
  } finally { await f.close(); await Promise.allSettled(pending); await stalled.close(); await healthy.close() }
})
