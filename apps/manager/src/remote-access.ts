import { randomUUID } from "node:crypto"
import { readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import type { ConnectivityInfo } from "@omw/contracts"
import { readRemoteAccessConfig, type RemoteAccessConfig } from "./config.js"
import { ConnectivityService, type ConnectivityOptions } from "./connectivity.js"
import { ManagerError } from "./errors.js"

interface RemoteProfile {
  hostname: string
  managerPublicPort: number
  instancePortMin: number
  instancePortMax: number
}

function profileConfig(value: unknown, managerPort: number): RemoteAccessConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("遠端存取 profile 格式無效。")
  const profile = value as Record<string, unknown>
  if (Object.keys(profile).sort().join(",") !== "hostname,instancePortMax,instancePortMin,managerPublicPort"
    || typeof profile.hostname !== "string"
    || ![profile.managerPublicPort, profile.instancePortMin, profile.instancePortMax].every(Number.isInteger)) {
    throw new Error("遠端存取 profile 格式無效。")
  }
  return readRemoteAccessConfig({
    OMW_REMOTE_ACCESS: "1",
    OMW_EXPECTED_LOOPBACK_ORIGIN: `http://127.0.0.1:${managerPort}`,
    OMW_TAILNET_DNS_HOST: profile.hostname,
    OMW_MANAGER_PUBLIC_HTTPS_PORT: String(profile.managerPublicPort),
    OMW_INSTANCE_PUBLIC_PORT_MIN: String(profile.instancePortMin),
    OMW_INSTANCE_PUBLIC_PORT_MAX: String(profile.instancePortMax),
  }, managerPort)!
}

export class RemoteProfileStore {
  private readonly filename: string
  constructor(dataDirectory: string) {
    this.filename = path.join(dataDirectory, "remote-access.json")
  }

  async load(managerPort: number): Promise<RemoteAccessConfig | null> {
    try {
      return profileConfig(JSON.parse(await readFile(this.filename, "utf8")), managerPort)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw error
    }
  }

  async save(profile: RemoteProfile): Promise<void> {
    const temporary = `${this.filename}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(profile), { flag: "wx" })
      await rename(temporary, this.filename)
    } finally {
      await rm(temporary, { force: true })
    }
  }
}

export async function startupRemoteAccess(
  environment: NodeJS.ProcessEnv, managerPort: number, store: Pick<RemoteProfileStore, "load">,
): Promise<RemoteAccessConfig | null> {
  if (environment.OMW_REMOTE_ACCESS === "0") return null
  if (environment.OMW_REMOTE_ACCESS === "1") return readRemoteAccessConfig(environment, managerPort)
  if (environment.OMW_REMOTE_ACCESS !== undefined) throw new Error("OMW_REMOTE_ACCESS 只接受 0 或 1。")
  return store.load(managerPort)
}

// active config 是 auth、authority 與 URL gate 的同一份同步來源；Serve 寫入只能發生在切換之後。
export class RemoteAccessController {
  private delegate: ConnectivityService
  private active: RemoteAccessConfig | null
  private enabling: Promise<ConnectivityInfo> | null = null
  private closing = false

  constructor(private readonly options: ConnectivityOptions & {
    disabled: boolean
    store: Pick<RemoteProfileStore, "save">
  }) {
    this.active = options.remoteAccess
    this.delegate = new ConnectivityService(options)
  }

  get config(): RemoteAccessConfig | null { return this.active }

  async get(): Promise<ConnectivityInfo> {
    const delegate = this.delegate
    const info = await delegate.get()
    // 切換前的慢速 snapshot 不得蓋回 loopback 狀態。
    if (delegate !== this.delegate) return this.get()
    return { ...info, remoteAccess: this.options.disabled ? "disabled" : this.active ? "enabled" : "available" }
  }

  async register(trigger: "startup" | "manual"): Promise<ConnectivityInfo> {
    await this.delegate.register(trigger)
    return this.get()
  }

  enable(): Promise<ConnectivityInfo> {
    if (this.closing) return Promise.reject(new ManagerError("REMOTE_ENABLE_STOPPED", "Manager 正在關閉。", 503))
    if (this.options.disabled) return Promise.reject(new ManagerError("REMOTE_ENABLE_DISABLED", "OMW_REMOTE_ACCESS=0 已明確停用遠端存取。", 409))
    if (this.enabling) return this.enabling
    if (this.active) return this.get()
    const request = this.activate().finally(() => { if (this.enabling === request) this.enabling = null })
    this.enabling = request
    return request
  }

  remoteOriginForPort(port: number): string | null {
    return this.active ? this.delegate.remoteOriginForPort(port) : null
  }

  async ensureRemoteOriginForPort(port: number): Promise<void> {
    if (this.active) await this.delegate.ensureRemoteOriginForPort(port)
  }

  async close(): Promise<void> {
    this.closing = true
    await this.delegate.close()
    await this.enabling?.catch(() => undefined)
  }

  private async activate(): Promise<ConnectivityInfo> {
    const hostname = await this.delegate.discoverHostname()
    const profile: RemoteProfile = {
      hostname, managerPublicPort: this.options.managerPort,
      instancePortMin: this.options.portPool.min, instancePortMax: this.options.portPool.max,
    }
    let config: RemoteAccessConfig
    try { config = profileConfig(profile, this.options.managerPort) } catch {
      throw new ManagerError("REMOTE_PROFILE_INVALID", "目前 Manager port 或 Instance pool 不符合固定 Tailnet mapping 規則；請檢查埠號衝突與範圍設定。", 409)
    }
    if (this.closing) throw new ManagerError("REMOTE_ENABLE_STOPPED", "Manager 正在關閉。", 503)
    try { await this.options.store.save(profile) } catch {
      throw new ManagerError("REMOTE_PROFILE_SAVE_FAILED", "無法保存遠端存取設定；尚未啟用，請確認資料目錄可寫入後重試。", 500)
    }
    if (this.closing) throw new ManagerError("REMOTE_ENABLE_STOPPED", "Manager 正在關閉；已保存設定會於下次啟動套用。", 503)
    // 保存失敗不可改 policy；保存成功後同步替換，不能在 auth 與 mapping gate 之間 await。
    this.delegate = new ConnectivityService({ ...this.options, remoteAccess: config })
    this.active = config
    return this.register("manual")
  }
}
