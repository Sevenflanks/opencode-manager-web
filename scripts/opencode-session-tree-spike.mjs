import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import process from "node:process"
import { randomUUID } from "node:crypto"

const REPO_ROOT = path.resolve(import.meta.dirname, "..")
const OPENCODE = process.env.OPENCODE_SPIKE_EXECUTABLE
const OVERALL_DEADLINE_MS = 60_000
const HTTP_DEADLINE_MS = 3_000
const HEALTH_DEADLINE_MS = 10_000
const MAX_STDIO_BYTES = 64 * 1024
const startedAt = Date.now()
const runId = randomUUID().replaceAll("-", "")
const sandbox = path.join(REPO_ROOT, ".scratch", `opencode-session-tree-${runId}`)
const projectDirectory = path.join(sandbox, "project")
const configDirectory = path.join(sandbox, "config")
const databasePath = path.join(sandbox, "data", "opencode.db")
const configPath = path.join(configDirectory, "opencode.json")
const fixturePath = path.join(projectDirectory, "fixture.txt")
const resultPath = path.join(sandbox, "result.json")
const owned = []

const result = {
  status: "running",
  run_id: runId,
  sandbox,
  installed_version: null,
  isolation: {},
  server: null,
  fixture: {},
  observations: {},
  cleanup: {},
  limitations: [
    "Parent relationships were created directly with the session API; this does not prove native agent provenance.",
    "parentID was tested as structural session metadata. Official task creation parent context was not dispatched through an agent.",
    "fork behavior was not tested.",
    "No prompt, provider, model request, plugin, skill, or LLM operation was used.",
  ],
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertBudget() {
  if (Date.now() - startedAt >= OVERALL_DEADLINE_MS) {
    throw new Error("Overall 60 second spike deadline exceeded.")
  }
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
  if (!port) return false
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
    OPENCODE_DB: databasePath,
    OPENCODE_CONFIG: configPath,
    OPENCODE_CONFIG_DIR: configDirectory,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_PURE: "1",
    OPENCODE_DISABLE_PLUGINS: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_EXTERNAL_PLUGINS: "1",
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
      state.chunks.push(chunk.subarray(0, remaining))
      state.bytes += Math.min(chunk.length, remaining)
    }
    if (chunk.length > remaining) state.truncated = true
  })
  return state
}

