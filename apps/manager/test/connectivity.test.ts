import assert from "node:assert/strict"
import process from "node:process"
import test from "node:test"
import type { ConnectivityInfo } from "@omw/contracts"
import { buildApp } from "../src/app.js"
import { SeparateRequestAuthenticator, type StoredCredentials } from "../src/auth.js"
import type { RemoteAccessConfig } from "../src/config.js"
import { ConnectivityService, type CommandRunner, tailscaleExecutable } from "../src/connectivity.js"
import type { ManagerService } from "../src/service.js"

const MANAGER_PORT = 4_174
const PUBLIC_PORT = 8_443
const HOST = "safe-device.example.ts.net"
const POOL = { min: 42_000, max: 42_002 }
const EXECUTABLE = "C:\\fixture\\tailscale.exe"

type RunnerOptions = Parameters<CommandRunner["execFile"]>[2]
type RunnerResponse = string | Error | Promise<string>

class FakeRunner implements CommandRunner {
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
    registration: { state: "verified", trigger: null, diagnostic: null },
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
    { name: "extra handler", serve: serveFixture({ extraManagerHandler: true }), managerMapped: false },
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
      assert.equal(info.manager.publicUrl, null)
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
  let monotonicNow = 0
  const connectivity = provider(runner, () => now, () => monotonicNow)

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
  monotonicNow = 5_001
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
  let monotonicNow = 0
  const connectivity = provider(runner, () => now, () => monotonicNow)

  assert.equal((await connectivity.get()).tailscale.state, "unknown")
  responses["status --json"] = statusFixture()
  responses["serve status --json"] = serveFixture()
  assert.equal((await connectivity.get()).tailscale.state, "unknown")
  assert.equal(runner.calls.length, 2)

  now = new Date("2026-09-18T12:00:05.001Z")
  monotonicNow = 5_001
  const recovered = await connectivity.get()
  assert.equal(recovered.tailscale.state, "connected")
  assert.equal(recovered.serve.state, "verified")
  assert.equal(runner.calls.length, 4)
})

