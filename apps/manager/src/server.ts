import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { buildApp } from "./app.js"
import { SeparateRequestAuthenticator, type StoredCredentials } from "./auth.js"
import { readInstancePortPoolConfig, readRemoteAccessConfig } from "./config.js"
import { DpapiCredentialStore } from "./credential-store.js"
import { ManagerRepository } from "./repository.js"
import { OpenCodeRuntime } from "./runtime.js"
import { ManagerService } from "./service.js"

const host = "127.0.0.1"
const port = parsePort(process.env.OMW_PORT ?? "4174")
const dataDirectory = path.resolve(process.env.OMW_DATA_DIR ?? path.join(process.cwd(), ".omw"))
const remoteAccess = readRemoteAccessConfig(process.env, port)
const portPool = readInstancePortPoolConfig(process.env, remoteAccess)
const launcherIntegration = process.env.OMW_LAUNCHER_INTEGRATION === "1"
let credentials: StoredCredentials | undefined
if (remoteAccess || launcherIntegration) {
  const credentialStore = new DpapiCredentialStore({
    dataDirectory,
    ...(process.env.OMW_POWERSHELL_EXECUTABLE ? { powershell: process.env.OMW_POWERSHELL_EXECUTABLE } : {}),
  })
  if (!credentialStore.exists()) throw new Error("Remote access 或 launcher integration 需要先建立 Windows current-user DPAPI credential store。")
  credentials = await credentialStore.load()
}
const repository = new ManagerRepository(path.join(dataDirectory, "omw.sqlite"))
const runtime = new OpenCodeRuntime({
  executable: process.env.OMW_OPENCODE_EXECUTABLE ?? "",
  dataDirectory,
  ...(process.env.OMW_POWERSHELL_EXECUTABLE ? { powershell: process.env.OMW_POWERSHELL_EXECUTABLE } : {}),
  ...(credentials ? { credentials: credentials.openCode } : {}),
  ...(remoteAccess ? { publicOriginForPort: (instancePort: number) => remoteAccess.instanceOrigin(instancePort) } : {}),
})
const service = new ManagerService(repository, runtime, portPool)
const allowedOrigins = readAllowedOrigins(port, remoteAccess?.publicManagerOrigin)
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../web/dist")
const app = buildApp({
  service,
  authority: { hostname: host, port },
  allowedOrigins,
  webRoot,
  ...(remoteAccess ? { publicOrigin: remoteAccess.publicManagerOrigin } : {}),
  ...(remoteAccess && credentials ? { authenticator: new SeparateRequestAuthenticator(credentials) } : {}),
  ...(launcherIntegration && credentials ? { launcherAuthenticator: new SeparateRequestAuthenticator(credentials) } : {}),
})

app.addHook("onClose", async () => {
  // Background Instances deliberately survive Manager shutdown; only close Manager-owned SQLite.
  repository.close()
})

await service.reconcile()
await app.listen({ host, port })

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
