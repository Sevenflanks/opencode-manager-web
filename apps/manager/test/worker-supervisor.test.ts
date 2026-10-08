import assert from "node:assert/strict"
import test from "node:test"
import { buildExecutionApp } from "../src/worker/supervisor.js"
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createServer } from "node:net"
import { localDirectories } from "../src/directory.js"

test("same-epoch not-found inspection proves port availability in execution network only", async () => {
  const listener = createServer()
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve))
  const port = (listener.address() as { port: number }).port
  const app = buildExecutionApp({ token: "a".repeat(32), executable: process.execPath, runtimePort: port })
  const headers = { authorization: `Bearer ${"a".repeat(32)}` }
  try {
    const epoch = (await app.inject({ url: "/v1/execution", headers })).json().epoch
    const inspect = (scope: string) => app.inject({ method: "POST", url: "/v1/inspect", headers, payload: { epoch: scope, instanceId: "stopped" } })
    const busy = (await inspect(epoch)).json()
    assert.equal(busy.processState, "not-found")
    assert.equal(busy.matched, false)
    assert.equal(busy.portAvailable, false)
    await new Promise<void>((resolve) => listener.close(() => resolve()))
    assert.equal((await inspect(epoch)).json().portAvailable, true)
    const stale = (await inspect("stale")).json()
    assert.equal(stale.processState, "unknown")
    assert.notEqual(stale.portAvailable, true)
  } finally {
    if (listener.listening) await new Promise<void>((resolve) => listener.close(() => resolve()))
    await app.close()
  }
})

test("authenticated direct Start rejects a canonical directory outside workspace before accepting an attempt", async () => {
  const disk = await mkdtemp(path.join(tmpdir(), "omw-start-boundary-"))
  await mkdir(path.join(disk, "workspace"))
  await mkdir(path.join(disk, "workspace-sibling"))
  await mkdir(path.join(disk, "outside"))
  await symlink(path.join(disk, "outside"), path.join(disk, "workspace", "escape"), "junction")
  const app = buildExecutionApp({ token: "a".repeat(32), executable: process.execPath, runtimePort: 4096 }, {
    ...localDirectories,
    async resolve(input) {
      const resolved = await localDirectories.resolve(path.join(disk, input))
      return `/${path.relative(disk, resolved).split(path.sep).join("/")}`
    },
  })
  const headers = { authorization: `Bearer ${"a".repeat(32)}` }
  try {
    const epoch = (await app.inject({ url: "/v1/execution", headers })).json().epoch
    for (const [index, directory] of ["/outside", "/workspace-sibling", "/workspace/../outside", "/workspace/escape"].entries()) {
      const identity = { epoch, instanceId: `outside-workspace-${index}` }
      const response = await app.inject({ method: "POST", url: "/v1/start", headers, payload: { ...identity, directory } })
      assert.equal(response.statusCode, 400, response.body)
      assert.equal(response.json().error.code, "WORKER_DIRECTORY_OUTSIDE_WORKSPACE")
      assert.equal((await app.inject({ method: "POST", url: "/v1/stop", headers, payload: identity })).statusCode, 409,
        "rejected directory does not grant cleanup authority")
    }
    assert.equal((await app.inject({ url: "/v1/execution", headers })).json().execution, null)
  } finally { await app.close(); await rm(disk, { recursive: true, force: true }) }
})

test("native root gateway challenges unauthenticated access and rejects cross-origin requests", async () => {
  const app = buildExecutionApp({ token: "a".repeat(32), executable: process.execPath, runtimePort: 4096,
    nativeOrigin: "https://native.example.test", browserUsername: "operator", browserPassword: "fixture-password-only" })
  const native = app.nativeGateway
  const headers = { host: "native.example.test", authorization: `Basic ${Buffer.from("operator:fixture-password-only").toString("base64")}` }
  try {
    assert.equal((await native.inject({ url: "/", headers: { host: headers.host } })).statusCode, 401)
    assert.equal((await native.inject({ url: "/", headers })).statusCode, 503)
    assert.equal((await native.inject({ url: "/", headers: { ...headers, origin: "https://evil.test" } })).statusCode, 403)
    assert.equal((await native.inject({ method: "POST", url: "/auth", headers, payload: {} })).statusCode, 403)
    assert.equal((await native.inject({ url: "/", headers: { ...headers, host: "evil.test" } })).statusCode, 403)
  } finally { await app.close() }
})

