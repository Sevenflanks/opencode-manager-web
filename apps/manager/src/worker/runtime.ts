import { OpenCodeRuntime } from "../agents/opencode/runtime.js"
import type { InstanceRecord } from "../repository.js"
import type { InspectResult, LaunchResult, StopResult } from "../runtime.js"
import { ManagerError } from "../errors.js"
import type { DirectoryPort } from "../directory.js"
import type { DirectoryListing } from "@omw/contracts"

export interface WorkerRuntimeOptions {
  controlOrigin: string
  token: string
  nativeOrigin: string
  fetch?: typeof fetch
}

// 共用 OpenCode session/readiness/SSE 投影；只有程序 authority 與 HTTP transport 改由 supervisor 持有。
export class WorkerRuntime extends OpenCodeRuntime {
  private readonly options: WorkerRuntimeOptions
  private readonly attempts = new Map<string, string>()
  readonly directories: DirectoryPort = {
    resolve: async (input) => (await this.directoryRequest<{ directory: string }>("resolve", input)).directory,
    browse: async (input) => await this.directoryRequest<DirectoryListing>("browse", input),
  }
  constructor(options: WorkerRuntimeOptions) {
    const transport: typeof fetch = async (url, init) => {
      const headers = new Headers(init?.headers)
      headers.set("authorization", `Bearer ${options.token}`)
      return (options.fetch ?? fetch)(url, { ...init, headers, redirect: "error" })
    }
    super({ executable: process.execPath, dataDirectory: "", http: {
      fetch: transport,
      endpoint(value) {
        const url = new URL(value)
        if (url.origin !== options.controlOrigin || url.username || url.password || url.search || url.hash
          || !/^\/runtime\/[a-zA-Z0-9-]+\/[a-zA-Z0-9-]+$/.test(url.pathname)) throw new ManagerError("UNTRUSTED_INSTANCE_ENDPOINT", "Worker endpoint 不屬於指定 execution supervisor。", 409)
        return value
      },
    } })
    this.options = options
  }

  private async executionRequest(pathname: string, body?: unknown): Promise<Response> {
    try {
      return await (this.options.fetch ?? fetch)(`${this.options.controlOrigin}${pathname}`, {
        headers: { authorization: `Bearer ${this.options.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
        // Start 最多 30s readiness + 5s owned cleanup；client deadline 不可先切斷確定結果。
        signal: AbortSignal.timeout(pathname === "/v1/start" ? 40_000 : 8_000), redirect: "error",
      })
    } catch {
      // 目錄解析先於 slot 配置；連線中斷也必須以 unknown authority 拒絕，不可漏成 generic 500。
      // 不附原始 transport error，避免 control endpoint／credentials 進入公開回應。
      throw new ManagerError("WORKER_CAPACITY_UNAVAILABLE", "Execution supervisor 無法連線；Worker capacity 無法確認。", 409)
    }
  }

  private async control<T>(pathname: string, body?: unknown): Promise<T> {
    const response = await this.executionRequest(pathname, body)
    if (!response.ok) throw new ManagerError("EXECUTION_REJECTED", `Execution supervisor 拒絕操作（HTTP ${response.status}）。`, response.status === 409 ? 409 : 502)
    return await response.json() as T
  }

  private async directoryRequest<T>(operation: "resolve" | "browse", input: string): Promise<T> {
    if (typeof input !== "string" || !input.trim()) throw new ManagerError("DIRECTORY_REQUIRED", "請提供目錄路徑。", 400)
    const response = await this.executionRequest(`/v1/directories/${operation}?directory=${encodeURIComponent(input)}`)
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: { code?: string; details?: { reason?: string } } } | null
      if (response.status === 400 && body?.error?.code === "DIRECTORY_NOT_ACCESSIBLE") {
        const reason = body.error.details?.reason
        throw new ManagerError("DIRECTORY_NOT_ACCESSIBLE", "Execution 目錄不存在、不是目錄或無法存取。", 400,
          { reason: ["NOT_FOUND", "NOT_DIRECTORY"].includes(reason ?? "") ? reason : "NOT_ACCESSIBLE" })
      }
      if (response.status === 400 && body?.error?.code === "DIRECTORY_REQUIRED") throw new ManagerError("DIRECTORY_REQUIRED", "請提供目錄路徑。", 400)
      throw new ManagerError("EXECUTION_REJECTED", "Execution 目錄服務無法使用。", 502)
    }
    return await response.json() as T
  }

  async allocationScope(): Promise<{ scope: string; state: "available" | "occupied" | "unknown" }> {
    const info = await this.control<{ epoch: string; capacity: string }>("/v1/execution")
    if (typeof info.epoch !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(info.epoch)
      || !["available", "occupied", "unknown"].includes(info.capacity)) throw new ManagerError("EXECUTION_IDENTITY_INVALID", "Execution scope 無法核對。", 502)
    return { scope: info.epoch, state: info.capacity as "available" | "occupied" | "unknown" }
  }

  override async launch(directory: string, _port: number, instanceId: string, allocationScope?: string): Promise<LaunchResult> {
    // 使用配置 slot 時的同一 authority；中途換 epoch 必須讓 supervisor 拒絕，不能重綁本次 allocation。
    const epoch = allocationScope ?? (await this.allocationScope()).scope
    this.attempts.set(instanceId, epoch)
    const launch = await this.control<LaunchResult>("/v1/start", { epoch, instanceId, directory })
    if (launch.instanceId !== instanceId || launch.creationTimeTicks !== epoch || launch.directory !== directory) throw new ManagerError("EXECUTION_IDENTITY_INVALID", "Supervisor 回傳非本次啟動身分。", 502)
    return { ...launch, endpoint: `${this.options.controlOrigin}/runtime/${epoch}/${instanceId}` }
  }

  override async adoptLocal(): Promise<LaunchResult> {
    throw new ManagerError("WORKER_UNSUPPORTED", "Worker 不支援本機 launcher／TUI Wrap。", 409)
  }

  override async inspect(instance: InstanceRecord | LaunchResult): Promise<InspectResult> {
    try { return await this.control<InspectResult>("/v1/inspect", identity(instance)) }
    catch { return { processState: "unknown", running: false, matched: false, portOwnerMatched: false, portOwnedByOther: false } }
  }

  override async stop(instance: InstanceRecord): Promise<StopResult> {
    try { return await this.control<StopResult>("/v1/stop", identity(instance)) }
    catch { return { stopped: false, reason: "execution unreachable or exact identity rejected" } }
  }

  override async cleanupLaunch(instanceId: string): Promise<StopResult> {
    const epoch = this.attempts.get(instanceId)
    if (!epoch) return { stopped: false, reason: "same-run launch authority unavailable" }
    try { return await this.control<StopResult>("/v1/stop", { epoch, instanceId }) }
    catch { return { stopped: false, reason: "execution cleanup unconfirmed" } }
  }

  override openUrl(instance: Pick<InstanceRecord, "endpoint" | "projectDirectory" | "port">, sessionId?: string): string {
    const directory = Buffer.from(instance.projectDirectory, "utf8").toString("base64url")
    return `${this.options.nativeOrigin}/${directory}/session${sessionId ? `/${encodeURIComponent(sessionId)}` : ""}`
  }
}

function identity(instance: InstanceRecord | LaunchResult) {
  return { epoch: instance.creationTimeTicks, instanceId: "id" in instance ? instance.id : instance.instanceId }
}
