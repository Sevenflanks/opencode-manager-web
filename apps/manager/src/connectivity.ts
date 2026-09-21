import { execFile } from "node:child_process"
import path from "node:path"
import process from "node:process"
import type { ConnectivityInfo } from "@omw/contracts"
import type { InstancePortPoolConfig, RemoteAccessConfig } from "./config.js"
import { ManagerError } from "./errors.js"

const COMMAND_OPTIONS = {
  encoding: "utf8",
  maxBuffer: 1_048_576,
  shell: false,
  timeout: 2_500,
  windowsHide: true,
} as const
type CommandOptions = Omit<typeof COMMAND_OPTIONS, "timeout"> & { timeout: number }
const CACHE_TTL_MS = 5_000
const REGISTRATION_DEADLINE_MS = 30_000

export interface CommandRunner {
  execFile(
    executable: string,
    args: readonly string[],
    options: CommandOptions,
  ): Promise<{ stdout: string }>
}

export interface ConnectivityOptions {
  managerPort: number
  remoteAccess: RemoteAccessConfig | null
  portPool: InstancePortPoolConfig
  executable: string
  runner?: CommandRunner
  now?: () => Date
  monotonicNow?: () => number
  registrationDeadlineMs?: number
}

type CommandResult =
  | { state: "ok"; value: unknown }
  | { state: "deadline" | "missing" | "unknown" }

type JsonRecord = Record<string, unknown>
type Registration = ConnectivityInfo["registration"]
type Diagnostic = NonNullable<Registration["diagnostic"]>

interface Snapshot {
  generation: number
  info: ConnectivityInfo
  serveResult: CommandResult
  deadlineExpired: boolean
}

interface MappingTarget {
  hostname: string
  publicPort: number
  loopbackOrigin: string
}

export class ConnectivityService {
  private readonly runner: CommandRunner
  private readonly now: () => Date
  private readonly monotonicNow: () => number
  private readonly registrationDeadlineMs: number
  private cached: { storedAtMonotonicMs: number; value: ConnectivityInfo } | null = null
  private inflight: Promise<ConnectivityInfo> | null = null
  private registrationInflight: Promise<ConnectivityInfo> | null = null
  private registration: Registration
  private remoteReady = false
  private nextSnapshotGeneration = 0
  private storedSnapshotGeneration = 0
  private closing = false

  constructor(private readonly options: ConnectivityOptions) {
    this.runner = options.runner ?? nodeCommandRunner
    this.now = options.now ?? (() => new Date())
    this.monotonicNow = options.monotonicNow ?? (() => performance.now())
    this.registrationDeadlineMs = options.registrationDeadlineMs ?? REGISTRATION_DEADLINE_MS
    this.registration = {
      state: options.remoteAccess ? "idle" : "not-configured",
      trigger: null,
      diagnostic: null,
    }
  }

  get(): Promise<ConnectivityInfo> {
    if (this.cached && this.isCacheFresh(this.cached)) {
      return Promise.resolve(this.withRegistration(this.cached.value))
    }
    if (this.inflight) return this.inflight

    const request = this.inspectFresh().finally(() => {
      if (this.inflight === request) this.inflight = null
    })
    this.inflight = request
    return request
  }

  async discoverHostname(): Promise<string> {
    const status = parseTailscaleStatus(await this.readJson(["status", "--json"]))
    if (status.state === "unavailable") throw new ManagerError("TAILSCALE_UNAVAILABLE", "找不到已安裝的 Tailscale CLI；請確認安裝後重試。", 503)
    if (status.state === "needs-login") throw new ManagerError("TAILSCALE_NEEDS_LOGIN", "Tailscale 尚未登入；請先在 Tailscale 登入後重試。", 503)
    if (status.state !== "connected") throw new ManagerError("TAILSCALE_OFFLINE", "無法確認 Tailscale 已連線；請確認狀態後重試。", 503)
    if (!status.dnsName) throw new ManagerError("TAILSCALE_DNS_INVALID", "Tailscale Self.DNSName 不是有效的 tailnet host。", 503)
    return status.dnsName
  }

