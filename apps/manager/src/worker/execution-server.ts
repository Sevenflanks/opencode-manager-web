import { buildExecutionApp, requireNamespaceOwner } from "./supervisor.js"
import { workerBrowserCredentials, workerExecutionHost, workerOrigin, workerPort, workerSecret } from "./config.js"
import { startHealthServer } from "./health.js"
import { installWorkerShutdown } from "./shutdown.js"

let health: Awaited<ReturnType<typeof startHealthServer>>
let app: ReturnType<typeof buildExecutionApp> | undefined
// 初始化期間也必須接收 TERM；PID 1 不能等 bootstrap 完成才安裝 signal handler。
const removeSignals = installWorkerShutdown(async () => {
  health?.drain()
  app?.beginDrain()
  await health?.close()
  if (app) {
    const cleanup = await app.shutdownExecution()
    // 先 TERM→KILL 給 DB/auth 寫入機會；未確認則非零退出，讓 PID namespace 結束作最後回收。
    if (!cleanup.stopped) throw new Error("Execution shutdown cleanup unconfirmed")
    await app.close()
  }
})
const environment = process.env
const controlHost = workerExecutionHost(environment.OMW_EXECUTION_HOST)
const controlPort = workerPort(environment.OMW_EXECUTION_PORT, 4175)
const nativePort = workerPort(environment.OMW_NATIVE_PORT, 4180)
const runtimePort = workerPort(environment.OMW_RUNTIME_PORT, 4096)
const healthPort = environment.OMW_HEALTH_PORT === undefined ? undefined : workerPort(environment.OMW_HEALTH_PORT, 4177)
const ports = [controlPort, nativePort, runtimePort, ...(healthPort === undefined ? [] : [healthPort])]
if (new Set(ports).size !== ports.length) throw new Error("Execution、native、runtime 與 health ports 必須不同。")
try {
  await requireNamespaceOwner()
  health = await startHealthServer(healthPort)
  // 同程序 await，讓 Node 維持 PID 1/tini 的直接 child；初始化失敗時尚未建立 supervisor/listener。
  const bootstrapUrl = new URL(import.meta.url.includes("/dist/src/") ? "../../../../../scripts/worker/bootstrap.mjs" : "../../../../scripts/worker/bootstrap.mjs", import.meta.url)
  const { initializeWorker }: { initializeWorker: (environment: NodeJS.ProcessEnv) => Promise<unknown> } = await import(bootstrapUrl.href)
  await initializeWorker(environment)
  const credentials = await workerBrowserCredentials(environment)
  const nativeOrigin = workerOrigin(environment.OMW_NATIVE_ORIGIN, "OMW_NATIVE_ORIGIN")
  app = buildExecutionApp({ token: await workerSecret(environment, "OMW_EXECUTION_TOKEN_FILE", 32),
    executable: environment.OMW_OPENCODE_EXECUTABLE ?? "/usr/local/bin/opencode", runtimePort,
    nativeOrigin, browserUsername: credentials.username, browserPassword: credentials.password,
  })
  app.addHook("onClose", async () => { removeSignals(); await health?.close() })
  await app.listen({ host: controlHost, port: controlPort })
  await app.nativeGateway.listen({ host: "0.0.0.0", port: nativePort })
  health?.ready()
} catch (error) {
  try { await app?.close() } finally { removeSignals(); await health?.close() }
  throw error
}
