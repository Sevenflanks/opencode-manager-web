import assert from "node:assert/strict"
import { mkdir, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { randomUUID } from "node:crypto"
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
  await writeFile(path.join(config, "opencode.json"), "{\"plugin\":[]}\n", "utf8")
  isolateEnvironment(sandbox, config)

  const runtime = new OpenCodeRuntime({ executable, dataDirectory: data })
  const instanceId = randomUUID()
  const port = await freePort()
  let launch: LaunchResult | null = null
  try {
    launch = await runtime.launch(project, port, instanceId)
    const health = await runtime.readiness(launch)
    assert.ok(health.version)
    assert.equal(path.resolve(health.directory).toLowerCase(), path.resolve(project).toLowerCase())
    const observed = await runtime.inspect(asRecord(launch, port))
    assert.deepEqual(observed, { running: true, matched: true, portOwnerMatched: true, portOwnedByOther: false })
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

function isolateEnvironment(sandbox: string, config: string): void {
  const sensitive = /^(?:OPENCODE|OTUI)|(?:_API_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIAL|AUTH|^AWS_|^AZURE_|^GOOGLE_|^GITHUB_|^GITLAB_|^ANTHROPIC_|^OPENAI_)/i
  for (const name of Object.keys(process.env)) if (sensitive.test(name)) delete process.env[name]
  const home = path.join(sandbox, "home")
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    OPENCODE_TEST_HOME: home,
    XDG_CONFIG_HOME: path.join(sandbox, "xdg-config"),
    XDG_DATA_HOME: path.join(sandbox, "xdg-data"),
    XDG_CACHE_HOME: path.join(sandbox, "xdg-cache"),
    XDG_STATE_HOME: path.join(sandbox, "xdg-state"),
    OPENCODE_DB: path.join(sandbox, "opencode.sqlite"),
    OPENCODE_CONFIG: path.join(config, "opencode.json"),
    OPENCODE_CONFIG_DIR: config,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_PURE: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_PRUNE: "1",
    OPENCODE_AUTO_SHARE: "false",
  })
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
