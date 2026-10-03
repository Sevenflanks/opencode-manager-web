import { buildExecutionApp, requireNamespaceOwner } from "./supervisor.js"
import { workerBrowserCredentials, workerOrigin, workerPort, workerSecret } from "./config.js"

await requireNamespaceOwner()
const environment = process.env
const credentials = await workerBrowserCredentials(environment)
const nativeOrigin = workerOrigin(environment.OMW_NATIVE_ORIGIN, "OMW_NATIVE_ORIGIN")
const controlPort = workerPort(environment.OMW_EXECUTION_PORT, 4175)
const nativePort = workerPort(environment.OMW_NATIVE_PORT, 4180)
const runtimePort = workerPort(environment.OMW_RUNTIME_PORT, 4096)
if (new Set([controlPort, nativePort, runtimePort]).size !== 3) throw new Error("Execution、native 與 runtime ports 必須不同。")
const app = buildExecutionApp({ token: await workerSecret(environment, "OMW_EXECUTION_TOKEN_FILE", 32),
  executable: environment.OMW_OPENCODE_EXECUTABLE ?? "/usr/local/bin/opencode", runtimePort,
  nativeOrigin, browserUsername: credentials.username, browserPassword: credentials.password,
})
await app.listen({ host: "0.0.0.0", port: controlPort })
await app.nativeGateway.listen({ host: "0.0.0.0", port: nativePort })
// PID namespace 的 PID 1 結束會由 kernel 終止同 namespace 成員；容器停止是 execution 的 final owner。
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => process.exit(0))
