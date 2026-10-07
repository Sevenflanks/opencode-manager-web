import { randomUUID, timingSafeEqual } from "node:crypto"
import Fastify from "fastify"
import { spawn, type ChildProcess } from "node:child_process"
import { readdir, readFile, readlink } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { LaunchResult } from "../runtime.js"
import { proxyRuntime, proxyRuntimeUpgrade } from "./proxy.js"
import { localDirectories, type DirectoryPort } from "../directory.js"
import { ManagerError } from "../errors.js"
import { resolveStartDirectory } from "./directory.js"

export interface ExecutionOptions {
  token: string
  executable: string
  runtimePort: number
  arguments?: string[]
  environment?: NodeJS.ProcessEnv
  nativeOrigin?: string
  browserUsername?: string
  browserPassword?: string
}

export interface StartRejectionAcknowledgment {
  epoch: string
  instanceId: string
  accepted: false
}

// 第三參數只供 filesystem fixture 注入；production 固定 /workspace，沒有環境或設定可改 root。
export function buildExecutionApp(options: ExecutionOptions, directories: DirectoryPort = localDirectories, testWorkspaceRoot = "/workspace") {
  if (options.token.length < 32) throw new Error("Execution control token 至少 32 字元。")
  const epoch = randomUUID()
  const runtimePassword = randomUUID()
  let current: LaunchResult | null = null
  let root: ChildProcess | null = null
  let listenerIdentity: string | null = null
  let mutation = false
  let draining = false
  let shutdown: Promise<{ stopped: boolean; reason: string | null }> | undefined
  let startupFailure: { phase: string; code: string } | null = null
  let lastAcceptedAttempt: { instanceId: string; stopped: boolean } | null = null
  const app = Fastify({ logger: false, bodyLimit: 4096 })
  app.addHook("onRequest", async (request, reply) => {
    if (request.headers.origin !== undefined) return reply.code(403).send({ error: "BROWSER_NOT_ALLOWED" })
    if (!equalSecret(request.headers.authorization ?? "", `Bearer ${options.token}`)) return reply.code(401).send({ error: "AUTH_REQUIRED" })
    if (draining) return reply.code(503).send({ error: "EXECUTION_DRAINING" })
  })
  app.setErrorHandler((_error, _request, reply) => reply.code(503).send({ error: "EXECUTION_UNAVAILABLE" }))
  // 只讀目錄操作使用 execution 自己的 filesystem；不 spawn helper，不接受外部 target/command。
  for (const operation of ["resolve", "browse", "resolve-start"] as const) {
    app.get<{ Querystring: { directory: string } }>(`/v1/directories/${operation}`, {
      schema: { querystring: { type: "object", required: ["directory"], additionalProperties: false,
        properties: { directory: { type: "string", maxLength: 4096 } } } },
    }, async (request, reply) => {
      try {
        if (operation === "resolve-start") return { directory: await resolveStartDirectory(request.query.directory, directories, testWorkspaceRoot) }
        return operation === "resolve" ? { directory: await directories.resolve(request.query.directory) }
          : await directories.browse(request.query.directory)
      } catch (error) {
        if (error instanceof ManagerError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details } })
        throw error
      }
    })
  }
  app.get("/v1/execution", async () => {
    try {
      const members = await namespaceProcesses()
      return { epoch, execution: current, capacity: mutation || members.length > 0 ? "occupied" : "available", ...(startupFailure ? { startupFailure } : {}) }
    } catch { return { epoch, execution: current, capacity: "unknown" } }
  })
  type Identity = { epoch: string; instanceId: string }
  const matches = (identity: Identity) => identity.epoch === epoch && identity.instanceId === current?.instanceId
  const listenerMatches = async () => root?.exitCode === null && root?.signalCode === null && listenerIdentity !== null
    && (await listenerOwners(options.runtimePort)).join() === listenerIdentity
  app.post<{ Body: Identity & { directory: string } }>("/v1/start", async (request, reply) => {
    const body = request.body
    if (!body || body.epoch !== epoch) return reply.code(409).send({ error: "EPOCH_MISMATCH" })
    if (typeof body.instanceId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(body.instanceId)
      || typeof body.directory !== "string" || !path.isAbsolute(body.directory)) return reply.code(400).send({ error: "START_INVALID" })
    try { await resolveStartDirectory(body.directory, directories, testWorkspaceRoot) }
    catch (error) {
      if (error instanceof ManagerError) {
        // 只有本次 preaccept 拒絕可回收 reservation；不授予 Stop，也不能替既有／在途 attempt 宣告未接受。
        const startRejected: StartRejectionAcknowledgment | undefined = !mutation && current?.instanceId !== body.instanceId
          && lastAcceptedAttempt?.instanceId !== body.instanceId ? { epoch, instanceId: body.instanceId, accepted: false } : undefined
        return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details },
          ...(startRejected ? { startRejected } : {}) })
      }
      throw error
    }
    if (mutation) return reply.code(409).send({ error: "EXECUTION_BUSY" })
    mutation = true
    let phase = "namespace-owner"
    let acceptedAttempt: typeof lastAcceptedAttempt = null
    let spawned = false
    startupFailure = null
    try {
      await requireNamespaceOwner()
      if (draining) return reply.code(503).send({ error: "EXECUTION_DRAINING" })
      if (current?.instanceId === body.instanceId) {
        if (current.directory !== await resolveStartDirectory(body.directory, directories, testWorkspaceRoot)) return reply.code(409).send({ error: "IDENTITY_MISMATCH" })
        if (!listenerIdentity || root?.exitCode !== null || root?.signalCode !== null
          || (await listenerOwners(options.runtimePort)).join() !== listenerIdentity) return reply.code(409).send({ error: "EXECUTION_NOT_READY" })
        if (draining) return reply.code(503).send({ error: "EXECUTION_DRAINING" })
        return current
      }
      if ((await namespaceProcesses()).length) return reply.code(409).send({ error: "EXECUTION_BUSY" })
      if (draining) return reply.code(503).send({ error: "EXECUTION_DRAINING" })
      // 只有通過 preflight 的 Start 才持有 cleanup authority；下一個已接受 attempt 立即撤銷舊身分。
      acceptedAttempt = lastAcceptedAttempt = { instanceId: body.instanceId, stopped: false }
      current = null
      root = null
      listenerIdentity = null
      phase = "directory"
      const directory = await resolveStartDirectory(body.directory, directories, testWorkspaceRoot)
      // TERM 可在任一 await 到達；最後一個 await 後重新檢查，避免 cleanup 掃完才又 spawn。
      if (draining) return reply.code(503).send({ error: "EXECUTION_DRAINING" })
      phase = "spawn"
      const child = spawn(options.executable, options.arguments ?? ["serve", "--hostname", "127.0.0.1", "--port", String(options.runtimePort)], {
        cwd: directory, env: executionEnvironment(options.environment ?? process.env, runtimePassword), stdio: "ignore", detached: true,
      })
      root = child
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject) })
      spawned = true
      current = { pid: child.pid!, instanceId: body.instanceId, directory, executable: options.executable,
        creationTimeUtc: new Date().toISOString(), creationTimeTicks: epoch,
        endpoint: `http://127.0.0.1:${options.runtimePort}` }
      listenerIdentity = null
      // spawn 只證明建立程序，不代表 listener 已就緒。Start 回傳前建立同一次 execution 的 listener 身分。
      const deadline = Date.now() + 30_000
      try {
        while (!draining && Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
          phase = "listener-owners"
          const owners = await listenerOwners(options.runtimePort)
          if (owners.length === 1) {
            phase = "authenticated-health"
            try {
              const response = await fetch(`http://127.0.0.1:${options.runtimePort}/global/health`, {
                headers: { authorization: `Basic ${Buffer.from(`opencode:${runtimePassword}`).toString("base64")}` },
                signal: AbortSignal.timeout(Math.min(1_000, Math.max(1, deadline - Date.now()))), redirect: "error",
              })
              const health = await response.json() as { healthy?: boolean }
              if (response.ok && health.healthy === true && child.exitCode === null && child.signalCode === null
                && (await listenerOwners(options.runtimePort)).join() === owners.join() && !draining) {
                listenerIdentity = owners[0]!
                return current
              }
            } catch { /* 尚未 ready；只在同一次 bounded Start 內重試。 */ }
          }
          await delay(50)
        }
        if (child.exitCode !== null || child.signalCode !== null) phase = "child-exited"
        throw new Error("Execution startup did not establish an authenticated listener")
      } catch (error) {
        // Draining 時由 final owner 在 mutation 解鎖後做一次 cleanup，不能與 Start cleanup 同時掃 namespace。
        if (!draining) {
          const cleanup = await stopNamespace()
          if (!cleanup.stopped) return reply.code(503).send({ error: "STARTUP_CLEANUP_UNCONFIRMED" })
        }
        throw error
      }
    } catch (error) {
      // pre-spawn 失敗沒有 LaunchResult，但仍須留下同一次 attempt 的「未啟動且 namespace 已空」證據。
      // available 或不認識的 ID 不能替代此證據；spawn 成功後仍走原有 current/owned Stop 契約。
      if (acceptedAttempt && !spawned) {
        acceptedAttempt.stopped = await namespaceProcesses().then((members) => members.length === 0).catch(() => false)
      }
      // Control-only 固定 enum：不回傳原始錯誤、路徑、環境或 runtime credential。
      const details = error instanceof ManagerError ? error.details as { reason?: string } | undefined : undefined
      const code = details?.reason === "NOT_FOUND" ? "ENOENT" : (error as NodeJS.ErrnoException).code
      startupFailure = { phase, code: ["EACCES", "EPERM", "ENOENT", "ESRCH"].includes(code ?? "") ? code! : "START_FAILED" }
      if (error instanceof ManagerError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details } })
      throw error
    } finally { mutation = false }
  })
  app.post<{ Body: Identity }>("/v1/inspect", async (request) => {
    if (!request.body || request.body.epoch !== epoch) return { processState: "unknown", running: false, matched: false, portOwnerMatched: false, portOwnedByOther: false }
    if (!matches(request.body)) return { processState: "not-found", running: false, matched: false, portOwnerMatched: false, portOwnedByOther: false }
    const members = await namespaceProcesses()
    const running = members.length > 0
    const owners = await listenerOwners(options.runtimePort)
    const rootRunning = root?.exitCode === null && root?.signalCode === null
    const portOwnerMatched = rootRunning && listenerIdentity !== null && owners.length === 1 && owners[0] === listenerIdentity
    return { processState: running ? "running" : "not-found", running, matched: running,
      portOwnerMatched, portOwnedByOther: owners.length > 0 && !portOwnerMatched && rootRunning, rootRunning,
      managedProcessCount: members.length }
  })
  app.post<{ Body: Identity }>("/v1/stop", async (request, reply) => {
    const failedAttemptMatches = request.body?.epoch === epoch && !current && lastAcceptedAttempt?.stopped === true
      && request.body.instanceId === lastAcceptedAttempt.instanceId
    if (!request.body || (!matches(request.body) && !failedAttemptMatches)) return reply.code(409).send({ error: "IDENTITY_MISMATCH" })
    if (mutation) return reply.code(409).send({ error: "EXECUTION_BUSY" })
    mutation = true
    try {
      await requireNamespaceOwner()
      if (failedAttemptMatches) {
        // 冪等確認不送 signal；即使 namespace 後來出現其他程序，也不能藉舊失敗 attempt 停掉它。
        const empty = (await namespaceProcesses()).length === 0
        return { stopped: empty, reason: empty ? null : "failed launch namespace is no longer empty" }
      }
      return await stopNamespace()
    } finally { mutation = false }
  })
  app.addHook("onRequest", async (request, reply) => {
    if (request.routeOptions.url !== "/runtime/:epoch/:instanceId/*") return
    const params = request.params as Identity
    if (!matches(params)) return reply.code(409).send({ error: "IDENTITY_MISMATCH" })
    if (!await listenerMatches()) return reply.code(503).send({ error: "EXECUTION_NOT_READY" })
    if (draining) return reply.code(503).send({ error: "EXECUTION_DRAINING" })
    const prefix = `/runtime/${params.epoch}/${params.instanceId}`
    if (!request.raw.url?.startsWith(`${prefix}/`)) return reply.code(400).send({ error: "PATH_INVALID" })
    reply.hijack()
    proxyRuntime(request.raw, reply.raw, options.runtimePort, request.raw.url.slice(prefix.length), runtimePassword)
  })
  app.all("/runtime/:epoch/:instanceId/*", async () => undefined)
  const native = Fastify({ logger: false })
  // 原生 Web 使用獨立 root origin 與 Basic auth，沒有 manager token／內部 runtime credential。
  native.addHook("onRequest", async (request, reply) => {
    if (!options.nativeOrigin || !options.browserUsername || !options.browserPassword) return reply.code(503).send()
    const origin = new URL(options.nativeOrigin)
    if (request.headers.host !== origin.host || (request.headers.origin !== undefined && request.headers.origin !== origin.origin)
      || request.headers["sec-fetch-site"] === "cross-site") return reply.code(403).send()
    const expected = `Basic ${Buffer.from(`${options.browserUsername}:${options.browserPassword}`).toString("base64")}`
    if (!equalSecret(request.headers.authorization ?? "", expected)) return reply.header("www-authenticate", 'Basic realm="OpenCode Worker", charset="UTF-8"').code(401).send()
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && request.headers.origin !== origin.origin) return reply.code(403).send()
    if (draining) return reply.code(503).send({ error: "EXECUTION_DRAINING" })
    if (!current) return reply.code(503).send({ error: "EXECUTION_NOT_STARTED" })
    if (!await listenerMatches()) return reply.code(503).send({ error: "EXECUTION_NOT_READY" })
    if (draining) return reply.code(503).send({ error: "EXECUTION_DRAINING" })
    reply.hijack()
    proxyRuntime(request.raw, reply.raw, options.runtimePort, request.raw.url ?? "/", runtimePassword)
  })
  native.all("/*", async () => undefined)
  native.server.on("upgrade", (request, socket, head) => {
    const authorized = !draining && options.nativeOrigin && options.browserUsername && options.browserPassword && current
      && request.headers.host === new URL(options.nativeOrigin).host && request.headers.origin === options.nativeOrigin
      && request.headers["sec-fetch-site"] !== "cross-site"
      && equalSecret(request.headers.authorization ?? "", `Basic ${Buffer.from(`${options.browserUsername}:${options.browserPassword}`).toString("base64")}`)
    if (!authorized) { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return }
    void listenerMatches().then((matched) => {
      if (!matched || draining) { socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n"); return }
      proxyRuntimeUpgrade(request, socket, head, options.runtimePort, runtimePassword)
    }).catch(() => socket.destroy())
  })
  app.decorate("nativeGateway", native)
  app.addHook("onClose", async () => { await native.close() })
  const beginDrain = () => { draining = true }
  const shutdownExecution = () => {
    beginDrain()
    shutdown ??= (async () => {
      await requireNamespaceOwner()
      // 在途 Start/Stop 先退出 mutation；超時只交給容器 final owner，不並行啟動另一輪掃描。
      const deadline = Date.now() + 5_000
      while (mutation && Date.now() < deadline) await delay(20)
      if (mutation) return { stopped: false, reason: "execution mutation did not drain" }
      mutation = true
      try { return await stopNamespace() }
      finally { mutation = false }
    })()
    return shutdown
  }
  return Object.assign(app, { nativeGateway: native, beginDrain, shutdownExecution })
}

