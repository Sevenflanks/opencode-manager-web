import { execFile } from "node:child_process"
import path from "node:path"
import process from "node:process"
import type { ConnectivityInfo } from "@omw/contracts"
import type { InstancePortPoolConfig, RemoteAccessConfig } from "./config.js"

const COMMAND_OPTIONS = {
  encoding: "utf8",
  maxBuffer: 1_048_576,
  shell: false,
  timeout: 2_500,
  windowsHide: true,
} as const
const CACHE_TTL_MS = 5_000

export interface ReadonlyCommandRunner {
  execFile(
    executable: string,
    args: readonly string[],
    options: typeof COMMAND_OPTIONS,
  ): Promise<{ stdout: string }>
}

export interface ConnectivityOptions {
  managerPort: number
  remoteAccess: RemoteAccessConfig | null
  portPool: InstancePortPoolConfig
  executable: string
  runner?: ReadonlyCommandRunner
  now?: () => Date
}

type CommandResult =
  | { state: "ok"; value: unknown }
  | { state: "missing" | "unknown" }

type JsonRecord = Record<string, unknown>

export class ConnectivityService {
  private readonly runner: ReadonlyCommandRunner
  private readonly now: () => Date
  private cached: { checkedAtMs: number; value: ConnectivityInfo } | null = null
  private inflight: Promise<ConnectivityInfo> | null = null

  constructor(private readonly options: ConnectivityOptions) {
    this.runner = options.runner ?? nodeCommandRunner
    this.now = options.now ?? (() => new Date())
  }

  get(): Promise<ConnectivityInfo> {
    const nowMs = this.now().getTime()
    if (this.cached && nowMs - this.cached.checkedAtMs < CACHE_TTL_MS) return Promise.resolve(this.cached.value)
    if (this.inflight) return this.inflight

    const request = this.inspect().then((value) => {
      this.cached = { checkedAtMs: Date.parse(value.checkedAt), value }
      return value
    }).finally(() => {
      if (this.inflight === request) this.inflight = null
    })
    this.inflight = request
    return request
  }

  private async inspect(): Promise<ConnectivityInfo> {
    const statusRequest = this.readJson(["status", "--json"])
    const serveRequest = this.options.remoteAccess
      ? this.readJson(["serve", "status", "--json"])
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

    return {
      checkedAt: this.now().toISOString(),
      mode: this.options.remoteAccess ? "tailnet" : "loopback",
      manager: {
        localUrl: `http://127.0.0.1:${this.options.managerPort}`,
        publicUrl: this.options.remoteAccess?.publicManagerOrigin ?? null,
      },
      tailscale,
      serve,
      nodeVersion: process.version,
    }
  }

  private async readJson(args: readonly string[]): Promise<CommandResult> {
    try {
      const result = await this.runner.execFile(this.options.executable, args, COMMAND_OPTIONS)
      return { state: "ok", value: JSON.parse(result.stdout) as unknown }
    } catch (error) {
      return { state: isMissingExecutable(error) ? "missing" : "unknown" }
    }
  }
}

export function tailscaleExecutable(environment: NodeJS.ProcessEnv): string {
  return environment.OMW_TAILSCALE_EXECUTABLE
    ?? path.join(environment.ProgramFiles ?? "C:\\Program Files", "Tailscale", "tailscale.exe")
}

const nodeCommandRunner: ReadonlyCommandRunner = {
  execFile(executable, args, options) {
    return new Promise((resolve, reject) => {
      execFile(executable, [...args], options, (error, stdout) => {
        if (error) reject(error)
        else resolve({ stdout })
      })
    })
  },
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
  const managerMapped = mappingMatches(web, tcp, publicHost, managerPort, remoteAccess.expectedLoopbackOrigin)
  let mappedInstancePorts = 0
  for (let port = portPool.min; port <= portPool.max; port += 1) {
    if (mappingMatches(web, tcp, publicHost, port, `http://127.0.0.1:${port}`)) mappedInstancePorts += 1
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
    funnel: Object.values(allowFunnel).some((value) => value === true) ? "enabled" : "disabled",
  }
}

function mappingMatches(web: JsonRecord, tcp: JsonRecord, hostname: string, port: number, expectedProxy: string): boolean {
  const webEntry = web[`${hostname}:${port}`]
  const tcpEntry = tcp[String(port)]
  if (!isRecord(webEntry) || !isRecord(webEntry.Handlers) || !isRecord(webEntry.Handlers["/"]) || !isRecord(tcpEntry)) return false
  const handler = webEntry.Handlers["/"]
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
