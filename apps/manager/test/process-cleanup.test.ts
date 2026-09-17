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
