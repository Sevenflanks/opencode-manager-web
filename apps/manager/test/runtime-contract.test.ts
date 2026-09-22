import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { managedServerEnvironment, OpenCodeRuntime, runProcessHelper } from "../src/runtime.js"
import type { InstanceRecord } from "../src/repository.js"

test("summary keeps successful endpoint signals when one endpoint fails", async (t) => {
  const directory = "C:\\workspace\\專案"
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    assert.equal(url.searchParams.get("directory"), directory)
    response.setHeader("content-type", "application/json")
    if (url.pathname === "/session") return response.end(JSON.stringify([{ id: "ses_root", title: "主工作", directory }]))
    if (url.pathname === "/session/status") return response.end("{}")
    if (url.pathname === "/question") {
      response.statusCode = 503
      return response.end(JSON.stringify({ error: "unavailable" }))
    }
    if (url.pathname === "/permission") {
      return response.end(JSON.stringify([
        { id: "req_1", sessionID: "ses_root" },
        { id: "req_1", sessionID: "ses_root" },
      ]))
    }
    response.statusCode = 404
    return response.end("{}")
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const address = server.address()
  assert.ok(address && typeof address === "object")

  const dataDirectory = await mkdtemp(path.join(tmpdir(), "omw-runtime-contract-"))
  t.after(() => rm(dataDirectory, { recursive: true, force: true }))
  const runtime = new OpenCodeRuntime({ executable: process.execPath, dataDirectory })
  const instance = record(directory, address.port)
  const summary = await runtime.summary(instance)

  assert.equal(summary.activity, "none-reported")
  assert.equal(summary.busySessions, 0)
  assert.equal(summary.pendingQuestions, null)
  assert.equal(summary.pendingPermissions, 1)
  assert.deepEqual(summary.sessions.map((session) => session.id), ["ses_root"])
  assert.match(summary.error ?? "", /question/)
})

test("multiple slow process helpers do not block the event loop", async () => {
  const helpers = Array.from({ length: 4 }, () => runProcessHelper<{ ok: boolean }>(
    process.execPath,
    ["-e", "setTimeout(() => process.stdout.write(JSON.stringify({ ok: true })), 250)"],
  ))

  const timerWon = await Promise.race([
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 50)),
    Promise.all(helpers).then(() => false),
  ])

  assert.equal(timerWon, true)
  assert.deepEqual(await Promise.all(helpers), Array.from({ length: 4 }, () => ({ ok: true })))
})

test("process helper bounds its deadline and captured output", async () => {
  await assert.rejects(
    runProcessHelper(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], { timeoutMs: 50 }),
    /執行逾時/,
  )
  await assert.rejects(
    runProcessHelper(process.execPath, ["-e", "process.stdout.write('x'.repeat(2048))"], { maxOutputBytes: 1024 }),
    /輸出超過限制/,
  )
})

test("process helper decodes UTF-8 only after split output chunks are complete", async () => {
  const fixture = [
    "const output = Buffer.from(JSON.stringify({ path: 'C:\\\\workspace\\\\專案' }))",
    "const splitAt = output.indexOf(Buffer.from('專')) + 1",
    "process.stdout.write(output.subarray(0, splitAt))",
    "setTimeout(() => process.stdout.write(output.subarray(splitAt)), 10)",
  ].join(";")

  const result = await runProcessHelper<{ path: string }>(process.execPath, ["-e", fixture])

  assert.equal(result.path, "C:\\workspace\\專案")
})

test("OpenCode 1.18.31 Web URLs use its URL-safe directory route", async (t) => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "omw-runtime-url-"))
  t.after(() => rm(dataDirectory, { recursive: true, force: true }))
  const runtime = new OpenCodeRuntime({ executable: process.execPath, dataDirectory })
  const instance = record("C:\\workspace\\專案", 43210)
  const encodedDirectory = Buffer.from(instance.projectDirectory, "utf8").toString("base64url")

  assert.equal(new URL(runtime.openUrl(instance)).pathname, `/${encodedDirectory}/session`)
  assert.equal(new URL(runtime.openUrl(instance, "ses_1")).pathname, `/${encodedDirectory}/session/ses_1`)
  assert.equal(new URL(runtime.openUrl(instance, "ses_1")).search, "")
})

test("OpenCode internal API calls are unauthenticated and only open configured HTTPS mappings", async (t) => {
  const directory = "C:\\workspace\\secure"
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, undefined)
    response.setHeader("content-type", "application/json")
    response.end("[]")
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === "object")
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "omw-runtime-auth-"))
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await rm(dataDirectory, { recursive: true, force: true })
  })
  const runtime = new OpenCodeRuntime({
    executable: process.execPath,
    dataDirectory,
    publicOriginForPort: (port) => `https://device.example.ts.net:${port}`,
  })
  const instance = record(directory, address.port)

  assert.deepEqual(await runtime.sessions(instance), [])
  assert.equal(new URL(runtime.openUrl(instance)).origin, `https://device.example.ts.net:${address.port}`)
  assert.equal(new URL(runtime.openUrl(instance)).pathname, `/${Buffer.from(directory).toString("base64url")}/session`)
})

