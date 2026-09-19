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

test("an exact live-root identity can stop its bounded process tree", { skip: !windows, timeout: 20_000 }, async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "omw-identity-stop-"))
  const childPidFile = path.join(sandbox, "child.pid")
  const rootPort = 61992
  const childPort = 61993
  const root = spawn(process.execPath, ["-e", fixtureLiveTree(), String(rootPort), String(childPort), childPidFile], {
    stdio: "ignore",
    windowsHide: true,
  })
  assert.ok(root.pid)
  let childPid = 0

  try {
    await waitForPort(rootPort, true, 5_000)
    await waitForPort(childPort, true, 5_000)
    childPid = Number(await readFile(childPidFile, "utf8"))

    const described = runHelper([
      "-Action", "Describe",
      "-ProcessId", String(root.pid),
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
    await waitForPort(rootPort, false, 5_000)
    await waitForPort(childPort, false, 5_000)
    assert.equal(processExists(root.pid), false)
    assert.equal(processExists(childPid), false)
  } finally {
    if (root.exitCode === null) root.kill()
    await waitForExit(root).catch(() => undefined)
    if (childPid > 0) await waitFor(() => !processExists(childPid), 13_000).catch(() => undefined)
    await rm(sandbox, { recursive: true, force: true })
  }
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
const child = spawn(process.execPath, ["-e", "require('node:net').createServer().listen(" + childPort + ", '127.0.0.1'); setTimeout(() => process.exit(0), 12000)"], { stdio: "ignore" })
writeFileSync(pidFile, String(child.pid))
net.createServer().listen(rootPort, "127.0.0.1")
setTimeout(() => process.exit(0), 12000)
`
}

function runHelper(arguments_: string[]) {
  return spawnSync("pwsh.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-File", helperPath,
    ...arguments_,
  ], { encoding: "utf8", timeout: 12_000, windowsHide: true })
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
  ], { windowsHide: true, timeout: 3_000 })
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
