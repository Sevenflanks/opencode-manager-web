import assert from "node:assert/strict"
import process from "node:process"
import test from "node:test"
import type { ConnectivityInfo } from "@omw/contracts"
import { buildApp } from "../src/app.js"
import { SeparateRequestAuthenticator, type StoredCredentials } from "../src/auth.js"
import type { RemoteAccessConfig } from "../src/config.js"
import { ConnectivityService, type ReadonlyCommandRunner, tailscaleExecutable } from "../src/connectivity.js"
import type { ManagerService } from "../src/service.js"

const MANAGER_PORT = 4_174
const PUBLIC_PORT = 8_443
const HOST = "safe-device.example.ts.net"
const POOL = { min: 42_000, max: 42_002 }
const EXECUTABLE = "C:\\fixture\\tailscale.exe"

type RunnerOptions = Parameters<ReadonlyCommandRunner["execFile"]>[2]
type RunnerResponse = string | Error | Promise<string>

class FakeRunner implements ReadonlyCommandRunner {
  readonly calls: Array<{ executable: string; args: readonly string[]; options: RunnerOptions }> = []

  constructor(private readonly responses: Record<string, RunnerResponse>) {}

  async execFile(executable: string, args: readonly string[], options: RunnerOptions): Promise<{ stdout: string }> {
    this.calls.push({ executable, args: [...args], options })
    const response = this.responses[args.join(" ")]
    if (response === undefined) throw new Error(`Unexpected command: ${args.join(" ")}`)
    if (response instanceof Error) throw response
    return { stdout: await response }
  }
}

test("connectivity API is authority/auth protected and returns only verified safe fields", async (t) => {
  const runner = new FakeRunner({
    "status --json": statusFixture(),
    "serve status --json": serveFixture(),
  })
  const connectivity = provider(runner)
  const credentials: StoredCredentials = {
    manager: { username: "fixture-user", password: "fixture-password" },
    launcherToken: "fixture-launcher-token",
  }
  const publicOrigin = remoteConfig().publicManagerOrigin
  const app = buildApp({
    service: fakeService(),
    connectivity,
    authority: { hostname: "127.0.0.1", port: MANAGER_PORT },
    allowedOrigins: new Set([`http://127.0.0.1:${MANAGER_PORT}`, publicOrigin]),
    publicOrigin,
    authenticator: new SeparateRequestAuthenticator(credentials),
  })
  t.after(async () => await app.close())
  const host = new URL(publicOrigin).host
  const authorization = `Basic ${Buffer.from("fixture-user:fixture-password").toString("base64")}`

  const unauthorized = await app.inject({ method: "GET", url: "/api/v1/connectivity", headers: { host } })
  assert.equal(unauthorized.statusCode, 401)

  const foreignOrigin = await app.inject({
    method: "GET",
    url: "/api/v1/connectivity",
    headers: { host, origin: "https://attacker.example", authorization },
  })
  assert.equal(foreignOrigin.statusCode, 403)
  assert.equal(foreignOrigin.json().error.code, "UNTRUSTED_ORIGIN")

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/connectivity",
    headers: { host, origin: publicOrigin, authorization },
  })
  assert.equal(response.statusCode, 200)
  const body = response.json() as ConnectivityInfo
  assert.deepEqual(body, {
    checkedAt: "2026-09-18T12:00:00.000Z",
    mode: "tailnet",
    manager: { localUrl: `http://127.0.0.1:${MANAGER_PORT}`, publicUrl: publicOrigin },
    tailscale: { state: "connected", dnsName: HOST, version: "1.90.2" },
    serve: {
      state: "verified",
      managerMapped: true,
      mappedInstancePorts: 3,
      expectedInstancePorts: 3,
      funnel: "disabled",
    },
    nodeVersion: process.version,
  })
  assert.doesNotMatch(response.body, /secret-peer|node-secret|fixture@example|login-token/)
  assert.deepEqual(runner.calls.map((call) => call.args), [["status", "--json"], ["serve", "status", "--json"]])
  for (const call of runner.calls) {
    assert.equal(call.executable, EXECUTABLE)
    assert.deepEqual(call.options, {
      encoding: "utf8",
      maxBuffer: 1_048_576,
      shell: false,
      timeout: 2_500,
      windowsHide: true,
    })
  }
})

