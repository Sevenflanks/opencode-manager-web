import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { buildApp } from "../src/app.js"
import { SeparateRequestAuthenticator } from "../src/auth.js"
import type { CommandRunner } from "../src/connectivity.js"
import { RemoteAccessController, RemoteProfileStore, startupRemoteAccess } from "../src/remote-access.js"
import { OpenCodeRuntime } from "../src/runtime.js"
import type { ManagerService } from "../src/service.js"

const host = "device.example.ts.net"
const local = "http://127.0.0.1:4174"
const authorization = `Basic ${Buffer.from("fixture:fixture-password").toString("base64")}`
const headers = { host: "127.0.0.1:4174", origin: local, "x-omw-csrf": "1", authorization }

class TailnetFixture implements CommandRunner {
  calls: string[] = []
  mapped = new Set<number>()
  failMutation = false
  status: unknown = { BackendState: "Running", Self: { Online: true, DNSName: `${host}.` } }
  beforeMutation: (() => void) | undefined
  async execFile(_executable: string, args: readonly string[], options: Parameters<CommandRunner["execFile"]>[2]) {
    assert.ok(options.timeout > 0 && options.timeout <= 2500)
    assert.equal(options.shell, false)
    this.calls.push(args.join(" "))
    if (args[0] === "status") {
      if (this.status instanceof Error) throw this.status
      return { stdout: JSON.stringify(this.status) }
    }
    if (args[1] === "status") return { stdout: JSON.stringify({
      Web: Object.fromEntries([...this.mapped].map((port) => [`${host}:${port}`, { Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } } }])),
      TCP: Object.fromEntries([...this.mapped].map((port) => [port, { HTTPS: true }])),
    }) }
    this.beforeMutation?.()
    if (this.failMutation) throw new Error("fixture mutation failure")
    this.mapped.add(Number(args[3]?.split("=")[1]))
    return { stdout: "" }
  }
}

function controller(runner: TailnetFixture, store: { save: RemoteProfileStore["save"] } = { save: async () => undefined }, disabled = false) {
  return new RemoteAccessController({
    managerPort: 4174, portPool: { min: 42000, max: 42001 }, remoteAccess: null,
    executable: "fixture-only", runner, store, disabled,
  })
}

function appFor(remoteAccess: RemoteAccessController) {
  return buildApp({
    service: { overview: async () => ({ shortcuts: [], instances: [] }), shutdown: async () => undefined } as unknown as ManagerService,
    authority: { hostname: "127.0.0.1", port: 4174 }, allowedOrigins: new Set([local]),
    remoteAccess, connectivity: remoteAccess,
    remoteAuthenticator: new SeparateRequestAuthenticator({ manager: { username: "fixture", password: "fixture-password" }, launcherToken: "fixture-launcher" }),
  })
}

test("no-env local UI enable persists before auth/authority activation and Serve mutation; default is read-only", async (t) => {
  const runner = new TailnetFixture()
  let saved = false
  const remote = controller(runner, { save: async () => { assert.equal(remote.config, null); saved = true } })
  runner.beforeMutation = () => { assert.ok(saved); assert.ok(remote.config) }
  const app = appFor(remote)
  t.after(async () => { await app.close(); await remote.close() })
  const initial = await app.inject({ url: "/api/v1/connectivity", headers: { host: headers.host } })
  assert.equal(initial.json().remoteAccess, "available")
  assert.deepEqual(runner.calls, ["status --json"])
  const response = await app.inject({ method: "POST", url: "/api/v1/connectivity/enable", headers, payload: { confirmed: true } })
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.json().mode, "tailnet")
  assert.equal(response.json().registration.state, "verified")
  assert.equal(response.json().manager.publicUrl, `https://${host}:4174`)
  assert.deepEqual([...runner.mapped], [4174, 42000, 42001])
  assert.equal((await app.inject({ url: "/api/v1/overview", headers: { host: headers.host } })).statusCode, 401)
  assert.equal((await app.inject({ url: "/api/v1/overview", headers: { host: `${host}:4174`, origin: `https://${host}:4174`, authorization } })).statusCode, 200)
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/connectivity/enable", headers: { ...headers, host: `${host}:4174` }, payload: { confirmed: true } })).statusCode, 403)
})