function executionEnvironment(source: NodeJS.ProcessEnv, password: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  // 只傳精選 profile、工具鏈與同程序 bootstrap 的 gh 設定；manager secret／seed 路徑不可進工具環境。
  for (const name of ["HOME", "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "TZ", "TERM", "COLORTERM",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
    "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "GH_TOKEN", "GH_CONFIG_DIR", "GIT_CONFIG_GLOBAL", "JAVA_HOME", "MAVEN_HOME",
    "OFFICECLI_SKIP_UPDATE", "OFFICECLI_NO_AUTO_INSTALL", "OFFICECLI_NO_AUTO_RESIDENT"]) {
    if (source[name] !== undefined) result[name] = source[name]
  }
  for (const name of Object.keys(source)) if (/^LC_[A-Z_]+$/.test(name)) result[name] = source[name]
  return { ...result, OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: password }
}

async function stopNamespace() {
  // Namespace 才涵蓋 orphan/setsid 工具；先給 SQLite/auth 寫入 graceful TERM 的機會，再對剩餘成員 KILL。
  const started = Date.now()
  const termSent = new Set<number>()
  while (Date.now() - started < 5_000) {
    const members = await namespaceProcesses()
    if (!members.length) return { stopped: true, reason: null }
    for (const pid of members) {
      const force = Date.now() - started >= 2_000
      if (!force && termSent.has(pid)) continue
      try { process.kill(pid, force ? "SIGKILL" : "SIGTERM"); termSent.add(pid) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error }
    }
    await delay(20)
  }
  return { stopped: false, reason: "managed process namespace did not become empty" }
}

