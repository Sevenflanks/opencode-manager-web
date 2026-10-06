import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildExecutionApp } from "../src/worker/supervisor.js"
import { localDirectories } from "../src/directory.js"
import { WorkerRuntime } from "../src/worker/runtime.js"
import { ManagerRepository } from "../src/repository.js"
import { ManagerService } from "../src/service.js"

for (const window of ["directory", "epoch"] as const) {
for (const retry of [false, true]) {
test(`cleanup fences an undispatched launch waiting for ${window}; preaccept retry=${retry}`, async () => {
  let arrived!: () => void, resume!: () => void
  const waiting = new Promise<void>(resolve => { arrived = resolve })
  const release = new Promise<void>(resolve => { resume = resolve })
  let starts = 0, stops = 0, waits = 0
  const runtime = new WorkerRuntime({ controlOrigin: "http://execution.fixture", token: "synthetic-token", nativeOrigin: "http://native.fixture", fetch: async (url, init) => {
    const pathname = new URL(String(url)).pathname
    if (pathname === (window === "directory" ? "/v1/directories/resolve-start" : "/v1/execution") && ++waits === 1) { arrived(); await release }
    if (pathname === "/v1/directories/resolve-start") return Response.json({ directory: "/workspace" })
    if (pathname === "/v1/execution") return Response.json({ epoch: "fixture-epoch", capacity: "available" })
    if (pathname === "/v1/start") {
      starts++
      const { epoch, instanceId } = JSON.parse(String(init?.body))
      return Response.json({ error: { code: "DIRECTORY_NOT_ACCESSIBLE" }, startRejected: { epoch, instanceId, accepted: false } }, { status: 400 })
    }
    if (pathname === "/v1/stop") stops++
    return Response.json({}, { status: 409 })
  } })
  const launch = runtime.launch("/workspace", 4096, "same-id")
  const rejected = assert.rejects(launch, { code: "EXECUTION_REJECTED" })
  try {
    await waiting
    if (retry) await assert.rejects(runtime.launch("/workspace", 4096, "same-id"), { code: "EXECUTION_REJECTED" })
    assert.equal((await runtime.cleanupLaunch("same-id")).stopped, true)
    if (retry) {
      await assert.rejects(runtime.launch("/workspace", 4096, "same-id"), { code: "EXECUTION_REJECTED" })
      assert.equal((await runtime.cleanupLaunch("same-id")).stopped, true, "confirmed preaccept retry need not become unknown")
    }
  } finally { resume() }
  await rejected
  assert.equal(starts, retry ? 2 : 0, "cleanup-confirmed preflight must never dispatch later")
  assert.equal(stops, 0, "undispatched cleanup does not grant Stop authority")
})
}
}

test("Manager releases a reservation when runtime directory preflight fails before dispatch", async () => {
  const disk = await mkdtemp(path.join(tmpdir(), "omw-start-outcome-"))
  const project = path.join(disk, "project")
  await mkdir(project)
  const token = "synthetic-workspace-control-32-characters"
  const execution = buildExecutionApp({ token, executable: process.execPath, runtimePort: 4096 }, localDirectories, disk)
  const repository = new ManagerRepository(":memory:")
  let resolves = 0, starts = 0, stops = 0
  const runtime = new WorkerRuntime({ controlOrigin: "http://execution.fixture", token, nativeOrigin: "http://native.fixture", fetch: async (url, init) => {
    const request = new URL(String(url))
    if (request.pathname === "/v1/execution") return Response.json({ epoch: "fixture-epoch", capacity: "available" })
    if (request.pathname === "/v1/start") {
      starts++
      const body = JSON.parse(String(init?.body))
      return Response.json({ pid: 12, instanceId: body.instanceId, directory: project, executable: "/bin/opencode",
        creationTimeUtc: new Date().toISOString(), creationTimeTicks: body.epoch, endpoint: "http://localhost:4096" })
    }
    if (request.pathname === "/v1/stop") { stops++; return Response.json({}, { status: 409 }) }
    if (request.pathname === "/v1/inspect") return Response.json({ running: true, matched: true, portOwnerMatched: true, portOwnedByOther: false })
    if (request.pathname.endsWith("/global/health")) return Response.json({ healthy: true, version: "fixture" })
    if (request.pathname.endsWith("/path")) return Response.json({ directory: project })
    if (request.pathname.endsWith("/session/status")) return Response.json({})
    if (request.pathname.endsWith("/session")) return Response.json([])
    if (request.pathname === "/v1/directories/resolve-start" && ++resolves === 2) await rm(project, { recursive: true })
    const response = await execution.inject({ url: request.pathname + request.search, headers: Object.fromEntries(new Headers(init?.headers)) })
    return new Response(response.body, { status: response.statusCode })
  } })
  const service = new ManagerService(repository, runtime, { min: 4096, max: 4096 })
  try {
    await assert.rejects(service.start(project, false), { code: "DIRECTORY_NOT_ACCESSIBLE" })
    assert.equal(starts, 0)
    assert.equal(stops, 0, "no undispatched attempt may send Stop")
    assert.deepEqual(repository.allocationScopes(), [], "definitely undispatched Start releases only its reservation")
    assert.deepEqual(await service.workerCapacity(), { state: "available", maxInstances: 1 })
    await mkdir(project)
    assert.equal((await service.start(project, false)).state, "ready")
    assert.equal(starts, 1)
  } finally { await service.shutdown(); repository.close(); await execution.close(); await rm(disk, { recursive: true, force: true }) }
})

