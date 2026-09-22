import assert from "node:assert/strict"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { OpenCodeRuntime } from "../src/runtime.js"

const windows = process.platform === "win32"
const helperPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/process-control.ps1")
const processQueryTimeoutMs = 3_000
const helperTimeoutMs = 12_000
const liveTreeStepTimeoutMs = 5_000
const delayedSetupMs = 12_500
const liveTreeCleanupBudgetMs = 15_000
const liveTreeOperationBudgetMs = liveTreeStepTimeoutMs * 5 + delayedSetupMs + helperTimeoutMs * 2 + processQueryTimeoutMs * 2
const liveTreeFixtureBackstopMs = liveTreeOperationBudgetMs + liveTreeStepTimeoutMs
const liveTreeTestTimeoutMs = liveTreeFixtureBackstopMs + liveTreeCleanupBudgetMs

test("a root exit before Describe leaves descendant cleanup unresolved instead of reconstructing PID authority", { skip: !windows, timeout: 20_000 }, async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "omw-cleanup-unresolved-"))
  const project = path.join(sandbox, "project")
  const pidFile = path.join(sandbox, "descendant.pid")
  await mkdir(project)
  await writeFile(path.join(project, "serve"), fixtureDelegatingLauncher(pidFile), "utf8")
  const runtime = new OpenCodeRuntime({ executable: process.execPath, dataDirectory: path.join(sandbox, "data") })
  let descendantPid = 0

  try {
    await assert.rejects(runtime.launch(project, 61991, "describe-failure"), /cleanup unresolved/i)
    descendantPid = Number(await readFile(pidFile, "utf8"))
    assert.ok(descendantPid > 0)
    assert.equal(processExists(descendantPid), true, "an unproven descendant must not be killed")
  } finally {
    if (descendantPid > 0) await waitFor(() => !processExists(descendantPid), 9_000).catch(() => undefined)
    await rm(sandbox, { recursive: true, force: true })
  }
})

test("a post-root-exit replacement candidate with mismatched executable is not trusted or killed", { skip: !windows, timeout: 20_000 }, async () => {
  const root = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", windowsHide: true })
  await waitForExit(root)
  const replacement = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 8000)"], { stdio: "ignore", windowsHide: true })
  assert.ok(replacement.pid)

  try {
    const result = runHelper([
      "-Action", "Describe",
      "-ProcessId", String(replacement.pid),
      "-ExpectedExecutable", path.join(tmpdir(), "not-the-spawned-executable.exe"),
    ])
    assert.notEqual(result.status, 0, "Describe must reject a PID whose executable is not the expected launch image")
    assert.equal(processExists(replacement.pid), true, "identity rejection must not stop the unrelated process")
  } finally {
    replacement.kill()
    await waitForExit(replacement).catch(() => undefined)
  }
})

test("an exact live-root identity can stop its bounded process tree after delayed setup", { skip: !windows, timeout: liveTreeTestTimeoutMs }, async () => {
  const rootPort = 61992
  const childPort = 61993
  await withLiveTreeFixture("omw-identity-stop-", rootPort, childPort, async ({ rootPid, childPid }) => {
    await delay(delayedSetupMs)

    const described = runHelper([
      "-Action", "Describe",
      "-ProcessId", String(rootPid),
      "-ExpectedExecutable", process.execPath,
    ])
    assert.equal(described.status, 0, described.stderr)
    const identity = JSON.parse(described.stdout.trim()) as {
      pid: number
      creationTimeTicks: string
      executable: string
    }

    const stopped = runHelper([
      "-Action", "Stop",
      "-ProcessId", String(identity.pid),
      "-ExpectedCreationTicks", identity.creationTimeTicks,
      "-ExpectedExecutable", identity.executable,
      "-Port", String(rootPort),
    ])
    assert.equal(stopped.status, 0, stopped.stderr)
    assert.deepEqual(JSON.parse(stopped.stdout.trim()), { stopped: true, reason: null })
    await waitForPort(rootPort, false, liveTreeStepTimeoutMs)
    await waitForPort(childPort, false, liveTreeStepTimeoutMs)
    assert.equal(processExists(rootPid), false)
    assert.equal(processExists(childPid), false)
  })
})

