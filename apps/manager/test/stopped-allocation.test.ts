import assert from "node:assert/strict"
import test from "node:test"
import { createServer } from "node:net"
import { ManagerRepository } from "../src/repository.js"
import { ManagerService } from "../src/service.js"
import { WorkerRuntime } from "../src/worker/runtime.js"
import type { InspectResult } from "../src/runtime.js"

function stoppedFixture(state: "stopped" | "unreachable" = "stopped", port = 49998) {
  const repository = new ManagerRepository(":memory:")
  const record = { id: "stopped-one", projectName: "project", projectDirectory: "/workspace", state,
    endpoint: "http://execution:4175/runtime/epoch-one/stopped-one", port, pid: 12,
    creationTimeUtc: "2026-10-02T00:00:00.000Z", creationTimeTicks: "epoch-one", executable: "/usr/bin/opencode",
    launchedAt: "2026-10-02T00:00:00.000Z", stoppedAt: "2026-10-02T01:00:00.000Z", healthVersion: null, error: null, stderrSummary: null }
  repository.createInstance(record)
  const allocation = { id: "allocation-one", kind: "headless" as const, clientInvocationId: null, projectDirectory: "/workspace",
    port: record.port, createdAt: record.launchedAt, expiresAt: null, instanceId: record.id, allocationScope: "epoch-one" }
  repository.tryCreateAllocation(allocation)
  const control = { inspection: { processState: "not-found", running: false, matched: false, portOwnerMatched: false, portOwnedByOther: false, portAvailable: true } as InspectResult,
    epoch: "epoch-one", capacity: "available", calls: 0, inspect: async () => {}, scope: async () => {}, fail: false }
  const runtime = new WorkerRuntime({ controlOrigin: "http://execution:4175", token: "fixture", nativeOrigin: "http://localhost:4180", fetch: async (url) => {
    control.calls++
    const pathname = new URL(String(url)).pathname
    if (pathname === "/v1/execution") { await control.scope(); return Response.json({ epoch: control.epoch, capacity: control.capacity }) }
    if (pathname === "/v1/inspect") { await control.inspect(); if (control.fail) throw new Error("fixture transport failure"); return Response.json(control.inspection) }
    if (pathname === "/v1/stop") { control.inspection = { ...control.inspection, processState: "not-found", running: false, matched: false }; return Response.json({ stopped: true, reason: null }) }
    throw new Error(`unexpected fixture request ${pathname}`)
  } })
  const service = new ManagerService(repository, runtime, { min: record.port, max: record.port })
  return { repository, runtime, service, record, allocation, control, close: async () => { await service.shutdown(); repository.close() } }
}

test("unreachable Worker retains execution reservation when Manager port is free but execution is busy", { timeout: 10_000 }, async () => {
  const listener = createServer()
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve))
  const port = (listener.address() as { port: number }).port
  await new Promise<void>((resolve) => listener.close(() => resolve()))
  const f = stoppedFixture("unreachable", port)
  try {
    f.control.inspection.portAvailable = false
    const result = await f.service.recheck(f.record.id)
    assert.equal(result.state, "unreachable")
    assert.equal(result.pid, 12)
    assert.equal((await f.service.workerCapacity()).state, "unknown")
    assert.equal(result.recovery.removeAllowed, false)
  } finally { await f.close() }
})

for (const state of ["stopped", "unreachable"] as const)
for (const scenario of ["unknown", "running", "identity-mismatch", "other-owner", "port-busy", "port-proof-missing", "probe-failed", "identity-missing", "unknown-launch", "epoch-changed", "scope-mismatch", "epoch-changed-after-inspect", "authority-lost"] as const) {
  test(`${state} recovery retains reservation: ${scenario}`, { timeout: 10_000 }, async () => {
    const f = stoppedFixture(state)
    try {
      if (scenario === "unknown") f.control.inspection.processState = "unknown"
      if (scenario === "running") f.control.inspection = { ...f.control.inspection, processState: "running", running: true, matched: true }
      if (scenario === "identity-mismatch") f.control.inspection = { ...f.control.inspection, processState: "running", running: true, matched: false }
      if (scenario === "other-owner") f.control.inspection.portOwnedByOther = true
      if (scenario === "port-busy") f.control.inspection.portAvailable = false
      if (scenario === "port-proof-missing") delete f.control.inspection.portAvailable
      if (scenario === "probe-failed") f.control.fail = true
      if (scenario === "identity-missing") f.repository.saveInstance({ ...f.record, creationTimeTicks: null })
      if (scenario === "unknown-launch") f.repository.saveInstance({ ...f.record, pid: null, creationTimeUtc: null, creationTimeTicks: null, executable: null })
      if (scenario === "epoch-changed") f.control.epoch = "epoch-two"
      if (scenario === "scope-mismatch") {
        f.repository.releaseAllocationForInstance(f.record.id)
        f.repository.tryCreateAllocation({ ...f.allocation, allocationScope: "epoch-two" })
      }
      if (scenario === "epoch-changed-after-inspect") {
        let authorityRead = false
        f.control.scope = async () => { authorityRead = true }
        f.control.inspect = async () => { if (authorityRead) f.control.epoch = "epoch-two" }
      }
      if (scenario === "authority-lost") f.control.capacity = "unknown"
      const result = await f.service.recheck(f.record.id)
      assert.equal(result.state, state)
      assert.equal(result.recovery.removeAllowed, false)
      assert.equal(result.recovery.recheckAllowed, true)
      assert.match(result.error!, state === "stopped" ? /^STOPPED_ALLOCATION_(IDENTITY|SCOPE|PORT)_UNVERIFIED$/
        : /^(STOPPED_ALLOCATION_(IDENTITY|SCOPE|PORT)_UNVERIFIED|INSTANCE_IDENTITY_(UNVERIFIED|CHECK_FAILED))$/)
      assert.equal(result.pid, scenario === "unknown-launch" ? null : 12)
      if (!["epoch-changed", "scope-mismatch", "epoch-changed-after-inspect"].includes(scenario)) {
        assert.notEqual((await f.service.workerCapacity()).state, "available")
      }
      await assert.rejects(f.service.deleteInstance(f.record.id), { code: "INSTANCE_REMOVAL_UNSAFE" })
    } finally { await f.close() }
  })
}