test("Manager releases a reservation only for the authenticated same-attempt supervisor preaccept acknowledgment", async () => {
  const disk = await mkdtemp(path.join(tmpdir(), "omw-start-remote-outcome-"))
  const project = path.join(disk, "project")
  await mkdir(project)
  const token = "synthetic-workspace-control-32-characters"
  const execution = buildExecutionApp({ token, executable: process.execPath, runtimePort: 4096 }, localDirectories, disk)
  const repository = new ManagerRepository(":memory:")
  let starts = 0, stops = 0
  let repaired = false
  let rejection: { error: { code: string }; startRejected?: { epoch: string; instanceId: string; accepted: boolean } } | undefined
  let attempt: { epoch: string; instanceId: string } | undefined
  const runtime = new WorkerRuntime({ controlOrigin: "http://execution.fixture", token, nativeOrigin: "http://native.fixture", fetch: async (url, init) => {
    const request = new URL(String(url))
    if (request.pathname === "/v1/start") {
      starts++
      attempt = JSON.parse(String(init?.body))
      if (repaired) return Response.json({ pid: 12, ...attempt, directory: project, executable: "/bin/opencode",
        creationTimeUtc: new Date().toISOString(), creationTimeTicks: attempt!.epoch, endpoint: "http://localhost:4096" })
      await rm(project, { recursive: true })
    }
    if (request.pathname === "/v1/stop") stops++
    if (request.pathname === "/v1/inspect") return Response.json({ running: true, matched: true, portOwnerMatched: true, portOwnedByOther: false })
    if (request.pathname.endsWith("/global/health")) return Response.json({ healthy: true, version: "fixture" })
    if (request.pathname.endsWith("/path")) return Response.json({ directory: project })
    if (request.pathname.endsWith("/session/status")) return Response.json({})
    if (request.pathname.endsWith("/session")) return Response.json([])
    const response = await execution.inject({ url: request.pathname + request.search, headers: Object.fromEntries(new Headers(init?.headers)),
      ...(init?.method === "POST" ? { method: "POST", payload: String(init.body) } : {}) })
    if (request.pathname === "/v1/start") { assert.equal(response.statusCode, 400); rejection = response.json() }
    // Windows fixture 沒有 namespace owner；只替換 capacity，epoch 與 rejection body 來自真正 authenticated HTTP。
    if (request.pathname === "/v1/execution") return Response.json({ ...response.json(), capacity: "available" })
    return new Response(response.body, { status: response.statusCode })
  } })
  const service = new ManagerService(repository, runtime, { min: 4096, max: 4096 })
  try {
    await assert.rejects(service.start(project, false), { code: "EXECUTION_REJECTED" })
    assert.equal(starts, 1)
    assert.deepEqual(repository.allocationScopes(), [], "authenticated preaccept rejection releases only its reservation")
    assert.equal(stops, 0, "preaccept acknowledgment does not require or grant Stop")
    assert.deepEqual(rejection?.startRejected, { epoch: attempt?.epoch, instanceId: attempt?.instanceId, accepted: false })
    assert.equal(rejection?.error.code, "DIRECTORY_NOT_ACCESSIBLE")
    assert.ok(attempt)
    assert.equal((await execution.inject({ method: "POST", url: "/v1/stop", headers: { authorization: `Bearer ${token}` }, payload: attempt })).statusCode, 409)
    assert.deepEqual(await service.workerCapacity(), { state: "available", maxInstances: 1 })
    await mkdir(project)
    repaired = true
    assert.equal((await service.start(project, false)).state, "ready")
    assert.equal(starts, 2)
  } finally { await service.shutdown(); repository.close(); await execution.close(); await rm(disk, { recursive: true, force: true }) }
})