test("a live-tree fixture cleans up its child when the operation loses its root", { skip: !windows, timeout: liveTreeTestTimeoutMs }, async () => {
  let rootPid = 0
  let childPid = 0

  await assert.rejects(
    withLiveTreeFixture("omw-identity-failure-", 61994, 61995, async ({ root, rootPid: fixtureRootPid, childPid: fixtureChildPid }) => {
      rootPid = fixtureRootPid
      childPid = fixtureChildPid
      assert.ok(root.stdin)
      root.stdin.write("exit-root\n")
      await waitForExit(root)
      assert.equal(processExists(childPid), true, "the child must outlive a root-only termination")
      throw new Error("simulated fixture operation failure")
    }),
    /simulated fixture operation failure/,
  )
  assert.equal(processExists(rootPid), false)
  assert.equal(processExists(childPid), false)
})

test("Inspect ignores a same-port listener on a non-overlapping loopback address", { skip: !windows, timeout: 20_000 }, async () => {
  let endpointListener: OwnedListener | null = null
  let otherLoopbackListener: OwnedListener | null = null

  try {
    endpointListener = await spawnOwnedListener("127.0.0.1")
    otherLoopbackListener = await spawnOwnedListener("127.0.0.2", endpointListener.port)
    const identity = describe(endpointListener.child)

    const inspected = runHelper([
      "-Action", "Inspect",
      "-ProcessId", String(identity.pid),
      "-ExpectedCreationTicks", identity.creationTimeTicks,
      "-ExpectedExecutable", identity.executable,
      "-Port", String(endpointListener.port),
    ])

    assert.equal(inspected.status, 0, inspected.stderr)
    assert.deepEqual(JSON.parse(inspected.stdout.trim()), {
      processState: "running",
      running: true,
      matched: true,
      portOwnerMatched: true,
      portOwnedByOther: false,
    })
  } finally {
    await Promise.all([stopOwnedListener(endpointListener), stopOwnedListener(otherLoopbackListener)])
  }
})

test("Inspect and Stop reject an expected PID bound only to another loopback address", { skip: !windows, timeout: 20_000 }, async () => {
  let expectedProcessListener: OwnedListener | null = null
  let foreignEndpointListener: OwnedListener | null = null

  try {
    expectedProcessListener = await spawnOwnedListener("127.0.0.2")
    foreignEndpointListener = await spawnOwnedListener("127.0.0.1", expectedProcessListener.port)
    const identity = describe(expectedProcessListener.child)
    const identityArguments = [
      "-ProcessId", String(identity.pid),
      "-ExpectedCreationTicks", identity.creationTimeTicks,
      "-ExpectedExecutable", identity.executable,
      "-Port", String(expectedProcessListener.port),
    ]

    const inspected = runHelper(["-Action", "Inspect", ...identityArguments])
    assert.equal(inspected.status, 0, inspected.stderr)
    assert.deepEqual(JSON.parse(inspected.stdout.trim()), {
      processState: "running",
      running: true,
      matched: true,
      portOwnerMatched: false,
      portOwnedByOther: true,
    })

    const stopped = runHelper(["-Action", "Stop", ...identityArguments])
    assert.equal(stopped.status, 0, stopped.stderr)
    assert.deepEqual(JSON.parse(stopped.stdout.trim()), { stopped: false, reason: "port is owned by another process" })
    assert.equal(processExists(identity.pid), true)
    assert.ok(foreignEndpointListener.child.pid)
    assert.equal(processExists(foreignEndpointListener.child.pid), true)
  } finally {
    await Promise.all([stopOwnedListener(expectedProcessListener), stopOwnedListener(foreignEndpointListener)])
  }
})

test("Inspect treats IPv4 and dual-stack wildcard listeners as endpoint owners", { skip: !windows, timeout: 20_000 }, async () => {
  for (const address of ["0.0.0.0", "::"]) {
    let listener: OwnedListener | null = null
    try {
      listener = await spawnOwnedListener(address)
      const identity = describe(listener.child)
      const inspected = runHelper([
        "-Action", "Inspect",
        "-ProcessId", String(identity.pid),
        "-ExpectedCreationTicks", identity.creationTimeTicks,
        "-ExpectedExecutable", identity.executable,
        "-Port", String(listener.port),
      ])

      assert.equal(inspected.status, 0, inspected.stderr)
      assert.deepEqual(JSON.parse(inspected.stdout.trim()), {
        processState: "running",
        running: true,
        matched: true,
        portOwnerMatched: true,
        portOwnedByOther: false,
      })
    } finally {
      await stopOwnedListener(listener)
    }
  }
})

function fixtureDelegatingLauncher(pidFile: string): string {
  return `
const { spawn } = require("node:child_process")
const { writeFileSync } = require("node:fs")
const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 8000)"], { detached: true, stdio: "ignore" })
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))
child.unref()
process.exit(0)
`
}

