import assert from "node:assert/strict"
import type { ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process"
import { EventEmitter } from "node:events"
import path from "node:path"
import { PassThrough } from "node:stream"
import test from "node:test"
import {
  managedArguments,
  planInvocation,
  runDpapi,
  runLauncher,
  type DpapiSpawn,
  type LauncherDependencies,
} from "../src/cli.js"

const credentials = {
  launcherToken: "launcher-test-token-with-at-least-thirty-two-characters",
  openCode: { username: "opencode-user", password: "opencode-test-password" },
}

test("root TUI recognizes both explicit port forms without rewriting them", () => {
  assert.deepEqual(planInvocation(["--port", "42001"]), { managed: true, requestedPort: 42001 })
  assert.deepEqual(planInvocation(["--port=42002", "C:\\project"]), {
    managed: true,
    requestedPort: 42002,
    projectArgument: "C:\\project",
  })
  assert.deepEqual(managedArguments(["--port=42002"], 42009), ["--port=42002", "--hostname", "127.0.0.1"])
  assert.deepEqual(
    managedArguments(["--port", "42001", "--hostname=127.0.0.1", "--", "--port"], 42009),
    ["--port", "42001", "--hostname=127.0.0.1", "--", "--port"],
  )
})

test("managed flags stay before the delimiter and delimiter positionals are never parsed as flags", () => {
  assert.deepEqual(planInvocation(["--", "--port"]), { managed: true, projectArgument: "--port" })
  assert.deepEqual(planInvocation(["--", "run"]), { managed: true, projectArgument: "run" })
  assert.deepEqual(planInvocation(["--", "--help"]), { managed: true, projectArgument: "--help" })
  assert.deepEqual(
    managedArguments(["--", "C:\\work"], 42004),
    ["--hostname", "127.0.0.1", "--port", "42004", "--", "C:\\work"],
  )
})

test("known subcommands and non-loopback hostnames bypass with exact argv", async () => {
  assert.deepEqual(planInvocation(["serve", "--port", "42001"]), { managed: false })
  assert.deepEqual(planInvocation(["completion", "powershell"]), { managed: false })
  assert.deepEqual(planInvocation(["mcp", "list"]), { managed: false })
  assert.deepEqual(planInvocation(["plugin", "example"]), { managed: false })
  assert.deepEqual(planInvocation(["--help"]), { managed: false })
  assert.deepEqual(planInvocation(["-v"]), { managed: false })
  assert.deepEqual(planInvocation(["--mdns-domain", "example.local", "C:\\work"]), {
    managed: true,
    projectArgument: "C:\\work",
  })
  assert.deepEqual(planInvocation(["-m", "provider/model", "C:\\work"]), {
    managed: true,
    projectArgument: "C:\\work",
  })
  assert.equal(planInvocation(["--unknown-root-option", "C:\\work"]).managed, false)
  assert.equal(planInvocation(["C:\\work", "extra-positional"]).managed, false)
  assert.equal(planInvocation(["--hostname=0.0.0.0"]).managed, false)
  const fixture = dependencies()
  const args = ["run", "--model", "test/model", "hello"]
  const code = await runLauncher(args, environment(), "C:\\project", "C:\\launcher.js", fixture.value)
  assert.equal(code, 23)
  assert.deepEqual(fixture.spawns[0]?.args, args)
  assert.equal(fixture.requests.length, 0)
})

test("managed launch reserves before spawn, forwards cwd and terminal, then preserves exit code", async () => {
  const fixture = dependencies()
  const invocationCwd = "C:\\invocation"
  const project = "project with spaces & [fixture]"
  const code = await runLauncher(["--", project], environment(), invocationCwd, "C:\\launcher.js", fixture.value)
  assert.equal(code, 23)
  assert.equal(fixture.requests[0]?.pathname, "/api/v1/launcher/reservations")
  assert.deepEqual(fixture.requests[0]?.body, {
    clientInvocationId: "11111111-1111-4111-8111-111111111111",
    directory: path.resolve(invocationCwd, project),
  })
  assert.deepEqual(fixture.spawns[0]?.args, ["--hostname", "127.0.0.1", "--port", "42004", "--", project])
  assert.equal(fixture.spawns[0]?.options.cwd, invocationCwd)
  assert.equal(fixture.spawns[0]?.options.stdio, "inherit")
  assert.equal(fixture.spawns[0]?.options.shell, false)
  assert.equal((fixture.spawns[0]?.options.env as NodeJS.ProcessEnv).OPENCODE_SERVER_PASSWORD, credentials.openCode.password)
  assert.match(fixture.requests[1]?.pathname ?? "", /\/register$/)
  assert.match(fixture.requests[2]?.pathname ?? "", /\/finalize$/)
})

test("Manager offline or explicit-port collision fails open with untouched argv", async () => {
  for (const message of ["connect ECONNREFUSED", "PORT_UNAVAILABLE: Explicit port 42004 is occupied"]) {
    const fixture = dependencies({ reserveError: new Error(message) })
    const args = ["--port=42004", "C:\\project"]
    const code = await runLauncher(args, environment(), "C:\\project", "C:\\launcher.js", fixture.value)
    assert.equal(code, 23)
    assert.deepEqual(fixture.spawns[0]?.args, args)
    assert.equal((fixture.spawns[0]?.options.env as NodeJS.ProcessEnv).OPENCODE_SERVER_PASSWORD, undefined)
  }

  const delimiterFixture = dependencies({ reserveError: new Error("connect ECONNREFUSED") })
  const delimiterArgs = ["--port=42004", "--", "project with spaces & [fixture]"]
  assert.equal(await runLauncher(delimiterArgs, environment(), "C:\\project", "C:\\launcher.js", delimiterFixture.value), 23)
  assert.deepEqual(delimiterFixture.spawns[0]?.args, delimiterArgs)
})

test("OMW_REQUIRED fails closed and finalize failure cannot change TUI exit", async () => {
  const strictFixture = dependencies({ reserveError: new Error("offline") })
  assert.equal(await runLauncher([], { ...environment(), OMW_REQUIRED: "1" }, "C:\\project", "C:\\launcher.js", strictFixture.value), 70)
  assert.equal(strictFixture.spawns.length, 0)

  const finalizeFixture = dependencies({ finalizeError: new Error("manager stopped") })
  assert.equal(await runLauncher([], environment(), "C:\\project", "C:\\launcher.js", finalizeFixture.value), 23)
})

test("credential helper failure preserves exact argv when fail-open and exits 70 when required", async () => {
  const args = ["--port=42004", "C:\\project with spaces"]
  const failOpen = dependencies({ credentialError: new Error("Windows DPAPI helper 超過 30ms deadline。") })
  assert.equal(await runLauncher(args, environment(), "C:\\project", "C:\\launcher.js", failOpen.value), 23)
  assert.deepEqual(failOpen.spawns[0]?.args, args)

  const required = dependencies({ credentialError: new Error("Windows DPAPI helper 超過 30ms deadline。") })
  assert.equal(await runLauncher(args, { ...environment(), OMW_REQUIRED: "1" }, "C:\\project", "C:\\launcher.js", required.value), 70)
  assert.equal(required.spawns.length, 0)
})

test("DPAPI helper has a bounded deadline and cleans up a child that never closes", async () => {
  const fixture = fakeDpapiChild()
  const startedAt = Date.now()
  await assert.rejects(
    runDpapi("fixture-pwsh", "fixture-helper.ps1", "fixture-ciphertext", {
      spawnProcess: fixture.spawn,
      timeoutMs: 30,
    }),
    /DPAPI helper.*deadline/,
  )
  const elapsedMs = Date.now() - startedAt
  assert.ok(elapsedMs >= 20, "a never-closing helper should settle through the deadline")
  assert.ok(elapsedMs < 500, "helper deadline should reject promptly")
  assert.equal(fixture.kills, 1)
  assert.equal(fixture.child.listenerCount("error"), 0)
  assert.equal(fixture.child.listenerCount("close"), 0)
  assert.equal(fixture.stdout.listenerCount("data"), 0)
  assert.equal(fixture.stderr.listenerCount("data"), 0)
})

test("DPAPI helper bounds output without exposing stderr credentials and clears a successful deadline", async () => {
  const oversized = fakeDpapiChild()
  const rejected = runDpapi("fixture-pwsh", "fixture-helper.ps1", "input-password-fixture", {
    spawnProcess: oversized.spawn,
    timeoutMs: 200,
  })
  oversized.stderr.write(`stderr-password-fixture-${"x".repeat(70 * 1024)}`)
  const error = await rejected.catch((cause: unknown) => cause)
  assert.ok(error instanceof Error)
  assert.match(error.message, /output limit/)
  assert.doesNotMatch(error.message, /input-password|stderr-password/)
  assert.equal(oversized.kills, 1)

  const successful = fakeDpapiChild()
  const resolved = runDpapi("fixture-pwsh", "fixture-helper.ps1", "fixture-ciphertext", {
    spawnProcess: successful.spawn,
    timeoutMs: 30,
  })
  successful.stdout.write("fixture-plaintext")
  successful.child.emit("close", 0, null)
  assert.equal(await resolved, "fixture-plaintext")
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(successful.kills, 0, "settled helper must not retain its deadline timer")
})

function environment(): NodeJS.ProcessEnv {
  return {
    OMW_OPENCODE_EXECUTABLE: "C:\\tools\\opencode.exe",
    OMW_MANAGER_ORIGIN: "http://127.0.0.1:4174",
  }
}

function dependencies(options: { reserveError?: Error; finalizeError?: Error; credentialError?: Error } = {}) {
  const spawns: Array<{ executable: string; args: string[]; options: SpawnOptions }> = []
  const requests: Array<{ pathname: string; body: unknown }> = []
  const value: LauncherDependencies = {
    async loadCredentials() {
      if (options.credentialError) throw options.credentialError
      return credentials
    },
    async resolveExecutable(value) { return value },
    async request<T>(_origin: string, pathname: string, _token: string, body: unknown): Promise<T> {
      requests.push({ pathname, body })
      if (pathname === "/api/v1/launcher/reservations") {
        if (options.reserveError) throw options.reserveError
        return { reservationId: "reservation-1", hostname: "127.0.0.1", port: 42004, expiresAt: new Date().toISOString(), status: "reserved" } as T
      }
      if (pathname.endsWith("/finalize") && options.finalizeError) throw options.finalizeError
      return { instanceId: "reservation-1", state: "starting" } as T
    },
    spawnForeground(executable, args, spawnOptions) {
      spawns.push({ executable, args, options: spawnOptions })
      return { pid: 4312, completion: Promise.resolve(23) }
    },
    invocationId() { return "11111111-1111-4111-8111-111111111111" },
    diagnostic() {},
  }
  return { value, spawns, requests }
}

function fakeDpapiChild(): {
  child: ChildProcessWithoutNullStreams
  stdout: PassThrough
  stderr: PassThrough
  spawn: DpapiSpawn
  readonly kills: number
} {
  const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let kills = 0
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    kill: () => { kills++; return true },
  })
  return {
    child,
    stdout,
    stderr,
    spawn: () => child,
    get kills() { return kills },
  }
}