test("enable rejects missing/invalid browser auth, launcher token, host, Origin, CSRF and unconfirmed body without discovery or writes", async (t) => {
  const runner = new TailnetFixture()
  const remote = controller(runner, { save: async () => { assert.fail("must not persist") } })
  const app = appFor(remote)
  t.after(() => app.close())
  for (const changes of [
    { authorization: "" }, { authorization: "Bearer fixture-launcher" },
    { authorization: "", "x-omw-launcher-token": "fixture-launcher" },
    { authorization: `Basic ${Buffer.from("fixture:wrong").toString("base64")}` },
    { host: "attacker.example" }, { origin: "https://attacker.example" }, { origin: "" }, { "x-omw-csrf": "" },
  ]) {
    const response = await app.inject({ method: "POST", url: "/api/v1/connectivity/enable", headers: { ...headers, ...changes }, payload: { confirmed: true } })
    assert.ok([401, 403].includes(response.statusCode), response.body)
  }
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/connectivity/enable", headers, payload: { confirmed: false } })).statusCode, 400)
  for (const url of ["/api/v1/connectivity/%65nable", "/api/v1/connectivity/enable?confirmed=true", "/api/v1/connectivity/enable/"]) {
    const response = await app.inject({ method: "POST", url, headers: { ...headers, authorization: "" }, payload: { confirmed: true } })
    assert.ok([401, 404].includes(response.statusCode), `${url}: ${response.body}`)
  }
  assert.deepEqual(runner.calls, [])
  assert.equal(remote.config, null)
})

test("registration failure remains enabled with diagnostic and is manually retryable", async () => {
  const runner = new TailnetFixture()
  runner.failMutation = true
  const remote = controller(runner)
  const result = await remote.enable()
  assert.equal(result.remoteAccess, "enabled")
  assert.equal(result.registration.diagnostic?.code, "COMMAND_FAILED")
  runner.failMutation = false
  assert.equal((await remote.register("manual")).registration.state, "verified")
})

test("persistence failure leaves loopback policy and starts no Serve command", async () => {
  const runner = new TailnetFixture()
  const remote = controller(runner, { save: async () => { throw new Error("fixture failure") } })
  await assert.rejects(remote.enable(), /無法保存/)
  assert.equal(remote.config, null)
  assert.deepEqual(runner.calls, ["status --json"])
})

test("discovery reports missing CLI, login and invalid DNS without persistence and permits retry", async () => {
  for (const [status, message] of [
    [Object.assign(new Error("fixture missing"), { code: "ENOENT" }), /找不到/],
    [{ BackendState: "NeedsLogin" }, /尚未登入/],
    [{ BackendState: "Running", Self: { Online: true, DNSName: "https://evil.example/" } }, /DNSName/],
  ] as const) {
    const runner = new TailnetFixture()
    const validStatus = runner.status
    runner.status = status
    const remote = controller(runner)
    await assert.rejects(remote.enable(), message)
    assert.equal(remote.config, null)
    runner.status = validStatus
    assert.equal((await remote.enable()).registration.state, "verified")
  }
})

