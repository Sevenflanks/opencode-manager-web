import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { buildApp } from "./app.js"
import { SeparateRequestAuthenticator, type StoredCredentials } from "./auth.js"
import { readDataDirectory, readInstancePortPoolConfig } from "./config.js"
import { tailscaleExecutable } from "./connectivity.js"
import { RemoteAccessController, RemoteProfileStore, startupRemoteAccess } from "./remote-access.js"
import { CredentialController } from "./credential-controller.js"
import { DpapiCredentialStore } from "./credential-store.js"
import { ManagerRepository } from "./repository.js"
import { OpenCodeRuntime } from "./runtime.js"
import { ManagerService } from "./service.js"

const host = "127.0.0.1"
const port = parsePort(process.env.OMW_PORT ?? "4174")
const dataDirectory = readDataDirectory(process.env)
const remoteProfileStore = new RemoteProfileStore(dataDirectory)
const remoteAccess = await startupRemoteAccess(process.env, port, remoteProfileStore)
const portPool = readInstancePortPoolConfig(process.env, remoteAccess)
const launcherIntegration = process.env.OMW_LAUNCHER_INTEGRATION === "1"
const credentialStore = new DpapiCredentialStore({
  dataDirectory,
  ...(process.env.OMW_POWERSHELL_EXECUTABLE ? { powershell: process.env.OMW_POWERSHELL_EXECUTABLE } : {}),
})
if (!credentialStore.exists()) throw new Error("請先執行 omw，在互動式終端完成初始設定。")
const credentials: StoredCredentials = await credentialStore.load()
const authenticator = new SeparateRequestAuthenticator(credentials)
const credentialController = new CredentialController(credentialStore, authenticator, credentials)
const repository = new ManagerRepository(path.join(dataDirectory, "omw.sqlite"))
const connectivity = new RemoteAccessController({
  managerPort: port,
  remoteAccess,
  portPool,
  executable: tailscaleExecutable(process.env),
  disabled: process.env.OMW_REMOTE_ACCESS === "0",
  store: remoteProfileStore,
})
const runtime = new OpenCodeRuntime({
  executable: process.env.OMW_OPENCODE_EXECUTABLE ?? "",
  dataDirectory,
  ...(process.env.OMW_POWERSHELL_EXECUTABLE ? { powershell: process.env.OMW_POWERSHELL_EXECUTABLE } : {}),
  publicOriginForPort: (instancePort: number) => connectivity.remoteOriginForPort(instancePort),
})
const service = new ManagerService(
  repository,
  runtime,
  portPool,
  (instancePort) => connectivity.ensureRemoteOriginForPort(instancePort),
)
const allowedOrigins = readAllowedOrigins(port, remoteAccess?.publicManagerOrigin)
const webRoot = path.resolve(process.env.OMW_WEB_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../web/dist"))
const app = buildApp({
  service,
  connectivity,
  authority: { hostname: host, port },
  allowedOrigins,
  webRoot,
  ...(remoteAccess ? { publicOrigin: remoteAccess.publicManagerOrigin } : {}),
  credentialController,
  shutdownManager: () => { void app.close() },
  remoteAccess: connectivity,
  remoteAuthenticator: authenticator,
  ...(launcherIntegration ? { launcherAuthenticator: authenticator } : {}),
})

app.addHook("onClose", async () => {
  // Serve 已在 preClose 停止；這裡清理 Manager-owned observers，OpenCode Instances 刻意存活。
  await service.shutdown()
  repository.close()
})

await service.reconcile()
await app.listen({ host, port })
if (remoteAccess) {
  // Serve provisioning is best-effort after listen so a Tailscale failure never takes down local management.
  void connectivity.register("startup").catch(() => undefined)
}

function parsePort(value: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error("OMW_PORT 必須是 1 到 65535 的整數。")
  return parsed
}

function readAllowedOrigins(managerPort: number, publicOrigin?: string): Set<string> {
  const configured = process.env.OMW_ALLOWED_ORIGINS?.split(",").map((value) => value.trim()).filter(Boolean)
  const values = configured?.length
    ? configured
    : [`http://127.0.0.1:${managerPort}`, "http://127.0.0.1:5173", ...(publicOrigin ? [publicOrigin] : [])]
  for (const value of values) {
    const url = new URL(value)
    const loopback = url.protocol === "http:" && url.hostname === "127.0.0.1"
    const remote = publicOrigin !== undefined && value === publicOrigin && url.protocol === "https:"
    if ((!loopback && !remote) || url.pathname !== "/" || url.origin !== value) {
      throw new Error("OMW_ALLOWED_ORIGINS 只接受 loopback origins 或核准的 public HTTPS origin。")
    }
  }
  return new Set(values)
}