  register(trigger: "startup" | "manual"): Promise<ConnectivityInfo> {
    if (this.registrationInflight) return this.registrationInflight
    if (!this.options.remoteAccess) return this.get()

    this.registration = { state: "registering", trigger, diagnostic: null }
    const request = this.runRegistration(trigger).finally(() => {
      if (this.registrationInflight === request) this.registrationInflight = null
    })
    this.registrationInflight = request
    return request
  }

  async close(): Promise<void> {
    this.closing = true
    await this.registrationInflight
  }

  async ensureRemoteOriginForPort(port: number): Promise<void> {
    if (!this.options.remoteAccess) throw new Error("遠端存取未設定。")
    await this.get()
    this.remoteOriginForPort(port)
  }

  remoteOriginForPort(port: number): string {
    if (!this.options.remoteAccess || !this.remoteReady || !this.cached || !this.isCacheFresh(this.cached)) {
      throw new Error("Tailscale Serve 映射尚未通過驗證。")
    }
    return this.options.remoteAccess.instanceOrigin(port)
  }

  private async runRegistration(trigger: "startup" | "manual"): Promise<ConnectivityInfo> {
    const remote = this.options.remoteAccess
    if (!remote) return this.get()
    const deadlineAt = this.monotonicNow() + this.registrationDeadlineMs
    const attemptedPorts = new Set<number>()

    while (true) {
      if (this.closing) return this.registrationStopped(trigger)
      if (this.deadlineExpired(deadlineAt)) return this.registrationTimedOut(trigger)

      const snapshot = await this.readSnapshot(deadlineAt)
      if (this.closing) return this.registrationStopped(trigger, snapshot.info)
      if (snapshot.deadlineExpired || this.deadlineExpired(deadlineAt)) {
        return this.registrationTimedOut(trigger, snapshot.info)
      }
      // 若較新的 read 已先完成，這份 preflight 也已過期；重新讀取後才可 mutation。
      if (!this.store(snapshot)) continue

      const plan = planMappings(snapshot.serveResult, this.targets())
      const diagnostic = registrationPreflightDiagnostic(
        snapshot.info,
        new URL(remote.publicManagerOrigin).hostname,
      ) ?? plan.diagnostic
      if (diagnostic) return this.registrationFailed(trigger, diagnostic, snapshot.info)

      const target = plan.missing[0]
      if (!target) {
        const current = this.cached?.value ?? snapshot.info
        if (!isRemoteReady(current)) {
          return this.registrationFailed(trigger, {
            code: "VERIFICATION_FAILED",
            message: "Tailscale Serve 設定後未通過完整驗證。",
            nextStep: "請檢查 Serve status 是否完整對應所有 OMW ports，且未啟用 Funnel。",
          }, current)
        }
        this.registration = { state: "verified", trigger, diagnostic: null }
        this.remoteReady = true
        return this.withRegistration(current)
      }
      if (attemptedPorts.has(target.publicPort)) {
        return this.registrationFailed(trigger, {
          code: "VERIFICATION_FAILED",
          message: "Tailscale Serve 設定後未通過完整驗證。",
          nextStep: "請檢查 Serve status 是否完整對應所有 OMW ports，且未啟用 Funnel。",
        }, snapshot.info)
      }

      // 每次只寫一個 target；下一筆前重新讀取全部 target，避免覆寫已觀測到的外部變更。
      if (this.closing) return this.registrationStopped(trigger, snapshot.info)
      if (this.deadlineExpired(deadlineAt)) return this.registrationTimedOut(trigger, snapshot.info)
      attemptedPorts.add(target.publicPort)
      const mutation = await this.run([
        "serve",
        "--bg",
        "--yes",
        `--https=${target.publicPort}`,
        target.loopbackOrigin,
      ], deadlineAt)
      if (mutation === "deadline") return this.registrationTimedOut(trigger, snapshot.info)
      if (mutation === "failed") {
        return this.registrationFailed(trigger, {
          code: "COMMAND_FAILED",
          message: "Tailscale Serve 設定失敗。",
          nextStep: "請確認目前使用者可管理 Tailscale Serve，然後再重試。",
        }, snapshot.info)
      }
    }
  }

  private registrationStopped(trigger: "startup" | "manual", info = this.safeInfo()): ConnectivityInfo {
    return this.registrationFailed(trigger, {
      code: "REGISTRATION_STOPPED",
      message: "Manager 正在關閉，已停止新增 Tailscale Serve 映射。",
      nextStep: "重新啟動 Manager 後再重試。",
    }, info)
  }