test("concurrent enables are singleflight; close during persistence prevents any subsequent mutation", async () => {
  const runner = new TailnetFixture()
  let release!: () => void
  let started!: () => void
  const saving = new Promise<void>((resolve) => { started = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  let saves = 0
  const remote = controller(runner, { save: async () => { saves++; started(); await gate } })
  const first = remote.enable()
  assert.equal(remote.enable(), first)
  await saving
  const closing = remote.close()
  release()
  await assert.rejects(first, /正在關閉/)
  await closing
  assert.equal(saves, 1)
  assert.equal(remote.config, null)
  assert.deepEqual(runner.calls, ["status --json"])
  await assert.rejects(remote.enable(), /正在關閉/)
})

test("saved nonsecret profile validates on restart, startup registration uses it, explicit env overrides fail closed", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "omw-remote-profile-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new RemoteProfileStore(directory)
  assert.equal(await startupRemoteAccess({}, 4174, store), null)
  await controller(new TailnetFixture(), store).enable()
  const text = await readFile(path.join(directory, "remote-access.json"), "utf8")
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ["hostname", "instancePortMax", "instancePortMin", "managerPublicPort"])
  const config = await startupRemoteAccess({}, 4174, store)
  assert.ok(config)
  const runner = new TailnetFixture()
  const restarted = new RemoteAccessController({ managerPort: 4174, remoteAccess: config, portPool: { min: config.instancePortMin, max: config.instancePortMax }, store, disabled: false, executable: "fixture-only", runner })
  assert.equal((await restarted.register("startup")).registration.state, "verified")
  assert.equal(await startupRemoteAccess({ OMW_REMOTE_ACCESS: "0" }, 4174, store), null)
  await assert.rejects(startupRemoteAccess({ OMW_REMOTE_ACCESS: "1" }, 4174, store), /EXPECTED_LOOPBACK_ORIGIN/)
  await writeFile(path.join(directory, "remote-access.json"), '{"hostname":"invalid"}')
  await assert.rejects(startupRemoteAccess({}, 4174, store), /profile/)
})

test("an older loopback status read cannot overwrite activated remote policy", async () => {
  const runner = new TailnetFixture()
  const original = runner.execFile.bind(runner)
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let first = true
  runner.execFile = async (...args) => {
    if (first) { first = false; await gate }
    return original(...args)
  }
  const remote = controller(runner)
  const stale = remote.get()
  await remote.enable()
  release()
  assert.equal((await stale).mode, "tailnet")
  assert.equal((await stale).remoteAccess, "enabled")
  await remote.close()
})

test("HTTP shutdown stops an in-flight enable before draining the request", async () => {
  const runner = new TailnetFixture()
  let release!: () => void
  let notifySaving!: () => void
  let notifyClosing!: () => void
  const saving = new Promise<void>((resolve) => { notifySaving = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const beganClosing = new Promise<void>((resolve) => { notifyClosing = resolve })
  const remote = controller(runner, { save: async () => { notifySaving(); await gate } })
  const originalClose = remote.close.bind(remote)
  remote.close = () => { const promise = originalClose(); notifyClosing(); return promise }
  const app = appFor(remote)
  const request = app.inject({ method: "POST", url: "/api/v1/connectivity/enable", headers, payload: { confirmed: true } }).then((response) => response)
  await saving
  const closing = app.close()
  await beganClosing
  release()
  assert.equal((await request).statusCode, 503)
  await closing
  assert.equal(remote.config, null)
  assert.deepEqual(runner.calls, ["status --json"])
})

test("disabled override does not discover; live runtime keeps local URLs until activation", async () => {
  const runner = new TailnetFixture()
  const disabled = controller(runner, undefined, true)
  await assert.rejects(disabled.enable(), /已明確停用/)
  assert.deepEqual(runner.calls, [])
  const remote = controller(runner)
  const runtime = new OpenCodeRuntime({ executable: process.execPath, dataDirectory: "fixture-only", publicOriginForPort: (port) => remote.remoteOriginForPort(port) })
  const instance = { port: 42000, endpoint: "http://127.0.0.1:42000", projectDirectory: "C:\\fixture" }
  assert.equal(runtime.remoteUrlUnavailableReason(instance), null)
  assert.ok(runtime.openUrl(instance).startsWith(instance.endpoint))
  await remote.enable()
  assert.ok(runtime.openUrl(instance).startsWith(`https://${host}:42000`))
})
