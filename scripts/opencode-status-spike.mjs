import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import process from "node:process"
import { startMockProvider } from "./opencode-status-mock-provider.mjs"

const REPO_ROOT = path.resolve(import.meta.dirname, "..")
const OPENCODE = process.env.OPENCODE_SPIKE_EXECUTABLE
const OVERALL_DEADLINE_MS = 120_000
const HTTP_DEADLINE_MS = 4_000
const WAIT_DEADLINE_MS = 12_000
const MAX_STDIO_BYTES = 64 * 1024
const startedAt = Date.now()
const runId = randomUUID().replaceAll("-", "")
const sandbox = path.join(REPO_ROOT, ".scratch", `opencode-status-${runId}`)
const projectDirectory = path.join(sandbox, "project")
const configDirectory = path.join(sandbox, "config")
const resultPath = path.join(sandbox, "result.json")
const fixturePath = path.join(projectDirectory, "fixture.txt")
const owned = []
let provider

const result = {
  status: "running",
  run_id: runId,
  sandbox,
  installed_version: null,
  isolation: {},
  instances: [],
  schemas: {},
  matrix: {},
  provider: {},
  cleanup: {},
  limitations: [
    "SSE client behavior was not tested; bounded HTTP polling was used.",
    "Retry status was not forced and remains NOT VERIFIED.",
    "Only local fixed mock data was used; no real model, credentials, or production data were accessed.",
  ],
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertBudget() {
  if (Date.now() - startedAt >= OVERALL_DEADLINE_MS) throw new Error("Overall 120 second spike deadline exceeded.")
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

async function portReachable(port, timeoutMs = 300) {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port })
    const finish = (value) => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once("connect", () => finish(true))
    socket.once("timeout", () => finish(false))
    socket.once("error", () => finish(false))
  })
}

function isolatedEnvironment() {
  const environment = { ...process.env }
  const credentialName = /(?:_API_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIAL|AUTH|^AWS_|^AZURE_|^GOOGLE_|^GITHUB_|^GITLAB_|^ANTHROPIC_|^OPENAI_|^GEMINI_|^COHERE_|^MISTRAL_|^GROQ_|^CEREBRAS_|^XAI_|^VERTEXAI_|^OCI_)/i
  let removed = 0
  for (const name of Object.keys(environment)) {
    if (/^(?:OPENCODE|OTUI)/i.test(name) || credentialName.test(name)) {
      delete environment[name]
      removed++
    }
  }
  const home = path.join(sandbox, "home")
  Object.assign(environment, {
    HOME: home,
    USERPROFILE: home,
    OPENCODE_TEST_HOME: home,
    XDG_CONFIG_HOME: path.join(sandbox, "xdg-config"),
    XDG_DATA_HOME: path.join(sandbox, "xdg-data"),
    XDG_CACHE_HOME: path.join(sandbox, "xdg-cache"),
    XDG_STATE_HOME: path.join(sandbox, "xdg-state"),
    OPENCODE_DB: path.join(sandbox, "data", "opencode.db"),
    OPENCODE_CONFIG: path.join(configDirectory, "opencode.json"),
    OPENCODE_CONFIG_DIR: configDirectory,
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
  return { environment, removed }
}

function capture(stream) {
  const state = { bytes: 0, truncated: false, chunks: [] }
  stream.on("data", (chunk) => {
    const remaining = MAX_STDIO_BYTES - state.bytes
    if (remaining > 0) {
      const bounded = chunk.subarray(0, remaining)
      state.chunks.push(bounded)
      state.bytes += bounded.length
    }
    if (chunk.length > remaining) state.truncated = true
  })
  return state
}

function startInstance(name, port, environment) {
  assertBudget()
  const child = spawn(
    OPENCODE,
    ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--pure", "--log-level", "INFO"],
    { cwd: projectDirectory, env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  )
  const entry = {
    name,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    child,
    pid: child.pid,
    stdout: capture(child.stdout),
    stderr: capture(child.stderr),
    exit: null,
    launchError: null,
  }
  owned.push(entry)
  child.once("error", (error) => {
    entry.launchError = { name: error.name, message: error.message, code: error.code ?? null }
  })
  child.once("exit", (code, signal) => {
    entry.exit = { code, signal }
  })
  return entry
}

async function request(baseUrl, pathname, { method = "GET", body, expected = [200] } = {}) {
  assertBudget()
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(HTTP_DEADLINE_MS),
  })
  const text = await response.text()
  if (!expected.includes(response.status)) {
    throw new Error(`${method} ${pathname} returned HTTP ${response.status}: ${text.slice(0, 500)}`)
  }
  if (!text) return null
  return JSON.parse(text)
}

function routed(pathname) {
  const separator = pathname.includes("?") ? "&" : "?"
  return `${pathname}${separator}directory=${encodeURIComponent(projectDirectory)}`
}

async function waitFor(description, operation, predicate, timeoutMs = WAIT_DEADLINE_MS) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    assertBudget()
    latest = await operation()
    if (predicate(latest)) return latest
    await sleep(75)
  }
  throw new Error(`${description} was not observed within ${timeoutMs} ms; latest=${JSON.stringify(latest).slice(0, 500)}`)
}

