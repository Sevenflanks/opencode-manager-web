import assert from "node:assert/strict"
import { mkdir, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { prepareIsolatedEnvironment } from "../src/isolation.js"
import { OpenCodeRuntime, type LaunchResult } from "../src/runtime.js"
import type { InstanceRecord } from "../src/repository.js"

const enabled = process.env.OMW_REAL_OPENCODE_TEST === "1"

test("installed OpenCode survives its launcher, proves directory identity, and stops by exact identity", { skip: !enabled, timeout: 45_000 }, async () => {
  const executable = process.env.OMW_OPENCODE_EXECUTABLE
  assert.ok(executable, "OMW_OPENCODE_EXECUTABLE is required")
  const sandbox = path.join(tmpdir(), `omw-real-${randomUUID()}`)
  const project = path.join(sandbox, "project")
  const config = path.join(sandbox, "config")
  const data = path.join(sandbox, "data")
  await Promise.all([mkdir(project, { recursive: true }), mkdir(config, { recursive: true }), mkdir(data, { recursive: true })])
  const configFile = path.join(config, "opencode.json")
  await writeFile(configFile, "{\"plugin\":[]}\n", "utf8")
  const isolation = await prepareIsolatedEnvironment({ mode: "test", root: sandbox, configFile, sourceEnvironment: process.env })

  const runtime = new OpenCodeRuntime({
    executable,
    dataDirectory: data,
    environment: {
      ...isolation.environment,
      OPENCODE_SERVER_USERNAME: "inherited-user-sentinel",
      OPENCODE_SERVER_PASSWORD: "inherited-password-sentinel",
    },
  })
  const instanceId = randomUUID()
  const port = await freePort()
  let launch: LaunchResult | null = null
  try {
    launch = await runtime.launch(project, port, instanceId)
    const health = await runtime.readiness(launch)
    assert.ok(health.version)
    assert.equal(path.resolve(health.directory).toLowerCase(), path.resolve(project).toLowerCase())
    const unauthenticatedHealth = await fetch(`http://127.0.0.1:${port}/global/health`, { redirect: "error" })
    assert.equal(unauthenticatedHealth.status, 200)
    const observed = await runtime.inspect(asRecord(launch, port))
    assert.deepEqual(observed, { processState: "running", running: true, matched: true, portOwnerMatched: true, portOwnedByOther: false })
    const created = await runtime.createSession(asRecord(launch, port))
    assert.ok(created.id)
    assert.equal(created.parentID, undefined)
    assert.ok((await runtime.sessions(asRecord(launch, port))).some((session) => session.id === created.id))
  } finally {
    if (launch) {
      const stopped = await runtime.stop(asRecord(launch, port))
      assert.deepEqual(stopped, { stopped: true, reason: null })
      assert.equal(await portReachable(port), false)
    }
    await rm(sandbox, { recursive: true, force: true })
  }
})

function asRecord(launch: LaunchResult, port: number): InstanceRecord {
  return {
    id: launch.instanceId,
    projectName: path.basename(launch.directory),
    projectDirectory: launch.directory,
    state: "ready",
    endpoint: launch.endpoint,
    port,
    pid: launch.pid,
    creationTimeUtc: launch.creationTimeUtc,
    creationTimeTicks: launch.creationTimeTicks,
    executable: launch.executable,
    launchedAt: new Date().toISOString(),
    healthVersion: null,
    stoppedAt: null,
    error: null,
    stderrSummary: null,
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close((error) => error ? reject(error) : resolve(typeof address === "object" && address ? address.port : 0))
    })
  })
}

function portReachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port })
    const finish = (value: boolean) => { socket.destroy(); resolve(value) }
    socket.setTimeout(300)
    socket.once("connect", () => finish(true))
    socket.once("timeout", () => finish(false))
    socket.once("error", () => finish(false))
  })
}