test("Serve verification rejects wrong host, port, target, TCP modes, and device hostname", async (t) => {
  const cases: Array<{ name: string; status?: string; serve: string; managerMapped: boolean }> = [
    { name: "host", serve: serveFixture({ host: "other-safe.example.ts.net" }), managerMapped: false },
    { name: "port", serve: serveFixture({ managerPublicPort: 9_443 }), managerMapped: false },
    { name: "target", serve: serveFixture({ managerTarget: "http://127.0.0.1:9999" }), managerMapped: false },
    { name: "TLS", serve: serveFixture({ managerHttps: false }), managerMapped: false },
    { name: "plain TCP forwarding", serve: serveFixture({ managerTcpForward: "127.0.0.1:4174" }), managerMapped: false },
    { name: "TLS termination forwarding", serve: serveFixture({ managerTerminateTls: "127.0.0.1:4174" }), managerMapped: false },
    { name: "device hostname", status: statusFixture({ dnsName: "other-safe.example.ts.net." }), serve: serveFixture(), managerMapped: true },
  ]
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const info = await provider(new FakeRunner({
        "status --json": entry.status ?? statusFixture(),
        "serve status --json": entry.serve,
      })).get()
      assert.equal(info.serve.state, "mismatch")
      assert.equal(info.serve.managerMapped, entry.managerMapped)
    })
  }
})

test("status failures distinguish disconnected, login, unavailable, malformed, and timeout", async (t) => {
  const missing = commandError("ENOENT")
  const timeout = commandError("ETIMEDOUT")
  const permission = commandError("EACCES")
  const cases: Array<{ name: string; response: RunnerResponse; expected: ConnectivityInfo["tailscale"]["state"] }> = [
    { name: "disconnected", response: statusFixture({ backendState: "Stopped", online: false }), expected: "offline" },
    { name: "needs login", response: statusFixture({ backendState: "NeedsLogin", online: false }), expected: "needs-login" },
    { name: "missing executable", response: missing, expected: "unavailable" },
    { name: "malformed JSON", response: "not-json", expected: "unknown" },
    { name: "timeout", response: timeout, expected: "unknown" },
    { name: "permission denied", response: permission, expected: "unknown" },
    { name: "Running without Online true", response: statusFixture({ includeOnline: false }), expected: "unknown" },
  ]
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const info = await provider(new FakeRunner({
        "status --json": entry.response,
        "serve status --json": serveFixture(),
      })).get()
      assert.equal(info.tailscale.state, entry.expected)
    })
  }
})

test("Serve schema uncertainty and foreground configuration never report verified", async (t) => {
  const timeout = commandError("ETIMEDOUT")
  const cases: Array<{ name: string; response: RunnerResponse }> = [
    { name: "malformed JSON", response: "{" },
    { name: "timeout", response: timeout },
    { name: "malformed map", response: JSON.stringify({ Web: [], TCP: {} }) },
    { name: "malformed funnel", response: JSON.stringify({ Web: {}, TCP: {}, AllowFunnel: { [`${HOST}:${PUBLIC_PORT}`]: "true" } }) },
    {
      name: "foreground",
      response: JSON.stringify({
        ...JSON.parse(serveFixture()),
        Foreground: { session: JSON.parse(serveFixture()) },
      }),
    },
  ]
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const info = await provider(new FakeRunner({
        "status --json": statusFixture(),
        "serve status --json": entry.response,
      })).get()
      assert.equal(info.serve.state, "unknown")
      assert.equal(info.serve.managerMapped, null)
      assert.equal(info.serve.mappedInstancePorts, null)
      assert.equal(info.serve.funnel, "unknown")
    })
  }
})

