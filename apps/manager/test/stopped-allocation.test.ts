import assert from "node:assert/strict"
import test from "node:test"
import { createServer } from "node:net"
import { ManagerRepository } from "../src/repository.js"
import { ManagerService } from "../src/service.js"
import { WorkerRuntime } from "../src/worker/runtime.js"
import type { InspectResult } from "../src/runtime.js"

function stoppedFixture() {
  const repository = new ManagerRepository(":memory:")
  const record = { id: "stopped-one", projectName: "project", projectDirectory: "/workspace", state: "stopped" as const,
    endpoint: "http://execution:4175/runtime/epoch-one/stopped-one", port: 49998, pid: 12,
    creationTimeUtc: "2026-10-02T00:00:00.000Z", creationTimeTicks: "epoch-one", executable: "/usr/bin/opencode",
    launchedAt: "2026-10-02T00:00:00.000Z", stoppedAt: "2026-10-02T01:00:00.000Z", healthVersion: null, error: null, stderrSummary: null }
  repository.createInstance(record)
  const allocation = { id: "allocation-one", kind: "headless" as const, clientInvocationId: null, projectDirectory: "/workspace",
    port: record.port, createdAt: record.launchedAt, expiresAt: null, instanceId: record.id, allocationScope: "epoch-one" }
  repository.tryCreateAllocation(allocation)
  const control = { inspection: { processState: "not-found", running: false, matched: false, portOwnerMatched: false, portOwnedByOther: false, portAvailable: true } as InspectResult,
    epoch: "epoch-one", calls: 0, inspect: async () => {}, scope: async () => {}, fail: false }
  const runtime = new WorkerRuntime({ controlOrigin: "http://execution:4175", token: "fixture", nativeOrigin: "http://localhost:4180", fetch: async (url) => {
    control.calls++
    const pathname = new URL(String(url)).pathname
    if (pathname === "/v1/execution") { await control.scope(); return Response.json({ epoch: control.epoch, capacity: "available" }) }
    if (pathname === "/v1/inspect") { await control.inspect(); if (control.fail) throw new Error("fixture transport failure"); return Response.json(control.inspection) }
    if (pathname === "/v1/stop") { control.inspection = { ...control.inspection, processState: "not-found", running: false, matched: false }; return Response.json({ stopped: true, reason: null }) }
    throw new Error(`unexpected fixture request ${pathname}`)
  } })
  const service = new ManagerService(repository, runtime, { min: record.port, max: record.port })
  return { repository, runtime, service, record, allocation, control, close: async () => { await service.shutdown(); repository.close() } }
}

for (const scenario of ["unknown", "running", "identity-mismatch", "other-owner", "port-busy", "port-proof-missing", "probe-failed", "identity-missing", "epoch-changed", "scope-mismatch", "epoch-changed-after-inspect"] as const) {
  test(`stopped recovery retains reservation: ${scenario}`, async () => {
    const f = stoppedFixture()
    try {
      if (scenario === "unknown") f.control.inspection.processState = "unknown"
      if (scenario === "running") f.control.inspection = { ...f.control.inspection, processState: "running", running: true, matched: true }
      if (scenario === "identity-mismatch") f.control.inspection = { ...f.control.inspection, processState: "running", running: true, matched: false }
      if (scenario === "other-owner") f.control.inspection.portOwnedByOther = true
      if (scenario === "port-busy") f.control.inspection.portAvailable = false
      if (scenario === "port-proof-missing") delete f.control.inspection.portAvailable
      if (scenario === "probe-failed") f.control.fail = true
      if (scenario === "identity-missing") f.repository.saveInstance({ ...f.record, creationTimeTicks: null })
      if (scenario === "epoch-changed") f.control.epoch = "epoch-two"
      if (scenario === "scope-mismatch") {
        f.repository.releaseAllocationForInstance(f.record.id)
        f.repository.tryCreateAllocation({ ...f.allocation, allocationScope: "epoch-two" })
      }
      if (scenario === "epoch-changed-after-inspect") f.control.inspect = async () => { f.control.epoch = "epoch-two" }
      const result = await f.service.recheck(f.record.id)
      assert.equal(result.state, "stopped")
      assert.equal(result.recovery.removeAllowed, false)
      assert.equal(result.recovery.recheckAllowed, true)
      assert.match(result.error!, /^STOPPED_ALLOCATION_(IDENTITY|SCOPE|PORT)_UNVERIFIED$/)
      await assert.rejects(f.service.deleteInstance(f.record.id), { code: "INSTANCE_REMOVAL_UNSAFE" })
    } finally { await f.close() }
  })
}

for (const scenario of ["allocation-replaced", "identity-replaced", "record-starting"] as const) {
  test(`late stopped recovery cannot overwrite ${scenario}`, async () => {
    const f = stoppedFixture()
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
      if (scenario !== "allocation-replaced") assert.equal(result.error, "INSTANCE_START_TIMEOUT")
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

test("local stopped recovery still uses local port proof without requiring Worker scope", async () => {
  const f = stoppedFixture()
  try {
    Object.defineProperty(f.runtime, "allocationScope", { value: undefined })
    f.control.inspection.portAvailable = false
    assert.equal((await f.service.recheck(f.record.id)).recovery.removeAllowed, true)
  } finally { await f.close() }
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

test("stopped allocation can be rechecked after the port becomes free, then Start is available", async () => {
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
    const result = await service.stop(instance.id)
    assert.equal(result.state, "stopped")
    assert.equal(result.recovery.removeAllowed, false)
    assert.equal((await service.workerCapacity()).state, "unknown")
    assert.equal(result.recovery.recheckAllowed, true)
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()))
    portAvailable = true
    const rechecked = await service.recheck(instance.id)
    assert.equal(rechecked.state, "stopped")
    assert.equal(rechecked.recovery.removeAllowed, true)
    assert.equal(rechecked.recovery.recheckAllowed, false)
    assert.equal((await service.workerCapacity()).state, "available")
    assert.equal((await service.start("/workspace", false)).state, "ready")
  } finally {
    if (listener.listening) await new Promise<void>((resolve) => listener.close(() => resolve()))
    await service.shutdown()
    repository.close()
  }
})