async function waitHealth(instance) {
  return await waitFor(
    `${instance.name} health`,
    async () => {
      try {
        return await request(instance.baseUrl, "/global/health")
      } catch {
        return null
      }
    },
    (health) => health?.healthy === true,
    20_000,
  )
}

async function snapshot(instance) {
  const [sessions, statuses, permissions, questions] = await Promise.all([
    request(instance.baseUrl, routed("/session")),
    request(instance.baseUrl, routed("/session/status")),
    request(instance.baseUrl, routed("/permission")),
    request(instance.baseUrl, routed("/question")),
  ])
  return { sessions, statuses, permissions, questions }
}

function shape(value) {
  if (Array.isArray(value)) {
    return { type: "array", count: value.length, item_keys: [...new Set(value.flatMap((item) => Object.keys(item ?? {})))].sort() }
  }
  return { type: typeof value, keys: value && typeof value === "object" ? Object.keys(value).sort() : [] }
}

function statusFor(statuses, sessionId) {
  return Object.hasOwn(statuses, sessionId) ? statuses[sessionId] : null
}

function pendingFor(items, sessionId) {
  return items.filter((item) => item.sessionID === sessionId)
}

async function observeStatusAfterRelease(instance, sessionId) {
  const observations = []
  const deadline = Date.now() + 4_000
  while (Date.now() < deadline) {
    const statuses = await request(instance.baseUrl, routed("/session/status"))
    const value = statusFor(statuses, sessionId)
    observations.push(value)
    if (value === null && observations.length > 1) break
    await sleep(50)
  }
  return {
    values: [...new Set(observations.map((value) => JSON.stringify(value)))].map((value) => JSON.parse(value)),
    explicit_idle_observed: observations.some((value) => value?.type === "idle"),
    absent_observed: observations.some((value) => value === null),
  }
}

async function promptAsync(instance, sessionId, text) {
  await request(instance.baseUrl, routed(`/session/${sessionId}/prompt_async`), {
    method: "POST",
    expected: [204],
    body: {
      model: { providerID: "localmock", modelID: "mock" },
      tools: { bash: false, edit: false, write: false, patch: false, webfetch: false, task: false },
      parts: [{ type: "text", text }],
    },
  })
}

async function createScenarioSession(instanceA, instanceB, scenario) {
  const session = await request(instanceA.baseUrl, routed("/session"), {
    method: "POST",
    body: { title: `Local ${scenario} boundary fixture` },
  })
  assert(typeof session.id === "string", `${scenario} session creation did not return an id.`)
  const visibleOnB = await waitFor(
    `${scenario} session metadata on instance B`,
    () => request(instanceB.baseUrl, routed("/session")),
    (sessions) => sessions.some((item) => item.id === session.id),
  )
  const [statusA, statusB] = await Promise.all([
    request(instanceA.baseUrl, routed("/session/status")),
    request(instanceB.baseUrl, routed("/session/status")),
  ])
  return {
    id: session.id,
    boundary: {
      metadata_A: true,
      metadata_B: visibleOnB.some((item) => item.id === session.id),
      status_A: statusFor(statusA, session.id),
      status_B: statusFor(statusB, session.id),
    },
  }
}

async function stopInstance(entry) {
  if (entry.exit) return
  entry.child.kill()
  await Promise.race([
    new Promise((resolve) => entry.child.once("exit", resolve)),
    sleep(5_000).then(() => {
      if (!entry.exit) entry.child.kill("SIGKILL")
    }),
  ])
  if (!entry.exit) await Promise.race([new Promise((resolve) => entry.child.once("exit", resolve)), sleep(2_000)])
}

