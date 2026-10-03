import assert from "node:assert/strict"
import test from "node:test"
import { buildApp } from "../src/app.js"
import { SeparateRequestAuthenticator } from "../src/auth.js"
import { ManagerRepository } from "../src/repository.js"
import { ManagerService } from "../src/service.js"
import { WorkerRuntime } from "../src/worker/runtime.js"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

test("public Worker manual start/resume uses fresh scope without retiring unknown history", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "omw-worker-scope-"))
  const repository = new ManagerRepository(path.join(directory, "manager.sqlite"))
  let epoch = "epoch-one"
  let current: string | null = null
  let offline = false
  let scopeOffline = false
  let loseStart = false
  let orphan = false
  let starts = 0
  const runtime = new WorkerRuntime({ controlOrigin: "http://execution:4175", token: "fixture", nativeOrigin: "http://localhost:4180", fetch: async (url, init) => {
    if (offline) throw new Error("network lost")
    const pathname = new URL(String(url)).pathname
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    if (pathname === "/v1/directories/resolve") return Response.json({ directory })
    if (pathname === "/v1/execution") {
      if (scopeOffline) throw new Error("fixture control endpoint unavailable")
      return Response.json({ epoch, capacity: current || orphan ? "occupied" : "available" })
    }
    if (pathname === "/v1/start") {
      if (body.epoch !== epoch || current || orphan) return Response.json({}, { status: 409 })
      current = body.instanceId; starts++
      if (loseStart) { offline = true; throw new Error("response lost") }
      return Response.json({ instanceId: current, pid: 12, directory, executable: "/bin/opencode", creationTimeUtc: new Date().toISOString(), creationTimeTicks: epoch, endpoint: "http://localhost:4096" })
    }
    if (pathname === "/v1/inspect") return Response.json(body.epoch !== epoch
      ? { processState: "unknown", running: false, matched: false, portOwnerMatched: false, portOwnedByOther: false }
      : { processState: current === body.instanceId ? "running" : "not-found", running: current === body.instanceId, matched: current === body.instanceId, portOwnerMatched: current === body.instanceId, portOwnedByOther: false })
    if (pathname === "/v1/stop") {
      if (body.epoch !== epoch || body.instanceId !== current) return Response.json({}, { status: 409 })
      current = null; return Response.json({ stopped: true, reason: null })
    }
    if (pathname.endsWith("/global/health")) return Response.json({ healthy: true, version: "fixture" })
    if (pathname.endsWith("/path")) return Response.json({ directory })
    if (pathname.endsWith("/session/status")) return Response.json({})
    if (pathname.endsWith("/session")) return Response.json([{ id: "ses_primary", title: "Existing", directory, time: { created: 1, updated: 2 } }])
    if (pathname.endsWith("/event")) return new Response(null, { status: 503 })
    assert.equal(init?.method === "POST", false, "must not create Session or send prompt")
    return Response.json([])
  } })
  const service = new ManagerService(repository, runtime, { min: 4096, max: 4096 })
  const app = buildApp({ service, authority: { hostname: "127.0.0.1", port: 4174 }, allowedOrigins: new Set(["http://127.0.0.1:4174"]), worker: { nativeOrigin: "http://localhost:4180" }, authenticator: new SeparateRequestAuthenticator({ manager: { username: "fixture", password: "fixture-only-password" }, launcherToken: "unused" }) })
  const headers = { host: "127.0.0.1:4174", authorization: `Basic ${Buffer.from("fixture:fixture-only-password").toString("base64")}`, origin: "http://127.0.0.1:4174", "x-omw-csrf": "1" }
  const start = () => app.inject({ method: "POST", url: "/api/v1/instances", headers, payload: { directory } })
  const capacity = async () => (await app.inject({ url: "/api/v1/worker/capacity", headers })).json()
  try {
    assert.deepEqual(await capacity(), { state: "available", maxInstances: 1 })
    const first = await start(); assert.equal(first.statusCode, 201, first.body)
    const oldId = first.json().id
    await service.selectPrimarySession(oldId, "ses_primary")
    const allocationsBeforeOffline = repository.allocationScopes()
    offline = true
    assert.deepEqual(await capacity(), { state: "unknown", maxInstances: 1 })
    const offlineStart = await start()
    assert.equal(offlineStart.statusCode, 409, offlineStart.body)
    assert.equal(offlineStart.json().error.code, "WORKER_CAPACITY_UNAVAILABLE")
    assert.deepEqual(repository.allocationScopes(), allocationsBeforeOffline, "unknown authority 不可寫入新 allocation")
    assert.equal(starts, 1, "execution offline 不可嘗試 launch")
    offline = false
    scopeOffline = true
    const scopeLostStart = await start()
    assert.equal(scopeLostStart.statusCode, 409, scopeLostStart.body)
    assert.equal(scopeLostStart.json().error.code, "WORKER_CAPACITY_UNAVAILABLE")
    assert.doesNotMatch(scopeLostStart.body, /fixture control endpoint/)
    assert.deepEqual(repository.allocationScopes(), allocationsBeforeOffline, "目錄解析後 scope 斷線也不可配置")
    assert.equal(starts, 1)
    scopeOffline = false
    epoch = "epoch-two"; current = null
    await service.reconcile()
    assert.equal(repository.getInstance(oldId)?.state, "unreachable")
    assert.deepEqual(await capacity(), { state: "available", maxInstances: 1 })
    const resumed = await app.inject({ method: "POST", url: `/api/v1/instances/${oldId}/resume`, headers })
    assert.equal(resumed.statusCode, 200, resumed.body)
    assert.equal(repository.getPrimarySession(resumed.json().id)?.sessionId, "ses_primary")
    assert.equal(repository.getInstance(oldId)?.creationTimeTicks, "epoch-one")
    assert.equal(repository.getInstance(oldId)?.state, "unreachable")
    assert.equal((await app.inject({ method: "POST", url: `/api/v1/instances/${oldId}/stop`, headers })).statusCode, 409)
    assert.equal((await start()).statusCode, 409)
    assert.equal(starts, 2)
    epoch = "epoch-three"; current = null
    const concurrent = await Promise.all([start(), start()])
    assert.deepEqual(concurrent.map((r) => r.statusCode).sort(), [201, 409])
    epoch = "epoch-four"; current = null; loseStart = true
    assert.notEqual((await start()).statusCode, 201)
    assert.deepEqual(await capacity(), { state: "unknown", maxInstances: 1 })
    offline = false; current = null; loseStart = false
    assert.deepEqual(await capacity(), { state: "unknown", maxInstances: 1 })
    assert.equal((await start()).statusCode, 409, "same epoch unresolved allocation stays reserved")
    const reopened = new ManagerRepository(path.join(directory, "manager.sqlite"))
    const restarted = new ManagerService(reopened, runtime, { min: 4096, max: 4096 })
    try {
      assert.deepEqual(await restarted.workerCapacity(), { state: "unknown", maxInstances: 1 })
      await assert.rejects(restarted.start(directory, false), { code: "WORKER_CAPACITY_UNAVAILABLE" })
    } finally { await restarted.shutdown(); reopened.close() }
    epoch = "epoch-five"; orphan = true
    assert.equal((await start()).statusCode, 409)
    orphan = false
    assert.equal((await start()).statusCode, 201)
  } finally { await app.close(); await service.shutdown(); repository.close(); await rm(directory, { recursive: true, force: true }) }
})

