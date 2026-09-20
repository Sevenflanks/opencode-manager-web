import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import net from "node:net"
import path from "node:path"
import test from "node:test"
import { resolveCredentialHelper, resolveDataDirectory, resolveExecutable } from "../src/cli.js"
import {
  ensureCredentials,
  isLoopbackPortOccupied,
  runManagerCli,
  type CredentialInitializationDependencies,
  type LocalCredentials,
  type ManagerCliDependencies,
} from "../src/manager-cli.js"

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

test("bare Manager CLI reuses an exact OMW identity without spawning", async () => {
  const { dependencies, spawned, output } = fixture(["omw"])
  assert.equal(await runManagerCli([], { OMW_DATA_DIR: "C:\\fixture\\data" }, dependencies), 0)
  assert.equal(spawned.length, 0)
  assert.match(output.join("\n"), /OMW Manager ready: http:\/\/127\.0\.0\.1:4174/)
  assert.match(output.join("\n"), /npx @sevenflanks\/omw opencode/)
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
  const { dependencies, spawned } = fixture(["foreign"])
  await assert.rejects(runManagerCli([], { OMW_DATA_DIR: "C:\\fixture\\data" }, dependencies), /非 OMW Manager/)
  assert.equal(spawned.length, 0)
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

test("opencode bootstrap keeps initialization strict and only fail-opens general Manager failures", async () => {
  const strictInitialization = fixture(["omw"])
  strictInitialization.dependencies.ensureCredentials = async () => { throw new Error("missing non-TTY setup") }
  await assert.rejects(
    runManagerCli(["opencode"], { LOCALAPPDATA: "C:\\fixture\\local" }, strictInitialization.dependencies),
    /missing non-TTY setup/,
  )
  assert.doesNotMatch(strictInitialization.events.join(","), /run/)

  const failOpen = fixture(["absent"])
  failOpen.dependencies.probe = async () => { throw new Error("Manager unavailable") }
  failOpen.dependencies.runOpenCode = async () => { failOpen.events.push("run"); return 23 }
  assert.equal(await runManagerCli(["opencode"], { LOCALAPPDATA: "C:\\fixture\\local" }, failOpen.dependencies), 23)
  assert.deepEqual(failOpen.events, ["ensure", "run"])
  assert.match(failOpen.diagnostics.join("\n"), /Manager bootstrap failed.*Manager unavailable/)

  await assert.rejects(
    runManagerCli(
      ["opencode"],
      { LOCALAPPDATA: "C:\\fixture\\local", OMW_REQUIRED: "1" },
      failOpen.dependencies,
    ),
    /Manager unavailable/,
  )
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

test("OpenCode executable resolution uses an explicit executable or exact opencode.exe in known locations", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "omw-executable-"))
  const executable = path.join(root, "opencode.exe")
  const launcher = path.join(root, "omw-opencode.cmd")
  try {
    await writeFile(executable, "fixture", "utf8")
    assert.equal(await resolveExecutable(executable, launcher, {}), await import("node:fs/promises").then(({ realpath }) => realpath(executable)))
    assert.equal(await resolveExecutable("", launcher, { OPENCODE_INSTALL_DIR: root }), await import("node:fs/promises").then(({ realpath }) => realpath(executable)))
    assert.equal(await resolveExecutable("", launcher, { PATH: root }), await import("node:fs/promises").then(({ realpath }) => realpath(executable)))
    await assert.rejects(resolveExecutable("", launcher, { PATH: path.join(root, "missing") }), /OMW_OPENCODE_EXECUTABLE/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
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