function startServer(port, environment) {
  assertBudget()
  const child = spawn(
    OPENCODE,
    ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--pure", "--log-level", "INFO"],
    { cwd: projectDirectory, env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  )
  const entry = {
    name: "session-tree-server",
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    child,
    pid: child.pid ?? null,
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

async function request(instance, pathname, { method = "GET", body, expected = [200] } = {}) {
  assertBudget()
  const response = await fetch(`${instance.baseUrl}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(HTTP_DEADLINE_MS),
  })
  const text = await response.text()
  if (!expected.includes(response.status)) {
    throw new Error(`${method} ${pathname} returned HTTP ${response.status}: ${text.slice(0, 500)}`)
  }
  return text ? JSON.parse(text) : null
}

function routed(pathname) {
  const separator = pathname.includes("?") ? "&" : "?"
  return `${pathname}${separator}directory=${encodeURIComponent(projectDirectory)}`
}

async function waitFor(description, operation, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    assertBudget()
    try {
      latest = await operation()
      if (predicate(latest)) return latest
    } catch (error) {
      latest = { error: error.message }
    }
    await sleep(75)
  }
  throw new Error(`${description} was not observed within ${timeoutMs} ms; latest=${JSON.stringify(latest).slice(0, 500)}`)
}

async function waitHealth(instance) {
  return await waitFor(
    "OpenCode health",
    async () => await request(instance, "/global/health"),
    (health) => health?.healthy === true,
    HEALTH_DEADLINE_MS,
  )
}

function ids(sessions) {
  assert(Array.isArray(sessions), "Expected a session array.")
  return sessions.map((session) => session.id)
}

function metadataById(sessions) {
  return Object.fromEntries(sessions.map((session) => [session.id, session]))
}

async function createSession(instance, name, parentID) {
  const body = { title: `Fixture ${name}` }
  if (parentID) body.parentID = parentID
  const session = await request(instance, routed("/session"), { method: "POST", body })
  assert(typeof session?.id === "string", `${name} creation did not return an id.`)
  return { id: session.id, name, parentID: parentID ?? null, response: session }
}

async function stopServer(entry) {
  if (entry.exit) return
  entry.child.kill()
  await Promise.race([
    new Promise((resolve) => entry.child.once("exit", resolve)),
    sleep(5_000),
  ])
  if (!entry.exit) {
    entry.child.kill("SIGKILL")
    await Promise.race([
      new Promise((resolve) => entry.child.once("exit", resolve)),
      sleep(2_000),
    ])
  }
}

try {
  assert(OPENCODE, "Set OPENCODE_SPIKE_EXECUTABLE to an existing OpenCode executable before running this archived spike.")
  await mkdir(projectDirectory, { recursive: true })
  await mkdir(configDirectory, { recursive: true })
  await mkdir(path.dirname(databasePath), { recursive: true })
  await writeFile(fixturePath, "session tree fixture only\n", "utf8")
  await writeFile(configPath, "{}\n", "utf8")

  const { environment, removed } = isolatedEnvironment()
  result.isolation = {
    project_directory: projectDirectory,
    database: databasePath,
    config_file: configPath,
    empty_config: true,
    removed_sensitive_variable_name_count: removed,
    credential_values_read_or_logged: false,
    parent_environment_modified: false,
    path_modified: false,
    loopback_only: true,
    pure: true,
    plugins_disabled: true,
    skills_disabled: true,
    model_fetch_disabled: true,
    autoupdate_disabled: true,
    lsp_download_disabled: true,
  }

  const port = await freePort()
  const instance = startServer(port, environment)
  result.server = { pid: instance.pid, port, base_url: instance.baseUrl }
  const health = await waitHealth(instance)
  result.installed_version = health.version ?? null
  assert(health.version === "1.18.31", `Expected OpenCode 1.18.31, got ${health.version ?? "unknown"}.`)

  const initial = await request(instance, routed("/session"))
  assert(Array.isArray(initial) && initial.length === 0, "Fresh isolated session list was not empty.")

  const rootA = await createSession(instance, "rootA")
  const rootB = await createSession(instance, "rootB")
  const childA = await createSession(instance, "childA", rootA.id)
  const grandchild = await createSession(instance, "grandchild", childA.id)

  const all = await request(instance, routed("/session"))
  const roots = await request(instance, routed("/session?roots=true"))
  const rootAChildren = await request(instance, routed(`/session/${rootA.id}/children`))
  const childAChildren = await request(instance, routed(`/session/${childA.id}/children`))
  const grandchildChildren = await request(instance, routed(`/session/${grandchild.id}/children`))
  const allMetadata = metadataById(all)

  assert(ids(all).length === 4, "GET /session did not return four fixture sessions.")
  assert(ids(roots).length === 2, "GET /session?roots=true did not return two roots.")
  assert(ids(roots).includes(rootA.id) && ids(roots).includes(rootB.id), "Root query did not return rootA and rootB.")
  assert(ids(rootAChildren).length === 1 && ids(rootAChildren)[0] === childA.id, "rootA children was not direct-only childA.")
  assert(!ids(rootAChildren).includes(grandchild.id), "rootA children unexpectedly included grandchild.")
  assert(ids(childAChildren).length === 1 && ids(childAChildren)[0] === grandchild.id, "childA children did not return grandchild.")
  assert(Array.isArray(grandchildChildren) && grandchildChildren.length === 0, "Leaf children was not empty.")
  assert(allMetadata[rootA.id]?.parentID == null, "rootA metadata unexpectedly had parentID.")
  assert(allMetadata[rootB.id]?.parentID == null, "rootB metadata unexpectedly had parentID.")
  assert(allMetadata[childA.id]?.parentID === rootA.id, "childA metadata did not retain parentID=rootA.")
  assert(allMetadata[grandchild.id]?.parentID === childA.id, "grandchild metadata did not retain parentID=childA.")

  result.fixture = {
    sessions_created: { rootA, rootB, childA, grandchild },
    expected_parent_edges: [
      { child: childA.id, parent: rootA.id },
      { child: grandchild.id, parent: childA.id },
    ],
  }
  result.observations = {
    initial_session_list: initial,
    metadata: all,
    roots_true: roots,
    children_rootA: rootAChildren,
    children_childA: childAChildren,
    children_grandchild: grandchildChildren,
    counts: {
      metadata: all.length,
      roots: roots.length,
      rootA_direct_children: rootAChildren.length,
      childA_direct_children: childAChildren.length,
      grandchild_direct_children: grandchildChildren.length,
    },
  }
  result.status = "passed"
} catch (error) {
  result.status = "failed"
  result.error = error.stack ?? error.message
} finally {
  const cleanupErrors = []
  for (const entry of owned) {
    try {
      await stopServer(entry)
    } catch (error) {
      cleanupErrors.push(`${entry.name}: ${error.message}`)
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
  for (const entry of owned) {
    portChecks.push({ port: entry.port, reachable: await portReachable(entry.port) })
  }
  result.cleanup = {
    owned_processes: processChecks,
    ports: portChecks,
    all_owned_processes_exited: processChecks.every((item) => item.exited),
    all_ports_released: portChecks.every((item) => !item.reachable),
    errors: cleanupErrors,
    database_retained_for_evidence: true,
    delete_api_used: false,
    process_scan_used: false,
    taskkill_used: false,
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