test("activity evidence keeps exact busy IDs and session creation is a directory-scoped empty root", async (t) => {
  const directory = "C:\\workspace\\activity"
  const requests: Array<{ method: string; pathname: string; directory: string | null; body: string }> = []
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    let body = ""
    request.setEncoding("utf8")
    request.on("data", (chunk) => { body += chunk })
    request.on("end", () => {
      requests.push({ method: request.method ?? "", pathname: url.pathname, directory: url.searchParams.get("directory"), body })
      response.setHeader("content-type", "application/json")
      if (url.pathname === "/session/status") return response.end(JSON.stringify({ busy: { type: "busy" }, idle: { type: "idle" } }))
      if (url.pathname === "/session" && request.method === "POST") {
        return response.end(JSON.stringify({ id: "created", title: "New session", directory, time: { created: 1, updated: 1 } }))
      }
      if (url.pathname === "/session" && request.method === "GET") {
        return response.end(JSON.stringify([{ id: "foreign", title: "Foreign", directory: "C:\\workspace\\other" }]))
      }
      response.statusCode = 404
      return response.end("{}")
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const address = server.address()
  assert.ok(address && typeof address === "object")
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "omw-runtime-activity-"))
  t.after(() => rm(dataDirectory, { recursive: true, force: true }))
  const runtime = new OpenCodeRuntime({ executable: process.execPath, dataDirectory })
  const instance = record(directory, address.port)

  assert.deepEqual(await runtime.activity(instance), { busySessionIds: ["busy"] })
  assert.deepEqual(await runtime.createSession(instance), { id: "created", title: "New session", updatedAt: 1 })
  await assert.rejects(runtime.sessions(instance), /directory 與 Instance 不符/)
  assert.deepEqual(requests.map((request) => [request.method, request.pathname, request.directory, request.body]), [
    ["GET", "/session/status", directory, ""],
    ["POST", "/session", directory, "{}"],
    ["GET", "/session", directory, ""],
  ])
})

