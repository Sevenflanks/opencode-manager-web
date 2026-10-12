import { randomUUID } from "node:crypto"
import { SeparateRequestAuthenticator } from "../auth.js"
import { startHealthServer } from "../worker/health.js"
import { installWorkerShutdown } from "../worker/shutdown.js"
import { buildCoordinatorApp } from "./app.js"
import { coordinatorConfig } from "./config.js"
import { CoordinatorRegistry } from "./registry.js"

export async function startCoordinator(environment: NodeJS.ProcessEnv, managerVersion: string, webRoot: string) {
  const { config, credentials, port, healthPort } = await coordinatorConfig(environment)
  if (healthPort === port) throw new Error("Manager 與 health ports 必須不同。")
  let health: Awaited<ReturnType<typeof startHealthServer>>
  let app: ReturnType<typeof buildCoordinatorApp> | undefined
  let registry: CoordinatorRegistry | undefined
  const removeSignals = installWorkerShutdown(async () => {
    health?.drain()
    try { await app?.close(); await registry?.close() } finally { await health?.close() }
  })
  try {
    health = await startHealthServer(healthPort)
    registry = await CoordinatorRegistry.open(config)
    app = buildCoordinatorApp({ registry, publicOrigin: config.publicOrigin, port, managerVersion, webRoot,
      authenticator: new SeparateRequestAuthenticator({ manager: credentials, launcherToken: randomUUID() }) })
    app.addHook("preClose", async () => { health?.drain(); await health?.close() })
    app.addHook("onClose", async () => { removeSignals() })
    await app.listen({ host: "0.0.0.0", port })
    registry.start()
    health?.ready()
    return app
  } catch (error) {
    try { if (app) await app.close(); await registry?.close() }
    finally { removeSignals(); await health?.close() }
    throw error
  }
}