  private registrationTimedOut(trigger: "startup" | "manual", info = this.safeInfo()): ConnectivityInfo {
    return this.registrationFailed(trigger, {
      code: "REGISTRATION_TIMEOUT",
      message: "Tailscale 自動註冊未能在 30 秒內完成。",
      nextStep: "檢查本機 Tailscale 回應速度後再重試；已成功的安全映射會保留。",
    }, info)
  }

  private registrationFailed(trigger: "startup" | "manual", diagnostic: Diagnostic, info: ConnectivityInfo): ConnectivityInfo {
    this.registration = { state: "failed", trigger, diagnostic }
    this.remoteReady = false
    return this.withRegistration(info)
  }

  private async inspectFresh(): Promise<ConnectivityInfo> {
    const snapshot = await this.readSnapshot()
    if (!this.store(snapshot)) return this.withRegistration(this.cached?.value ?? snapshot.info)
    if (this.remoteReady) {
      this.registration = { state: "verified", trigger: this.registration.trigger, diagnostic: null }
    } else if (this.registration.state === "verified") {
      this.registration = { state: "idle", trigger: null, diagnostic: null }
    }
    return this.withRegistration(snapshot.info)
  }

  private async readSnapshot(deadlineAt?: number): Promise<Snapshot> {
    const generation = ++this.nextSnapshotGeneration
    const statusRequest = this.readJson(["status", "--json"], deadlineAt)
    const serveRequest = this.options.remoteAccess
      ? this.readJson(["serve", "status", "--json"], deadlineAt)
      : Promise.resolve<CommandResult>({ state: "unknown" })
    const [statusResult, serveResult] = await Promise.all([statusRequest, serveRequest])
    const tailscale = parseTailscaleStatus(statusResult)
    const serve = this.options.remoteAccess
      ? parseServeStatus(serveResult, this.options.remoteAccess, this.options.portPool, tailscale.dnsName)
      : {
          state: "not-configured" as const,
          managerMapped: null,
          mappedInstancePorts: null,
          expectedInstancePorts: poolSize(this.options.portPool),
          funnel: "unknown" as const,
        }
    const ready = tailscale.state === "connected" && serve.state === "verified" && serve.funnel === "disabled"
    const info: ConnectivityInfo = {
      checkedAt: this.now().toISOString(),
      mode: this.options.remoteAccess ? "tailnet" : "loopback",
      manager: {
        localUrl: `http://127.0.0.1:${this.options.managerPort}`,
        publicUrl: ready ? this.options.remoteAccess?.publicManagerOrigin ?? null : null,
      },
      tailscale,
      serve,
      registration: this.registration,
      nodeVersion: process.version,
    }
    return {
      generation,
      info,
      serveResult,
      deadlineExpired: statusResult.state === "deadline" || serveResult.state === "deadline",
    }
  }

  private targets(): MappingTarget[] {
    const remote = this.options.remoteAccess
    if (!remote) return []
    const publicUrl = new URL(remote.publicManagerOrigin)
    const hostname = publicUrl.hostname
    const managerPort = Number(publicUrl.port || "443")
    const targets = [{ hostname, publicPort: managerPort, loopbackOrigin: remote.expectedLoopbackOrigin }]
    for (let port = this.options.portPool.min; port <= this.options.portPool.max; port += 1) {
      targets.push({ hostname, publicPort: port, loopbackOrigin: `http://127.0.0.1:${port}` })
    }
    return targets
  }

  private store(snapshot: Snapshot): boolean {
    if (snapshot.generation < this.storedSnapshotGeneration) return false
    this.storedSnapshotGeneration = snapshot.generation
    this.remoteReady = isRemoteReady(snapshot.info)
    this.cached = { storedAtMonotonicMs: this.monotonicNow(), value: snapshot.info }
    return true
  }

  private isCacheFresh(cache: NonNullable<ConnectivityService["cached"]>): boolean {
    const age = this.monotonicNow() - cache.storedAtMonotonicMs
    return age >= 0 && age < CACHE_TTL_MS
  }

  private deadlineExpired(deadlineAt: number): boolean {
    return this.monotonicNow() >= deadlineAt
  }