test("Serve reports partial pool count, empty remote config mismatch, and enabled Funnel", async (t) => {
  await t.test("partial pool", async () => {
    const info = await provider(new FakeRunner({
      "status --json": statusFixture(),
      "serve status --json": serveFixture({ instancePorts: [42_000, 42_002] }),
    })).get()
    assert.equal(info.serve.state, "mismatch")
    assert.equal(info.serve.mappedInstancePorts, 2)
    assert.equal(info.serve.expectedInstancePorts, 3)
  })

  await t.test("empty config", async () => {
    const info = await provider(new FakeRunner({
      "status --json": statusFixture(),
      "serve status --json": "{}",
    })).get()
    assert.equal(info.serve.state, "mismatch")
    assert.equal(info.serve.managerMapped, false)
    assert.equal(info.serve.mappedInstancePorts, 0)
    assert.equal(info.serve.funnel, "disabled")
  })

  await t.test("Funnel enabled", async () => {
    const info = await provider(new FakeRunner({
      "status --json": statusFixture(),
      "serve status --json": serveFixture({ funnel: true }),
    })).get()
    assert.equal(info.serve.state, "verified")
    assert.equal(info.serve.funnel, "enabled")
  })
})

test("cache coalesces concurrent callers and refreshes after five seconds", async () => {
  let resolveStatus!: (value: string) => void
  let resolveServe!: (value: string) => void
  const status = new Promise<string>((resolve) => { resolveStatus = resolve })
  const serve = new Promise<string>((resolve) => { resolveServe = resolve })
  const runner = new FakeRunner({ "status --json": status, "serve status --json": serve })
  let now = new Date("2026-09-18T12:00:00.000Z")
  const connectivity = provider(runner, () => now)

  const first = connectivity.get()
  const second = connectivity.get()
  assert.equal(runner.calls.length, 2)
  resolveStatus(statusFixture())
  resolveServe(serveFixture())
  assert.strictEqual(await first, await second)

  const cached = await connectivity.get()
  assert.equal(cached.checkedAt, "2026-09-18T12:00:00.000Z")
  assert.equal(runner.calls.length, 2)

  now = new Date("2026-09-18T12:00:05.001Z")
  const refreshed = await connectivity.get()
  assert.equal(refreshed.checkedAt, "2026-09-18T12:00:05.001Z")
  assert.equal(runner.calls.length, 4)
})

test("cached command errors retry normally after the TTL", async () => {
  const responses: Record<string, RunnerResponse> = {
    "status --json": commandError("ETIMEDOUT"),
    "serve status --json": commandError("ETIMEDOUT"),
  }
  const runner = new FakeRunner(responses)
  let now = new Date("2026-09-18T12:00:00.000Z")
  const connectivity = provider(runner, () => now)

  assert.equal((await connectivity.get()).tailscale.state, "unknown")
  responses["status --json"] = statusFixture()
  responses["serve status --json"] = serveFixture()
  assert.equal((await connectivity.get()).tailscale.state, "unknown")
  assert.equal(runner.calls.length, 2)

  now = new Date("2026-09-18T12:00:05.001Z")
  const recovered = await connectivity.get()
  assert.equal(recovered.tailscale.state, "connected")
  assert.equal(recovered.serve.state, "verified")
  assert.equal(runner.calls.length, 4)
})

test("loopback mode skips Serve and legacy buildApp returns a safe fallback", async (t) => {
  const runner = new FakeRunner({ "status --json": statusFixture() })
  const connectivity = new ConnectivityService({
    managerPort: MANAGER_PORT,
    remoteAccess: null,
    portPool: POOL,
    executable: EXECUTABLE,
    runner,
    now: () => new Date("2026-09-18T12:00:00.000Z"),
  })
  const info = await connectivity.get()
  assert.equal(info.mode, "loopback")
  assert.deepEqual(info.manager, { localUrl: `http://127.0.0.1:${MANAGER_PORT}`, publicUrl: null })
  assert.deepEqual(info.serve, {
    state: "not-configured",
    managerMapped: null,
    mappedInstancePorts: null,
    expectedInstancePorts: 3,
    funnel: "unknown",
  })
  assert.deepEqual(runner.calls.map((call) => call.args), [["status", "--json"]])

  const app = buildApp({
    service: fakeService(),
    authority: { hostname: "127.0.0.1", port: MANAGER_PORT },
    allowedOrigins: new Set([`http://127.0.0.1:${MANAGER_PORT}`]),
  })
  t.after(async () => await app.close())
  const response = await app.inject({
    method: "GET",
    url: "/api/v1/connectivity",
    headers: { host: `127.0.0.1:${MANAGER_PORT}` },
  })
  assert.equal(response.statusCode, 200)
  assert.equal(response.json().serve.state, "not-configured")
  assert.equal(response.json().tailscale.state, "unknown")
})

