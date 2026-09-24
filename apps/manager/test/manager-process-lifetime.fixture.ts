import { randomUUID } from "node:crypto"
import path from "node:path"
import { buildApp } from "../src/app.js"
import { SeparateRequestAuthenticator } from "../src/auth.js"
import { ManagerRepository } from "../src/repository.js"
import { OpenCodeRuntime } from "../src/runtime.js"
import { ManagerService } from "../src/service.js"

// 使用獨立 Manager 程序，讓父測試持有 child handle 並提供隔離的環境變數。
const managerPort = Number(process.env.OMW_PORT)
const instancePort = Number(process.env.OMW_INSTANCE_PORT_MIN)
const dataDirectory = process.env.OMW_DATA_DIR!
const username = process.env.OMW_TEST_MANAGER_USERNAME
const password = process.env.OMW_TEST_MANAGER_PASSWORD
if (!username || !password) throw new Error("Missing dedicated test-only Manager credentials")
const openCodeEnvironment = { ...process.env }
delete openCodeEnvironment.OMW_TEST_MANAGER_USERNAME
delete openCodeEnvironment.OMW_TEST_MANAGER_PASSWORD
const repository = new ManagerRepository(path.join(dataDirectory, "omw.sqlite"))
const service = new ManagerService(repository, new OpenCodeRuntime({
  executable: process.env.OMW_OPENCODE_EXECUTABLE!,
  dataDirectory,
  environment: openCodeEnvironment,
}), { min: instancePort, max: instancePort })
const origin = `http://127.0.0.1:${managerPort}`
const app = buildApp({
  service,
  authority: { hostname: "127.0.0.1", port: managerPort },
  allowedOrigins: new Set([origin]),
  authenticator: new SeparateRequestAuthenticator({ manager: { username, password }, launcherToken: randomUUID() }),
})
app.addHook("onClose", async () => {
  await service.shutdown()
  repository.close()
})

try {
  await service.reconcile()
  await app.listen({ host: "127.0.0.1", port: managerPort })
  process.stdin.resume()
  // 以關閉 stdin 明確觸發正常關機，避免依賴 Windows 的 signal 語意。
  process.stdin.once("end", () => { void app.close().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  }) })
} catch (error) {
  console.error(error)
  await app.close().catch(() => repository.close())
  process.exitCode = 1
}
