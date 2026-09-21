import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import net from "node:net"
import path from "node:path"
import test from "node:test"
import { resolveCredentialHelper, resolveDataDirectory, resolveExecutable } from "../src/cli.js"
import {
  CredentialInitializationCancelledError,
  CredentialSetupRequiredError,
  decodeManagerCredentials,
  ensureCredentials,
  isLoopbackPortOccupied,
  runManagerCli,
  type CredentialInitializationDependencies,
  type LocalCredentials,
  type ManagerCliDependencies,
} from "../src/manager-cli.js"

function windowsPeFixture(): Buffer {
  const fixture = Buffer.alloc(68)
  fixture.write("MZ", 0, "ascii")
  fixture.writeUInt32LE(64, 0x3c)
  fixture.write("PE\0\0", 64, "binary")
  return fixture
}

function knownOpenCodeShim(): string {
  return [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    '"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*',
    "",
  ].join("\r\n")
}

function fixture(statuses: Array<"omw" | "absent" | "foreign">): {
  dependencies: ManagerCliDependencies
  spawned: Array<{ entry: string; environment: NodeJS.ProcessEnv }>
  output: string[]
  diagnostics: string[]
  events: string[]
  ownerActions: string[]
  resolvedEnvironments: NodeJS.ProcessEnv[]
} {
  const spawned: Array<{ entry: string; environment: NodeJS.ProcessEnv }> = []
  const output: string[] = []
  const diagnostics: string[] = []
  const events: string[] = []
  const ownerActions: string[] = []
  const resolvedEnvironments: NodeJS.ProcessEnv[] = []
  let probeIndex = 0
  return {
    spawned,
    output,
    diagnostics,
    events,
    ownerActions,
    resolvedEnvironments,
    dependencies: {
      ensureCredentials: async () => {
        events.push("ensure")
        return {
          manager: { username: "fixture", password: "fixture-password-long-enough" },
          launcherToken: "fixture-launcher-token-long-enough-for-validation",
        }
      },
      probe: async () => {
        events.push("probe")
        return statuses[Math.min(probeIndex++, statuses.length - 1)] ?? "absent"
      },
      spawnManager: (entry, options) => {
        events.push("spawn")
        spawned.push({ entry, environment: options.env ?? {} })
        return {
          stop: async () => { ownerActions.push("stop") },
          preserve: () => { ownerActions.push("preserve") },
        }
      },
      managerEntry: async () => "C:\\fixture\\manager.js",
      webRoot: async () => "C:\\fixture\\web",
      resolveExecutable: async (_value, _launcherPath, environment) => {
        resolvedEnvironments.push(environment)
        return "C:\\fixture\\opencode.exe"
      },
      launcherPath: () => "C:\\fixture\\omw.cmd",
      sleep: async () => undefined,
      now: Date.now,
      output: (message) => { output.push(message) },
      diagnostic: (message) => { diagnostics.push(message) },
      runOpenCode: async () => { events.push("run"); return 0 },
    },
  }
}

async function startLockOwner(script: string, root: string): Promise<ChildProcess> {
  const moduleUrl = new URL("../src/manager-cli.js", import.meta.url).href
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script, moduleUrl, root], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  let output = ""
  let diagnostics = ""
  child.stdout?.setEncoding("utf8")
  child.stderr?.setEncoding("utf8")
  child.stdout?.on("data", (chunk: string) => { output += chunk })
  child.stderr?.on("data", (chunk: string) => { diagnostics += chunk })
  try {
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => finish(new Error(`lock owner did not acquire within deadline: ${diagnostics}`)), 5_000)
      const finish = (error?: Error): void => {
        clearTimeout(deadline)
        child.stdout?.off("data", onData)
        child.off("exit", onExit)
        child.off("error", onError)
        if (error) reject(error)
        else resolve()
      }
      const onData = (): void => {
        if (output.includes("LOCKED\n")) finish()
      }
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        finish(new Error(`lock owner exited before acquiring: code=${code}, signal=${signal}, stderr=${diagnostics}`))
      }
      const onError = (cause: Error): void => finish(cause)
      child.stdout?.on("data", onData)
      child.once("exit", onExit)
      child.once("error", onError)
      onData()
    })
    return child
  } catch (cause) {
    await stopLockOwner(child)
    throw cause
  }
}