  private safeInfo(): ConnectivityInfo {
    if (this.cached) return this.cached.value
    return {
      checkedAt: this.now().toISOString(),
      mode: this.options.remoteAccess ? "tailnet" : "loopback",
      manager: {
        localUrl: `http://127.0.0.1:${this.options.managerPort}`,
        publicUrl: null,
      },
      tailscale: { state: "unknown", dnsName: null, version: null },
      serve: {
        state: this.options.remoteAccess ? "unknown" : "not-configured",
        managerMapped: null,
        mappedInstancePorts: null,
        expectedInstancePorts: poolSize(this.options.portPool),
        funnel: "unknown",
      },
      registration: this.registration,
      nodeVersion: process.version,
    }
  }

  private withRegistration(value: ConnectivityInfo): ConnectivityInfo {
    return {
      ...value,
      manager: { ...value.manager, publicUrl: this.remoteReady ? this.options.remoteAccess?.publicManagerOrigin ?? null : null },
      registration: this.registration,
    }
  }

  private async readJson(args: readonly string[], deadlineAt?: number): Promise<CommandResult> {
    const options = this.commandOptions(deadlineAt)
    if (!options) return { state: "deadline" }
    try {
      const result = await this.runner.execFile(this.options.executable, args, options)
      return { state: "ok", value: JSON.parse(result.stdout) as unknown }
    } catch (error) {
      return { state: isMissingExecutable(error) ? "missing" : "unknown" }
    }
  }

  private async run(args: readonly string[], deadlineAt: number): Promise<"ok" | "failed" | "deadline"> {
    const options = this.commandOptions(deadlineAt)
    if (!options) return "deadline"
    try {
      await this.runner.execFile(this.options.executable, args, options)
      return this.deadlineExpired(deadlineAt) ? "deadline" : "ok"
    } catch {
      return this.deadlineExpired(deadlineAt) ? "deadline" : "failed"
    }
  }

  private commandOptions(deadlineAt?: number): CommandOptions | null {
    if (deadlineAt === undefined) return COMMAND_OPTIONS
    const remaining = deadlineAt - this.monotonicNow()
    // Node 的 timeout=0 代表停用 timeout；budget 用完時必須拒絕啟動 command。
    if (remaining <= 0) return null
    return { ...COMMAND_OPTIONS, timeout: Math.max(1, Math.min(COMMAND_OPTIONS.timeout, Math.ceil(remaining))) }
  }
}

export function tailscaleExecutable(environment: NodeJS.ProcessEnv): string {
  return environment.OMW_TAILSCALE_EXECUTABLE
    ?? path.join(environment.ProgramFiles ?? "C:\\Program Files", "Tailscale", "tailscale.exe")
}

const nodeCommandRunner: CommandRunner = {
  execFile(executable, args, options) {
    return new Promise((resolve, reject) => {
      execFile(executable, [...args], options, (error, stdout) => {
        if (error) reject(error)
        else resolve({ stdout })
      })
    })
  },
}

function registrationPreflightDiagnostic(info: ConnectivityInfo, expectedHostname: string): Diagnostic | null {
  if (info.tailscale.state === "unavailable") return diagnostic("TAILSCALE_UNAVAILABLE", "找不到已安裝的 Tailscale CLI。", "請確認已安裝 Tailscale，或設定 OMW_TAILSCALE_EXECUTABLE。")
  if (info.tailscale.state === "needs-login") return diagnostic("TAILSCALE_NEEDS_LOGIN", "Tailscale 尚未登入。", "請先在 Tailscale 完成登入，再回到 OMW 重試。")
  if (info.tailscale.state === "offline") return diagnostic("TAILSCALE_OFFLINE", "Tailscale 目前離線。", "請先讓已登入的 Tailscale 恢復連線，再回到 OMW 重試。")
  if (info.tailscale.state !== "connected") return diagnostic("TAILSCALE_UNKNOWN", "無法確認 Tailscale 連線狀態。", "請執行 Tailscale 狀態檢查，確認 CLI 可在有限時間內回應。")
  if (info.tailscale.dnsName !== expectedHostname) return diagnostic("DNS_MISMATCH", "目前 Tailscale node 與 OMW 設定的 DNS host 不一致。", "請核對 OMW_TAILNET_DNS_HOST；OMW 不會替其他 node 建立 mapping。")
  return null
}

