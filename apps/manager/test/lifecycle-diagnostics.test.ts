import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { prepareIsolatedEnvironment, type IsolationContext } from "../src/isolation.js"
import { DpapiCredentialStore } from "../src/credential-store.js"

const directory = path.dirname(fileURLToPath(import.meta.url))
const diagnosticsUrl = pathToFileURL(path.resolve(directory, "../src/lifecycle-diagnostics.js")).href
const server = path.resolve(directory, "../src/server.js")
const deadlineMs = 8_000

async function withIsolatedChild(run: (context: IsolationContext, execute: (script: string | null, override?: NodeJS.ProcessEnv, onSpawn?: (child: ChildProcess) => Promise<void>) => Promise<{ code: number; stderr: string }>) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "omw-lifecycle-"))
  const context = await prepareIsolatedEnvironment({ mode: "test", root, ownedRoot: true, sourceEnvironment: process.env })
  let child: ChildProcess | undefined
  const execute = async (script: string | null, override: NodeJS.ProcessEnv = {}, onSpawn?: (child: ChildProcess) => Promise<void>): Promise<{ code: number; stderr: string }> => {
    const arguments_ = script === null ? [server] : ["--input-type=module", "-e", script]
    child = spawn(process.execPath, arguments_, {
      env: { ...context.environment, ...override }, stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
    })
    const ownedChild = child
    let stderr = ""
    ownedChild.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16_384) })
    const closed = new Promise<{ code: number; stderr: string }>((resolve, reject) => {
      const timer = setTimeout(() => { ownedChild.kill(); reject(new Error("isolated Manager fixture timed out")) }, deadlineMs)
      ownedChild.once("error", (error) => { clearTimeout(timer); reject(error) })
      ownedChild.once("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stderr }) })
    })
    if (onSpawn) {
      try { await onSpawn(ownedChild) } catch (error) {
        ownedChild.kill()
        await closed.catch(() => undefined)
        throw error
      }
    }
    const result = await closed
    child = undefined
    return result
  }
  try {
    await run(context, execute)
  } finally {
    if (child) {
      if (child.exitCode === null && child.signalCode === null) child.kill()
      // 只有持有的 child 確認退出後才能刪除隔離資料；未確認時保留 root 供 owner 排查。
      await new Promise<void>((resolve, reject) => {
        if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return resolve()
        const timer = setTimeout(() => reject(new Error("owned Manager fixture cleanup unresolved")), 3_000)
        child.once("close", () => { clearTimeout(timer); resolve() })
      })
    }
    await context.dispose()
  }
}

async function log(context: IsolationContext): Promise<Array<Record<string, unknown>>> {
  const contents = await readFile(path.join(context.paths.omwData, "logs", "manager-lifecycle.jsonl"), "utf8")
  return contents.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
}

test("a real uncaught throw and unhandled rejection retain Node's nonzero crash behavior and safe diagnostics", { timeout: 25_000 }, async () => {
  for (const [source, statement] of [
    ["uncaughtException", "setImmediate(() => { throw new Error('private crash marker') })"],
    ["unhandledRejection", "Promise.reject(new Error('private rejection marker'))"],
  ]) {
    await withIsolatedChild(async (context, execute) => {
      const result = await execute(`const { createLifecycleDiagnostics } = await import(${JSON.stringify(diagnosticsUrl)}); createLifecycleDiagnostics(process.env.OMW_DATA_DIR); ${statement}`)
      assert.notEqual(result.code, 0, result.stderr)
      const records = await log(context)
      assert.equal(records[0]?.event, "start")
      assert.equal(records.find((entry) => entry.event === "uncaught_exception")?.source, source)
      assert.equal(records.at(-1)?.event, "exit")
      assert.notEqual(records.at(-1)?.code, 0)
      assert.doesNotMatch(JSON.stringify(records), /private crash marker|private rejection marker/)
    })
  }
})

test("revoked Proxy thrown as fatal error cannot make the monitor crash with exit code 7", { timeout: 12_000 }, async () => {
  await withIsolatedChild(async (context, execute) => {
    const result = await execute(`const { createLifecycleDiagnostics } = await import(${JSON.stringify(diagnosticsUrl)}); createLifecycleDiagnostics(process.env.OMW_DATA_DIR); const { proxy, revoke } = Proxy.revocable(new Error('private revoked error'), {}); revoke(); setImmediate(() => { throw proxy })`)
    assert.notEqual(result.code, 0)
    assert.notEqual(result.code, 7, "the monitor must not replace the original fatal with its own exception")
    const records = await log(context)
    assert.deepEqual(records.find((entry) => entry.event === "uncaught_exception")?.error, { name: null, code: null, frames: [] })
    assert.equal(records.at(-1)?.event, "exit")
    assert.doesNotMatch(JSON.stringify(records), /private revoked error/)
  })
})

