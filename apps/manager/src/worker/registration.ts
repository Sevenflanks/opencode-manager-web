import http from "node:http"
import https from "node:https"
import { isIP } from "node:net"
import type { BasicCredential } from "../auth.js"
import { validGeneration, validWorkerId, type WorkerIdentity } from "../coordinator/identity.js"
import type { WorkerRegistration } from "../coordinator/registry.js"
import { workerOrigin, workerSecret } from "./config.js"

export interface WorkerRegistrationConfig {
  coordinatorOrigin: string
  publicOrigin: string
  identity: WorkerIdentity
  registration: WorkerRegistration
  intervalMs: number
}

export async function workerCoordinatorRegistration(environment: NodeJS.ProcessEnv, publicOrigin: string, nativeOrigin: string,
  credentials: BasicCredential): Promise<WorkerRegistrationConfig | undefined> {
  if (environment.OMW_COORDINATOR_URL === undefined) return undefined
  const coordinatorOrigin = workerOrigin(environment.OMW_COORDINATOR_URL, "OMW_COORDINATOR_URL", true)
  const id = environment.OMW_COORDINATOR_WORKER_ID
  const generation = environment.OMW_COORDINATOR_GENERATION
  const kind = environment.OMW_COORDINATOR_WORKER_KIND
  const address = environment.OMW_COORDINATOR_ADVERTISE_ADDRESS
  const name = environment.OMW_COORDINATOR_WORKER_NAME
  const intervalMs = Number(environment.OMW_COORDINATOR_REGISTER_INTERVAL_MS ?? 15_000)
  if (!validWorkerId(id) || !validGeneration(generation) || (kind !== "task" && kind !== "resident")
    || !address || isIP(address) !== 4 || !Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 3_600_000
    || (name !== undefined && (!name.length || name.length > 80))) throw new Error("Worker Coordinator registration 設定不完整或格式不正確。")
  const native = new URL(nativeOrigin)
  if (native.protocol !== new URL(publicOrigin).protocol || !native.hostname.startsWith(`omw-job-${id}-code.`)
    || native.host !== native.hostname || nativeOrigin !== native.origin || native.hostname !== native.hostname.toLowerCase()) {
    throw new Error("OMW_NATIVE_ORIGIN 必須使用 Worker id 的 canonical native root host。")
  }
  if ((environment.OMW_PORT !== undefined && environment.OMW_PORT !== "4174")
    || (environment.OMW_NATIVE_PORT !== undefined && environment.OMW_NATIVE_PORT !== "4180")) throw new Error("Coordinator Worker 固定使用 manager 4174／native 4180。")
  const key = await workerSecret(environment, "OMW_COORDINATOR_WORKER_KEY_FILE", 43)
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error("Worker key 必須是 HMAC-SHA256 的 base64url。")
  return { coordinatorOrigin, publicOrigin, identity: { id, generation, key }, intervalMs,
    registration: { id, generation, kind, address, nativeOrigin, browser: credentials, ...(name === undefined ? {} : { name }) } }
}

/** Manager ready 後才啟動；網路失敗只在下一個 bounded renewal 重試，不阻擋本機 Start／任何副作用。 */
export class WorkerRegistrar {
  private readonly shutdown = new AbortController()
  private timer: NodeJS.Timeout | undefined
  private pending: Promise<void> | undefined
  private started = false
  constructor(private readonly config: WorkerRegistrationConfig) {}
  start(): void {
    if (this.started || this.shutdown.signal.aborted) return
    this.started = true
    const renew = () => {
      if (this.shutdown.signal.aborted) return
      this.pending = this.register().catch(() => { /* Registration response 不進 log，避免洩漏 credentials。 */ }).finally(() => {
        if (!this.shutdown.signal.aborted) { this.timer = setTimeout(renew, this.config.intervalMs); this.timer.unref() }
      })
    }
    renew()
  }
  private async register(): Promise<void> {
    const url = new URL("/api/v1/coordinator/register", this.config.coordinatorOrigin)
    const body = Buffer.from(JSON.stringify(this.config.registration))
    const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(5_000)])
    await new Promise<void>((resolve, reject) => {
      const request = (url.protocol === "https:" ? https : http).request(url, { method: "POST", signal, agent: false,
        headers: { host: new URL(this.config.publicOrigin).host, authorization: `Bearer ${this.config.identity.key}`,
          "content-type": "application/json", "content-length": body.length } }, (response) => {
        if (response.statusCode !== 200) { response.destroy(); request.destroy(); reject(new Error("WORKER_REGISTRATION_FAILED")); return }
        let bytes = 0
        response.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 4096) request.destroy(new Error("WORKER_REGISTRATION_BODY_LIMIT")) })
        response.once("end", resolve); response.once("error", reject)
      })
      request.once("error", reject); request.end(body)
    })
  }
  async close(): Promise<void> { this.shutdown.abort(); clearTimeout(this.timer); await this.pending }
}
