import assert from "node:assert/strict"
import { randomBytes, createHash } from "node:crypto"
import { spawn, execFileSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, writeFile, realpath, rename } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"
import os from "node:os"
import net from "node:net"
import { setTimeout as delay } from "node:timers/promises"
import { setup } from "./setup.mjs"
import { seedWorkerOwner } from "./seed-worker-owner.mjs"
import { classifyNativeRejection } from "./seed-worker-fixture.mjs"

const repo = fileURLToPath(new URL("../..", import.meta.url))
const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
const modelID = "gpt-6-luna-fast"
const quote = value => `'${value.replaceAll("\\", "/").replaceAll("'", "''")}'`
const now = () => new Date().toISOString()
async function port() {
  const server = net.createServer()
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  const result = server.address().port
  await new Promise(resolve => server.close(resolve))
  return result
}
export async function observeNativePrompt({ url, headers, sessionId, deadlineAt, detail, onRetry }) {
  const controller = new AbortController()
  const remaining = deadlineAt - Date.now()
  assert.ok(remaining > 0, "PROMPT_OWNER_DEADLINE")
  const response = await fetch(`${url}/event`, { headers: { ...headers, origin: url, accept: "text/event-stream" },
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(Math.min(150_000, remaining))]) })
  if (!response.ok) { controller.abort(); throw new Error("NATIVE_EVENT_OBSERVATION_FAILED") }
  detail.retryEventCount = 0
  const reader = response.body.getReader(), decoder = new TextDecoder()
  const done = (async () => {
    let buffer = ""
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) { if (!controller.signal.aborted) detail.eventObservationFailed = true; break }
        buffer += decoder.decode(part.value, { stream: true })
        buffer = buffer.replaceAll("\r\n", "\n")
        if (buffer.length > 1_000_000) throw new Error("EVENT_BUFFER_LIMIT")
        let boundary
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2)
          const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n")
          if (!data) continue
          const event = JSON.parse(data)
          if (event.type === "session.status" && event.properties?.sessionID === sessionId && event.properties.status?.type === "retry") {
            detail.retryEventCount++
            // 首次 retry 即透過原生 API abort；不自行重送或切換模型／auth。
            if (detail.retryEventCount === 1) { await onRetry(); detail.retryAborted = true }
          }
        }
      }
    } catch { if (!controller.signal.aborted) detail.eventObservationFailed = true }
    finally { controller.abort(); try { await reader.cancel() } catch {} reader.releaseLock() }
  })()
  return { stop: async () => { controller.abort(); await done } }
}
export function publicWorkerRequest({ managerUrl, nativeUrl, headers, deadlineAt }) {
  return async (native, route, body, timeout = 60_000) => {
    const method = body === undefined ? "GET" : "POST"
    const pathname = route.split(/[?#]/, 1)[0]
    const safePath = /^\/[a-zA-Z0-9_./-]{0,256}$/.test(pathname) ? pathname : "PUBLIC_PATH_REDACTED"
    const failure = (httpStatus, errorCode) => {
      const reason = httpStatus === null ? "PUBLIC_REQUEST_FAILED" : `PUBLIC_HTTP_${httpStatus}`
      const error = new Error(`${reason} ${method} ${safePath} ${errorCode}`)
      error.publicRequest = { method, path: safePath, httpStatus, errorCode }
      return error
    }
    const remaining = deadlineAt - Date.now()
    if (remaining <= 0) throw failure(null, "PUBLIC_OWNER_DEADLINE")
    let response
    try {
      response = await fetch((native ? nativeUrl : managerUrl) + route, { method,
        headers: { ...headers, origin: native ? nativeUrl : managerUrl },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(Math.min(timeout, remaining)) })
    } catch { throw failure(null, "PUBLIC_TRANSPORT_FAILED") }
    if (!response.ok) {
      // 舊 evidence 只保留 409，無法分辨 Start／primary／Stop；只發布路徑與安全 code，不保留 body 或 query。
      const value = await response.json().catch(() => null)
      const code = value?.error?.code
      throw failure(response.status, typeof code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : "PUBLIC_ERROR_REDACTED")
    }
    return response.json()
  }
}
async function main() {
  if (process.argv.includes("--help")) {
    console.log("node scripts/worker/verify-seed-workers.mjs --context desktop-linux [--image IMAGE] [--temp-root ABSOLUTE_DIR] [--prepare-login | --allow-provider --seed-source ABSOLUTE_FILE | --allow-provider --seed-source-volume VOLUME --seed-auth-path /RELATIVE/auth.json --seed-owner-record ABSOLUTE_JSON] [--resume-owned ABSOLUTE_OWNER_JSON]")
    return
  }
  const context = option("--context"), allowProvider = process.argv.includes("--allow-provider"), login = process.argv.includes("--prepare-login")
  assert.ok(!login || !allowProvider, "LOGIN_ENVIRONMENT_MUST_NOT_SUBMIT_PROMPTS")
  assert.equal(process.platform, "win32", "WINDOWS_OWNER_REQUIRED")
  assert.ok(context, "EXPLICIT_CONTEXT_REQUIRED")
  const sourceVolume = option("--seed-source-volume"), sourceFile = option("--seed-source"), authPath = option("--seed-auth-path")
  assert.ok(!(sourceVolume && sourceFile), "ONE_SEED_SOURCE_REQUIRED")
  if (allowProvider) assert.ok(sourceVolume || sourceFile, "APPROVED_SEED_REQUIRED")
  else assert.ok(!sourceVolume && !sourceFile, "REAL_SEED_REQUIRES_ALLOW_PROVIDER")
  if (sourceVolume) {
    assert.match(sourceVolume, /^[a-zA-Z0-9_.-]+$/)
    assert.ok(authPath?.startsWith("/") && !authPath.includes(".."), "SEED_AUTH_PATH_REQUIRED")
    const previous = JSON.parse(await readFile(option("--seed-owner-record"), "utf8"))
    assert.equal(previous.context, context, "SOURCE_CONTEXT_MISMATCH")
    const recorded = new Set([...(previous.shutdownAudit?.preservedVolumes ?? []), ...(previous.privateVolumes ?? []),
      ...(previous.containers ?? []).flatMap(c => (c.volumes ?? []).map(v => v.name))])
    assert.ok(recorded.has(sourceVolume), "SOURCE_NOT_IN_APPROVED_OWNER_RECORD")
  }
  const tempRoot = await realpath(option("--temp-root") ?? path.join(os.tmpdir(), "opencode"))
  const relative = path.relative(repo, tempRoot)
  assert.ok(relative.startsWith("..") || path.isAbsolute(relative), "TEMP_MUST_BE_OUTSIDE_CHECKOUT")
  const resumePath = option("--resume-owned")
  assert.ok(!login || !resumePath, "LOGIN_REQUIRES_NEW_ENVIRONMENT")
  const resume = resumePath ? JSON.parse(await readFile(resumePath, "utf8")) : undefined
  if (resume) {
    assert.equal(resume.context, context)
    assert.equal(path.resolve(resume.repo), path.resolve(repo))
    assert.equal(resume.lifecycle_result.status, "stopped", "RESUME_REQUIRES_CONFIRMED_STOP")
    assert.equal(resume.seedSource.volume, sourceVolume)
    assert.equal(resume.seedSource.path, authPath)
    assert.equal(resume.realDataRetained, allowProvider)
  }
  const runId = resume?.runId ?? `omw-seed-${randomBytes(8).toString("hex")}`
  const directory = resume ? path.dirname(path.resolve(resumePath)) : await mkdtemp(path.join(tempRoot, `${runId}-`))
  assert.equal(path.dirname(directory).toLowerCase(), tempRoot.toLowerCase(), "OWNER_BOUNDARY_MISMATCH")
  // 只保護新建 artifact boundary，不改 ancestor 或使用者既有 ACL。
  const sid = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }).match(/S-1-5-[0-9-]+/)?.[0]
  assert.ok(sid, "PRIVATE_ACL_IDENTITY_REQUIRED")
  if (!resume) execFileSync("icacls", [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"], { stdio: "ignore", windowsHide: true })
  const image = `${runId}:verification`, seedName = resume ? path.basename(resume.exportedSeed) : `auth-seed-${randomBytes(8).toString("hex")}.json`
  const exported = path.join(directory, "private-export")
  if (!resume) await mkdir(exported, { mode: 0o700 })
  const seedFile = path.join(exported, seedName)
  const binding = resume ? JSON.parse(await readFile(path.join(directory, "binding.json"), "utf8")) : { context, repo, runId, image, workers: [], watchdogMilliseconds: 25 * 60_000,
    watchdogEvidence: path.join(directory, "watchdog-cleanup.json") }
  for (const side of resume ? [] : login ? ["a"] : ["a", "b"]) {
    const managerPort = await port(), nativePort = await port()
    const files = await setup(path.join(directory, `private-${side}`), { managerPort, nativePort, image })
    await writeFile(files.envFile, await readFile(files.envFile, "utf8") + `OMW_AUTH_SEED_SOURCE=${quote(seedFile)}\n`)
    const project = `${runId}-${side}`, override = path.join(directory, `${side}.yaml`)
    const labels = `    labels:\n      io.omw.seed.run: ${runId}\n`
    await writeFile(override, `services:\n  manager:\n${labels}    logging:\n      driver: none\n  execution:\n${labels}    logging:\n      driver: none\n    volumes:\n      - type: bind\n        source: ${quote(path.join(repo, "scripts/worker"))}\n        target: /harness\n        read_only: true\nnetworks:\n  default:\n    labels:\n      io.omw.seed.run: ${runId}\nvolumes:\n  manager-data:\n${labels}  execution-home:\n${labels}  workspace:\n${labels}`)
    binding.workers.push({ side, project, seedEnabled: !login, override, ...files, managerUrl: `http://127.0.0.1:${managerPort}`, nativeUrl: `http://127.0.0.1:${nativePort}` })
  }
  binding.deadlineAt = Date.now() + binding.watchdogMilliseconds
  const owner = seedWorkerOwner(binding), ownerPath = path.join(directory, "owner.json"), bindingPath = path.join(directory, "binding.json")
  const evidencePath = path.join(directory, "evidence.json"), proofPath = path.join(directory, "proof-ready.md")
  const previousEvidence = resume ? JSON.parse(await readFile(evidencePath, "utf8")) : undefined
  assert.ok(!previousEvidence?.prompts.length, "OWNED_RUN_PROMPT_BUDGET_ALREADY_USED")
  if (resume) {
    const archive = `previous-${Date.now()}`
    for (const file of ["owner.json", "evidence.json", "proof-ready.md"]) await writeFile(path.join(directory, `${archive}-${file}`), await readFile(path.join(directory, file)), { flag: "wx" })
  }
  const evidence = { runId, startedAt: now(), model: `openai/${modelID}`, allowProvider, synthetic: !allowProvider,
    checks: [], workers: [], prompts: [], loginEnvironment: login, managerRestarted: false, pat: { status: "blocked", reason: "NOT_PROVIDED" } }
  const record = { ...binding, seedSource: sourceVolume ? { volume: sourceVolume, path: authPath } : sourceFile ? { file: sourceFile } : { synthetic: true },
    exportedSeed: login ? null : seedFile, createdAt: now(), later_owner: "main session + user", realDataRetained: allowProvider || login,
    platform: "Windows", selected_tier: "external-launcher", owner_binding: { kind: "official-interface-current-run", runId, context },
    os_inspection_performed: false, lifecycle_shell_calls: [],
    stdio: "Docker logging driver none; provider bodies never published", final_disposition: { requested: "Stop", status: "planned" },
    lifecycle_result: { status: "planned" }, downstream_result: null,
    stop: `node scripts/worker/seed-worker-owner.mjs ${quote(bindingPath)} --stop`,
    evidence_paths: [evidencePath, proofPath], next_owner: "main session + user" }
  let publication = Promise.resolve()
  const save = () => {
    const publish = async () => {
      for (const [filename, value] of [[evidencePath, evidence], [ownerPath, record]]) {
        await writeFile(`${filename}.next`, JSON.stringify(value, null, 2), { mode: 0o600 })
        await rename(`${filename}.next`, filename)
      }
    }
    publication = publication.then(publish, publish)
    return publication
  }
  const check = async (name, operation) => {
    const startedAt = now()
    try { const detail = await operation(); const status = detail?.status === "blocked" ? "blocked" : "passed"; evidence.checks.push({ name, startedAt, finishedAt: now(), status, detail }); console.log(`${status === "blocked" ? "BLOCKED" : "PASS"} ${name}`); return detail }
    catch (error) { evidence.checks.push({ name, startedAt, finishedAt: now(), status: "failed", errorKind: error.name,
      phase: binding.workers.find(w => name.startsWith(`worker-${w.side}-`))?.phase,
      reason: error.publicRequest ? error.publicRequest.httpStatus === null ? "PUBLIC_REQUEST_FAILED" : `PUBLIC_HTTP_${error.publicRequest.httpStatus}`
        : /^(PUBLIC_HTTP_\d+|DOCKER_[A-Z_]+)$/.test(error.message) ? error.message : "ASSERTION_OR_OPERATION_FAILED",
      ...(error.publicRequest ? { publicRequest: error.publicRequest } : {}) }); throw new Error(`CHECK_FAILED:${name}`) }
    finally { await save() }
  }
  let watchdog, local = false, preserved = false, exportedReady = false, sourceBaseline
  const fixtureArgs = ["run", "--rm", "--init", "--network", "none", "--label", `io.omw.seed.run=${runId}`,
    "--mount", `type=bind,source=${path.join(repo, "scripts/worker")},target=/harness,readonly`, "--entrypoint", "node"]
  const sourceRun = action => owner.docker([...fixtureArgs, "--name", `${runId}-${action}`,
    "--mount", `type=volume,source=${sourceVolume},target=/source,readonly`,
    "--mount", `type=bind,source=${exported},target=/export`, image, "/harness/seed-worker-fixture.mjs", action, seedName, `/source${authPath}`])
  const audit = (worker, phase) => owner.docker([...fixtureArgs, "--name", `${worker.project}-${phase}`,
    "--mount", `type=volume,source=${worker.project}_execution-home,target=/home/node`,
    "--mount", `type=bind,source=${seedFile},target=/run/secrets/auth_seed,readonly`, image, "/harness/seed-worker-fixture.mjs", "audit", phase]).then(JSON.parse)
  const requests = new Map()
  try {
    await check("explicit-local-context", async () => {
      const config = JSON.parse(await owner.docker(["context", "inspect", context]))[0]
      assert.match(config.Endpoints.docker.Host, /^(npipe|unix):\/\//)
      return { endpointKind: config.Endpoints.docker.Host.split(":")[0] }
    })
    local = true
    assert.equal(await owner.docker(["container", "ls", "-a", "-q", "--filter", `label=io.omw.seed.run=${runId}`]), "", "RESUME_CONTAINERS_MUST_BE_STOPPED")
    await writeFile(bindingPath, JSON.stringify(binding))
    await save()
    watchdog = spawn(process.execPath, [fileURLToPath(new URL("./seed-worker-owner.mjs", import.meta.url)), bindingPath], { detached: true, stdio: "ignore", windowsHide: true })
    await new Promise((resolve, reject) => { watchdog.once("spawn", resolve); watchdog.once("error", reject) })
    await check("fixed-current-worker-image", async () => {
      const reuse = option("--image")
      if (reuse) {
        const id = await owner.docker(["image", "inspect", reuse, "--format", "{{.Id}}"])
        assert.match(id, /^sha256:[a-f0-9]{64}$/)
        await owner.docker(["image", "tag", id, image])
      } else await owner.docker(["build", "--target", "worker", "--label", `io.omw.seed.run=${runId}`, "-f", "deploy/worker/Dockerfile", "-t", image, "."], 20 * 60_000)
      evidence.imageId = await owner.docker(["image", "inspect", image, "--format", "{{.Id}}"])
      return { imageId: evidence.imageId }
    })
    await check("fresh-readonly-seed-export", async () => {
      if (login) return { seedNotMounted: true, authNotInitiated: true }
      if (sourceVolume) {
        // volume inspect 必須先成功；禁止 Docker 對 typo 自動建立空的 source volume。
        await owner.docker(["volume", "inspect", sourceVolume, "--format", "{{.Name}}"])
        const result = JSON.parse(await sourceRun(resume ? "source-audit" : "export"))
        assert.ok(resume ? result.sourceUnchanged && result.exportedSeedUnchanged : result.exported)
        return { ...result, freshVersionedFile: true, reusedOwnedVersion: Boolean(resume), sourceReadOnly: true }
       } else if (sourceFile) {
         assert.ok(path.isAbsolute(sourceFile), "ABSOLUTE_SEED_SOURCE_REQUIRED")
         const location = path.relative(repo, await realpath(sourceFile))
         assert.ok(location.startsWith("..") || path.isAbsolute(location), "SEED_SOURCE_MUST_BE_OUTSIDE_CHECKOUT")
         const { copyFile, constants } = await import("node:fs/promises")
         sourceBaseline = createHash("sha256").update(await readFile(sourceFile)).digest("hex")
         await copyFile(sourceFile, seedFile, constants.COPYFILE_EXCL)
      } else await writeFile(seedFile, JSON.stringify({ openai: { type: "oauth", access: "synthetic-access", refresh: "synthetic-refresh", expires: 0 } }), { flag: "wx", mode: 0o600 })
      return { freshVersionedFile: true, sourceReadOnly: true, originalNeverModified: true }
    })
    exportedReady = !login
    for (const worker of binding.workers) {
      await check(`worker-${worker.side}-private-initialize`, async () => {
        if (previousEvidence?.checks.some(c => c.name === `worker-${worker.side}-private-initialize` && c.status === "passed")) return { previouslyInitializedPrivateCopy: true, artificialExpiry: true, privateOnly: true }
        const output = await owner.compose(worker, ["run", "--rm", "--no-deps", "-T", "--name", `${worker.project}-prepare`, "execution", "node", "/harness/seed-worker-fixture.mjs", login ? "prepare-login" : "prepare", worker.side])
        return JSON.parse(output)
      })
      await check(`worker-${worker.side}-compose-start`, async () => {
        await owner.compose(worker, ["up", "--wait", "--wait-timeout", "90", "--no-build"], 120_000)
        const ids = (await owner.compose(worker, ["ps", "-q"])).split(/\s+/).filter(Boolean)
        assert.equal(ids.length, 2)
        const info = JSON.parse(await owner.docker(["inspect", ...ids]))
        const publicInfo = info.map(c => {
          assert.equal(c.Config.Labels["io.omw.seed.run"], runId)
          assert.equal(c.Config.User, "node")
          assert.equal(c.HostConfig.Init, true)
          assert.equal(c.Image, evidence.imageId)
          assert.ok(Object.values(c.NetworkSettings.Ports).flat().filter(Boolean).every(p => p.HostIp === "127.0.0.1"))
          const seedMount = c.Mounts.find(m => m.Destination === "/run/secrets/auth_seed")
          if (!login && c.Config.Labels["com.docker.compose.service"] === "execution") assert.equal(seedMount.RW, false)
          return { id: c.Id, service: c.Config.Labels["com.docker.compose.service"], imageId: c.Image,
            volumes: c.Mounts.filter(m => m.Type === "volume").map(m => ({ name: m.Name, destination: m.Destination })) }
        })
         record[worker.side] = { containers: publicInfo }
         record.owner_binding.containerIds = Object.values(record).filter(v => v?.containers).flatMap(v => v.containers.map(c => c.id))
        return { containers: publicInfo, nonRoot: true, seedReadonly: true }
      })
      const password = (await readFile(worker.passwordFile, "utf8")).trim()
      const headers = { authorization: `Basic ${Buffer.from(`worker:${password}`).toString("base64")}`, "content-type": "application/json", origin: worker.managerUrl, "x-omw-csrf": "1" }
      const request = publicWorkerRequest({ ...worker, headers, deadlineAt: binding.deadlineAt })
      request.watchPrompt = detail => observeNativePrompt({ url: worker.nativeUrl, headers, sessionId: worker.sessionId,
        deadlineAt: binding.deadlineAt, detail, onRetry: () => request(true, `/session/${worker.sessionId}/abort`, {}) })
      requests.set(worker.side, request)
      await check(`worker-${worker.side}-public-start-primary`, async () => {
        worker.phase = "basic-gates"
        for (const url of [worker.managerUrl, worker.nativeUrl]) assert.equal((await fetch(url, { signal: AbortSignal.timeout(5000) })).status, 401)
        worker.phase = "start-instance"
        const instance = await request(false, "/api/v1/instances", { directory: "/workspace/seed-check" })
        worker.instanceId = instance.id
        assert.ok(worker.instanceId)
        worker.phase = "create-primary"
        const created = await request(false, `/api/v1/instances/${worker.instanceId}/sessions`, {})
        if (login) record.loginReadyUrl = created.url
        worker.sessionId = created.sessionId
        assert.ok(worker.sessionId)
        worker.phase = "primary-binding"
        // active detail 由 current overview 提供；/:id 僅提供持久 stopped detail。
        const current = (await request(false, "/api/v1/overview?view=compact&scope=current")).instances.find(i => i.id === worker.instanceId)
        worker.primaryBindingMatched = current?.primarySession?.sessionId === worker.sessionId
        assert.equal(current.primarySession.sessionId, worker.sessionId)
        worker.phase = "native-version"
        const health = await request(true, "/global/health")
        worker.runtimeVersion = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/.test(health.version) ? health.version : "not-version-json"
        assert.equal(health.version, "1.18.34")
        evidence.workers.push({ side: worker.side, instanceId: worker.instanceId, sessionId: worker.sessionId, version: health.version })
        return { instanceId: worker.instanceId, primarySessionId: worker.sessionId, version: health.version, basicGates: true }
      })
    }
    if (login) {
      evidence.completedAt = now()
      record.readiness = { basicGates: true, newPrimary: true, nativeVersion: "1.18.34", providerLoginInitiated: false }
      preserved = true
      return
    }
    await check("public-api-workspace-session-manager-isolation", async () => {
      const [a, b] = binding.workers
      assert.notEqual(a.sessionId, b.sessionId); assert.notEqual(a.instanceId, b.instanceId)
      for (const worker of binding.workers) {
        const request = requests.get(worker.side), peer = worker.side === "a" ? b : a
        const roots = await request(false, `/api/v1/instances/${worker.instanceId}/sessions`)
        assert.ok(roots.roots.some(s => s.id === worker.sessionId))
        assert.ok(!roots.roots.some(s => s.id === peer.sessionId))
        const files = await request(true, "/file?path=.")
        assert.ok(files.some(f => f.name === `marker-${worker.side}.txt`))
        assert.ok(!files.some(f => f.name === `marker-${peer.side}.txt`))
        const content = await request(true, `/file/content?path=marker-${worker.side}.txt`)
        assert.equal(content.content.trim(), `WORKER_${worker.side.toUpperCase()}_MARKER`)
        const config = await request(true, "/config")
        assert.equal(config.agent.title.disable, true); assert.equal(config.agent.summary.disable, true)
        assert.ok(config.permission["*"] === "deny" || Array.isArray(config.permission)
          && config.permission.some(rule => rule.permission === "*" && rule.pattern === "*" && rule.action === "deny"))
      }
      const volumes = binding.workers.map(w => record[w.side].containers.flatMap(c => c.volumes.map(v => v.name)))
      assert.ok(!volumes[0].some(v => volumes[1].includes(v)))
      return { independentPrimaryIds: true, peerSessionMissing: true, ownMarkerReadable: true, peerMarkerMissing: true,
        independentManagerDataWorkspaceAuthVolumes: true, noLiveExec: true, noAutomaticAuxiliaryModelCalls: true }
    })
    const available = await check("fixed-model-provider-metadata", async () => {
      const values = []
      for (const worker of binding.workers) {
        const provider = await requests.get(worker.side)(true, "/provider")
        const entry = provider.all?.find(p => p.id === "openai"), model = entry?.models?.[modelID]
         const sdk = model?.api?.npm ?? entry?.npm
         values.push({ side: worker.side, connected: provider.connected?.includes("openai") === true, modelIDExists: Boolean(model),
            requestedModelIdMatches: model?.id === modelID,
            apiTargetSameLunaFamily: typeof model?.api?.id === "string" && /^gpt-6-luna(?:-|$)/.test(model.api.id),
          sdk: sdk === "@ai-sdk/openai" ? "openai" : sdk === "@ai-sdk/openai-compatible" ? "openai-compatible" : sdk ? "other" : "unavailable" })
      }
      evidence.modelAvailability = values
      return values
    })
    // 原生 preset 可映射同家族的 canonical API ID；仍固定送出指定 OpenCode model ID，拒絕跨家族 alias。
    if (allowProvider && available.every(v => v.connected && v.modelIDExists && v.requestedModelIdMatches && v.apiTargetSameLunaFamily)) {
      const outcomes = await Promise.allSettled(binding.workers.map(async worker => {
        await check(`worker-${worker.side}-single-native-prompt`, async () => {
          const request = requests.get(worker.side), expected = `WORKER_${worker.side.toUpperCase()}_OK`
          const tools = await request(true, "/experimental/tool/ids")
           const detail = { side: worker.side, promptCount: 0, model: `openai/${modelID}`, artificialExpiry: true, status: "submitted" }
           const monitor = await request.watchPrompt(detail)
           evidence.prompts.push(detail)
           try {
             detail.submittedAt = now(); detail.promptCount = 1; await save()
             const response = await request(true, `/session/${worker.sessionId}/message`, { model: { providerID: "openai", modelID },
               parts: [{ type: "text", text: `不要使用工具、Git 或讀取檔案／secret；只回覆 ${expected}` }],
               tools: Object.fromEntries(tools.map(id => [id, false])) }, 140_000)
             detail.toolCount = (response.parts ?? []).filter(p => p.type === "tool").length
             detail.fixedReplyMatched = (response.parts ?? []).filter(p => p.type === "text").map(p => p.text).join("").trim() === expected
             detail.providerRejected = Boolean(response.info?.error)
             if (detail.providerRejected) detail.reason = classifyNativeRejection(response.info.error)
             detail.status = !detail.providerRejected && detail.fixedReplyMatched && !detail.toolCount && !detail.retryEventCount && !detail.eventObservationFailed ? "passed" : "blocked"
           } catch {
             detail.status = "blocked"; detail.reason = "NATIVE_PROMPT_OPERATION_FAILED"
             try { await request(true, `/session/${worker.sessionId}/abort`, {}) } catch { detail.abortFailed = true }
           } finally {
             await monitor.stop(); detail.finishedAt = now()
             if (detail.retryEventCount || detail.eventObservationFailed) detail.status = "blocked"
           }
          const states = await request(true, "/session/status")
           detail.idle = !states[worker.sessionId] || states[worker.sessionId].type === "idle"
           if (!detail.idle) { detail.status = "blocked"; await request(true, `/session/${worker.sessionId}/abort`, {}) }
          // 不輸出 assistant text、provider errors 或 response body。
          return detail
        })
       }))
      if (outcomes.some(o => o.status === "rejected") || evidence.prompts.length !== 2 || evidence.prompts.some(p => p.status !== "passed")) evidence.providerBlocker = "NATIVE_PROMPT_REJECTED_NO_FALLBACK"
    } else evidence.providerBlocker = allowProvider ? "FIXED_MODEL_NOT_AVAILABLE_NO_FALLBACK" : "SYNTHETIC_NO_PROVIDER_CALLS"
    for (const worker of binding.workers) {
      await check(`worker-${worker.side}-stop-and-refresh-audit`, async () => {
        await requests.get(worker.side)(false, `/api/v1/instances/${worker.instanceId}/stop`, {})
        await owner.compose(worker, ["stop", "--timeout", "15", "execution"])
        const detail = await audit(worker, "after-prompt")
        assert.ok(detail.authMode600 && detail.parentMode700 && detail.ownerUid1000 && detail.separateSeedInode && detail.seedUnchanged)
        evidence.workers.find(w => w.side === worker.side).refresh = detail.changed
        return detail
      })
      await check(`worker-${worker.side}-execution-restart-preserves-private-auth`, async () => {
        await owner.compose(worker, ["start", "execution"])
        await delay(2000)
        const request = requests.get(worker.side)
        const instance = await request(false, "/api/v1/instances", { directory: "/workspace/seed-check" })
        worker.restartInstanceId = instance.id
        const roots = await request(false, `/api/v1/instances/${instance.id}/sessions`)
         assert.ok(roots.roots.some(s => s.id === worker.sessionId))
         assert.ok(!roots.roots.some(s => s.id === binding.workers.find(w => w.side !== worker.side).sessionId))
        await request(false, `/api/v1/instances/${instance.id}/primary-session`, { sessionId: worker.sessionId })
        await request(false, `/api/v1/instances/${instance.id}/stop`, {})
        await owner.compose(worker, ["stop", "--timeout", "15", "execution"])
        const detail = await audit(worker, "after-restart")
        assert.ok(detail.privateAuthPreserved && detail.seedUnchanged)
        return { ...detail, ownSessionPersisted: true, managerRestarted: false, restartPromptCount: 0 }
      })
    }
    evidence.completedAt = now()
  } catch (error) {
    evidence.failure = /^CHECK_FAILED:[a-z0-9-]+$/.test(error.message) ? error.message : "HARNESS_FAILED"
  } finally {
    if (local && exportedReady && sourceVolume) {
      try { await check("original-source-and-exported-seed-unchanged", async () => {
        const result = JSON.parse(await sourceRun("source-audit"))
        assert.ok(result.sourceUnchanged && result.exportedSeedUnchanged); return result
      }) } catch { evidence.sourceAuditFailed = true }
    }
    if (exportedReady && sourceFile) {
      try { await check("original-source-and-exported-seed-unchanged", async () => {
        const unchanged = async filename => createHash("sha256").update(await readFile(filename)).digest("hex") === sourceBaseline
        const result = { sourceUnchanged: await unchanged(sourceFile), exportedSeedUnchanged: await unchanged(seedFile) }
        assert.ok(result.sourceUnchanged && result.exportedSeedUnchanged); return result
      }) } catch { evidence.sourceAuditFailed = true }
    }
    if (preserved) {
      record.final_disposition = { requested: "Preserve", status: "preserved" }
      record.lifecycle_result = { status: "preserved" }
      record.cleanup_attempt = "not-attempted-preserve-for-human-login"
      record.cleanup_result = "preserved"
      record.retainedVolumes = record.a.containers.flatMap(c => c.volumes.map(v => v.name)).filter((v, i, all) => all.indexOf(v) === i)
    } else if (local) {
      evidence.cleanup = await owner.cleanup()
      if (evidence.cleanup.status === "stopped") watchdog?.kill()
      record.final_disposition.status = evidence.cleanup.status
      record.lifecycle_result = { status: evidence.cleanup.status }
      record.cleanup_attempt = "finally-scoped-compose-down-no-volume-removal"
      record.cleanup_result = evidence.cleanup.status
      record.retainedVolumes = evidence.cleanup.retainedVolumes
    }
    const allPromptsPassed = evidence.prompts.length === 2 && evidence.prompts.every(p => p.status === "passed" && p.idle)
    const refreshed = evidence.workers.length === 2 && evidence.workers.every(w => w.refresh?.access && w.refresh?.refresh && w.refresh?.expires)
    evidence.result = preserved ? "login-environment-ready" : !evidence.failure && !evidence.sourceAuditFailed && allPromptsPassed && refreshed && evidence.cleanup?.status === "stopped" ? "seed-workers-passed-PAT-blocked" : "partial"
    record.downstream_result = { status: evidence.result, failure: evidence.failure ?? null, providerBlocker: evidence.providerBlocker ?? null, pat: "not-tested" }
    record.minimum_outcomes = Object.fromEntries(["ownership_binding", "stdio", "readiness", "observation", "disposition", "cleanup_or_handoff", "lifecycle_callback"].map(k => [k, "owner handled"]))
    record.unresolved_items = ["PAT scratch Git/gh not tested", ...(!allPromptsPassed ? ["fixed model prompt acceptance incomplete"] : []), ...(!refreshed ? ["native refresh not observed"] : [])]
    if (preserved) record.unresolved_items = ["人類尚未執行 OpenCode 原生 Headless 登入；登入完成後先 Stop，再由唯讀 one-shot 匯出新 seed", "雙 Worker provider 與 PAT 驗收尚未完成"]
    record.unresolved_reason = record.unresolved_items.join("; ")
    record.failure_kind = evidence.failure ? "downstream-failure" : evidence.providerBlocker === "NATIVE_PROMPT_REJECTED_NO_FALLBACK" ? "provider-rejected"
      : evidence.providerBlocker === "FIXED_MODEL_NOT_AVAILABLE_NO_FALLBACK" ? "model-unavailable" : null
    await save()
    if (preserved) watchdog?.kill()
    await writeFile(proofPath, `# #105 seed／雙 Worker 驗收\n\n- Result: ${evidence.result}\n- Model: openai/${modelID}\n- Image: ${evidence.imageId ?? "not-built"}\n- Prompt submissions: ${evidence.prompts.reduce((n, p) => n + p.promptCount, 0)}; successful: ${evidence.prompts.filter(p => p.status === "passed").length}\n- Refresh observed: ${evidence.workers.filter(w => w.refresh?.access && w.refresh?.refresh && w.refresh?.expires).length}\n- Cleanup: ${evidence.cleanup?.status ?? "not-launched"}; all volumes retained\n- PAT: not provided / not tested\n- Detail: evidence.json; ownership and retained resources: owner.json\n`)
    if (preserved) await writeFile(proofPath, `# 人類 Headless 登入環境\n\n- Disposition: Preserve；later owner: main session + user\n- OpenCode: 1.18.34；新私有 execution-home、workspace、manager-data\n- Provider login initiated: false；prompt submissions: 0\n- 由 private owner.json 的 loginReadyUrl 開啟新 primary；username: worker；passwordFile 僅由操作者讀取。\n- 在原生 Providers 選 OpenAI／ChatGPT Headless，依 UI 人工登入；不要把 code／token 貼到 evidence。\n- 登入後先透過 OMW Stop Instance，再執行 owner.json.stop；此 Stop 保留所有 volumes。\n- 之後依 docs/worker-auth-seed.md 使用同 image 的離線 readonly one-shot 匯出新的 seed 檔名。\n- 安全的 later Stop 指令與精確 container/volume identity 位於 owner.json；不可 down -v。\n`)
    console.log(JSON.stringify({ result: evidence.result, evidencePath, ownerPath, proofPath, providerBlocker: evidence.providerBlocker ?? null, lifecycle: record.lifecycle_result.status }))
    if (evidence.result === "partial") process.exitCode = 1
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error("SEED_WORKER_HARNESS_FAILED (no secrets published)"); process.exitCode = 1 })
