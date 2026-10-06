import assert from "node:assert/strict"
import test from "node:test"
import { WorkerRuntime } from "../src/worker/runtime.js"
import type { InstanceRecord } from "../src/repository.js"
import { ManagerRepository } from "../src/repository.js"
import { ManagerService } from "../src/service.js"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

test("Worker launch is pinned to reserved scope even if supervisor incarnation changes", async () => {
  const requests: string[] = []
  const runtime = new WorkerRuntime({ controlOrigin: "http://execution:4175", token: "fixture", nativeOrigin: "http://localhost:4180", fetch: async (url, init) => {
    requests.push(new URL(String(url)).pathname)
    if (new URL(String(url)).pathname === "/v1/directories/resolve-start") return Response.json({ directory: "/workspace" })
    assert.equal(JSON.parse(String(init?.body)).epoch, "reserved-epoch")
    return Response.json({ error: "EPOCH_MISMATCH" }, { status: 409 })
  } })
  await assert.rejects(runtime.launch("/workspace", 4096, "instance", "reserved-epoch"), { code: "EXECUTION_REJECTED" })
  assert.deepEqual(requests, ["/v1/directories/resolve-start", "/v1/start"])
})

test("Worker adapter uses persisted epoch for authenticated control and never exposes internal endpoint in open URL", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const record: InstanceRecord = { id: "instance-one", projectName: "project", projectDirectory: "/workspace/CaseSensitive", state: "ready",
    endpoint: "http://execution:4175/runtime/epoch-one/instance-one", port: 4096, pid: 12, creationTimeUtc: "2026-10-02T00:00:00.000Z",
    creationTimeTicks: "epoch-one", executable: "/usr/local/bin/opencode", launchedAt: "2026-10-02T00:00:00.000Z", healthVersion: null, stoppedAt: null, error: null, stderrSummary: null }
  const runtime = new WorkerRuntime({ controlOrigin: "http://execution:4175", token: "fixture-token-32-characters-long!!", nativeOrigin: "http://127.0.0.1:4180", fetch: async (url, init) => {
    requests.push({ url: String(url), ...(init ? { init } : {}) })
    if (String(url).endsWith("/v1/inspect")) return Response.json({ processState: "unknown", running: false, matched: false, portOwnerMatched: false, portOwnedByOther: false })
    return Response.json([])
  } })
  assert.equal((await runtime.inspect(record)).processState, "unknown")
  assert.deepEqual(JSON.parse(String(requests[0]!.init!.body)), { epoch: "epoch-one", instanceId: "instance-one" })
  assert.equal(new Headers(requests[0]!.init!.headers).get("authorization"), "Bearer fixture-token-32-characters-long!!")
  assert.deepEqual(await runtime.sessions(record), [])
  assert.match(requests[1]!.url, /^http:\/\/execution:4175\/runtime\/epoch-one\/instance-one\/session\?directory=/)
  const publicUrl = new URL(runtime.openUrl(record))
  assert.equal(publicUrl.origin, "http://127.0.0.1:4180")
  assert.equal(publicUrl.username, "")
  assert.equal(publicUrl.search, "")
  assert.equal(requests.some((request) => request.url.includes("/v1/start")), false)
})

test("ManagerService restart reuses persisted execution identity; shutdown and unknown inspection never launch or stop execution", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "omw-worker-reconcile-"))
  const filename = path.join(directory, "manager.sqlite")
  const calls: string[] = []
  let unknown = false
  const runtime = () => new WorkerRuntime({ controlOrigin: "http://execution:4175", token: "fixture-secret", nativeOrigin: "http://127.0.0.1:4180", fetch: async (url, init) => {
    const request = new URL(String(url))
    calls.push(request.pathname)
    if (request.pathname === "/v1/directories/resolve" || request.pathname === "/v1/directories/resolve-start") return Response.json({ directory })
    if (request.pathname === "/v1/execution") return Response.json({ epoch: "epoch-one", capacity: "available" })
    if (request.pathname === "/v1/start") {
      const body = JSON.parse(String(init?.body))
      return Response.json({ pid: 12, instanceId: body.instanceId, directory: body.directory, executable: "/usr/local/bin/opencode", creationTimeUtc: "2026-10-02T00:00:00.000Z", creationTimeTicks: "epoch-one", endpoint: "http://127.0.0.1:4096" })
    }
    if (request.pathname === "/v1/inspect") {
      assert.equal(JSON.parse(String(init?.body)).epoch, "epoch-one")
      return Response.json(unknown ? { processState: "unknown", running: false, matched: false, portOwnerMatched: false, portOwnedByOther: false }
        : { processState: "running", running: true, matched: true, portOwnerMatched: true, portOwnedByOther: false })
    }
    if (request.pathname.endsWith("/global/health")) return Response.json({ healthy: true, version: "fixture" })
    if (request.pathname.endsWith("/path")) return Response.json({ directory })
    if (request.pathname.endsWith("/session/status")) return Response.json({})
    if (request.pathname.endsWith("/session")) return Response.json([{ id: "ses_primary", title: "Work", directory, time: { created: 1, updated: 2 } }])
    if (request.pathname.endsWith("/event")) return new Response(null, { status: 503 })
    return Response.json([])
  } })
  let repository = new ManagerRepository(filename)
  let service = new ManagerService(repository, runtime(), { min: 42991, max: 42991 })
  try {
    const started = await service.start(directory, false)
    assert.equal(started.state, "ready")
    await service.selectPrimarySession(started.id, "ses_primary")
    await service.shutdown()
    repository.close()
    repository = new ManagerRepository(filename)
    service = new ManagerService(repository, runtime(), { min: 42991, max: 42991 })
    await service.reconcile()
    assert.equal((await service.overview()).instances[0]?.id, started.id)
    assert.equal(calls.filter((value) => value === "/v1/start").length, 1)
    assert.equal(calls.includes("/v1/stop"), false)
    unknown = true
    await service.reconcile()
    await assert.rejects(service.resume(started.id))
    assert.equal(calls.filter((value) => value === "/v1/start").length, 1)
    assert.equal(calls.includes("/v1/stop"), false)
  } finally { await service.shutdown(); repository.close(); await rm(directory, { recursive: true, force: true }) }
})