async function stopLockOwner(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => finish(new Error("lock owner did not exit within cleanup deadline")), 5_000)
    const finish = (error?: Error): void => {
      clearTimeout(deadline)
      child.off("exit", onExit)
      child.off("error", onError)
      if (error) reject(error)
      else resolve()
    }
    const onExit = (): void => finish()
    const onError = (cause: Error): void => finish(cause)
    child.once("exit", onExit)
    child.once("error", onError)
    if (!child.kill()) finish(new Error("failed to terminate lock owner"))
  })
}

test("bare Manager CLI reuses an exact OMW identity without spawning", async () => {
  const { dependencies, spawned, output } = fixture(["omw"])
  assert.equal(await runManagerCli([], { OMW_DATA_DIR: "C:\\fixture\\data" }, dependencies), 0)
  assert.equal(spawned.length, 0)
  assert.match(output.join("\n"), /OMW Manager ready: http:\/\/127\.0\.0\.1:4174/)
  assert.match(output.join("\n"), /OpenCode TUI: omw opencode/)
  assert.doesNotMatch(output.join("\n"), /npx/)
})

test("Manager CLI starts one detached Manager and waits for exact readiness", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "omw-manager-start-one-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { dependencies, spawned, ownerActions, resolvedEnvironments } = fixture(["absent", "absent", "omw"])
  const environment = { OMW_DATA_DIR: root, OMW_PORT: "4180", PATH: "C:\\fixture\\bin" }
  assert.equal(await runManagerCli([], environment, dependencies), 0)
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0]?.entry, "C:\\fixture\\manager.js")
  assert.equal(spawned[0]?.environment.OMW_PORT, "4180")
  assert.equal(spawned[0]?.environment.OMW_LAUNCHER_INTEGRATION, "1")
  assert.equal(spawned[0]?.environment.OMW_DATA_DIR, root)
  assert.equal(spawned[0]?.environment.OMW_OPENCODE_EXECUTABLE, "C:\\fixture\\opencode.exe")
  assert.equal(resolvedEnvironments[0], environment)
  assert.deepEqual(ownerActions, ["preserve"])
})

test("Manager CLI rejects a foreign default-port listener and never replaces it", async () => {
  const { dependencies, spawned, ownerActions } = fixture(["foreign"])
  await assert.rejects(runManagerCli([], { OMW_DATA_DIR: "C:\\fixture\\data" }, dependencies), /非 OMW Manager/)
  assert.equal(spawned.length, 0)
  assert.deepEqual(ownerActions, [])
})

test("loopback occupancy detection recognizes a foreign listener", async (t) => {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  assert.equal(await isLoopbackPortOccupied(`http://127.0.0.1:${address.port}`), true)
})

test("Manager CLI rejects unknown commands", async () => {
  const { dependencies } = fixture(["omw"])
  await assert.rejects(runManagerCli(["unknown"], { OMW_DATA_DIR: "C:\\fixture\\data" }, dependencies), /未知命令/)
})

test("opencode subcommand starts Manager before dispatching the native wrapper", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "omw-wrapper-bootstrap-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { dependencies, spawned, events } = fixture(["absent", "absent", "omw"])
  let received: string[] = []
  dependencies.runOpenCode = async (argv) => { events.push("run"); received = argv; return 23 }
  assert.equal(await runManagerCli(["opencode", "project", "-s", "session-1"], { OMW_DATA_DIR: root }, dependencies), 23)
  assert.deepEqual(received, ["project", "-s", "session-1"])
  assert.equal(spawned.length, 1)
  assert.deepEqual(events, ["ensure", "probe", "probe", "spawn", "probe", "run"])
})