function planMappings(result: CommandResult, targets: MappingTarget[]): { missing: MappingTarget[]; diagnostic: Diagnostic | null } {
  if (result.state !== "ok" || !isRecord(result.value)) {
    return { missing: [], diagnostic: diagnostic("SERVE_STATUS_UNKNOWN", "無法讀取 Tailscale Serve 設定。", "請確認 tailscale serve status --json 可在有限時間內回應。") }
  }
  const web = optionalRecord(result.value.Web)
  const tcp = optionalRecord(result.value.TCP)
  const allowFunnel = optionalRecord(result.value.AllowFunnel)
  const foreground = optionalRecord(result.value.Foreground)
  if (!web || !tcp || !allowFunnel || !foreground || Object.keys(foreground).length > 0
    || !validWebMap(web) || !validTcpMap(tcp) || !Object.values(allowFunnel).every((value) => typeof value === "boolean")) {
    return { missing: [], diagnostic: diagnostic("SERVE_STATUS_UNKNOWN", "Tailscale Serve 設定格式無法安全判讀。", "請檢查 Serve status，移除目標 port 的 foreground 或未知設定後再重試。") }
  }

  const missing: MappingTarget[] = []
  for (const target of targets) {
    const webEntry = web[`${target.hostname}:${target.publicPort}`]
    const tcpEntry = tcp[String(target.publicPort)]
    const funnel = allowFunnel[`${target.hostname}:${target.publicPort}`]
    if (funnel === true) {
      return { missing: [], diagnostic: diagnostic("FUNNEL_ENABLED", "目標 port 已啟用 Funnel。", "請由管理者核對並關閉該 Funnel；OMW 不會自動修改。") }
    }
    if (webEntry === undefined && tcpEntry === undefined) {
      missing.push(target)
      continue
    }
    if (!mappingMatches(web, tcp, target.hostname, target.publicPort, target.loopbackOrigin, true)) {
      return { missing: [], diagnostic: diagnostic("TARGET_CONFLICT", "目標 HTTPS port 已有不相容或額外的 Serve 設定。", "請檢查該 port；OMW 不會覆寫、重設或移除既有 mapping。") }
    }
  }
  return { missing, diagnostic: null }
}

function diagnostic(code: string, message: string, nextStep: string): Diagnostic {
  return { code, message, nextStep }
}

function isRemoteReady(info: ConnectivityInfo): boolean {
  return info.mode === "tailnet"
    && info.tailscale.state === "connected"
    && info.serve.state === "verified"
    && info.serve.funnel === "disabled"
}

function parseTailscaleStatus(result: CommandResult): ConnectivityInfo["tailscale"] {
  if (result.state === "missing") return { state: "unavailable", dnsName: null, version: null }
  if (result.state !== "ok" || !isRecord(result.value)) return { state: "unknown", dnsName: null, version: null }

  const self = isRecord(result.value.Self) ? result.value.Self : null
  const dnsName = safeDnsName(self?.DNSName)
  const version = safeVersion(result.value.Version)
  const backendState = result.value.BackendState
  const online = self?.Online
  const state = backendState === "NeedsLogin"
    ? "needs-login"
    : backendState === "Stopped" || online === false
      ? "offline"
      : backendState === "Running" && online === true
        ? "connected"
        : "unknown"
  return { state, dnsName, version }
}

