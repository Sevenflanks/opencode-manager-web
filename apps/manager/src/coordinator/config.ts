import { isIP } from "node:net"
import path from "node:path"
import { workerBrowserCredentials, workerOrigin, workerPort, workerSecret } from "../worker/config.js"

export interface CoordinatorConfig {
  publicOrigin: string
  nativeHostSuffix: string
  allowedCidrs: string[]
  registrationSecret: string
  dataDirectory: string
  healthIntervalMs: number
  healthTimeoutMs: number
  failureThreshold: number
}

function ipv4(value: string): number {
  if (isIP(value) !== 4) throw new Error("需要 literal IPv4。")
  return value.split(".").reduce((sum, octet) => sum * 256 + Number(octet), 0) >>> 0
}

function cidr(value: string): { network: number; mask: number } {
  const parts = value.split("/")
  if (parts.length !== 2 || !/^(?:[1-9]|[12][0-9]|3[0-2])$/.test(parts[1]!)) throw new Error("CIDR 必須限制為 IPv4 /1 至 /32。")
  const network = ipv4(parts[0]!)
  const mask = (0xffffffff << (32 - Number(parts[1]))) >>> 0
  if (((network & mask) >>> 0) !== network) throw new Error("CIDR 必須使用 canonical network address。")
  return { network, mask }
}

export function addressAllowed(address: string, ranges: string[]): boolean {
  try {
    const numeric = ipv4(address)
    // multicast、unspecified、broadcast 不可作 Worker endpoint，即使 operator CIDR 過寬。
    if (numeric === 0 || numeric >= 0xe0000000) return false
    return ranges.some((range) => { const { network, mask } = cidr(range); return ((numeric & mask) >>> 0) === network })
  } catch { return false }
}

export function validateCoordinatorConfig(config: CoordinatorConfig): void {
  workerOrigin(config.publicOrigin, "OMW_PUBLIC_ORIGIN")
  if (!path.isAbsolute(config.dataDirectory)) throw new Error("OMW_DATA_DIR 必須是 absolute path。")
  if (!config.allowedCidrs.length) throw new Error("OMW_COORDINATOR_ALLOWED_CIDRS 必填。")
  config.allowedCidrs.forEach(cidr)
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(config.nativeHostSuffix)
    || config.nativeHostSuffix.length > 190) throw new Error("OMW_COORDINATOR_NATIVE_HOST_SUFFIX 必須是 canonical parent domain。")
  for (const value of [config.healthIntervalMs, config.healthTimeoutMs, config.failureThreshold]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("Health 設定必須是正整數。")
  }
  if (config.healthTimeoutMs > 10_000 || config.healthIntervalMs > 3_600_000 || config.failureThreshold > 100) throw new Error("Health 設定超出 bounded limits。")
}

export async function coordinatorConfig(environment: NodeJS.ProcessEnv) {
  const config: CoordinatorConfig = {
    publicOrigin: workerOrigin(environment.OMW_PUBLIC_ORIGIN, "OMW_PUBLIC_ORIGIN"),
    nativeHostSuffix: environment.OMW_COORDINATOR_NATIVE_HOST_SUFFIX ?? "",
    allowedCidrs: (environment.OMW_COORDINATOR_ALLOWED_CIDRS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
    registrationSecret: await workerSecret(environment, "OMW_COORDINATOR_REGISTRATION_SECRET_FILE", 32),
    dataDirectory: environment.OMW_DATA_DIR ?? "",
    healthIntervalMs: Number(environment.OMW_COORDINATOR_HEALTH_INTERVAL_MS ?? 15_000),
    healthTimeoutMs: Number(environment.OMW_COORDINATOR_HEALTH_TIMEOUT_MS ?? 3_000),
    failureThreshold: Number(environment.OMW_COORDINATOR_HEALTH_FAILURE_THRESHOLD ?? 3),
  }
  validateCoordinatorConfig(config)
  return { config, credentials: await workerBrowserCredentials(environment), port: workerPort(environment.OMW_PORT, 4174),
    healthPort: environment.OMW_HEALTH_PORT === undefined ? undefined : workerPort(environment.OMW_HEALTH_PORT, 4176) }
}