test("project-scoped SSE preserves a short busy ID even when the connected snapshot is already idle", async (t) => {
  const directory = "C:\\workspace\\events"
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    assert.equal(url.searchParams.get("directory"), directory)
    if (url.pathname === "/session/status") {
      response.setHeader("content-type", "application/json")
      return response.end("{}")
    }
    if (url.pathname === "/event") {
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`)
      response.write(`data: ${JSON.stringify({ type: "session.status", properties: { sessionID: "short-work", status: { type: "busy" } } })}\n\n`)
      response.write(`data: ${JSON.stringify({ type: "session.created", properties: { info: { id: "new-root", title: "New root", directory } } })}\n\n`)
      return
    }
    response.statusCode = 404
    return response.end("{}")
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const address = server.address()
  assert.ok(address && typeof address === "object")
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "omw-runtime-events-"))
  t.after(() => rm(dataDirectory, { recursive: true, force: true }))
  const runtime = new OpenCodeRuntime({ executable: process.execPath, dataDirectory })
  const events: unknown[] = []
  const observer = runtime.observeActivity(record(directory, address.port), (event) => { events.push(event) })
  t.after(() => observer.close())

  await waitFor(() => events.length === 3, 1_000)
  assert.deepEqual(events, [
    { type: "activity", source: "snapshot", sessionIds: [] },
    { type: "activity", source: "event", sessionIds: ["short-work"] },
    { type: "session-created", sessionId: "new-root" },
  ])
  observer.close()
  await observer.done
})

test("managed headless environment removes inherited OpenCode server auth", () => {
  const parent = {
    PATH: "fixture-path",
    TEMP: "C:\\fixture\\temp",
    OPENCODE_DB: "C:\\fixture\\opencode.sqlite",
    OPENCODE_SERVER_USERNAME: "inherited-user-sentinel",
    OPENCODE_SERVER_PASSWORD: "inherited-password-sentinel",
  }
  const child = managedServerEnvironment(parent)

  assert.deepEqual(child, {
    PATH: "fixture-path",
    TEMP: "C:\\fixture\\temp",
    OPENCODE_DB: "C:\\fixture\\opencode.sqlite",
  })
  assert.deepEqual(parent, {
    PATH: "fixture-path",
    TEMP: "C:\\fixture\\temp",
    OPENCODE_DB: "C:\\fixture\\opencode.sqlite",
    OPENCODE_SERVER_USERNAME: "inherited-user-sentinel",
    OPENCODE_SERVER_PASSWORD: "inherited-password-sentinel",
  })
})

test("an unrecognized or malformed Session status keeps activity unknown", async (t) => {
  const directory = "C:\\workspace\\專案"
  const responses = [
    { ses_future: { type: "future-status" } },
    { ses_retry: { type: "retry", attempt: -1, message: "later", next: 10 } },
  ]
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    response.setHeader("content-type", "application/json")
    if (url.pathname === "/session/status") return response.end(JSON.stringify(responses.shift()))
    if (url.pathname === "/session" || url.pathname === "/question" || url.pathname === "/permission") return response.end("[]")
    response.statusCode = 404
    return response.end("{}")
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const address = server.address()
  assert.ok(address && typeof address === "object")
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "omw-runtime-status-"))
  t.after(() => rm(dataDirectory, { recursive: true, force: true }))
  const runtime = new OpenCodeRuntime({ executable: process.execPath, dataDirectory })
  const instance = record(directory, address.port)

  for (const _expected of ["future-status", "retry"]) {
    const summary = await runtime.summary(instance)
    assert.equal(summary.activity, "unknown")
    assert.equal(summary.busySessions, null)
    assert.deepEqual(summary.invalidStatusSessionIds, ["ses_a"])
    assert.match(summary.error ?? "", /status: RESPONSE_INVALID/)
  }
})

test("malformed summary entries retain attributable Session IDs without accepting partial aggregates", async (t) => {
  const directory = "C:\\workspace\\專案"
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    response.setHeader("content-type", "application/json")
    if (url.pathname === "/session") {
      return response.end(JSON.stringify([
        { id: "root-a", title: "Root A", directory },
        { id: "root-b", title: "Root B", directory },
      ]))
    }
    if (url.pathname === "/session/status") {
      return response.end(JSON.stringify({
        "root-a": { type: "idle" },
        "root-b": { type: "future-status" },
      }))
    }
    if (url.pathname === "/question") {
      return response.end(JSON.stringify([
        { id: "question-a", sessionID: "root-a" },
        { id: 42, sessionID: "root-b" },
      ]))
    }
    if (url.pathname === "/permission") return response.end(JSON.stringify([{ id: "permission-without-session" }]))
    response.statusCode = 404
    return response.end("{}")
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const address = server.address()
  assert.ok(address && typeof address === "object")
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "omw-runtime-attributed-invalid-"))
  t.after(() => rm(dataDirectory, { recursive: true, force: true }))
  const runtime = new OpenCodeRuntime({ executable: process.execPath, dataDirectory })

  const summary = await runtime.summary(record(directory, address.port))
  assert.equal(summary.activity, "unknown")
  assert.equal(summary.busySessions, null)
  assert.deepEqual(summary.sessionStatuses, [{ sessionId: "root-a", type: "idle" }])
  assert.deepEqual(summary.invalidStatusSessionIds, ["root-b"])
  assert.equal(summary.pendingQuestions, null)
  assert.deepEqual(summary.questionRequests, [{ id: "question-a", sessionId: "root-a" }])
  assert.deepEqual(summary.invalidQuestionSessionIds, ["root-b"])
  assert.equal(summary.pendingPermissions, null)
  assert.equal(summary.permissionRequests, null)
  assert.equal(summary.invalidPermissionSessionIds, null)
})

test("validated idle and retry statuses are explicit non-busy reports", async (t) => {
  const directory = "C:\\workspace\\專案"
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    response.setHeader("content-type", "application/json")
    if (url.pathname === "/session/status") {
      return response.end(JSON.stringify({
        ses_idle: { type: "idle" },
        ses_retry: { type: "retry", attempt: 1, message: "稍後重試", next: 2_000 },
      }))
    }
    if (url.pathname === "/session" || url.pathname === "/question" || url.pathname === "/permission") return response.end("[]")
    response.statusCode = 404
    return response.end("{}")
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const address = server.address()
  assert.ok(address && typeof address === "object")
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "omw-runtime-known-status-"))
  t.after(() => rm(dataDirectory, { recursive: true, force: true }))
  const runtime = new OpenCodeRuntime({ executable: process.execPath, dataDirectory })

  const summary = await runtime.summary(record(directory, address.port))
  assert.equal(summary.activity, "reported-non-busy")
  assert.equal(summary.busySessions, 0)
  assert.equal(summary.retrySessions, 1)
  assert.deepEqual(summary.sessionStatuses, [
    { sessionId: "ses_idle", type: "idle" },
    { sessionId: "ses_retry", type: "retry" },
  ])
  assert.deepEqual(summary.questionRequests, [])
  assert.deepEqual(summary.permissionRequests, [])
  assert.equal(summary.error, null)
})

test("pending request responses reject malformed entries and count distinct request IDs", async (t) => {
  const directory = "C:\\workspace\\專案"
  const questions: unknown[] = [
    null,
    [{ id: 42, sessionID: "ses_a" }],
    [
      { id: "req_same", sessionID: "ses_a", extension: "allowed" },
      { id: "req_same", sessionID: "ses_a" },
    ],
    [
      { id: "req_a", sessionID: "ses_same" },
      { id: "req_b", sessionID: "ses_same" },
      { id: "req_c", sessionID: "ses_other" },
    ],
  ]
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    response.setHeader("content-type", "application/json")
    if (url.pathname === "/question") return response.end(JSON.stringify(questions.shift()))
    if (url.pathname === "/permission") return response.end(JSON.stringify([{ id: "perm_1", sessionID: "ses_a" }]))
    if (url.pathname === "/session/status") return response.end("{}")
    if (url.pathname === "/session") return response.end("[]")
    response.statusCode = 404
    return response.end("{}")
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const address = server.address()
  assert.ok(address && typeof address === "object")
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "omw-runtime-pending-"))
  t.after(() => rm(dataDirectory, { recursive: true, force: true }))
  const runtime = new OpenCodeRuntime({ executable: process.execPath, dataDirectory })
  const instance = record(directory, address.port)

  for (let index = 0; index < 2; index++) {
    const summary = await runtime.summary(instance)
    assert.equal(summary.pendingQuestions, null)
    assert.equal(summary.pendingPermissions, 1)
    if (index === 0) {
      assert.equal(summary.questionRequests, null)
      assert.equal(summary.invalidQuestionSessionIds, null)
    } else {
      assert.deepEqual(summary.questionRequests, [])
      assert.deepEqual(summary.invalidQuestionSessionIds, ["ses_a"])
    }
    assert.deepEqual(summary.permissionRequests, [{ id: "perm_1", sessionId: "ses_a" }])
    assert.match(summary.error ?? "", /question: RESPONSE_INVALID/)
  }
  const duplicate = await runtime.summary(instance)
  assert.equal(duplicate.pendingQuestions, 1)
  assert.deepEqual(duplicate.questionRequests, [
    { id: "req_same", sessionId: "ses_a" },
    { id: "req_same", sessionId: "ses_a" },
  ])
  assert.equal(duplicate.error, null)
  const distinct = await runtime.summary(instance)
  assert.equal(distinct.pendingQuestions, 3)
  assert.deepEqual(distinct.questionRequests, [
    { id: "req_a", sessionId: "ses_same" },
    { id: "req_b", sessionId: "ses_same" },
    { id: "req_c", sessionId: "ses_other" },
  ])
  assert.equal(distinct.error, null)
})

test("credential-shaped child output is not captured in runtime artifacts", async (t) => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "omw-runtime-output-"))
  const dataDirectory = path.join(sandbox, "data")
  const preload = path.join(sandbox, "fixture-output.cjs")
  const password = "fixture-output-password"
  const authorization = "Basic Zml4dHVyZS11c2VyOmZpeHR1cmUtb3V0cHV0LXBhc3N3b3Jk"
  await writeFile(preload, `process.stdout.write("OPENCODE_SERVER_PASSWORD=${password}\\n"); process.stderr.write("Authorization: ${authorization}\\n")\n`, "utf8")
  const runtime = new OpenCodeRuntime({
    executable: process.execPath,
    dataDirectory,
    environment: { ...process.env, NODE_OPTIONS: `--require=${preload}` },
  })
  t.after(async () => {
    await runtime.cleanupLaunch("credential-output").catch(() => undefined)
    await rm(sandbox, { recursive: true, force: true })
  })

  await runtime.launch(sandbox, 49_999, "credential-output").catch(() => undefined)
  await new Promise((resolve) => setTimeout(resolve, 250))
  const entries = await readdir(dataDirectory, { recursive: true, withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isFile()) continue
    assert.notEqual(entry.name, "stdout.log")
    assert.notEqual(entry.name, "stderr.log")
    const content = await readFile(path.join(entry.parentPath, entry.name))
    assert.equal(content.includes(password) || content.includes(authorization), false, `secret leaked to ${entry.name}`)
  }
})

function record(projectDirectory: string, port: number): InstanceRecord {
  return {
    id: "instance-contract",
    projectName: "專案",
    projectDirectory,
    state: "ready",
    endpoint: `http://127.0.0.1:${port}`,
    port,
    pid: null,
    creationTimeUtc: null,
    creationTimeTicks: null,
    executable: null,
    launchedAt: "2026-09-17T00:00:00.000Z",
    healthVersion: "1.18.31",
    stoppedAt: null,
    error: null,
    stderrSummary: null,
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not met before timeout")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