test("opencode bootstrap keeps cancelled and non-TTY initialization fail-closed", async () => {
  for (const cause of [new CredentialInitializationCancelledError(), new CredentialSetupRequiredError()]) {
    const strictInitialization = fixture(["omw"])
    strictInitialization.dependencies.ensureCredentials = async () => { throw cause }
    await assert.rejects(
      runManagerCli(["opencode"], { LOCALAPPDATA: "C:\\fixture\\local" }, strictInitialization.dependencies),
      cause,
    )
    assert.doesNotMatch(strictInitialization.events.join(","), /run/)
  }
})

test("opencode bootstrap fail-opens unreadable credentials and general Manager failures", async () => {
  const unreadableCredentials = fixture(["omw"])
  unreadableCredentials.dependencies.ensureCredentials = async () => { throw new Error("DPAPI decrypt failed") }
  unreadableCredentials.dependencies.runOpenCode = async () => { unreadableCredentials.events.push("run"); return 17 }
  assert.equal(await runManagerCli(["opencode"], { LOCALAPPDATA: "C:\\fixture\\local" }, unreadableCredentials.dependencies), 17)
  assert.deepEqual(unreadableCredentials.events, ["run"])
  assert.match(unreadableCredentials.diagnostics.join("\n"), /bootstrap failed.*DPAPI decrypt failed/)

  const failOpen = fixture(["absent"])
  failOpen.dependencies.probe = async () => { throw new Error("Manager unavailable") }
  failOpen.dependencies.runOpenCode = async () => { failOpen.events.push("run"); return 23 }
  assert.equal(await runManagerCli(["opencode"], { LOCALAPPDATA: "C:\\fixture\\local" }, failOpen.dependencies), 23)
  assert.deepEqual(failOpen.events, ["ensure", "run"])
  assert.match(failOpen.diagnostics.join("\n"), /Manager bootstrap failed.*Manager unavailable/)
})

test("malformed decrypted credentials and bounded diagnostics do not expose secrets", async () => {
  const decryptedSecret = "credential-password-super-secret-fixture"
  const malformed = fixture(["omw"])
  malformed.dependencies.ensureCredentials = async () => decodeManagerCredentials(`{"manager":"${decryptedSecret}`)
  malformed.dependencies.runOpenCode = async () => 19
  assert.equal(await runManagerCli(["opencode"], { LOCALAPPDATA: "C:\\fixture\\local" }, malformed.dependencies), 19)
  assert.match(malformed.diagnostics.join("\n"), /DPAPI credential store 無法解析/)
  assert.doesNotMatch(malformed.diagnostics.join("\n"), new RegExp(decryptedSecret))

  const diagnosticSecret = "diagnostic-password-super-secret-fixture"
  const noisy = fixture(["omw"])
  noisy.dependencies.ensureCredentials = async () => {
    throw new Error(`request failed?password=${diagnosticSecret}&reason=${"x".repeat(2_000)}`)
  }
  noisy.dependencies.runOpenCode = async () => 20
  assert.equal(await runManagerCli(["opencode"], { LOCALAPPDATA: "C:\\fixture\\local" }, noisy.dependencies), 20)
  assert.doesNotMatch(noisy.diagnostics.join("\n"), new RegExp(diagnosticSecret))
  assert.ok(noisy.diagnostics.join("\n").length < 600)
})

test("OMW_REQUIRED keeps unreadable credentials fail-closed", async () => {
  const required = fixture(["omw"])
  required.dependencies.ensureCredentials = async () => { throw new Error("DPAPI decrypt failed") }
  await assert.rejects(
    runManagerCli(
      ["opencode"],
      { LOCALAPPDATA: "C:\\fixture\\local", OMW_REQUIRED: "1" },
      required.dependencies,
    ),
    /DPAPI decrypt failed/,
  )
  assert.doesNotMatch(required.events.join(","), /run/)
})