function fixtureLiveTree(): string {
  return `
const { spawn } = require("node:child_process")
const { writeFileSync } = require("node:fs")
const net = require("node:net")
const rootPort = Number(process.argv[1])
const childPort = Number(process.argv[2])
const pidFile = process.argv[3]
const cleanupMarkerFile = process.argv[4]
const childScript = [
  "const net = require('node:net')",
  "const { existsSync } = require('node:fs')",
  "const server = net.createServer()",
  "let stopping = false",
  "const stop = () => { if (stopping) return; stopping = true; clearInterval(cleanupPoll); clearTimeout(timer); if (server.listening) server.close(() => process.exit(0)); else process.exit(0) }",
  "server.listen(Number(process.argv[1]), '127.0.0.1')",
  "const cleanupPoll = setInterval(() => { if (existsSync(process.argv[2])) stop() }, 100)",
  "const timer = setTimeout(stop, Number(process.argv[3]))",
].join(";")
const child = spawn(process.execPath, ["-e", childScript, String(childPort), cleanupMarkerFile, String(${liveTreeFixtureBackstopMs})], { detached: true, stdio: "ignore" })
writeFileSync(pidFile, String(child.pid))
const server = net.createServer()
let stopping = false
const stop = () => {
  if (stopping) return
  stopping = true
  clearTimeout(backstop)
  if (server.listening) server.close()
  if (child.exitCode !== null || child.signalCode !== null) process.exit(0)
  child.once("exit", () => process.exit(0))
  setTimeout(() => process.exit(1), ${liveTreeCleanupBudgetMs})
}
const handleCommand = (chunk) => {
  if (chunk.toString("utf8").trim() === "exit-root") process.exit(0)
  stop()
}
server.listen(rootPort, "127.0.0.1")
process.stdin.resume()
process.stdin.once("data", handleCommand)
process.stdin.once("end", stop)
const backstop = setTimeout(stop, ${liveTreeFixtureBackstopMs})
`
}

function runHelper(arguments_: string[]) {
  return spawnSync("pwsh.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-File", helperPath,
    ...arguments_,
  ], { encoding: "utf8", timeout: helperTimeoutMs, windowsHide: true })
}

interface OwnedListener {
  child: ChildProcess
  port: number
}

interface DescribedIdentity {
  pid: number
  creationTimeTicks: string
  executable: string
}

interface LiveTreeFixture {
  root: ChildProcess
  rootPid: number
  childPid: number
}

async function withLiveTreeFixture<T>(
  sandboxPrefix: string,
  rootPort: number,
  childPort: number,
  operation: (fixture: LiveTreeFixture) => Promise<T>,
): Promise<T> {
  const sandbox = await mkdtemp(path.join(tmpdir(), sandboxPrefix))
  const childPidFile = path.join(sandbox, "child.pid")
  const cleanupMarkerFile = path.join(sandbox, "cleanup")
  const root = spawn(process.execPath, ["-e", fixtureLiveTree(), String(rootPort), String(childPort), childPidFile, cleanupMarkerFile], {
    stdio: ["pipe", "ignore", "ignore"],
    windowsHide: true,
  })
  assert.ok(root.pid)
  const rootPid = root.pid
  let childPid = 0

  try {
    childPid = await waitForPidFile(childPidFile, liveTreeStepTimeoutMs)
    await waitForPort(rootPort, true, liveTreeStepTimeoutMs)
    await waitForPort(childPort, true, liveTreeStepTimeoutMs)
    return await operation({ root, rootPid, childPid })
  } finally {
    try {
      await stopLiveTreeFixture(root, childPidFile, cleanupMarkerFile, childPid)
    } finally {
      await rm(sandbox, { recursive: true, force: true })
    }
  }
}

async function stopLiveTreeFixture(root: ChildProcess, childPidFile: string, cleanupMarkerFile: string, childPid: number): Promise<void> {
  const deadline = Date.now() + liveTreeCleanupBudgetMs
  await writeFile(cleanupMarkerFile, "", "utf8")
  if (root.exitCode === null && root.signalCode === null) {
    root.stdin?.once("error", () => undefined)
    root.stdin?.end("stop\n")
    await waitForExitWithin(root, liveTreeStepTimeoutMs)
  }
  if (root.exitCode === null && root.signalCode === null) {
    root.kill()
    await waitForExitWithin(root, Math.min(liveTreeStepTimeoutMs, remainingTime(deadline)))
  }
  assert.notEqual(root.exitCode ?? root.signalCode, null, "fixture root did not exit within its cleanup budget")

  // cleanup 只透過本次 spawn 的 ChildProcess 與 sandbox marker 操作；PID 只用於確認 child 無殘留，不作終止權限。
  const artifactChildPid = await readPidFileIfPresent(childPidFile)
  const cleanupChildPid = artifactChildPid > 0 ? artifactChildPid : childPid
  if (cleanupChildPid > 0) {
    await waitForProcessExit(cleanupChildPid, deadline)
  }
}