for (const mode of ["lost-response", "missing-ack", "wrong-epoch", "wrong-id", "accepted-ack", "invalid-token", "epoch-mismatch", "concurrent-resend", "older-preflight", "partial-body"] as const) {
test(`Manager retains unknown reservation after ${mode}; available does not prove this attempt stopped`, async () => {
  const disk = await mkdtemp(path.join(tmpdir(), "omw-start-unknown-"))
  const project = path.join(disk, "project")
  await mkdir(project)
  const token = "synthetic-workspace-control-32-characters"
  const execution = buildExecutionApp({ token, executable: process.execPath, runtimePort: 4096 }, localDirectories, disk)
  const repository = new ManagerRepository(":memory:")
  let starts = 0, stops = 0, preflights = 0
  let firstRejected!: () => void, releaseFirst!: () => void
  const rejected = new Promise<void>(resolve => { firstRejected = resolve })
  const release = new Promise<void>(resolve => { releaseFirst = resolve })
  const runtime = new WorkerRuntime({ controlOrigin: "http://execution.fixture", token, nativeOrigin: "http://native.fixture", fetch: async (url, init) => {
    const request = new URL(String(url))
    const headers = Object.fromEntries(new Headers(init?.headers))
    let payload = init?.body ? JSON.parse(String(init.body)) : undefined
    if (request.pathname === "/v1/start") {
      starts++
      await rm(project, { recursive: true, force: true })
      if (mode === "invalid-token") headers.authorization = "Bearer wrong-token"
      if (mode === "epoch-mismatch") payload = { ...payload, epoch: "wrong-epoch" }
    }
    if (request.pathname === "/v1/stop") stops++
    const response = await execution.inject({ url: request.pathname + request.search, headers,
      ...(init?.method === "POST" ? { method: "POST", payload } : {}) })
    if (request.pathname === "/v1/directories/resolve-start" && ++preflights === 2 && mode === "older-preflight") {
      firstRejected()
      await release
    }
    if (request.pathname === "/v1/execution") return Response.json({ ...response.json(), capacity: "available" })
    if (request.pathname === "/v1/start" && starts === 1) {
      if (mode === "concurrent-resend") { firstRejected(); await release }
      if (mode === "lost-response" || mode === "older-preflight") throw new Error("synthetic response lost after dispatch")
      if (mode === "partial-body") return new Response('{"startRejected":', { status: response.statusCode })
      const body = response.json()
      if (mode === "missing-ack") delete body.startRejected
      // 由實際 authenticated preaccept response 變更 identity；client 不可接受錯誤／不完整證據。
      if (mode === "wrong-epoch") body.startRejected = { ...body.startRejected, epoch: "wrong-epoch" }
      if (mode === "wrong-id") body.startRejected = { ...body.startRejected, instanceId: "another-attempt" }
      if (mode === "accepted-ack") body.startRejected = { ...body.startRejected, accepted: true }
      return Response.json(body, { status: response.statusCode })
    }
    if (request.pathname === "/v1/start" && mode === "concurrent-resend") throw new Error("synthetic resend response lost")
    return new Response(response.body, { status: response.statusCode })
  } })
  const service = new ManagerService(repository, runtime, { min: 4096, max: 4096 })
  try {
    const start = service.start(project, false)
    if (mode === "concurrent-resend" || mode === "older-preflight") {
      await rejected
      const reserved = repository.allocationScopes()[0]!
      assert.ok(reserved.scope)
      await mkdir(project, { recursive: true })
      try { await assert.rejects(runtime.launch(project, 4096, reserved.id, reserved.scope), { code: "WORKER_CAPACITY_UNAVAILABLE" }) }
      finally { releaseFirst() }
    }
    await assert.rejects(start, { code: mode === "lost-response" ? "WORKER_CAPACITY_UNAVAILABLE" : "EXECUTION_REJECTED" })
    assert.equal(starts, mode === "concurrent-resend" || mode === "older-preflight" ? 2 : 1)
    assert.equal(stops, 1, "unknown dispatch still requires exact same-attempt cleanup")
    const reservations = repository.allocationScopes()
    assert.equal(reservations.length, 1)
    assert.deepEqual(await service.workerCapacity(), { state: "unknown", maxInstances: 1 })
    if (mode === "lost-response") {
      const failed = repository.listInstances()[0]!
      const scope = reservations[0]!.scope
      assert.ok(scope)
      await assert.rejects(runtime.launch(project, 4096, failed.id, scope), { code: "DIRECTORY_NOT_ACCESSIBLE" })
      assert.equal((await runtime.cleanupLaunch(failed.id)).stopped, false, "resend local preflight cannot erase previous dispatch")
      await mkdir(project)
      await assert.rejects(runtime.launch(project, 4096, failed.id, scope), { code: "EXECUTION_REJECTED" })
      assert.equal((await runtime.cleanupLaunch(failed.id)).stopped, false, "resend preaccept acknowledgment cannot erase previous dispatch")
      assert.equal(starts, 2)
    }
    await mkdir(project, { recursive: true })
    assert.equal((await runtime.allocationScope()).state, "available")
    await assert.rejects(service.start(project, false), { code: "WORKER_CAPACITY_UNAVAILABLE" })
    assert.deepEqual(repository.allocationScopes(), reservations)
  } finally { releaseFirst(); await service.shutdown(); repository.close(); await execution.close(); await rm(disk, { recursive: true, force: true }) }
})
}