test("concurrent Manager invocations use one atomic start owner and one spawn", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "omw-manager-start-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const first = fixture(["absent"])
  let initialProbes = 0
  let releaseInitialProbes: (() => void) | undefined
  const bothInitialProbes = new Promise<void>((resolve) => { releaseInitialProbes = resolve })
  first.dependencies.probe = async () => {
    if (first.spawned.length) return "omw"
    initialProbes++
    if (initialProbes === 1) await bothInitialProbes
    else if (initialProbes === 2) releaseInitialProbes?.()
    return "absent"
  }
  first.dependencies.sleep = async () => { await new Promise<void>((resolve) => setImmediate(resolve)) }

  const environment = { OMW_DATA_DIR: root }
  assert.deepEqual(await Promise.all([
    runManagerCli([], environment, first.dependencies),
    runManagerCli([], environment, first.dependencies),
  ]), [0, 0])
  assert.equal(first.spawned.length, 1)
  assert.deepEqual(first.ownerActions, ["preserve"])
  assert.deepEqual(await readdir(root), [])
})

test("a stale legacy manager-start.lock does not block startup or get overwritten", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "omw-manager-stale-lock-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const legacyLock = path.join(root, "manager-start.lock")
  await writeFile(legacyLock, "stale-owner", "utf8")
  const { dependencies, spawned } = fixture(["absent"])
  dependencies.probe = async () => spawned.length ? "omw" : "absent"
  let clock = 0
  dependencies.now = () => { clock += 6_000; return clock }

  assert.equal(await runManagerCli([], { OMW_DATA_DIR: root }, dependencies), 0)
  assert.equal(spawned.length, 1)
  assert.equal(await readFile(legacyLock, "utf8"), "stale-owner")
})