for (const state of ["stopped", "unreachable"] as const)
for (const scenario of ["allocation-replaced", "identity-replaced", "record-starting"] as const) {
  test(`late ${state} recovery cannot overwrite ${scenario}`, { timeout: 10_000 }, async () => {
    const f = stoppedFixture(state)
    try {
      f.control.inspect = async () => {
        await Promise.resolve()
        if (scenario === "allocation-replaced") {
          f.repository.releaseAllocationForInstance(f.record.id)
          f.repository.tryCreateAllocation({ ...f.allocation, id: "replacement-allocation" })
        } else f.repository.saveInstance({ ...f.record, ...(scenario === "identity-replaced" ? { pid: 99 } : { state: "starting" as const, pid: null }), error: "INSTANCE_START_TIMEOUT" })
      }
      const result = await f.service.recheck(f.record.id)
      assert.equal(result.recovery.removeAllowed, false)
      assert.equal((await f.service.workerCapacity()).state, "unknown")
      if (scenario === "identity-replaced") assert.equal(result.pid, 99)
      if (scenario === "record-starting") {
        assert.equal(result.state, "starting")
        assert.equal(result.pid, null)
      }
      if (scenario !== "allocation-replaced" && state === "stopped") assert.equal(result.error, "INSTANCE_START_TIMEOUT")
    } finally { await f.close() }
  })
}

test("unreachable Worker without allocation retains identity and cannot be removed", { timeout: 10_000 }, async () => {
  const f = stoppedFixture("unreachable")
  try {
    f.repository.releaseAllocationForInstance(f.record.id)
    const result = await f.service.recheck(f.record.id)
    assert.equal(result.state, "unreachable")
    assert.equal(result.pid, 12)
    assert.equal(result.recovery.removeAllowed, false)
    assert.equal(result.error, "INSTANCE_IDENTITY_UNVERIFIED")
  } finally { await f.close() }
})

for (const portAvailable of [false, true]) {
  test(`startup Worker reconciliation uses execution port proof: ${portAvailable}`, { timeout: 10_000 }, async () => {
    const f = stoppedFixture("unreachable")
    try {
      f.control.inspection.portAvailable = portAvailable
      await f.service.reconcile()
      const result = (await f.service.overview()).instances.find((instance) => instance.id === f.record.id)!
      assert.equal(result.state, portAvailable ? "stopped" : "unreachable")
      assert.equal(result.pid, 12)
      assert.equal(result.recovery.removeAllowed, portAvailable)
      assert.equal((await f.service.workerCapacity()).state, portAvailable ? "available" : "unknown")
    } finally { await f.close() }
  })
}

test("stopped without allocation is cheap and idempotent; legacy known epoch can release", async () => {
  const f = stoppedFixture()
  try {
    f.repository.releaseAllocationForInstance(f.record.id)
    const { allocationScope: _scope, ...legacy } = f.allocation
    f.repository.tryCreateAllocation(legacy)
    assert.equal((await f.service.recheck(f.record.id)).recovery.removeAllowed, true)
    const calls = f.control.calls
    assert.equal((await f.service.recheck(f.record.id)).recovery.recheckAllowed, false)
    assert.equal(f.control.calls, calls)
  } finally { await f.close() }
})

