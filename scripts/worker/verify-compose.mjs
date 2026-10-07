import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { spawn, execFileSync } from "node:child_process"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { setup } from "./setup.mjs"
import { dockerOwner } from "./docker-owner.mjs"
import { browserProof } from "./browser-proof.mjs"
import { firstSseEvent } from "./stream-proof.mjs"

const repo = fileURLToPath(new URL("../..", import.meta.url))
const option = (name) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined }
const context = option("--context")
if (!context) throw new Error("必須明確指定 --context <local-docker-context>。")
const skillsContext = option("--skills-context")
if (process.argv.includes("--skills-context") && (!skillsContext?.trim() || skillsContext.startsWith("--"))) throw new Error("--skills-context 必須指定 <private-worker-skills> 路徑。")
const composeFile = path.join(repo, "deploy/worker/compose.yaml")
const selectedComposeFiles = [composeFile, ...(skillsContext ? [path.join(repo, "deploy/worker/compose.skills-build.yaml")] : [])]
const contextpathOnly = skillsContext ? path.resolve(skillsContext) : undefined
const project = `omw-verify-${randomBytes(8).toString("hex")}`
const runDirectory = await mkdtemp(path.join(os.tmpdir(), `${project}-`))
const evidencePath = path.join(runDirectory, "evidence.json")
const image = `${project}:verification`
const evidence = { project, context, image, startedAt: new Date().toISOString(), tree: {}, versions: {}, checks: [], screenshotReferences: [], gaps: ["未使用真實 ChatGPT credentials／LLM；不宣稱 #101 完成。", "manager restart 的自動驗證為 idle identity；真實 LLM／工具 in-flight 與 provider auth recreation 仍須人類驗收。"] }
let owner, watchdog, secretDirectory, token = "", password = "", basic = "", resourcesAuthorized = false
const deadline = Date.now() + 20 * 60_000
const sanitize = (text) => [token, password, basic, basic.replace(/^Basic /, "")].filter(Boolean).reduce((value, secret) => value.replaceAll(secret, "[REDACTED]"), String(text))
const save = () => writeFile(evidencePath, JSON.stringify(evidence, null, 2))
async function check(name, action) {
  const started = Date.now()
  try {
    const detail = await action()
    const skipped = detail?.outcome === "not-requested"
    evidence.checks.push({ name, status: skipped ? "skipped" : "passed", milliseconds: Date.now() - started, ...(detail !== undefined ? { detail } : {}) })
    console.log(`${skipped ? "SKIP" : "PASS"} ${name}`)
  } catch (error) {
    evidence.checks.push({ name, status: "failed", milliseconds: Date.now() - started, error: sanitize(error.message), stack: sanitize(error.stack ?? error.message) })
    throw error
  } finally { await save() }
}
async function port() {
  const server = net.createServer()
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  const value = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return value
}
async function snapshot(directory = repo, result = evidence.tree) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", ".git", ".scratch", ".serena", ".omw", "test-results", "playwright-report"].includes(entry.name)) continue
    const filename = path.join(directory, entry.name)
    const relative = path.relative(repo, filename).replaceAll("\\", "/")
    if (entry.isDirectory()) {
      if (["apps", "packages", "scripts", "deploy"].some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`))) await snapshot(filename, result)
    } else if (entry.isFile() && (/\.(?:ts|vue|mjs|json|yaml|html|css)$/.test(relative) || [".dockerignore", "deploy/worker/Dockerfile"].includes(relative))) {
      result[relative] = createHash("sha256").update(await readFile(filename)).digest("hex")
    }
  }
}
try {
  const managerPort = await port()
  let nativePort = await port()
  while (nativePort === managerPort) nativePort = await port()
  secretDirectory = path.join(runDirectory, "secrets")
  const secrets = await setup(secretDirectory, { managerPort, nativePort, image })
  token = (await readFile(secrets.tokenFile, "utf8")).trimEnd()
  password = (await readFile(secrets.passwordFile, "utf8")).trimEnd()
  basic = `Basic ${Buffer.from(`worker:${password}`).toString("base64")}`
  const binding = { context, project, repo, image, envFile: secrets.envFile, composeFile, selectedComposeFiles, contextpathOnly, secretDirectory,
    watchdogMilliseconds: 22 * 60_000, watchdogEvidence: path.join(runDirectory, "watchdog-cleanup.json") }
  owner = dockerOwner(binding)
  await check("explicit-local-context", async () => {
    const configuration = JSON.parse(await owner.docker(["context", "inspect", context]))[0]
    const endpoint = configuration.Endpoints.docker.Host
    assert.ok(endpoint.startsWith("npipe://") || endpoint.startsWith("unix://"), "只接受 local npipe/unix context，拒絕 SSH/TCP remote")
    evidence.versions.docker = await owner.docker(["version", "--format", "{{.Server.Version}}"])
    evidence.versions.compose = await owner.docker(["compose", "version", "--short"])
    return { endpointKind: endpoint.split(":")[0] }
  })
  resourcesAuthorized = true
  await snapshot()
  evidence.git = { head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
    status: execFileSync("git", ["status", "--short"], { cwd: repo, encoding: "utf8" }).trim() }
  evidence.origins = { manager: `http://127.0.0.1:${managerPort}`, native: `http://127.0.0.1:${nativePort}` }
  const bindingFile = path.join(runDirectory, "ownership.json")
  await writeFile(bindingFile, JSON.stringify(binding), { mode: 0o600 })
  watchdog = spawn(process.execPath, [fileURLToPath(new URL("./watchdog.mjs", import.meta.url)), bindingFile], { stdio: "ignore", windowsHide: true, detached: true })
  await new Promise((resolve, reject) => { watchdog.once("spawn", resolve); watchdog.once("error", reject) })
  evidence.lifecycle = { applicable: true, platform: process.platform === "win32" ? "Windows" : "non-Windows", selected_tier: "external-launcher",
    owner_binding: { kind: "official-interface-current-run", project, image }, final_disposition: { requested: "Stop", status: "planned" },
    watchdog: { deadlineMilliseconds: binding.watchdogMilliseconds, evidencePath: binding.watchdogEvidence },
    os_inspection_performed: false, lifecycle_shell_calls: [], downstream_result: null }
  const docker = (args, timeout = 90_000) => owner.docker(args, Math.min(timeout, Math.max(1, deadline - Date.now())))
  const compose = (args, timeout = 90_000) => owner.compose(args, Math.min(timeout, Math.max(1, deadline - Date.now())))
  await check("compose-config-boundaries", async () => {
    const config = JSON.parse(await compose(["config", "--format", "json"]))
    for (const service of Object.values(config.services)) {
      assert.equal(service.init, true); assert.equal(service.pid, undefined)
      assert.equal(service.user, undefined) // 固定 image USER node，沒有 host UID／root override。
      for (const published of service.ports ?? []) { assert.equal(published.host_ip, "127.0.0.1"); assert.ok([4174, 4180].includes(published.target)) }
      assert.ok(service.volumes.every((volume) => volume.type === "volume"))
    }
    assert.deepEqual(config.services.execution.command, ["node", "apps/manager/dist/src/worker/execution-server.js"])
    assert.equal(config.services.execution.healthcheck, undefined)
    assert.equal(config.services.manager.environment.OMW_EXECUTION_ORIGIN, "http://execution:4175")
  })
  await check("build-current-tree-image", async () => { await compose(["build", "manager"], 12 * 60_000) })
  await check("build-input-tree-stable", async () => {
    const after = {}
    await snapshot(repo, after)
    const changed = [...new Set([...Object.keys(evidence.tree), ...Object.keys(after)])].filter((filename) => evidence.tree[filename] !== after[filename])
    evidence.buildInputChanges = changed
    assert.equal(changed.length, 0, `build 期間 worktree 有變更，請在整合節點重跑：${changed.join(", ")}`)
  })
  evidence.versions.imageId = await docker(["image", "inspect", image, "--format", "{{.Id}}"])
  evidence.versions.node = await docker(["run", "--rm", "--init", "--network", "none", "--name", `${project}-version`, "--label", `com.docker.compose.project=${project}`, image, "node", "--version"])
  if (process.argv.includes("--diagnose-start")) {
    await check("synthetic-opencode-start-diagnostic", async () => {
      // 獨立一次性 namespace、沒有任何 host/Compose secret mount；只捕捉本次 synthetic child。
      const probe = `const {spawn}=require('node:child_process');
        const env=Object.fromEntries(['HOME','PATH','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME'].map(k=>[k,process.env[k]]));
        env.OPENCODE_SERVER_USERNAME='opencode';env.OPENCODE_SERVER_PASSWORD='synthetic-diagnostic-only';
        const child=spawn('/usr/local/bin/opencode',['serve','--hostname','127.0.0.1','--port','4096'],{cwd:'/workspace',env,stdio:['ignore','pipe','pipe']});
        let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',b=>output=(output+b).slice(-8000));
        const finish=code=>{console.log(JSON.stringify({code,output:output.replaceAll(env.OPENCODE_SERVER_PASSWORD,'[REDACTED]')}));process.exit(0)};
        child.on('error',e=>finish(e.code));child.on('exit',finish);setTimeout(()=>finish('deadline'),12000);`
      return JSON.parse(await docker(["run", "--rm", "--init", "--network", "none", "--name", `${project}-diagnostic`, "--label", `com.docker.compose.project=${project}`, image, "node", "-e", probe], 20_000))
    })
  } else {
  await check("linux-namespace-orphan-stop", async () => {
    const output = await docker(["run", "--rm", "--init", "--network", "none", "--name", `${project}-namespace`, "--label", `com.docker.compose.project=${project}`, image,
      "node", "apps/manager/dist/test/worker-supervisor-linux.test.js"], 60_000)
    assert.match(output, /(?:#|ℹ) pass 8\b/); assert.match(output, /(?:#|ℹ) skipped 0\b/); assert.match(output, /(?:#|ℹ) fail 0\b/)
    return { command: "node apps/manager/dist/test/worker-supervisor-linux.test.js", passed: 8, skipped: 0, failed: 0 }
  })
  const marker = `${project}-synthetic-persistence`
  const seed = `const fs=require('node:fs'); for(const dir of ['/workspace/verification-project',process.env.XDG_CONFIG_HOME,process.env.XDG_DATA_HOME])fs.mkdirSync(dir,{recursive:true}); for(const name of ['/workspace/verification-project/uncommitted.txt',process.env.HOME+'/verification-home.txt',process.env.XDG_CONFIG_HOME+'/verification-config.txt',process.env.XDG_DATA_HOME+'/verification-data.txt'])fs.writeFileSync(name,${JSON.stringify(marker)});`
  await check("synthetic-persistence-seed-no-auth", async () => { await compose(["run", "--rm", "--no-deps", "--name", `${project}-seed`, "execution", "node", "-e", seed]) })
  await check("compose-ready", async () => { await compose(["up", "-d", "--no-build", "--wait", "--wait-timeout", "120"], 150_000) })
  const api = async (pathname, { method = "GET", body, expected = 200, headers = {}, authenticated = true, native = false, responseHeaders } = {}) => {
    if (Date.now() >= deadline) throw new Error("整輪驗證 deadline exceeded。")
    const origin = native ? evidence.origins.native : evidence.origins.manager
    const response = await fetch(`${origin}${pathname}`, { method, headers: {
      ...(authenticated ? { authorization: basic } : {}),
      ...(!["GET", "HEAD"].includes(method) ? { origin, "x-omw-csrf": "1" } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers,
    }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(Math.min(20_000, Math.max(1, deadline - Date.now()))), redirect: "error" })
    const text = await response.text()
    responseHeaders?.(response.headers)
    assert.equal(response.status, expected, `${pathname}：${sanitize(text).slice(0, 300)}`)
    assert.ok(!text.includes(token) && !text.includes(password), "public response 不可包含 secrets")
    try { return JSON.parse(text) } catch { return text }
  }
  const control = async (pathname = "/v1/execution", body, mode) => JSON.parse(await compose(["exec", "-T", "manager", "node", "scripts/worker/control.mjs", pathname, ...(body === undefined ? (mode ? ["null", mode] : []) : [JSON.stringify(body), ...(mode ? [mode] : [])])]))
  const capacity = async (state) => {
    assert.deepEqual(await api("/api/v1/worker/capacity", { responseHeaders: (headers) => assert.equal(headers.get("cache-control"), "no-store") }), { state, maxInstances: 1 })
  }
  const currentInstance = async (id) => {
    // Active／unreachable 投影屬於 overview；detail seam 只補 stopped history，active 回 null 不代表 DB 遺失。
    const overview = await api("/api/v1/overview?view=legacy&scope=current&includeHidden=true")
    const instance = overview.instances.find((candidate) => candidate.id === id)
    assert.ok(instance, "current overview 必須保留指定 Instance identity")
    return instance
  }
  await check("basic-origin-csrf-boundaries", async () => {
    await api("/api/v1/connectivity", { authenticated: false, expected: 401 })
    await api("/api/v1/worker/capacity", { authenticated: false, expected: 401 })
    await api("/api/v1/connectivity", { headers: { origin: "https://invalid.example" }, expected: 403 })
    await api("/api/v1/instances", { method: "POST", body: { directory: "/workspace" }, headers: { "x-omw-csrf": "0" }, expected: 403 })
    await api("/", { native: true, authenticated: false, expected: 401 })
    await api("/", { native: true, headers: { origin: "https://invalid.example" }, expected: 403 })
    assert.equal((await control("/v1/execution", undefined, "unauthenticated")).status, 401)
    assert.equal((await control("/v1/execution", undefined, "browser-origin")).status, 403)
  })
  await check("live-mobile-browser-no-llm", async () => {
    if (!process.argv.includes("--browser")) {
      evidence.gaps.push("未指定 --browser；本輪沒有 live mobile UI／native assets／provider 方法畫面證據。")
      return { outcome: "not-requested", optIn: "--browser" }
    }
    try {
      return await browserProof({ origins: evidence.origins, password, evidenceDirectory: runDirectory,
        screenshotReferences: evidence.screenshotReferences, deadline, onOutcome: async (outcome) => { evidence.browser = outcome; await save() } })
    } catch (error) {
      // Supervisor 已失聯時仍保留原本 browser／Start 錯誤；diagnostic 失敗不能覆蓋原始 failure。
      const diagnostic = await control().catch(() => null)
      evidence.startupFailure = diagnostic?.body?.startupFailure ?? null
      if (!diagnostic) evidence.startupFailureDiagnostic = "unavailable"
      throw error
    }
  })
  let instance, session, identity
  await check("omw-browse-shortcut-start-inspect-sessions-openurl", async () => {
    const directory = "/workspace/verification-project"
    await capacity("available")
    await api(`/api/v1/directories?path=${encodeURIComponent(directory)}`)
    await api("/api/v1/shortcuts", { method: "POST", body: { name: "Compose verification", directory }, expected: 201 })
    instance = await api("/api/v1/instances", { method: "POST", body: { directory }, expected: 201 })
    assert.equal(instance.state, "ready")
    await capacity("occupied")
    await api("/api/v1/instances", { method: "POST", body: { directory }, expected: 409 })
    const info = (await control()).body
    identity = { epoch: info.epoch, instanceId: info.execution.instanceId }
    assert.equal(identity.instanceId, instance.id)
    assert.equal((await control("/v1/inspect", identity)).body.processState, "running")
    const createdSession = await api(`/api/v1/instances/${instance.id}/sessions`, { method: "POST", expected: 201 })
    session = { id: createdSession.sessionId }
    assert.ok(session.id, "公開 createSession 回傳 sessionId")
    const roots = await api(`/api/v1/instances/${instance.id}/sessions`)
    assert.ok(roots.roots.some((root) => root.id === session.id))
    const opened = await api(`/api/v1/instances/${instance.id}/open-url`, { method: "POST", body: { sessionId: session.id } })
    assert.equal(new URL(opened.url).origin, evidence.origins.native)
    await api(new URL(opened.url).pathname, { native: true })
    const health = await api("/global/health", { native: true })
    assert.equal(health.version, "1.18.34"); evidence.versions.opencode = health.version
    return { instanceId: instance.id, sessionId: session.id, identity, nativeUrl: opened.url }
  })
  await check("native-live-sse-first-event", async () => await firstSseEvent(`${evidence.origins.native}/event?directory=${encodeURIComponent(instance.projectDirectory)}`, {
    headers: { authorization: basic }, timeout: Math.min(20_000, Math.max(1, deadline - Date.now())),
  }))
  await check("manager-restart-same-live-execution-identity", async () => {
    const before = (await control()).body
    const executionContainer = await compose(["ps", "-q", "execution"])
    await compose(["restart", "manager"], 45_000)
    for (let attempt = 0; ; attempt++) {
      try { await api("/api/v1/connectivity"); break } catch (error) { if (attempt >= 30) throw error; await delay(500) }
    }
    const after = (await control()).body
    assert.deepEqual(after, before); assert.equal(await compose(["ps", "-q", "execution"]), executionContainer)
    assert.equal((await currentInstance(instance.id)).state, "ready")
    return { before, after, executionContainer, kind: "真 OpenCode 存活 identity；沒有 LLM in-flight 工作" }
  })
  await check("wrong-stop-and-epoch-rejected", async () => {
    assert.equal((await control("/v1/stop", { ...identity, instanceId: "wrong-instance" })).status, 409)
    assert.equal((await control("/v1/stop", { ...identity, epoch: "wrong-epoch" })).status, 409)
    assert.equal((await control("/v1/inspect", { ...identity, epoch: "wrong-epoch" })).body.processState, "unknown")
    assert.equal((await control("/v1/inspect", identity)).body.processState, "running")
  })
  await check("omw-exact-stop-completion", async () => {
    const stopped = await api(`/api/v1/instances/${instance.id}/stop`, { method: "POST" })
    assert.equal(stopped.state, "stopped")
    assert.equal((await control("/v1/inspect", identity)).body.processState, "not-found")
    await capacity("available")
  })
  let second, secondIdentity, originalMessages
  await check("execution-exit-unreachable-no-automatic-restart", async () => {
    second = await api("/api/v1/instances", { method: "POST", body: { directory: "/workspace/verification-project" }, expected: 201 })
    await api(`/api/v1/instances/${second.id}/primary-session`, { method: "POST", body: { sessionId: session.id } })
    originalMessages = (await api(`/session/${session.id}/message?directory=${encodeURIComponent(second.projectDirectory)}`, { native: true })).map((message) => message.info.id)
    secondIdentity = { epoch: (await control()).body.epoch, instanceId: second.id }
    await compose(["stop", "execution"], 30_000)
    assert.equal((await api(`/api/v1/instances/${second.id}/recheck`, { method: "POST" })).state, "unreachable")
    await capacity("unknown")
    await api("/api/v1/instances", { method: "POST", body: { directory: second.projectDirectory }, expected: 409 })
    return { instanceId: second.id, observed: "unreachable" }
  })
  await check("same-image-volume-recreation-preserves-files-db-session-not-process", async () => {
    await compose(["up", "-d", "--no-deps", "--no-build", "--force-recreate", "execution"], 60_000)
    let info
    for (let attempt = 0; ; attempt++) {
      try { info = (await control()).body; assert.ok(info.epoch); break } catch (error) { if (attempt >= 30) throw error; await delay(500) }
    }
    assert.notEqual(info.epoch, identity.epoch); assert.equal(info.execution, null)
    assert.equal((await control("/v1/inspect", identity)).body.processState, "unknown")
    assert.equal((await control("/v1/stop", identity)).status, 409)
    assert.equal((await api(`/api/v1/instances/${second.id}/recheck`, { method: "POST" })).state, "unreachable")
    await capacity("available")
    // 停止／移除無工作 supervisor 後才在相同 volumes 上執行檔案檢查，避免污染 live namespace。
    await compose(["stop", "execution"])
    const verify = `const fs=require('node:fs');for(const name of ['/workspace/verification-project/uncommitted.txt',process.env.HOME+'/verification-home.txt',process.env.XDG_CONFIG_HOME+'/verification-config.txt',process.env.XDG_DATA_HOME+'/verification-data.txt'])if(fs.readFileSync(name,'utf8')!==${JSON.stringify(marker)})process.exit(1); console.log('synthetic-files-preserved')`
    assert.match(await compose(["run", "--rm", "--no-deps", "--name", `${project}-persistence`, "execution", "node", "-e", verify]), /synthetic-files-preserved/)
    await compose(["up", "-d", "--no-build", "--force-recreate", "manager", "--wait", "--wait-timeout", "120"], 150_000)
    assert.equal((await currentInstance(second.id)).state, "unreachable")
    // 容量與歷史是不同事實；只有公開、明確的手動 resume 可以配置新的 epoch 身分，不重送 prompt。
    let recreated
    for (let attempt = 0; ; attempt++) {
      try { recreated = (await control()).body; assert.ok(recreated.epoch); break } catch (error) { if (attempt >= 30) throw error; await delay(500) }
    }
    assert.equal(recreated.execution, null)
    await capacity("available")
    const oldHistory = await currentInstance(second.id)
    const resumed = await api(`/api/v1/instances/${second.id}/resume`, { method: "POST" })
    assert.notEqual(resumed.id, second.id)
    assert.equal(resumed.state, "ready")
    assert.equal(resumed.primarySession.sessionId, session.id)
    const probeIdentity = { epoch: (await control()).body.epoch, instanceId: resumed.id }
    assert.notEqual(probeIdentity.epoch, secondIdentity.epoch)
    assert.equal((await control()).body.execution.instanceId, resumed.id)
    try {
      await capacity("occupied")
      await api("/api/v1/instances", { method: "POST", body: { directory: second.projectDirectory }, expected: 409 })
      assert.equal((await control("/v1/inspect", secondIdentity)).body.processState, "unknown")
      assert.equal((await control("/v1/stop", secondIdentity)).status, 409)
      await api(`/api/v1/instances/${second.id}/stop`, { method: "POST", expected: 409 })
      const afterHistory = await currentInstance(second.id)
      assert.equal(afterHistory.state, "unreachable")
      for (const key of ["id", "projectDirectory", "launchedAt", "pid", "primarySession"]) assert.deepEqual(afterHistory[key], oldHistory[key], `舊歷史 ${key} 不得重綁`)
      assert.equal((await control("/v1/inspect", probeIdentity)).body.processState, "running")
      const sessions = await api(`/session?directory=${encodeURIComponent("/workspace/verification-project")}`, { native: true })
      assert.ok(sessions.some((candidate) => candidate.id === session.id))
      assert.equal((await api(`/session/${session.id}?directory=${encodeURIComponent(second.projectDirectory)}`, { native: true })).id, session.id)
      assert.deepEqual((await api(`/session/${session.id}/message?directory=${encodeURIComponent(second.projectDirectory)}`, { native: true })).map((message) => message.info.id), originalMessages, "resume 保留原生 HTTP history，不自動增加 prompt／message")
      assert.ok((await api(`/api/v1/instances/${resumed.id}/sessions`)).roots.some((candidate) => candidate.id === session.id))
    } finally {
      assert.equal((await api(`/api/v1/instances/${resumed.id}/stop`, { method: "POST" })).state, "stopped")
      assert.equal((await control("/v1/inspect", probeIdentity)).body.processState, "not-found")
      await capacity("available")
    }
    return { recovery: "公開手動 resume；無 prompt replay", markerKind: "synthetic 非 auth 檔案", sessionId: session.id,
      messageHistoryCount: originalMessages.length, historyKind: "新建 Session 的 HTTP history；不代表真實聊天內容持久化",
      oldInstanceState: "unreachable", oldIdentity: secondIdentity, probeIdentity }
  })
  }
  evidence.status = "passed"
} catch (error) {
  evidence.status = "failed"
  evidence.error = sanitize(error.message)
  evidence.stack = sanitize(error.stack ?? error.message)
  console.error(evidence.error)
  process.exitCode = 1
} finally {
  if (owner && resourcesAuthorized) {
    evidence.cleanup = await owner.cleanup()
    evidence.cleanup.errors = evidence.cleanup.errors.map(sanitize)
    evidence.lifecycle ??= { downstream_result: null }
    evidence.lifecycle.lifecycle_result = { status: evidence.cleanup.status }
    evidence.lifecycle.final_disposition = { requested: "Stop", status: evidence.cleanup.status }
    evidence.lifecycle.downstream_result = { status: evidence.status }
    evidence.lifecycle.minimum_outcomes = Object.fromEntries(["ownership_binding", "stdio", "readiness", "observation", "disposition", "cleanup_or_handoff", "lifecycle_callback"].map((key) => [key, evidence.cleanup.status === "stopped" ? "owner handled" : "escalated"]))
    if (evidence.cleanup.status !== "stopped") process.exitCode = 1
  }
  if (watchdog && evidence.cleanup?.status === "stopped") {
    const exited = new Promise((resolve) => watchdog.once("close", resolve))
    watchdog.kill(); await exited
    evidence.lifecycle.watchdog.stopped = true
  } else if (watchdog) {
    watchdog.unref()
    evidence.lifecycle.watchdog.laterOwner = "本次獨立 watchdog，22 分鐘 deadline 後 scoped cleanup；請查看 watchdog-cleanup.json"
  }
  if (secretDirectory && (!resourcesAuthorized || evidence.cleanup?.status === "stopped")) {
    await rm(secretDirectory, { recursive: true, force: true })
    if (evidence.cleanup) evidence.cleanup.syntheticSecretsRemoved = true
  }
  evidence.finishedAt = new Date().toISOString()
  await save()
  console.log(`Evidence：${evidencePath}\nCleanup：${evidence.cleanup?.status ?? "no-resources"}`)
}