test("hostile context and record details never throw from diagnostic entry points", { timeout: 12_000 }, async () => {
  await withIsolatedChild(async (context, execute) => {
    const result = await execute(`const { createLifecycleDiagnostics } = await import(${JSON.stringify(diagnosticsUrl)}); const logger = createLifecycleDiagnostics(process.env.OMW_DATA_DIR); const { proxy, revoke } = Proxy.revocable({}, {}); revoke(); logger.setContext(proxy); logger.record('ready', proxy); logger.record('ready')`)
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual((await log(context)).map((entry) => entry.event), ["start", "ready", "exit"])
  })
})

test("normal shutdown records ordered lifecycle and exits zero", { timeout: 12_000 }, async () => {
  await withIsolatedChild(async (context, execute) => {
    const result = await execute(`const { createLifecycleDiagnostics } = await import(${JSON.stringify(diagnosticsUrl)}); const logger = createLifecycleDiagnostics(process.env.OMW_DATA_DIR); logger.setContext({ port: Number(process.env.OMW_PORT), managerVersion: '0.3.0' }); logger.record('ready'); logger.record('shutdown_requested', { source: 'api' }); logger.record('close_completed')`)
    assert.equal(result.code, 0, result.stderr)
    const records = await log(context)
    assert.deepEqual(records.map((entry) => entry.event), ["start", "ready", "shutdown_requested", "close_completed", "exit"])
    assert.equal(records[0]?.pid, records.at(-1)?.pid)
    assert.equal(records[0]?.ppid, process.pid)
    assert.equal(records[0]?.nodeVersion, process.version)
    assert.equal(records[1]?.managerVersion, "0.3.0")
    assert.equal(records[1]?.port, Number(context.environment.OMW_PORT))
    assert.equal(records.at(-1)?.code, 0)
  })
})

