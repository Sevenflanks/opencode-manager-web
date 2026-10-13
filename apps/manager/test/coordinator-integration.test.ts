import assert from "node:assert/strict"
import test from "node:test"
import path from "node:path"
import { tmpdir } from "node:os"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { buildApp } from "../src/app.js"
import { SeparateRequestAuthenticator } from "../src/auth.js"
import { CoordinatorRegistry } from "../src/coordinator/registry.js"
import { buildCoordinatorApp } from "../src/coordinator/app.js"
import { coordinatorConfig } from "../src/coordinator/config.js"
import { deriveWorkerKey } from "../src/coordinator/identity.js"
import { ManagerRepository } from "../src/repository.js"
import { ManagerService } from "../src/service.js"
import { WorkerRuntime } from "../src/worker/runtime.js"

const publicOrigin = "https://manager.example.test"
const nativeOrigin = "https://omw-job-one-code.example.test"
const secret = "fixture-coordinator-master-secret"
const key = deriveWorkerKey(secret, "one")
const browser = { username: "worker", password: "fixture-worker-only-password" }
const human = { username: "human", password: "fixture-human-only-password" }
const authenticator = (manager: typeof browser) => new SeparateRequestAuthenticator({ manager, launcherToken: "unused" })

test("Coordinator fixed Host/Origin and Worker Basic cross real Worker ManagerService Start/Session/Stop API, without creating processes or prompts", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "omw-coordinator-boundary-"))
  const repository = new ManagerRepository(":memory:")
  let current: string | null = null
  let starts = 0
  let stops = 0
  const runtime = new WorkerRuntime({ controlOrigin: "http://execution:4175", token: "fixture-control-only", nativeOrigin,
    fetch: async (input, init) => {
      const url = new URL(String(input))
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-control-only")
      if (url.pathname.startsWith("/v1/directories/")) return Response.json({ directory })
      if (url.pathname === "/v1/execution") return Response.json({ epoch: "epoch-one", capacity: current ? "occupied" : "available" })
      if (url.pathname === "/v1/start") {
        assert.equal(current, null); assert.equal(body.epoch, "epoch-one"); assert.equal(body.directory, directory)
        starts++; current = body.instanceId
        return Response.json({ instanceId: current, pid: 123, directory, executable: "/fixture/opencode", creationTimeUtc: "2026-10-12T00:00:00.000Z", creationTimeTicks: "epoch-one", endpoint: "http://127.0.0.1:4096" })
      }
      if (url.pathname === "/v1/inspect") return Response.json({ processState: current === body.instanceId ? "running" : "not-found", running: current === body.instanceId,
        matched: current === body.instanceId, portOwnerMatched: current === body.instanceId, portOwnedByOther: false })
      if (url.pathname === "/v1/stop") { assert.equal(body.instanceId, current); stops++; current = null; return Response.json({ stopped: true, reason: null }) }
      assert.notEqual(init?.method, "POST", "must not create sessions or send prompts automatically")
      if (url.pathname.endsWith("/global/health")) return Response.json({ healthy: true, version: "fixture" })
      if (url.pathname.endsWith("/path")) return Response.json({ directory })
      if (url.pathname.endsWith("/session/status")) return Response.json({})
      if (url.pathname.endsWith("/session")) return Response.json([{ id: "session-one", title: "Existing", directory, time: { created: 1, updated: 2 } }])
      if (url.pathname.endsWith("/event")) return new Response(null, { status: 503 })
      return Response.json([])
    } })
  const service = new ManagerService(repository, runtime, { min: 4096, max: 4096 })
  const worker = buildApp({ service, authority: { hostname: "127.0.0.1", port: 4174 }, publicOrigin, allowedOrigins: new Set([publicOrigin]),
    worker: { nativeOrigin, identity: { id: "one", generation: "uid-1", key } }, authenticator: authenticator(browser) })
  const registry = await CoordinatorRegistry.open({ publicOrigin, nativeHostSuffix: "example.test", allowedCidrs: ["127.0.0.0/8"], registrationSecret: secret,
    dataDirectory: directory, healthTimeoutMs: 1_000, healthIntervalMs: 15_000, failureThreshold: 3 })
  const coordinator = buildCoordinatorApp({ registry, publicOrigin, port: 4174, authenticator: authenticator(human) })
  const headers = { host: "manager.example.test", origin: publicOrigin, "x-omw-csrf": "1", authorization: `Basic ${Buffer.from(`${human.username}:${human.password}`).toString("base64")}` }
  const prefix = "/api/v1/coordinator/workers/one/uid-1/proxy/api/v1"
  const lifetime = setTimeout(() => { worker.server.closeAllConnections(); void worker.close(); void coordinator.close() }, 9_000); lifetime.unref()
  try {
    await worker.listen({ host: "127.0.0.4", port: 4174 })
    await registry.register({ id: "one", generation: "uid-1", kind: "resident", address: "127.0.0.4", nativeOrigin, browser }, key)
    const start = await coordinator.inject({ method: "POST", url: `${prefix}/instances`, headers, payload: { directory } })
    assert.equal(start.statusCode, 201, start.body); assert.equal(starts, 1)
    const id = start.json().id
    await registry.check("one", "uid-1")
    assert.equal(registry.overview().instances[0]?.instance.id, id)
    assert.equal(registry.overview().workers[0]?.capacity?.state, "occupied")
    const sessions = await coordinator.inject({ url: `${prefix}/instances/${id}/sessions`, headers })
    assert.equal(sessions.statusCode, 200, sessions.body); assert.ok(sessions.body.includes("session-one"))
    const stop = await coordinator.inject({ method: "POST", url: `${prefix}/instances/${id}/stop`, headers })
    assert.equal(stop.statusCode, 200, stop.body); assert.equal(stops, 1); assert.equal(starts, 1)
  } finally { clearTimeout(lifetime); await coordinator.close(); await worker.close(); repository.close(); await rm(directory, { recursive: true, force: true }) }
})

