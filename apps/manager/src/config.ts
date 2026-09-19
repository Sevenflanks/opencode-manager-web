export interface RemoteAccessConfig {
  publicManagerOrigin: string
  expectedLoopbackOrigin: string
  instancePortMin: number
  instancePortMax: number
  instanceOrigin(port: number): string
}

export interface InstancePortPoolConfig {
  min: number
  max: number
}

export function readRemoteAccessConfig(environment: NodeJS.ProcessEnv, managerPort: number): RemoteAccessConfig | null {
  if (environment.OMW_REMOTE_ACCESS !== "1") return null

  const expectedLoopbackOrigin = `http://127.0.0.1:${managerPort}`
  if (environment.OMW_EXPECTED_LOOPBACK_ORIGIN !== expectedLoopbackOrigin) {
    throw new Error(`OMW_EXPECTED_LOOPBACK_ORIGIN 必須明確等於 ${expectedLoopbackOrigin}。`)
  }
  const hostname = tailnetDnsHost(environment.OMW_TAILNET_DNS_HOST)
  const managerPublicPort = requiredPort(environment.OMW_MANAGER_PUBLIC_HTTPS_PORT, "OMW_MANAGER_PUBLIC_HTTPS_PORT")
  const instancePortMin = requiredPort(environment.OMW_INSTANCE_PUBLIC_PORT_MIN, "OMW_INSTANCE_PUBLIC_PORT_MIN")
  const instancePortMax = requiredPort(environment.OMW_INSTANCE_PUBLIC_PORT_MAX, "OMW_INSTANCE_PUBLIC_PORT_MAX")
  if (instancePortMin > instancePortMax) throw new Error("OpenCode public port range 下限不可大於上限。")
  validatePoolWidth(instancePortMin, instancePortMax)
  if (managerPublicPort >= instancePortMin && managerPublicPort <= instancePortMax) {
    throw new Error("Manager public HTTPS port 不可與 OpenCode instance port range 重疊。")
  }
  if (environment.OMW_REMOTE_MAPPING_READY !== "1") {
    throw new Error("Remote URL 只可在固定 Tailscale Serve mapping 已核對後啟用；請設定 OMW_REMOTE_MAPPING_READY=1。")
  }

  const publicManagerOrigin = httpsOrigin(hostname, managerPublicPort)
  return {
    publicManagerOrigin,
    expectedLoopbackOrigin,
    instancePortMin,
    instancePortMax,
    instanceOrigin(port: number): string {
      if (!Number.isInteger(port) || port < instancePortMin || port > instancePortMax) {
        throw new Error(`Instance port ${port} 不在已核對的 fixed mapping range ${instancePortMin}-${instancePortMax}。`)
      }
      // Approved contract maps each public HTTPS port to the same-numbered loopback port.
      return httpsOrigin(hostname, port)
    },
  }
}

export function readInstancePortPoolConfig(
  environment: NodeJS.ProcessEnv,
  remoteAccess: RemoteAccessConfig | null,
): InstancePortPoolConfig {
  if (remoteAccess) return { min: remoteAccess.instancePortMin, max: remoteAccess.instancePortMax }
  const hasMin = environment.OMW_INSTANCE_PORT_MIN !== undefined
  const hasMax = environment.OMW_INSTANCE_PORT_MAX !== undefined
  if (hasMin !== hasMax) throw new Error("OMW_INSTANCE_PORT_MIN 與 OMW_INSTANCE_PORT_MAX 必須一起設定。")
  const min = hasMin ? requiredPort(environment.OMW_INSTANCE_PORT_MIN, "OMW_INSTANCE_PORT_MIN") : 42_000
  const max = hasMax ? requiredPort(environment.OMW_INSTANCE_PORT_MAX, "OMW_INSTANCE_PORT_MAX") : 42_099
  if (min > max) throw new Error("OpenCode instance port range 下限不可大於上限。")
  validatePoolWidth(min, max)
  return { min, max }
}

function tailnetDnsHost(value: string | undefined): string {
  if (!value || value !== value.toLowerCase() || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.ts\.net$/.test(value)) {
    throw new Error("OMW_TAILNET_DNS_HOST 必須是小寫、無 scheme/path/port 的 tailnet DNS host（*.ts.net）。")
  }
  const url = new URL(`https://${value}`)
  if (url.hostname !== value || url.username || url.password || url.pathname !== "/") throw new Error("OMW_TAILNET_DNS_HOST 無效。")
  return value
}

function requiredPort(value: string | undefined, name: string): number {
  const parsed = Number(value)
  if (!value || !Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error(`${name} 必須是 1 到 65535 的整數。`)
  return parsed
}

function httpsOrigin(hostname: string, port: number): string {
  return new URL(`https://${hostname}:${port}`).origin
}

function validatePoolWidth(min: number, max: number): void {
  if (max - min + 1 > 128) throw new Error("OpenCode instance port range 最多可包含 128 個 ports。")
}
