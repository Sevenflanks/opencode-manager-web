import assert from "node:assert/strict"
import test from "node:test"
import { buildExecutionApp } from "../src/worker/supervisor.js"

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
  const app = buildExecutionApp({ token, executable: process.execPath, runtimePort: 4096 })
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