test("Tailscale executable override is trusted startup configuration", () => {
  assert.equal(tailscaleExecutable({ OMW_TAILSCALE_EXECUTABLE: EXECUTABLE }), EXECUTABLE)
  assert.equal(
    tailscaleExecutable({ ProgramFiles: "D:\\Program Files" }),
    "D:\\Program Files\\Tailscale\\tailscale.exe",
  )
})

function provider(runner: ReadonlyCommandRunner, now: () => Date = () => new Date("2026-09-18T12:00:00.000Z")): ConnectivityService {
  return new ConnectivityService({
    managerPort: MANAGER_PORT,
    remoteAccess: remoteConfig(),
    portPool: POOL,
    executable: EXECUTABLE,
    runner,
    now,
  })
}

function remoteConfig(): RemoteAccessConfig {
  const publicManagerOrigin = `https://${HOST}:${PUBLIC_PORT}`
  return {
    publicManagerOrigin,
    expectedLoopbackOrigin: `http://127.0.0.1:${MANAGER_PORT}`,
    instancePortMin: POOL.min,
    instancePortMax: POOL.max,
    instanceOrigin: (port) => `https://${HOST}:${port}`,
  }
}

function fakeService(): ManagerService {
  return { shutdown: async () => undefined } as unknown as ManagerService
}

function statusFixture(options: { backendState?: string; online?: boolean; includeOnline?: boolean; dnsName?: string } = {}): string {
  const self: Record<string, unknown> = {
    DNSName: options.dnsName ?? `${HOST}.`,
    ID: "node-secret",
  }
  if (options.includeOnline !== false) self.Online = options.online ?? true
  return JSON.stringify({
    Version: "1.90.2",
    BackendState: options.backendState ?? "Running",
    Self: self,
    Peer: { "peer-key": { HostName: "secret-peer" } },
    User: { "123": { LoginName: "fixture@example" } },
    AuthURL: "https://login.example/?token=login-token",
  })
}

function serveFixture(options: {
  host?: string
  managerPublicPort?: number
  managerTarget?: string
  managerHttps?: boolean
  managerTcpForward?: string
  managerTerminateTls?: string
  instancePorts?: number[]
  funnel?: boolean
} = {}): string {
  const host = options.host ?? HOST
  const managerPublicPort = options.managerPublicPort ?? PUBLIC_PORT
  const tcp: Record<string, unknown> = {
    [String(managerPublicPort)]: {
      HTTPS: options.managerHttps ?? true,
      ...(options.managerTcpForward ? { TCPForward: options.managerTcpForward } : {}),
      ...(options.managerTerminateTls ? { TerminateTLS: options.managerTerminateTls } : {}),
    },
  }
  const web: Record<string, unknown> = {
    [`${host}:${managerPublicPort}`]: {
      Handlers: { "/": { Proxy: options.managerTarget ?? `http://127.0.0.1:${MANAGER_PORT}` } },
    },
  }
  for (const port of options.instancePorts ?? [42_000, 42_001, 42_002]) {
    tcp[String(port)] = { HTTPS: true }
    web[`${host}:${port}`] = { Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } } }
  }
  return JSON.stringify({
    TCP: tcp,
    Web: web,
    AllowFunnel: { [`${host}:${managerPublicPort}`]: options.funnel ?? false },
  })
}

function commandError(code: string): Error {
  return Object.assign(new Error(code), { code })
}