function parseServeStatus(
  result: CommandResult,
  remoteAccess: RemoteAccessConfig,
  portPool: InstancePortPoolConfig,
  actualDnsName: string | null,
): ConnectivityInfo["serve"] {
  const expectedInstancePorts = poolSize(portPool)
  const unknown = {
    state: "unknown" as const,
    managerMapped: null,
    mappedInstancePorts: null,
    expectedInstancePorts,
    funnel: "unknown" as const,
  }
  if (result.state !== "ok" || !isRecord(result.value)) return unknown

  const web = optionalRecord(result.value.Web)
  const tcp = optionalRecord(result.value.TCP)
  const allowFunnel = optionalRecord(result.value.AllowFunnel)
  const foreground = optionalRecord(result.value.Foreground)
  if (!web || !tcp || !allowFunnel || !foreground) return unknown
  if (Object.keys(foreground).length > 0) return unknown
  if (!validWebMap(web) || !validTcpMap(tcp) || !Object.values(allowFunnel).every((value) => typeof value === "boolean")) return unknown

  const publicUrl = new URL(remoteAccess.publicManagerOrigin)
  const publicHost = publicUrl.hostname
  const managerPort = Number(publicUrl.port || "443")
  const managerMapped = mappingMatches(web, tcp, publicHost, managerPort, remoteAccess.expectedLoopbackOrigin, true)
  let mappedInstancePorts = 0
  for (let port = portPool.min; port <= portPool.max; port += 1) {
    if (mappingMatches(web, tcp, publicHost, port, `http://127.0.0.1:${port}`, true)) mappedInstancePorts += 1
  }

  const allMappingsMatch = managerMapped && mappedInstancePorts === expectedInstancePorts
  const hostnameMatches = actualDnsName === publicHost
  const state = !allMappingsMatch
    ? "mismatch"
    : actualDnsName === null
      ? "unknown"
      : hostnameMatches
        ? "verified"
        : "mismatch"
  return {
    state,
    managerMapped,
    mappedInstancePorts,
    expectedInstancePorts,
    funnel: targetPorts(remoteAccess, portPool)
      .some((port) => allowFunnel[`${publicHost}:${port}`] === true) ? "enabled" : "disabled",
  }
}

function targetPorts(remoteAccess: RemoteAccessConfig, portPool: InstancePortPoolConfig): number[] {
  const ports = [Number(new URL(remoteAccess.publicManagerOrigin).port || "443")]
  for (let port = portPool.min; port <= portPool.max; port += 1) ports.push(port)
  return ports
}

function mappingMatches(web: JsonRecord, tcp: JsonRecord, hostname: string, port: number, expectedProxy: string, strict = false): boolean {
  const webEntry = web[`${hostname}:${port}`]
  const tcpEntry = tcp[String(port)]
  if (!isRecord(webEntry) || !isRecord(webEntry.Handlers) || !isRecord(webEntry.Handlers["/"]) || !isRecord(tcpEntry)) return false
  const handler = webEntry.Handlers["/"]
  if (strict && (Object.keys(webEntry).some((key) => key !== "Handlers")
    || Object.keys(webEntry.Handlers).length !== 1
    || Object.keys(handler).some((key) => key !== "Proxy")
    || Object.keys(tcpEntry).some((key) => key !== "HTTPS"))) return false
  return handler.Proxy === expectedProxy
    && !hasNonEmptyString(handler.Path)
    && !hasNonEmptyString(handler.Text)
    && !hasNonEmptyString(handler.Redirect)
    && tcpEntry.HTTPS === true
    && tcpEntry.HTTP !== true
    && !hasNonEmptyString(tcpEntry.TCPForward)
    && !hasNonEmptyString(tcpEntry.TerminateTLS)
}

function validWebMap(web: JsonRecord): boolean {
  return Object.values(web).every((entry) => {
    if (!isRecord(entry) || !isRecord(entry.Handlers)) return false
    return Object.values(entry.Handlers).every((handler) => isRecord(handler)
      && optionalString(handler.Proxy)
      && optionalString(handler.Path)
      && optionalString(handler.Text)
      && optionalString(handler.Redirect))
  })
}

function validTcpMap(tcp: JsonRecord): boolean {
  return Object.values(tcp).every((entry) => isRecord(entry)
    && optionalBoolean(entry.HTTPS)
    && optionalBoolean(entry.HTTP)
    && optionalString(entry.TCPForward)
    && optionalString(entry.TerminateTLS))
}

function optionalRecord(value: unknown): JsonRecord | null {
  return value === undefined ? {} : isRecord(value) ? value : null
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string"
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean"
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0
}

function safeDnsName(value: unknown): string | null {
  if (typeof value !== "string") return null
  const candidate = value.endsWith(".") ? value.slice(0, -1) : value
  return candidate === candidate.toLowerCase()
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.ts\.net$/.test(candidate)
    ? candidate
    : null
}

function safeVersion(value: unknown): string | null {
  return typeof value === "string" && /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/.test(value) ? value : null
}

function poolSize(pool: InstancePortPoolConfig): number {
  return pool.max - pool.min + 1
}

function isMissingExecutable(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT"
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