test("Coordinator configuration fails closed without canonical CIDRs, private master file and native parent; honors operator port/health settings", { timeout: 5_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "omw-coordinator-config-"))
  const masterFile = path.join(directory, "registration-secret")
  const passwordFile = path.join(directory, "browser-password")
  await writeFile(masterFile, secret, { mode: 0o600 }); await writeFile(passwordFile, human.password, { mode: 0o600 })
  const env = { OMW_PUBLIC_ORIGIN: publicOrigin, OMW_DATA_DIR: directory, OMW_BROWSER_USERNAME: human.username, OMW_BROWSER_PASSWORD_FILE: passwordFile,
    OMW_COORDINATOR_REGISTRATION_SECRET_FILE: masterFile, OMW_COORDINATOR_ALLOWED_CIDRS: "127.0.0.0/8", OMW_COORDINATOR_NATIVE_HOST_SUFFIX: "example.test" }
  try {
    for (const cidr of ["", "0.0.0.0/0", "127.0.0.1/8", "127.1/16", "127.0.0.0/33", "::1/128"]) {
      await assert.rejects(coordinatorConfig({ ...env, OMW_COORDINATOR_ALLOWED_CIDRS: cidr }), cidr)
    }
    for (const patch of [{ OMW_COORDINATOR_ALLOWED_CIDRS: undefined }, { OMW_COORDINATOR_NATIVE_HOST_SUFFIX: "*.example.test" },
      { OMW_COORDINATOR_REGISTRATION_SECRET_FILE: "relative-path" }, { OMW_COORDINATOR_HEALTH_FAILURE_THRESHOLD: "0" }]) {
      await assert.rejects(coordinatorConfig({ ...env, ...patch }))
    }
    const config = await coordinatorConfig({ ...env, OMW_PORT: "4178", OMW_HEALTH_PORT: "4179", OMW_COORDINATOR_HEALTH_TIMEOUT_MS: "1000" })
    assert.equal(config.port, 4178); assert.equal(config.healthPort, 4179); assert.equal(config.config.healthTimeoutMs, 1000)
    const { config: runtimeConfig } = await coordinatorConfig(env)
    const registry = await CoordinatorRegistry.open(runtimeConfig)
    try { assert.deepEqual(registry.overview().workers, []) } finally { await registry.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