test("Manager startup lock is released by the OS when its owner exits", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "omw-manager-owner-exit-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const script = `
    const { runManagerCli } = await import(process.argv[1])
    const never = new Promise(() => {})
    await runManagerCli([], { OMW_DATA_DIR: process.argv[2] }, {
      ensureCredentials: async () => ({ manager: { username: "fixture", password: "fixture-password-long-enough" }, launcherToken: "fixture-launcher-token-long-enough-for-validation" }),
      probe: async () => "absent",
      spawnManager: () => { throw new Error("unexpected spawn") },
      managerEntry: async () => { process.stdout.write("LOCKED\\n"); await never },
      webRoot: async () => "unused",
      resolveExecutable: async () => "unused",
      launcherPath: () => "unused",
      sleep: async () => {},
      now: Date.now,
      output: () => {},
      diagnostic: () => {},
      runOpenCode: async () => 0,
    })
  `
  const owner = await startLockOwner(script, root)
  try {
    await stopLockOwner(owner)
    const retry = fixture(["absent"])
    retry.dependencies.probe = async () => retry.spawned.length ? "omw" : "absent"
    let clock = 0
    retry.dependencies.now = () => { clock += 6_000; return clock }
    assert.equal(await runManagerCli([], { OMW_DATA_DIR: root }, retry.dependencies), 0)
    assert.equal(retry.spawned.length, 1)
  } finally {
    await stopLockOwner(owner)
  }
})

test("post-spawn timeout and probe failure clean only the owned Manager process", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "omw-manager-cleanup-"))
  t.after(() => rm(root, { recursive: true, force: true }))

  const timedOut = fixture(["absent"])
  let clock = 0
  timedOut.dependencies.now = () => { clock += 6_000; return clock }
  await assert.rejects(runManagerCli([], { OMW_DATA_DIR: root }, timedOut.dependencies), /readiness/)
  assert.deepEqual(timedOut.ownerActions, ["stop"])
  assert.deepEqual(await readdir(root), [])

  const probeFailed = fixture(["absent", "absent"])
  let probes = 0
  probeFailed.dependencies.probe = async () => {
    probes++
    if (probes >= 3) throw new Error("probe exploded")
    return "absent"
  }
  await assert.rejects(runManagerCli([], { OMW_DATA_DIR: root }, probeFailed.dependencies), /probe exploded/)
  assert.deepEqual(probeFailed.ownerActions, ["stop"])
  assert.deepEqual(await readdir(root), [])
})

test("default data directory is fixed under LOCALAPPDATA and honors the explicit override", () => {
  assert.equal(resolveDataDirectory({ LOCALAPPDATA: "C:\\Users\\fixture\\AppData\\Local" }), path.resolve("C:\\Users\\fixture\\AppData\\Local", "OMW"))
  assert.equal(resolveDataDirectory({ LOCALAPPDATA: "C:\\ignored", OMW_DATA_DIR: "C:\\fixture\\data" }), path.resolve("C:\\fixture\\data"))
  assert.throws(() => resolveDataDirectory({}), /LOCALAPPDATA/)
})

test("OpenCode executable resolution accepts only a Windows PE executable and rejects wrappers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "omw-executable-"))
  const executable = path.join(root, "opencode.exe")
  const launcher = path.join(root, "omw-opencode.cmd")
  try {
    await writeFile(executable, windowsPeFixture())
    assert.equal(await resolveExecutable(executable, launcher, {}), await import("node:fs/promises").then(({ realpath }) => realpath(executable)))
    assert.equal(await resolveExecutable("", launcher, { OPENCODE_INSTALL_DIR: root }), await import("node:fs/promises").then(({ realpath }) => realpath(executable)))
    assert.equal(await resolveExecutable("", launcher, { PATH: root }), await import("node:fs/promises").then(({ realpath }) => realpath(executable)))
    await assert.rejects(resolveExecutable(executable, executable, {}), /不可指向 OMW launcher/)
    await assert.rejects(resolveExecutable("", launcher, { PATH: path.join(root, "missing") }), /OMW_OPENCODE_EXECUTABLE/)

    const textExecutable = path.join(root, "text.exe")
    await writeFile(textExecutable, "not an executable", "utf8")
    await assert.rejects(resolveExecutable(textExecutable, launcher, {}), /Windows PE executable/)

    const script = path.join(root, "opencode.cmd")
    await writeFile(script, windowsPeFixture())
    await assert.rejects(resolveExecutable(script, launcher, {}), /Windows PE executable/)

    const wrapper = path.join(root, "omw.exe")
    await writeFile(wrapper, windowsPeFixture())
    await assert.rejects(resolveExecutable(wrapper, launcher, {}), /不可指向 OMW launcher/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("OpenCode executable resolution discovers a known PATH shim without executing it", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "omw executable shim "))
  t.after(() => rm(root, { recursive: true, force: true }))
  const shim = path.join(root, "opencode.cmd")
  const executable = path.join(root, "node_modules", "opencode-ai", "bin", "opencode.exe")
  await mkdir(path.dirname(executable), { recursive: true })
  await writeFile(shim, knownOpenCodeShim(), "utf8")
  await writeFile(executable, windowsPeFixture())

  assert.equal(
    await resolveExecutable("", path.join(root, "omw-opencode.cmd"), { PATH: root }),
    await realpath(executable),
  )
})

test("OpenCode executable resolution tolerates horizontal whitespace in the known shim", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "omw whitespace shim "))
  t.after(() => rm(root, { recursive: true, force: true }))
  const shim = path.join(root, "opencode.cmd")
  const executable = path.join(root, "node_modules", "opencode-ai", "bin", "opencode.exe")
  const contents = knownOpenCodeShim()
    .replace("@ECHO off", " \t@ECHO\toff\t ")
    .replace("CALL :find_dp0", "\tCALL\t:find_dp0 ")
  await mkdir(path.dirname(executable), { recursive: true })
  await writeFile(shim, contents, "utf8")
  await writeFile(executable, windowsPeFixture())

  assert.equal(await resolveExecutable("", path.join(root, "omw-opencode.cmd"), { PATH: root }), await realpath(executable))
})

test("OpenCode executable resolution ignores relative PATH entries when discovering shims", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "omw relative shim "))
  t.after(() => rm(root, { recursive: true, force: true }))
  const shim = path.join(root, "opencode.cmd")
  const executable = path.join(root, "node_modules", "opencode-ai", "bin", "opencode.exe")
  const relativeEntry = path.relative(process.cwd(), root)
  assert.equal(path.isAbsolute(relativeEntry), false)
  await mkdir(path.dirname(executable), { recursive: true })
  await writeFile(shim, knownOpenCodeShim(), "utf8")
  await writeFile(executable, windowsPeFixture())

  await assert.rejects(
    resolveExecutable("", path.join(root, "omw-opencode.cmd"), { PATH: relativeEntry }),
    /找不到可驗證的 OpenCode executable/,
  )
})

test("OpenCode executable resolution rejects an explicit known shim with a validated target suggestion", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "omw explicit shim "))
  t.after(() => rm(root, { recursive: true, force: true }))
  const shim = path.join(root, "opencode.cmd")
  const executable = path.join(root, "node_modules", "opencode-ai", "bin", "opencode.exe")
  await mkdir(path.dirname(executable), { recursive: true })
  await writeFile(shim, knownOpenCodeShim(), "utf8")
  await writeFile(executable, windowsPeFixture())

  await assert.rejects(
    resolveExecutable(shim, path.join(root, "omw-opencode.cmd")),
    (error: Error) => error.message.includes(shim)
      && error.message.includes(executable)
      && /不可.*shim/.test(error.message)
      && /請改設/.test(error.message),
  )
})

test("OpenCode executable resolution reports why PATH shims cannot produce a verified executable", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "omw shim diagnostics "))
  t.after(() => rm(root, { recursive: true, force: true }))
  const launcher = path.join(root, "omw-opencode.cmd")

  await t.test("does not execute an unknown shim", async () => {
    const directory = path.join(root, "unknown")
    const shim = path.join(directory, "opencode.cmd")
    const sentinel = path.join(directory, "executed.txt")
    await mkdir(directory, { recursive: true })
    await writeFile(shim, `${knownOpenCodeShim()}ECHO executed>"${sentinel}"\r\n`, "utf8")

    await assert.rejects(
      resolveExecutable("", launcher, { PATH: directory }),
      (error: Error) => error.message.includes(shim)
        && error.message.includes("格式不符合")
        && error.message.includes("OMW_OPENCODE_EXECUTABLE"),
    )
    assert.equal(existsSync(sentinel), false)
  })

  await t.test("identifies a missing inferred target", async () => {
    const directory = path.join(root, "missing")
    const shim = path.join(directory, "opencode.cmd")
    const target = path.join(directory, "node_modules", "opencode-ai", "bin", "opencode.exe")
    await mkdir(directory, { recursive: true })
    await writeFile(shim, knownOpenCodeShim(), "utf8")

    await assert.rejects(
      resolveExecutable("", launcher, { PATH: directory }),
      (error: Error) => error.message.includes(shim)
        && error.message.includes(target)
        && error.message.includes("不存在")
        && error.message.includes("OMW_OPENCODE_EXECUTABLE"),
    )
  })

  await t.test("identifies an inferred target that is not a Windows PE", async () => {
    const directory = path.join(root, "invalid")
    const shim = path.join(directory, "opencode.cmd")
    const target = path.join(directory, "node_modules", "opencode-ai", "bin", "opencode.exe")
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(shim, knownOpenCodeShim(), "utf8")
    await writeFile(target, "not a Windows executable", "utf8")

    await assert.rejects(
      resolveExecutable("", launcher, { PATH: directory }),
      (error: Error) => error.message.includes(shim)
        && error.message.includes(target)
        && error.message.includes("Windows PE executable")
        && error.message.includes("OMW_OPENCODE_EXECUTABLE"),
    )
  })
})

test("credential helper resolution supports the staged package layout", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "omw-helper-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const moduleDirectory = path.join(root, "package", "dist", "src")
  const helper = path.join(root, "package", "dist", "scripts", "credential-store.ps1")
  await mkdir(path.dirname(helper), { recursive: true })
  await writeFile(helper, "fixture", "utf8")
  assert.equal(resolveCredentialHelper(moduleDirectory), helper)
})

test("credential initialization is idempotent and concurrent callers share one result", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "omw-init-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  let usernamePrompts = 0
  let passwordPrompts = 0
  const dependencies: CredentialInitializationDependencies = {
    isInteractive: () => true,
    load: async (filename) => JSON.parse(await readFile(filename, "utf8")) as LocalCredentials,
    save: async (filename, credentials) => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      await writeFile(filename, JSON.stringify(credentials), { encoding: "utf8", flag: "wx" })
    },
    promptUsername: async () => { usernamePrompts++; return "fixture" },
    promptPassword: async () => { passwordPrompts++; return "fixture-password-long-enough" },
    createToken: () => "fixture-token-with-at-least-thirty-two-characters",
    sleep: async () => { await new Promise((resolve) => setTimeout(resolve, 1)) },
    now: Date.now,
  }

  const [first, concurrent] = await Promise.all([
    ensureCredentials(root, {}, dependencies),
    ensureCredentials(root, {}, dependencies),
  ])
  const repeated = await ensureCredentials(root, {}, { ...dependencies, isInteractive: () => false })
  assert.deepEqual(concurrent, first)
  assert.deepEqual(repeated, first)
  assert.equal(usernamePrompts, 1)
  assert.equal(passwordPrompts, 1)
  assert.deepEqual(await readdir(root), ["credentials.dpapi"])
})

test("a stale legacy initialize.lock does not block initialization or get overwritten", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "omw-init-stale-lock-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const legacyLock = path.join(root, "initialize.lock")
  await writeFile(legacyLock, "stale-owner", "utf8")
  const credentials: LocalCredentials = {
    manager: { username: "fixture", password: "fixture-password-long-enough" },
    launcherToken: "fixture-token-with-at-least-thirty-two-characters",
  }
  const dependencies: CredentialInitializationDependencies = {
    isInteractive: () => true,
    load: async (filename) => JSON.parse(await readFile(filename, "utf8")) as LocalCredentials,
    save: async (filename, value) => { await writeFile(filename, JSON.stringify(value), { encoding: "utf8", flag: "wx" }) },
    promptUsername: async () => credentials.manager.username,
    promptPassword: async () => credentials.manager.password,
    createToken: () => credentials.launcherToken,
    sleep: async () => undefined,
    now: (() => { let clock = 0; return () => { clock += 20_000; return clock } })(),
  }

  assert.deepEqual(await ensureCredentials(root, {}, dependencies), credentials)
  assert.equal(await readFile(legacyLock, "utf8"), "stale-owner")
})

test("credential initialization lock is released by the OS when its owner exits", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "omw-init-owner-exit-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const script = `
    const { ensureCredentials } = await import(process.argv[1])
    const never = new Promise(() => {})
    await ensureCredentials(process.argv[2], {}, {
      isInteractive: () => true,
      load: async () => { throw new Error("unexpected load") },
      save: async () => { throw new Error("unexpected save") },
      promptUsername: async () => { process.stdout.write("LOCKED\\n"); await never },
      promptPassword: async () => "unused",
      createToken: () => "unused",
      sleep: async () => {},
      now: Date.now,
    })
  `
  const owner = await startLockOwner(script, root)
  try {
    await stopLockOwner(owner)
    const expected: LocalCredentials = {
      manager: { username: "retry", password: "retry-password-long-enough" },
      launcherToken: "retry-token-with-at-least-thirty-two-characters",
    }
    assert.deepEqual(await ensureCredentials(root, {}, {
      isInteractive: () => true,
      load: async (filename) => JSON.parse(await readFile(filename, "utf8")) as LocalCredentials,
      save: async (filename, value) => { await writeFile(filename, JSON.stringify(value), { encoding: "utf8", flag: "wx" }) },
      promptUsername: async () => expected.manager.username,
      promptPassword: async () => expected.manager.password,
      createToken: () => expected.launcherToken,
      sleep: async () => undefined,
      now: (() => { let clock = 0; return () => { clock += 20_000; return clock } })(),
    }), expected)
  } finally {
    await stopLockOwner(owner)
  }
})

test("non-interactive initialization without credentials reports a typed setup requirement", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "omw-init-required-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dependencies: CredentialInitializationDependencies = {
    isInteractive: () => false,
    load: async () => { throw new Error("unexpected load") },
    save: async () => { throw new Error("unexpected save") },
    promptUsername: async () => { throw new Error("unexpected prompt") },
    promptPassword: async () => { throw new Error("unexpected prompt") },
    createToken: () => "unexpected token",
    sleep: async () => undefined,
    now: Date.now,
  }

  await assert.rejects(ensureCredentials(root, {}, dependencies), CredentialSetupRequiredError)
  assert.deepEqual(await readdir(root), [])
})

test("successful initialization returns credentials reloaded from persisted storage", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "omw-init-persisted-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  let loadCount = 0
  const persisted: LocalCredentials = {
    manager: { username: "persisted", password: "persisted-password-long-enough" },
    launcherToken: "persisted-token-with-at-least-thirty-two-characters",
  }
  const dependencies: CredentialInitializationDependencies = {
    isInteractive: () => true,
    load: async (filename) => {
      loadCount++
      return JSON.parse(await readFile(filename, "utf8")) as LocalCredentials
    },
    save: async (filename) => { await writeFile(filename, JSON.stringify(persisted), { encoding: "utf8", flag: "wx" }) },
    promptUsername: async () => "prompted",
    promptPassword: async () => "prompted-password-long-enough",
    createToken: () => "generated-token-with-at-least-thirty-two-characters",
    sleep: async () => undefined,
    now: Date.now,
  }

  assert.deepEqual(await ensureCredentials(root, {}, dependencies), persisted)
  assert.equal(loadCount, 1)
})

test("cancelled or failed credential initialization leaves a clean retry", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "omw-init-retry-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  let passwordError: Error | null = new Error("cancelled")
  let saveError: Error | null = null
  const dependencies: CredentialInitializationDependencies = {
    isInteractive: () => true,
    load: async (filename) => JSON.parse(await readFile(filename, "utf8")) as LocalCredentials,
    save: async (filename, credentials) => {
      if (saveError) throw saveError
      await writeFile(filename, JSON.stringify(credentials), { encoding: "utf8", flag: "wx" })
    },
    promptUsername: async () => "fixture",
    promptPassword: async () => {
      if (passwordError) throw passwordError
      return "fixture-password-long-enough"
    },
    createToken: () => "fixture-token-with-at-least-thirty-two-characters",
    sleep: async () => undefined,
    now: Date.now,
  }

  await assert.rejects(ensureCredentials(root, {}, dependencies), /cancelled/)
  assert.deepEqual(await readdir(root), [])
  passwordError = null
  saveError = new Error("write failed")
  await assert.rejects(ensureCredentials(root, {}, dependencies), /write failed/)
  assert.deepEqual(await readdir(root), [])
  saveError = null
  const credentials = await ensureCredentials(root, {}, dependencies)
  assert.equal(credentials.manager.username, "fixture")
  assert.deepEqual(await readdir(root), ["credentials.dpapi"])
})