async function listenerOwners(port: number): Promise<string[]> {
  const inodes = new Set<string>()
  for (const family of ["tcp", "tcp6"]) {
    for (const line of (await readFile(`/proc/net/${family}`, "utf8")).split("\n")) {
      const fields = line.trim().split(/\s+/)
      if (fields[3] === "0A" && Number.parseInt(fields[1]?.split(":")[1] ?? "", 16) === port && fields[9]) inodes.add(`socket:[${fields[9]}]`)
    }
  }
  const owners = new Set<string>()
  for (const pid of await namespaceProcesses()) {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8")
      const startTicks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]
      for (const fd of await readdir(`/proc/${pid}/fd`)) {
        try { if (inodes.has(await readlink(`/proc/${pid}/fd/${fd}`))) owners.add(`${pid}:${startTicks}`) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ESRCH") throw error }
  }
  return [...owners].sort()
}

export async function requireNamespaceOwner(): Promise<void> {
  if (process.platform === "linux") {
    if (process.pid === 1) return
    // Docker init 回收 orphan zombie；只接受直接 child，不能把 host systemd 或任意 wrapper 當成 owner。
    if (process.ppid === 1 && ["docker-init", "tini"].includes(path.basename(await readlink("/proc/1/exe")))) return
  }
  throw new Error("Execution supervisor 必須是專用 Linux PID namespace 的 PID 1，或 docker-init/tini PID 1 的直接 child。")
}

async function namespaceProcesses(): Promise<number[]> {
  await requireNamespaceOwner()
  const result: number[] = []
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry) || Number(entry) === 1 || Number(entry) === process.pid) continue
    try {
      const stat = await readFile(`/proc/${entry}/stat`, "utf8")
      const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]
      // Zombie 已無可執行程式；不能因 PID 1 的等待回收時序將已終止工作判成仍執行。
      if (state !== "Z" && state !== "X") result.push(Number(entry))
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  }
  return result
}

export function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}