test("local stopped recovery still uses local port proof without requiring Worker scope", { timeout: 10_000 }, async () => {
  const listener = createServer()
  const closeListener = async () => {
    if (listener.listening) await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()))
  }
  const lifetime = setTimeout(() => { if (listener.listening) listener.close() }, 8_000)
  let f: ReturnType<typeof stoppedFixture> | undefined
  try {
    // 用自己持有的 OS 配發 port 驗證占用與釋放，不假設固定 port 在 CI 上可用。
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject)
      listener.listen(0, "127.0.0.1", resolve)
    })
    const address = listener.address()
    assert.ok(address && typeof address !== "string")
    f = stoppedFixture("stopped", address.port)
    Object.defineProperty(f.runtime, "allocationScope", { value: undefined })
    f.control.inspection.portAvailable = false
    assert.equal(listener.listening, true)
    const occupied = await f.service.recheck(f.record.id)
    assert.equal(listener.listening, true)
    assert.equal(occupied.recovery.removeAllowed, false)
    assert.equal(occupied.recovery.recheckAllowed, true)
    assert.equal(occupied.error, "STOPPED_ALLOCATION_PORT_UNVERIFIED")
    assert.deepEqual(f.repository.getAllocationForInstance(f.record.id), f.allocation)

    await closeListener()
    assert.equal(listener.listening, false)
    const released = await f.service.recheck(f.record.id)
    assert.equal(released.recovery.removeAllowed, true)
    assert.equal(released.recovery.recheckAllowed, false)
    assert.equal(released.error, null)
    assert.equal(f.repository.getAllocationForInstance(f.record.id), null)
  } finally {
    clearTimeout(lifetime)
    try { await closeListener() } finally { await f?.close() }
  }
})

test("Worker Stop retains allocation when execution port is busy even if Manager loopback is free", async () => {
  const fixture = stoppedFixture()
  try {
    fixture.repository.saveInstance({ ...fixture.record, state: "ready" })
    fixture.control.inspection = { processState: "running", running: true, matched: true, portOwnerMatched: true, portOwnedByOther: false, portAvailable: false }
    const result = await fixture.service.stop(fixture.record.id)
    assert.equal(result.state, "stopped")
    assert.equal(result.recovery.removeAllowed, false)
    assert.equal(result.error, "STOPPED_ALLOCATION_PORT_UNVERIFIED")
  } finally { await fixture.close() }
})

for (const state of ["stopped", "unreachable"] as const) {
test(`${state} allocation can be rechecked after the execution port becomes free, then removal and Start are available`, { timeout: 10_000 }, async () => {
  const listener = createServer()
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve))
  const port = (listener.address() as { port: number }).port
  let stopped = false
  let portAvailable = false
  const repository = new ManagerRepository(":memory:")
  const runtime = new WorkerRuntime({ controlOrigin: "http://execution:4175", token: "fixture", nativeOrigin: "http://localhost:4180", fetch: async (url, init) => {
    const pathname = new URL(String(url)).pathname
    if (pathname.startsWith("/v1/directories/")) return Response.json({ directory: "/workspace" })
    if (pathname === "/v1/execution") return Response.json({ epoch: "epoch-one", capacity: "available" })
    if (pathname === "/v1/start") {
      stopped = false
      return Response.json({ pid: 12, instanceId: JSON.parse(String(init?.body)).instanceId, directory: "/workspace", executable: "/usr/bin/opencode", creationTimeUtc: "2026-10-02T00:00:00.000Z", creationTimeTicks: "epoch-one", endpoint: `http://127.0.0.1:${port}` })
    }
    if (pathname === "/v1/stop") { stopped = true; return Response.json({ stopped: true, reason: null }) }
    if (pathname === "/v1/inspect") return Response.json({ processState: stopped ? "not-found" : "running", running: !stopped, matched: !stopped, portOwnerMatched: !stopped, portOwnedByOther: false, portAvailable })
    if (pathname.endsWith("/global/health")) return Response.json({ healthy: true, version: "fixture" })
    if (pathname.endsWith("/path")) return Response.json({ directory: "/workspace" })
    if (pathname.endsWith("/session/status")) return Response.json({})
    if (pathname.endsWith("/event")) return new Response(null, { status: 503 })
    return Response.json([])
  } })
  const service = new ManagerService(repository, runtime, { min: port, max: port })
  try {
    const instance = await service.start("/workspace", false)
    if (state === "unreachable") repository.saveInstance({ ...repository.getInstance(instance.id)!, state })
    if (state === "unreachable") stopped = true
    const result = state === "stopped" ? await service.stop(instance.id) : await service.recheck(instance.id)
    assert.equal(result.state, state)
    assert.equal(result.recovery.removeAllowed, false)
    assert.equal((await service.workerCapacity()).state, "unknown")
    assert.equal(result.recovery.recheckAllowed, true)
    portAvailable = true
    const rechecked = await service.recheck(instance.id)
    assert.equal(rechecked.state, "stopped")
    assert.equal(rechecked.recovery.removeAllowed, true)
    assert.equal(rechecked.recovery.recheckAllowed, false)
    assert.equal((await service.workerCapacity()).state, "available")
    assert.equal(rechecked.pid, 12, "Worker recovery preserves the successful launch identity")
    await service.deleteInstance(instance.id)
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()))
    assert.equal((await service.start("/workspace", false)).state, "ready")
  } finally {
    if (listener.listening) await new Promise<void>((resolve) => listener.close(() => resolve()))
    await service.shutdown()
    repository.close()
  }
})
}