try {
  assert(OPENCODE, "Set OPENCODE_SPIKE_EXECUTABLE to an existing OpenCode executable before running this archived spike.")
  await mkdir(projectDirectory, { recursive: true })
  await mkdir(configDirectory, { recursive: true })
  await mkdir(path.join(sandbox, "data"), { recursive: true })
  await writeFile(fixturePath, "local fixture only\n", "utf8")

  provider = await startMockProvider({ fixturePath })
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: "localmock/mock",
    small_model: "localmock/mock",
    provider: {
      localmock: {
        npm: "@ai-sdk/openai-compatible",
        name: "Local Mock Fixture",
        options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "test-only-dummy" },
        models: {
          mock: {
            name: "Local Mock Fixture",
            limit: { context: 32768, output: 2048 },
            tool_call: true,
          },
        },
      },
    },
    permission: {
      read: "ask",
      bash: "deny",
      edit: "deny",
      write: "deny",
      external_directory: "deny",
      webfetch: "deny",
    },
  }
  await writeFile(path.join(configDirectory, "opencode.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8")

  const { environment, removed } = isolatedEnvironment()
  result.isolation = {
    shared_database: environment.OPENCODE_DB,
    project_directory: projectDirectory,
    config_file: environment.OPENCODE_CONFIG,
    removed_sensitive_variable_name_count: removed,
    credential_values_read_or_logged: false,
    parent_environment_modified: false,
    path_modified: false,
    provider_loopback_only: true,
  }

  const [portA, portB] = [await freePort(), await freePort()]
  const instanceA = startInstance("instance-A", portA, environment)
  const instanceB = startInstance("instance-B", portB, environment)
  const [healthA, healthB] = await Promise.all([waitHealth(instanceA), waitHealth(instanceB)])
  assert(healthA.version === "1.18.31" && healthB.version === "1.18.31", "Both instances must report OpenCode 1.18.31.")
  result.installed_version = healthA.version
  result.instances = owned.map((entry) => ({ name: entry.name, pid: entry.pid, port: entry.port }))

  const initialA = await snapshot(instanceA)
  const initialB = await snapshot(instanceB)
  assert(initialA.sessions.length === 0 && initialB.sessions.length === 0, "Fresh isolated session lists must be empty.")
  assert(Object.keys(initialA.statuses).length === 0 && Object.keys(initialB.statuses).length === 0, "Fresh status maps must be empty.")
  assert(initialA.permissions.length === 0 && initialB.permissions.length === 0, "Fresh permission lists must be empty.")
  assert(initialA.questions.length === 0 && initialB.questions.length === 0, "Fresh question lists must be empty.")
  result.schemas = {
    session: shape(initialA.sessions),
    session_status: shape(initialA.statuses),
    permission: shape(initialA.permissions),
    question: shape(initialA.questions),
  }
  result.matrix.fresh = {
    instance_A: {
      sessions: initialA.sessions.length,
      statuses: Object.keys(initialA.statuses).length,
      permissions: initialA.permissions.length,
      questions: initialA.questions.length,
    },
    instance_B: {
      sessions: initialB.sessions.length,
      statuses: Object.keys(initialB.statuses).length,
      permissions: initialB.permissions.length,
      questions: initialB.questions.length,
    },
  }

  const scenarios = {}
  for (const name of ["busy", "question", "permission", "abort"]) {
    scenarios[name] = await createScenarioSession(instanceA, instanceB, name)
  }
  result.matrix.new_sessions = Object.fromEntries(
    Object.entries(scenarios).map(([name, scenario]) => [name, scenario.boundary]),
  )

  const busySessionId = scenarios.busy.id
  await promptAsync(instanceA, busySessionId, "SPIKE_BUSY_FIXTURE")
  await provider.waitFor((event) => event.phase === "busy")
  const busyA = await waitFor(
    "instance A busy status",
    () => request(instanceA.baseUrl, routed("/session/status")),
    (statuses) => statusFor(statuses, busySessionId)?.type === "busy",
  )
  const [busyB, busySessionsB, busyPermissionsA, busyQuestionsA] = await Promise.all([
    request(instanceB.baseUrl, routed("/session/status")),
    request(instanceB.baseUrl, routed("/session")),
    request(instanceA.baseUrl, routed("/permission")),
    request(instanceA.baseUrl, routed("/question")),
  ])
  result.matrix.busy = {
    status_A: statusFor(busyA, busySessionId),
    status_B: statusFor(busyB, busySessionId),
    metadata_B: busySessionsB.some((item) => item.id === busySessionId),
    pending_permission_A: pendingFor(busyPermissionsA, busySessionId).length,
    pending_question_A: pendingFor(busyQuestionsA, busySessionId).length,
  }
  provider.release("busy")
  result.matrix.after_busy = await observeStatusAfterRelease(instanceA, busySessionId)

  const questionSessionId = scenarios.question.id
  await promptAsync(instanceA, questionSessionId, "SPIKE_QUESTION_FIXTURE")
  await provider.waitFor((event) => event.phase === "question")
  const questionA = await waitFor(
    "instance A pending question",
    () => request(instanceA.baseUrl, routed("/question")),
    (items) => pendingFor(items, questionSessionId).length === 1,
  )
  const questionRequest = pendingFor(questionA, questionSessionId)[0]
  const [questionB, questionStatusA, questionStatusB, questionSessionsB] = await Promise.all([
    request(instanceB.baseUrl, routed("/question")),
    request(instanceA.baseUrl, routed("/session/status")),
    request(instanceB.baseUrl, routed("/session/status")),
    request(instanceB.baseUrl, routed("/session")),
  ])
  result.schemas.question = shape(questionA)
  result.matrix.question = {
    pending_A: pendingFor(questionA, questionSessionId).length,
    pending_B: pendingFor(questionB, questionSessionId).length,
    status_A: statusFor(questionStatusA, questionSessionId),
    status_B: statusFor(questionStatusB, questionSessionId),
    metadata_B: questionSessionsB.some((item) => item.id === questionSessionId),
  }
  result.matrix.question.reply = await request(instanceA.baseUrl, routed(`/question/${questionRequest.id}/reply`), {
    method: "POST",
    body: { answers: [["fixed-answer"]] },
  })
  await waitFor(
    "question reply settlement",
    () => request(instanceA.baseUrl, routed("/question")),
    (items) => pendingFor(items, questionSessionId).length === 0,
  )
  await provider.waitFor(
    (event) => event.scenario === "question" && event.follow_up === true,
  )
  result.matrix.after_question = await observeStatusAfterRelease(instanceA, questionSessionId)

  const permissionSessionId = scenarios.permission.id
  await promptAsync(instanceA, permissionSessionId, "SPIKE_PERMISSION_FIXTURE")
  await provider.waitFor((event) => event.phase === "permission")
  const permissionA = await waitFor(
    "instance A pending permission",
    () => request(instanceA.baseUrl, routed("/permission")),
    (items) => pendingFor(items, permissionSessionId).length === 1,
  )
  const permissionRequest = pendingFor(permissionA, permissionSessionId)[0]
  const [permissionB, permissionStatusA, permissionStatusB, permissionSessionsB] = await Promise.all([
    request(instanceB.baseUrl, routed("/permission")),
    request(instanceA.baseUrl, routed("/session/status")),
    request(instanceB.baseUrl, routed("/session/status")),
    request(instanceB.baseUrl, routed("/session")),
  ])
  result.schemas.permission = shape(permissionA)
  result.matrix.permission = {
    pending_A: pendingFor(permissionA, permissionSessionId).length,
    pending_B: pendingFor(permissionB, permissionSessionId).length,
    status_A: statusFor(permissionStatusA, permissionSessionId),
    status_B: statusFor(permissionStatusB, permissionSessionId),
    metadata_B: permissionSessionsB.some((item) => item.id === permissionSessionId),
    permission: permissionRequest.permission,
  }
  result.matrix.permission.reply = await request(instanceA.baseUrl, routed(`/permission/${permissionRequest.id}/reply`), {
    method: "POST",
    body: { reply: "reject" },
  })
  await waitFor(
    "permission rejection settlement",
    () => request(instanceA.baseUrl, routed("/permission")),
    (items) => pendingFor(items, permissionSessionId).length === 0,
  )
  result.matrix.after_permission = await observeStatusAfterRelease(instanceA, permissionSessionId)

  const abortSessionId = scenarios.abort.id
  await promptAsync(instanceA, abortSessionId, "SPIKE_ABORT_FIXTURE")
  await provider.waitFor((event) => event.phase === "abort")
  await waitFor(
    "instance A abort fixture busy status",
    () => request(instanceA.baseUrl, routed("/session/status")),
    (statuses) => statusFor(statuses, abortSessionId)?.type === "busy",
  )
  const [abortStatusA, abortStatusB, abortSessionsB, abortPermissionsA, abortPermissionsB, abortQuestionsA, abortQuestionsB] =
    await Promise.all([
      request(instanceA.baseUrl, routed("/session/status")),
      request(instanceB.baseUrl, routed("/session/status")),
      request(instanceB.baseUrl, routed("/session")),
      request(instanceA.baseUrl, routed("/permission")),
      request(instanceB.baseUrl, routed("/permission")),
      request(instanceA.baseUrl, routed("/question")),
      request(instanceB.baseUrl, routed("/question")),
    ])
  result.matrix.abort = {
    status_A: statusFor(abortStatusA, abortSessionId),
    status_B: statusFor(abortStatusB, abortSessionId),
    metadata_B: abortSessionsB.some((item) => item.id === abortSessionId),
    pending_permission_A: pendingFor(abortPermissionsA, abortSessionId).length,
    pending_permission_B: pendingFor(abortPermissionsB, abortSessionId).length,
    pending_question_A: pendingFor(abortQuestionsA, abortSessionId).length,
    pending_question_B: pendingFor(abortQuestionsB, abortSessionId).length,
  }
  const aborted = await request(instanceA.baseUrl, routed(`/session/${abortSessionId}/abort`), { method: "POST" })
  provider.release("abort")
  result.matrix.after_abort = {
    response: aborted,
    status: await observeStatusAfterRelease(instanceA, abortSessionId),
  }

  result.provider = {
    port: provider.port,
    requests: provider.events,
    real_provider_contacted: false,
    fixed_fixture_only: true,
  }
  assert(result.matrix.busy.status_A?.type === "busy", "Busy status was not observed on instance A.")
  assert(result.matrix.busy.status_B === null, "Busy status unexpectedly crossed into instance B.")
  assert(result.matrix.question.pending_A === 1, "Question request was not observed on instance A.")
  assert(result.matrix.question.pending_B === 0, "Question request unexpectedly crossed into instance B.")
  assert(result.matrix.question.reply === true, "Question reply did not return true.")
  assert(result.matrix.permission.pending_A === 1, "Permission request was not observed on instance A.")
  assert(result.matrix.permission.pending_B === 0, "Permission request unexpectedly crossed into instance B.")
  assert(result.matrix.permission.reply === true, "Permission rejection did not return true.")
  assert(result.matrix.after_abort.response === true, "Abort did not return true.")
  assert(
    Object.values(result.matrix.new_sessions).every(
      (boundary) => boundary.metadata_B === true && boundary.status_A === null && boundary.status_B === null,
    ),
    "New scenario session metadata/status boundary was not consistent across instances.",
  )
  result.status = "passed"
} catch (error) {
  result.status = "failed"
  result.error = error.stack ?? error.message
} finally {
  const cleanupErrors = []
  if (provider) {
    result.provider = {
      port: provider.port,
      requests: provider.events,
      real_provider_contacted: false,
      fixed_fixture_only: true,
    }
  }
  for (const entry of owned) {
    try {
      await stopInstance(entry)
    } catch (error) {
      cleanupErrors.push(`${entry.name}: ${error.message}`)
    }
  }
  if (provider) {
    try {
      provider.release("busy")
      provider.release("abort")
      await provider.close()
    } catch (error) {
      cleanupErrors.push(`provider: ${error.message}`)
    }
  }
  const processChecks = owned.map((entry) => ({
    name: entry.name,
    pid: entry.pid,
    exited: entry.exit !== null,
    exit: entry.exit,
    stdout_bytes: entry.stdout.bytes,
    stdout_truncated: entry.stdout.truncated,
    stderr_bytes: entry.stderr.bytes,
    stderr_truncated: entry.stderr.truncated,
    launch_error: entry.launchError,
  }))
  const portChecks = []
  for (const entry of owned) portChecks.push({ port: entry.port, reachable: await portReachable(entry.port) })
  if (provider) portChecks.push({ port: provider.port, reachable: await portReachable(provider.port), provider: true })
  result.cleanup = {
    owned_processes: processChecks,
    ports: portChecks,
    all_owned_processes_exited: processChecks.every((item) => item.exited),
    all_ports_released: portChecks.every((item) => !item.reachable),
    errors: cleanupErrors,
    sandbox_retained_for_evidence: true,
  }
  result.elapsed_milliseconds = Date.now() - startedAt
  if (!result.cleanup.all_owned_processes_exited || !result.cleanup.all_ports_released || cleanupErrors.length) {
    result.status = "failed"
  }
  await mkdir(sandbox, { recursive: true })
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8")
}

console.log(JSON.stringify({ status: result.status, sandbox, result: resultPath, elapsed_milliseconds: result.elapsed_milliseconds }))
if (result.status !== "passed") {
  console.error(result.error ?? JSON.stringify(result.cleanup))
  process.exitCode = 1
}
