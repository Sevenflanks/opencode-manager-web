import path from "node:path"
import { mkdir } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { buildApp } from "../app.js"
import { SeparateRequestAuthenticator } from "../auth.js"
import { ManagerRepository } from "../repository.js"
import { ManagerService } from "../service.js"
import { WorkerRuntime } from "./runtime.js"
import { workerBrowserCredentials, workerOrigin, workerPort, workerSecret } from "./config.js"

export async function startWorker(environment: NodeJS.ProcessEnv, managerVersion: string, webRoot: string) {
  const directory = environment.OMW_DATA_DIR
  if (!directory || !path.isAbsolute(directory)) throw new Error("Worker 必須設定 absolute OMW_DATA_DIR，並掛載 persistent volume。")
  const publicOrigin = workerOrigin(environment.OMW_PUBLIC_ORIGIN, "OMW_PUBLIC_ORIGIN")
  const nativeOrigin = workerOrigin(environment.OMW_NATIVE_ORIGIN, "OMW_NATIVE_ORIGIN")
  if (publicOrigin === nativeOrigin) throw new Error("Manager 與 native Web 必須使用不同 root origins。")
  const controlOrigin = workerOrigin(environment.OMW_EXECUTION_ORIGIN, "OMW_EXECUTION_ORIGIN", true)
  const token = await workerSecret(environment, "OMW_EXECUTION_TOKEN_FILE", 32)
  const credentials = await workerBrowserCredentials(environment)
  const port = workerPort(environment.OMW_PORT, 4174)
  const runtimePort = workerPort(environment.OMW_RUNTIME_PORT, 4096)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const repository = new ManagerRepository(path.join(directory, "omw.sqlite"))
  const service = new ManagerService(repository, new WorkerRuntime({ controlOrigin, token, nativeOrigin }), { min: runtimePort, max: runtimePort })
  const app = buildApp({ service, authority: { hostname: "127.0.0.1", port }, publicOrigin,
    allowedOrigins: new Set([publicOrigin]), worker: { nativeOrigin }, managerVersion, webRoot,
    authenticator: new SeparateRequestAuthenticator({ manager: credentials, launcherToken: randomUUID() }),
  })
  app.addHook("onClose", async () => {
    // Worker 關閉只清理觀察者和 DB，execution supervisor 仍持有執行中的工作。
    await service.shutdown()
    repository.close()
  })
  try {
    await service.reconcile()
    await app.listen({ host: "0.0.0.0", port })
  } catch (error) { await app.close(); throw error }
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { void app.close() })
  return app
}