async function spawnOwnedListener(address: string, port = 0): Promise<OwnedListener> {
  const script = [
    "const net = require('node:net')",
    "const server = net.createServer()",
    "server.on('error', (error) => { console.error(error.message); process.exit(2) })",
    "server.listen({ host: process.argv[1], port: Number(process.argv[2]), exclusive: true }, () => process.stdout.write(String(server.address().port) + '\\n'))",
    "setTimeout(() => process.exit(0), 12000)",
  ].join(";")
  const child = spawn(process.execPath, ["-e", script, address, String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })

  try {
    const listeningPort = await new Promise<number>((resolve, reject) => {
      let stdout = ""
      let stderr = ""
      const timer = setTimeout(() => reject(new Error(`listener ${address}:${port} did not start within 3000 ms`)), 3_000)
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8")
        const lineEnd = stdout.indexOf("\n")
        if (lineEnd < 0) return
        clearTimeout(timer)
        resolve(Number(stdout.slice(0, lineEnd)))
      })
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8") })
      child.once("error", (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once("exit", (code) => {
        clearTimeout(timer)
        reject(new Error(`listener ${address}:${port} exited with ${code}: ${stderr}`))
      })
    })
    return { child, port: listeningPort }
  } catch (error) {
    await stopOwnedListener({ child, port })
    throw error
  }
}

function describe(child: ChildProcess): DescribedIdentity {
  assert.ok(child.pid)
  const described = runHelper([
    "-Action", "Describe",
    "-ProcessId", String(child.pid),
    "-ExpectedExecutable", process.execPath,
  ])
  assert.equal(described.status, 0, described.stderr)
  return JSON.parse(described.stdout.trim()) as DescribedIdentity
}

async function stopOwnedListener(listener: OwnedListener | null): Promise<void> {
  if (!listener || listener.child.exitCode !== null || listener.child.signalCode !== null) return
  listener.child.kill()
  await Promise.race([
    waitForExit(listener.child),
    new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
  ])
  if (listener.child.pid && processExists(listener.child.pid)) {
    spawnSync("taskkill.exe", ["/PID", String(listener.child.pid), "/T", "/F"], { windowsHide: true, timeout: 3_000 })
  }
}

function processExists(pid: number): boolean {
  const result = spawnSync("pwsh.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    `try { $process = [Diagnostics.Process]::GetProcessById(${pid}); try { if ($process.HasExited) { exit 1 }; exit 0 } finally { $process.Dispose() } } catch { exit 1 }`,
  ], { windowsHide: true, timeout: processQueryTimeoutMs })
  if (result.error) throw result.error
  assert.ok(result.status === 0 || result.status === 1, `process query exited with unexpected status ${result.status}: ${result.stderr}`)
  return result.status === 0
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    child.once("exit", () => resolve())
    child.once("error", reject)
  })
}

async function waitFor(predicate: () => boolean, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Condition was not met within ${timeout} ms`)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function remainingTime(deadline: number): number {
  return Math.max(0, deadline - Date.now())
}

async function waitForExitWithin(child: ChildProcess, timeout: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await Promise.race([waitForExit(child).catch(() => undefined), delay(timeout)])
}

async function readPidFileIfPresent(file: string): Promise<number> {
  try {
    const pid = Number(await readFile(file, "utf8"))
    return Number.isInteger(pid) && pid > 0 ? pid : 0
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0
    throw error
  }
}

async function waitForProcessExit(pid: number, deadline: number): Promise<void> {
  while (remainingTime(deadline) > processQueryTimeoutMs) {
    if (!processExists(pid)) return
    await delay(Math.min(100, remainingTime(deadline) - processQueryTimeoutMs))
  }
  throw new Error(`Process ${pid} did not exit within the fixture cleanup budget`)
}

async function waitForPidFile(file: string, timeout: number): Promise<number> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      const pid = Number(await readFile(file, "utf8"))
      if (Number.isInteger(pid) && pid > 0) return pid
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    await delay(100)
  }
  throw new Error(`PID file ${file} was not ready within ${timeout} ms`)
}

async function waitForPort(port: number, expectedOpen: boolean, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await portIsOpen(port) === expectedOpen) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Port ${port} did not become ${expectedOpen ? "open" : "closed"} within ${timeout} ms`)
}

function portIsOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port })
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.once("error", () => {
      resolve(false)
    })
  })
}