test("Worker API authenticates all reads, reports unsupported desktop capabilities and rejects their mutations", async () => {
  const repository = new ManagerRepository(":memory:")
  const service = new ManagerService(repository, new WorkerRuntime({ controlOrigin: "http://execution:4175", token: "fixture", nativeOrigin: "http://127.0.0.1:4180" }), { min: 4096, max: 4096 })
  const app = buildApp({ service, authority: { hostname: "127.0.0.1", port: 4174 }, allowedOrigins: new Set(["http://127.0.0.1:4174"]),
    worker: { nativeOrigin: "http://127.0.0.1:4180" }, authenticator: new SeparateRequestAuthenticator({ manager: { username: "fixture", password: "fixture-only-password" }, launcherToken: "unused" }) })
  const headers = { host: "127.0.0.1:4174", authorization: `Basic ${Buffer.from("fixture:fixture-only-password").toString("base64")}`, origin: "http://127.0.0.1:4174", "x-omw-csrf": "1" }
  try {
    assert.equal((await app.inject({ url: "/api/v1/connectivity", headers: { host: headers.host } })).statusCode, 401)
    const info = (await app.inject({ url: "/api/v1/connectivity", headers })).json()
    assert.equal(info.mode, "worker")
    assert.deepEqual(info.capabilities, { launcher: false, tailscale: false, credentialUpdate: false, managerShutdown: false, maxInstances: 1, nativeWeb: true })
    for (const url of ["/api/v1/manager/shutdown", "/api/v1/connectivity/enable", "/api/v1/connectivity/register", "/api/v1/launcher/reservations"]) {
      const result = await app.inject({ method: "POST", url, headers, payload: {} })
      assert.equal(result.statusCode, 409, url)
      assert.equal(result.json().error.code, "WORKER_UNSUPPORTED")
    }
    assert.equal((await app.inject({ method: "PATCH", url: "/api/v1/settings/credentials", headers, payload: {} })).statusCode, 409)
  } finally { await app.close(); await service.shutdown(); repository.close() }
})