const token = "fixture-control-token-32-characters"
test("execution public HTTP requires control auth and rejects browser Origin; empty state does not invent execution", async () => {
  const app = buildExecutionApp({ token, executable: process.execPath, runtimePort: 4096 })
  try {
    assert.equal((await app.inject({ method: "GET", url: "/v1/execution" })).statusCode, 401)
    assert.equal((await app.inject({ method: "GET", url: "/v1/execution", headers: { authorization: `Bearer ${token}`, origin: "http://evil.test" } })).statusCode, 403)
    const response = await app.inject({ method: "GET", url: "/v1/execution", headers: { authorization: `Bearer ${token}` } })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().execution, null)
    if (process.platform !== "linux") assert.equal(response.json().capacity, "unknown", "cannot infer empty namespace on unsupported host")
    assert.equal(typeof response.json().epoch, "string")
    assert.equal(response.body.includes(token), false)
    const stale = await app.inject({ method: "POST", url: "/v1/stop", headers: { authorization: `Bearer ${token}` }, payload: { epoch: "old-epoch", instanceId: "old-instance" } })
    assert.equal(stale.statusCode, 409)
  } finally { await app.close() }
})

test("Start requires exact supervisor epoch and rejects malformed input without launching", async () => {
  const app = buildExecutionApp({ token, executable: process.execPath, runtimePort: 4096 }, localDirectories, process.cwd())
  const headers = { authorization: `Bearer ${token}` }
  try {
    const epoch = (await app.inject({ method: "GET", url: "/v1/execution", headers })).json().epoch
    assert.equal((await app.inject({ method: "POST", url: "/v1/start", headers, payload: { epoch: "stale", instanceId: "fixture", directory: "/workspace" } })).statusCode, 409)
    assert.equal((await app.inject({ method: "POST", url: "/v1/start", headers, payload: { epoch, instanceId: "fixture", directory: "relative" } })).statusCode, 400)
    if (process.platform !== "linux") {
      const identity = { epoch, instanceId: "owner-rejected" }
      assert.equal((await app.inject({ method: "POST", url: "/v1/start", headers, payload: { ...identity, directory: process.cwd() } })).statusCode, 503)
      assert.equal((await app.inject({ method: "POST", url: "/v1/stop", headers, payload: identity })).statusCode, 409, "namespace-owner rejection must not invent accepted-attempt cleanup proof")
    }
    assert.equal((await app.inject({ method: "POST", url: "/v1/inspect", headers, payload: { epoch: "stale", instanceId: "fixture" } })).json().processState, "unknown")
  } finally { await app.close() }
})

test("execution draining rejects new control work over HTTP while retaining authentication", { timeout: 10_000 }, async () => {
  const app = buildExecutionApp({ token, executable: process.execPath, runtimePort: 4096 })
  const lifetime = setTimeout(() => { app.server.closeAllConnections(); void app.close() }, 8_000)
  try {
    const origin = await app.listen({ host: "127.0.0.1", port: 0 })
    const get = (headers: Record<string, string>) => fetch(`${origin}/v1/execution`, { headers, signal: AbortSignal.timeout(1_000) })
    assert.equal((await get({ authorization: `Bearer ${token}` })).status, 200)
    app.beginDrain()
    assert.equal((await get({})).status, 401)
    assert.equal((await get({ authorization: `Bearer ${token}` })).status, 503)
    const start = await fetch(`${origin}/v1/start`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ epoch: "stale", instanceId: "must-not-start", directory: process.cwd() }), signal: AbortSignal.timeout(1_000) })
    assert.equal(start.status, 503)
    assert.deepEqual(await start.json(), { error: "EXECUTION_DRAINING" })
  } finally {
    clearTimeout(lifetime)
    app.server.closeAllConnections()
    await app.close()
  }
})