test("real Manager closes after its authenticated API shutdown", { skip: process.platform !== "win32", timeout: 20_000 }, async () => {
  await withIsolatedChild(async (context, execute) => {
    const password = "fixture-password-123456"
    await new DpapiCredentialStore({ dataDirectory: context.paths.omwData }).save({
      manager: { username: "fixture", password }, launcherToken: "x".repeat(32),
    })
    const origin = `http://127.0.0.1:${context.environment.OMW_PORT}`
    const result = await execute(null, { OMW_REMOTE_ACCESS: "0", OMW_OPENCODE_EXECUTABLE: process.execPath }, async (child) => {
      const deadline = Date.now() + 6_000
      while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Manager exited before ready: ${JSON.stringify(await log(context))}`)
        const records = await log(context).catch(() => [])
        if (records.some((record) => record.event === "ready")) break
        await new Promise((resolve) => setTimeout(resolve, 60))
      }
      assert.ok((await log(context)).some((record) => record.event === "ready"), "Manager must become ready")
      const response = await fetch(`${origin}/api/v1/manager/shutdown`, {
        method: "POST", headers: { authorization: `Basic ${Buffer.from(`fixture:${password}`).toString("base64")}`, origin, "x-omw-csrf": "1" },
        signal: AbortSignal.timeout(2_000),
      })
      assert.equal(response.status, 202)
    })
    assert.equal(result.code, 0, result.stderr)
    const records = await log(context)
    assert.deepEqual(records.map((record) => record.event), ["start", "ready", "shutdown_requested", "close_completed", "exit"])
    assert.equal(records[2]?.source, "api")
  })
})

test("server initialization failure before credentials leaves stage and nonzero exit", { timeout: 12_000 }, async () => {
  await withIsolatedChild(async (context, execute) => {
    const result = await execute(null, { OMW_PORT: "invalid-private-port" })
    assert.notEqual(result.code, 0)
    const records = await log(context)
    assert.equal(records[0]?.event, "start")
    assert.equal(records.find((entry) => entry.event === "startup_failed")?.stage, "port")
    assert.equal(records.at(-1)?.event, "exit")
    assert.doesNotMatch(JSON.stringify(records), /invalid-private-port/)
  })
})

test("hostile error fields and stack never write secrets, only allowlisted source positions", { timeout: 12_000 }, async () => {
  await withIsolatedChild(async (context, execute) => {
    const result = await execute(`const { createLifecycleDiagnostics } = await import(${JSON.stringify(diagnosticsUrl)}); const logger = createLifecycleDiagnostics(process.env.OMW_DATA_DIR); const error = new Error('secret-message-123'); error.name = 'secret-name-123'; error.code = 'SECRET_CODE_123'; error.cause = 'secret-cause-123'; error.stack = 'Error: secret-stack-123\\n    at leak (C:\\\\Users\\\\secret-user\\\\secret.js:1:2)\\n    at safe (${diagnosticsUrl}:11:20) secret-tail-123\\n    at safe (${diagnosticsUrl}:12:21)'; logger.record('startup_failed', { stage: 'credentials', error })`)
    assert.equal(result.code, 0, result.stderr)
    const records = await log(context)
    assert.deepEqual(records.find((entry) => entry.event === "startup_failed")?.error, { name: null, code: null, frames: ["lifecycle-diagnostics.js:12:21"] })
    assert.doesNotMatch(JSON.stringify(records), /secret-|Users|cause|message/)
  })
})

test("forged nonexistent Manager source filenames are never recorded", { timeout: 12_000 }, async () => {
  await withIsolatedChild(async (context, execute) => {
    const fakeUrl = new URL("CREDENTIAL_SAMPLE_123456.js", diagnosticsUrl).href
    const result = await execute(`const { createLifecycleDiagnostics } = await import(${JSON.stringify(diagnosticsUrl)}); const error = new Error('secret'); error.stack = 'Error: secret\\n    at fake (${fakeUrl}:9:3)\\n    at real (${diagnosticsUrl}:12:21)'; createLifecycleDiagnostics(process.env.OMW_DATA_DIR).record('startup_failed', { stage: 'credentials', error })`)
    assert.equal(result.code, 0, result.stderr)
    const records = await log(context)
    assert.deepEqual(records.find((entry) => entry.event === "startup_failed")?.error, { name: "Error", code: null, frames: ["lifecycle-diagnostics.js:12:21"] })
    assert.doesNotMatch(JSON.stringify(records), /CREDENTIAL_SAMPLE_123456|secret/)
  })
})

test("huge forged frame and string fields preserve valid bounded JSONL", { timeout: 12_000 }, async () => {
  await withIsolatedChild(async (context, execute) => {
    const result = await execute(`const { createLifecycleDiagnostics } = await import(${JSON.stringify(diagnosticsUrl)}); const logger = createLifecycleDiagnostics(process.env.OMW_DATA_DIR); const error = new Error('secret'); error.stack = 'Error: secret\\n    at forged (${diagnosticsUrl}:' + '9'.repeat(132000) + ':1)\\n    at tooLarge (${diagnosticsUrl}:999999:999999)'; logger.record('startup_failed', { stage: 'secret-stage-' + 'x'.repeat(132000), source: 'secret-source-' + 'x'.repeat(132000), error }); logger.record('ready')`)
    assert.equal(result.code, 0, result.stderr)
    const current = path.join(context.paths.omwData, "logs", "manager-lifecycle.jsonl")
    assert.ok((await stat(current)).size <= 128 * 1024)
    const records = await log(context)
    assert.deepEqual(records.map((entry) => entry.event), ["start", "startup_failed", "ready", "exit"])
    assert.deepEqual(records[1]?.error, { name: "Error", code: null, frames: [] })
    assert.equal(records[1]?.stage, undefined)
    assert.equal(records[1]?.source, undefined)
    assert.doesNotMatch(JSON.stringify(records), /secret-stage|secret-source|99999999999999999999/)
  })
})

test("a failing log path does not alter process exit behavior", { timeout: 12_000 }, async () => {
  await withIsolatedChild(async (context, execute) => {
    await writeFile(path.join(context.paths.omwData, "logs"), "occupied")
    const result = await execute(`const { createLifecycleDiagnostics } = await import(${JSON.stringify(diagnosticsUrl)}); createLifecycleDiagnostics(process.env.OMW_DATA_DIR).record('ready')`)
    assert.equal(result.code, 0, result.stderr)
    assert.equal(await readFile(path.join(context.paths.omwData, "logs"), "utf8"), "occupied")
  })
})

test("rotation bounds both JSONL files and retains latest events", { timeout: 12_000 }, async () => {
  await withIsolatedChild(async (context, execute) => {
    const result = await execute(`const { createLifecycleDiagnostics } = await import(${JSON.stringify(diagnosticsUrl)}); const logger = createLifecycleDiagnostics(process.env.OMW_DATA_DIR); for (let i = 0; i < 5000; i++) logger.record('ready')`)
    assert.equal(result.code, 0, result.stderr)
    const prefix = path.join(context.paths.omwData, "logs", "manager-lifecycle.jsonl")
    assert.ok((await stat(prefix)).size <= 128 * 1024)
    assert.ok((await stat(`${prefix}.1`)).size <= 128 * 1024)
    assert.equal((await log(context)).at(-1)?.event, "exit")
  })
})