test("an older GET snapshot cannot overwrite a completed registration", async () => {
  let releaseOldServe!: (value: string) => void
  let notifyOldServeStarted!: () => void
  const oldServeStarted = new Promise<void>((resolve) => { notifyOldServeStarted = resolve })
  const oldServe = new Promise<string>((resolve) => { releaseOldServe = resolve })
  const configuredPorts = new Set<number>()
  let serveReads = 0
  const runner: CommandRunner = {
    async execFile(_executable, args) {
      if (args.join(" ") === "status --json") return { stdout: statusFixture() }
      if (args.join(" ") === "serve status --json") {
        serveReads++
        if (serveReads === 1) {
          notifyOldServeStarted()
          return { stdout: await oldServe }
        }
        return {
          stdout: serveFixture({
            includeManager: configuredPorts.has(PUBLIC_PORT),
            instancePorts: [...configuredPorts].filter((port) => port !== PUBLIC_PORT),
          }),
        }
      }
      const portArgument = args.find((argument) => argument.startsWith("--https="))
      if (args[0] === "serve" && portArgument) {
        configuredPorts.add(Number(portArgument.slice("--https=".length)))
        return { stdout: "" }
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`)
    },
  }
  const connectivity = provider(runner)

  const staleGet = connectivity.get()
  await oldServeStarted
  const registered = await connectivity.register("manual")
  assert.equal(registered.registration.state, "verified")

  releaseOldServe("{}")
  const staleResult = await staleGet
  assert.equal(staleResult.registration.state, "verified")
  assert.equal(staleResult.manager.publicUrl, remoteConfig().publicManagerOrigin)
  assert.equal(connectivity.remoteOriginForPort(42_000), `https://${HOST}:42000`)
})

test("remote instance URLs remain unavailable until a complete snapshot is verified", async () => {
  const responses: Record<string, RunnerResponse> = {
    "status --json": statusFixture(),
    "serve status --json": "{}",
  }
  const runner = new FakeRunner(responses)
  let now = new Date("2026-09-18T12:00:00.000Z")
  let monotonicNow = 0
  const connectivity = provider(runner, () => now, () => monotonicNow)

  assert.equal((await connectivity.get()).manager.publicUrl, null)
  assert.throws(() => connectivity.remoteOriginForPort(42_000), /尚未通過驗證/)

  responses["serve status --json"] = serveFixture()
  now = new Date("2026-09-18T12:00:05.001Z")
  monotonicNow = 5_001
  assert.equal((await connectivity.get()).registration.state, "verified")
  assert.equal(connectivity.remoteOriginForPort(42_000), `https://${HOST}:42000`)

  responses["serve status --json"] = "{}"
  now = new Date("2026-09-18T12:00:10.002Z")
  monotonicNow = 10_002
  assert.equal((await connectivity.get()).registration.state, "idle")
  assert.throws(() => connectivity.remoteOriginForPort(42_000), /尚未通過驗證/)
})

test("remote URL TTL uses monotonic time when wall time rolls back and can recover", async () => {
  const responses: Record<string, RunnerResponse> = {
    "status --json": statusFixture(),
    "serve status --json": serveFixture(),
  }
  const runner = new FakeRunner(responses)
  let now = new Date("2026-09-18T12:00:00.000Z")
  let monotonicNow = 0
  const connectivity = provider(runner, () => now, () => monotonicNow)

  await connectivity.ensureRemoteOriginForPort(42_000)
  responses["serve status --json"] = "{}"
  now = new Date("2026-09-18T11:00:00.000Z")
  monotonicNow = 5_001
  assert.throws(() => connectivity.remoteOriginForPort(42_000), /尚未通過驗證/)
  await assert.rejects(connectivity.ensureRemoteOriginForPort(42_000), /尚未通過驗證/)

  responses["serve status --json"] = serveFixture()
  now = new Date("2026-09-18T10:00:00.000Z")
  monotonicNow = 10_002
  await connectivity.ensureRemoteOriginForPort(42_000)
  assert.equal(connectivity.remoteOriginForPort(42_000), `https://${HOST}:42000`)
})

test("registration preflights every target, adds only missing mappings, then verifies fresh state", async () => {
  const runner = new RegistrationRunner([
    "{}",
    serveFixture({ instancePorts: [] }),
    serveFixture({ instancePorts: [42_000] }),
    serveFixture({ instancePorts: [42_000, 42_001] }),
    serveFixture(),
  ])
  const connectivity = provider(runner)

  const first = connectivity.register("startup")
  const second = connectivity.register("manual")
  assert.strictEqual(first, second, "concurrent registration attempts are coalesced")
  const result = await first

  assert.equal(result.registration.state, "verified")
  assert.equal(result.registration.trigger, "startup")
  assert.equal(result.manager.publicUrl, `https://${HOST}:${PUBLIC_PORT}`)
  assert.deepEqual(runner.calls.map((call) => call.args), [
    ["status", "--json"],
    ["serve", "status", "--json"],
    ["serve", "--bg", "--yes", `--https=${PUBLIC_PORT}`, `http://127.0.0.1:${MANAGER_PORT}`],
    ["status", "--json"],
    ["serve", "status", "--json"],
    ["serve", "--bg", "--yes", "--https=42000", "http://127.0.0.1:42000"],
    ["status", "--json"],
    ["serve", "status", "--json"],
    ["serve", "--bg", "--yes", "--https=42001", "http://127.0.0.1:42001"],
    ["status", "--json"],
    ["serve", "status", "--json"],
    ["serve", "--bg", "--yes", "--https=42002", "http://127.0.0.1:42002"],
    ["status", "--json"],
    ["serve", "status", "--json"],
  ])
})

test("registration fails closed before mutation when a target has extra handlers", async () => {
  const runner = new RegistrationRunner([serveFixture({ extraManagerHandler: true })])

  const result = await provider(runner).register("manual")

  assert.equal(result.registration.state, "failed")
  assert.equal(result.registration.trigger, "manual")
  assert.equal(result.registration.diagnostic?.code, "TARGET_CONFLICT")
  assert.equal(result.manager.publicUrl, null)
  assert.deepEqual(runner.calls.map((call) => call.args), [["status", "--json"], ["serve", "status", "--json"]])
})

test("registration rechecks every target before each mutation and stops on a newly observed conflict", async () => {
  const runner = new RegistrationRunner([
    "{}",
    serveFixture({ instancePorts: [42_001], conflictingInstancePort: 42_001 }),
  ])

  const result = await provider(runner).register("manual")

  assert.equal(result.registration.state, "failed")
  assert.equal(result.registration.diagnostic?.code, "TARGET_CONFLICT")
  assert.deepEqual(
    runner.calls.filter((call) => call.args[0] === "serve" && call.args[1] !== "status").map((call) => call.args),
    [["serve", "--bg", "--yes", `--https=${PUBLIC_PORT}`, `http://127.0.0.1:${MANAGER_PORT}`]],
  )
})

test("successful Serve command exit is not accepted without fresh mapping verification", async () => {
  const runner = new RegistrationRunner(["{}", "{}"])

  const result = await provider(runner).register("manual")

  assert.equal(result.registration.state, "failed")
  assert.equal(result.registration.diagnostic?.code, "VERIFICATION_FAILED")
  assert.equal(result.manager.publicUrl, null)
  assert.equal(runner.calls.filter((call) => call.args[0] === "serve" && call.args[1] !== "status").length, 1)
  assert.equal(runner.calls.filter((call) => call.args.join(" ") === "serve status --json").length, 2)
})

test("registration checks the configured node DNS before any Serve mutation", async () => {
  const runner = new FakeRunner({
    "status --json": statusFixture({ dnsName: "other-safe.example.ts.net." }),
    "serve status --json": "{}",
  })

  const result = await provider(runner).register("startup")

  assert.equal(result.registration.state, "failed")
  assert.equal(result.registration.diagnostic?.code, "DNS_MISMATCH")
  assert.deepEqual(runner.calls.map((call) => call.args), [["status", "--json"], ["serve", "status", "--json"]])
})

test("registration preserves completed entries after a partial failure and safely resumes", async () => {
  const partial = serveFixture({ instancePorts: [42_000] })
  const runner = new RegistrationRunner([
    "{}",
    serveFixture({ instancePorts: [] }),
    partial,
    partial,
    serveFixture({ instancePorts: [42_000, 42_001] }),
    serveFixture(),
  ], "--https=42001")
  const connectivity = provider(runner)

  const failed = await connectivity.register("startup")
  assert.equal(failed.registration.diagnostic?.code, "COMMAND_FAILED")
  const recovered = await connectivity.register("manual")

  assert.equal(recovered.registration.state, "verified")
  assert.equal(runner.calls.filter((call) => call.args.includes(`--https=${PUBLIC_PORT}`)).length, 1)
  assert.equal(runner.calls.filter((call) => call.args.includes("--https=42000")).length, 1)
  assert.equal(runner.calls.filter((call) => call.args.includes("--https=42001")).length, 2)
  assert.equal(runner.calls.filter((call) => call.args.includes("--https=42002")).length, 1)
})

test("registration bounds each command by the remaining deadline and starts no later read", async () => {
  let monotonicNow = 0
  const calls: Array<{ args: readonly string[]; timeout: number }> = []
  const runner: CommandRunner = {
    async execFile(_executable, args, options) {
      calls.push({ args: [...args], timeout: options.timeout })
      if (args.join(" ") === "status --json") {
        monotonicNow = 29_999.6
        return { stdout: statusFixture() }
      }
      if (args.join(" ") === "serve status --json") {
        return { stdout: "{}" }
      }
      if (args[0] === "serve" && args.includes(`--https=${PUBLIC_PORT}`)) {
        monotonicNow = 30_000
        return { stdout: "" }
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`)
    },
  }
  const connectivity = new ConnectivityService({
    managerPort: MANAGER_PORT,
    remoteAccess: remoteConfig(),
    portPool: POOL,
    executable: EXECUTABLE,
    runner,
    now: () => new Date("2026-09-18T12:00:00.000Z"),
    monotonicNow: () => monotonicNow,
    registrationDeadlineMs: 30_000,
  })

  const result = await connectivity.register("manual")

  assert.equal(result.registration.diagnostic?.code, "REGISTRATION_TIMEOUT")
  assert.deepEqual(calls.map((call) => call.args), [
    ["status", "--json"],
    ["serve", "status", "--json"],
    ["serve", "--bg", "--yes", `--https=${PUBLIC_PORT}`, `http://127.0.0.1:${MANAGER_PORT}`],
  ])
  assert.deepEqual(calls.map((call) => call.timeout), [2_500, 1, 1])
})

test("registration checks its deadline before retrying a stale snapshot", async () => {
  let releaseOldServe!: () => void
  let notifyOldServeStarted!: () => void
  const oldServeStarted = new Promise<void>((resolve) => { notifyOldServeStarted = resolve })
  const oldServe = new Promise<void>((resolve) => { releaseOldServe = resolve })
  let monotonicNow = 0
  let serveReads = 0
  const calls: string[][] = []
  const runner: CommandRunner = {
    async execFile(_executable, args) {
      calls.push([...args])
      if (args.join(" ") === "status --json") return { stdout: statusFixture() }
      if (args.join(" ") !== "serve status --json") throw new Error(`Unexpected command: ${args.join(" ")}`)
      serveReads += 1
      if (serveReads === 1) {
        notifyOldServeStarted()
        await oldServe
      }
      if (serveReads > 2) throw new Error("Registration started a read after its deadline")
      return { stdout: "{}" }
    },
  }
  const connectivity = new ConnectivityService({
    managerPort: MANAGER_PORT,
    remoteAccess: remoteConfig(),
    portPool: POOL,
    executable: EXECUTABLE,
    runner,
    now: () => new Date("2026-09-18T12:00:00.000Z"),
    monotonicNow: () => monotonicNow,
    registrationDeadlineMs: 30_000,
  })

  const registration = connectivity.register("manual")
  await oldServeStarted
  await connectivity.get()
  monotonicNow = 30_000
  releaseOldServe()

  const result = await registration
  assert.equal(result.registration.diagnostic?.code, "REGISTRATION_TIMEOUT")
  assert.equal(calls.length, 4)
})

test("an already expired registration returns a safe snapshot without running CLI", async () => {
  const calls: string[][] = []
  const runner: CommandRunner = {
    async execFile(_executable, args) {
      calls.push([...args])
      throw new Error("CLI must not run after the registration deadline")
    },
  }
  const connectivity = new ConnectivityService({
    managerPort: MANAGER_PORT,
    remoteAccess: remoteConfig(),
    portPool: POOL,
    executable: EXECUTABLE,
    runner,
    now: () => new Date("2026-09-18T12:00:00.000Z"),
    monotonicNow: () => 0,
    registrationDeadlineMs: 0,
  })

  const result = await connectivity.register("manual")

  assert.equal(result.registration.diagnostic?.code, "REGISTRATION_TIMEOUT")
  assert.equal(result.tailscale.state, "unknown")
  assert.equal(result.serve.state, "unknown")
  assert.equal(result.manager.publicUrl, null)
  assert.equal(result.manager.localUrl, `http://127.0.0.1:${MANAGER_PORT}`)
  assert.deepEqual(calls, [])
})

test("close waits for the bounded command and prevents later Serve mutations", async () => {
  let releaseMutation!: () => void
  let signalMutationStarted!: () => void
  const mutationStarted = new Promise<void>((resolve) => { signalMutationStarted = resolve })
  const mutationReleased = new Promise<void>((resolve) => { releaseMutation = resolve })
  let managerMapped = false
  const calls: string[][] = []
  const runner: CommandRunner = {
    async execFile(_executable, args) {
      calls.push([...args])
      if (args.join(" ") === "status --json") return { stdout: statusFixture() }
      if (args.join(" ") === "serve status --json") {
        return { stdout: managerMapped ? serveFixture({ instancePorts: [] }) : "{}" }
      }
      if (args[0] === "serve" && args.includes(`--https=${PUBLIC_PORT}`)) {
        signalMutationStarted()
        await mutationReleased
        managerMapped = true
        return { stdout: "" }
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`)
    },
  }
  const connectivity = provider(runner)
  const registration = connectivity.register("startup")
  await mutationStarted

  let closeCompleted = false
  const close = connectivity.close().then(() => { closeCompleted = true })
  await Promise.resolve()
  assert.equal(closeCompleted, false)
  releaseMutation()

  const [result] = await Promise.all([registration, close])
  assert.equal(result.registration.diagnostic?.code, "REGISTRATION_STOPPED")
  const mutationCount = calls.filter((args) => args[0] === "serve" && args[1] !== "status").length
  assert.equal(mutationCount, 1)

  const afterClose = await connectivity.register("manual")
  assert.equal(afterClose.registration.diagnostic?.code, "REGISTRATION_STOPPED")
  assert.equal(calls.filter((args) => args[0] === "serve" && args[1] !== "status").length, 1)
})

test("registration mutation retains authority, auth, origin, and CSRF protections", async (t) => {
  const runner = new RegistrationRunner([serveFixture()])
  const connectivity = provider(runner)
  const credentials: StoredCredentials = {
    manager: { username: "fixture-user", password: "fixture-password" },
    launcherToken: "fixture-launcher-token",
  }
  const publicOrigin = remoteConfig().publicManagerOrigin
  const host = new URL(publicOrigin).host
  const authorization = `Basic ${Buffer.from("fixture-user:fixture-password").toString("base64")}`
  const app = buildApp({
    service: fakeService(),
    connectivity,
    authority: { hostname: "127.0.0.1", port: MANAGER_PORT },
    allowedOrigins: new Set([`http://127.0.0.1:${MANAGER_PORT}`, publicOrigin]),
    publicOrigin,
    authenticator: new SeparateRequestAuthenticator(credentials),
  })
  t.after(async () => await app.close())

  assert.equal((await app.inject({ method: "POST", url: "/api/v1/connectivity/register", headers: { host } })).statusCode, 401)
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/connectivity/register", headers: { host, origin: publicOrigin, authorization } })).statusCode, 403)
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/connectivity/register",
    headers: { host, origin: publicOrigin, authorization, "x-omw-csrf": "1" },
  })
  assert.equal(response.statusCode, 200)
  assert.equal(response.json().registration.trigger, "manual")
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
  assert.deepEqual(info.registration, { state: "not-configured", trigger: null, diagnostic: null })
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

function provider(
  runner: CommandRunner,
  now: () => Date = () => new Date("2026-09-18T12:00:00.000Z"),
  monotonicNow: () => number = () => 0,
): ConnectivityService {
  return new ConnectivityService({
    managerPort: MANAGER_PORT,
    remoteAccess: remoteConfig(),
    portPool: POOL,
    executable: EXECUTABLE,
    runner,
    now,
    monotonicNow,
  })
}

class RegistrationRunner implements CommandRunner {
  readonly calls: Array<{ executable: string; args: readonly string[]; options: RunnerOptions }> = []

  private failedOnce = false

  constructor(private readonly serveStatuses: string[], private readonly failArgumentOnce?: string) {}

  async execFile(executable: string, args: readonly string[], options: RunnerOptions): Promise<{ stdout: string }> {
    this.calls.push({ executable, args: [...args], options })
    if (args.join(" ") === "status --json") return { stdout: statusFixture() }
    if (args.join(" ") === "serve status --json") {
      const stdout = this.serveStatuses.shift()
      if (stdout === undefined) throw new Error("Missing Serve status fixture")
      return { stdout }
    }
    if (args[0] === "serve" && args.includes("--bg") && args.includes("--yes")) {
      if (this.failArgumentOnce && args.includes(this.failArgumentOnce) && !this.failedOnce) {
        this.failedOnce = true
        throw new Error("fixture command failure")
      }
      return { stdout: "" }
    }
    throw new Error(`Unexpected command: ${args.join(" ")}`)
  }
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
  includeManager?: boolean
  managerPublicPort?: number
  managerTarget?: string
  managerHttps?: boolean
  managerTcpForward?: string
  managerTerminateTls?: string
  extraManagerHandler?: boolean
  instancePorts?: number[]
  conflictingInstancePort?: number
  funnel?: boolean
} = {}): string {
  const host = options.host ?? HOST
  const managerPublicPort = options.managerPublicPort ?? PUBLIC_PORT
  const tcp: Record<string, unknown> = options.includeManager === false ? {} : {
    [String(managerPublicPort)]: {
      HTTPS: options.managerHttps ?? true,
      ...(options.managerTcpForward ? { TCPForward: options.managerTcpForward } : {}),
      ...(options.managerTerminateTls ? { TerminateTLS: options.managerTerminateTls } : {}),
    },
  }
  const web: Record<string, unknown> = options.includeManager === false ? {} : {
    [`${host}:${managerPublicPort}`]: {
      Handlers: {
        "/": { Proxy: options.managerTarget ?? `http://127.0.0.1:${MANAGER_PORT}` },
        ...(options.extraManagerHandler ? { "/admin": { Proxy: "http://127.0.0.1:9999" } } : {}),
      },
    },
  }
  for (const port of options.instancePorts ?? [42_000, 42_001, 42_002]) {
    tcp[String(port)] = { HTTPS: true }
    web[`${host}:${port}`] = {
      Handlers: { "/": { Proxy: `http://127.0.0.1:${port === options.conflictingInstancePort ? 49_999 : port}` } },
    }
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
