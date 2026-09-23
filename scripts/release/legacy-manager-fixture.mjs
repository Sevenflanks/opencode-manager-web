import { writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const [packageRoot, dataDirectory, portValue, powershell, cleanupMarker] = process.argv.slice(2)
if (!packageRoot || !dataDirectory || !portValue || !powershell || !cleanupMarker) {
  throw new Error("legacy Manager fixture arguments are incomplete")
}
const port = Number(portValue)
const managerRoot = path.join(packageRoot, "dist", "manager", "src")
const [{ buildApp }, { SeparateRequestAuthenticator }, { DpapiCredentialStore }, { ManagerRepository }, { ManagerService }] = await Promise.all([
  import(pathToFileURL(path.join(managerRoot, "app.js")).href),
  import(pathToFileURL(path.join(managerRoot, "auth.js")).href),
  import(pathToFileURL(path.join(managerRoot, "credential-store.js")).href),
  import(pathToFileURL(path.join(managerRoot, "repository.js")).href),
  import(pathToFileURL(path.join(managerRoot, "service.js")).href),
])

const credentialStore = new DpapiCredentialStore({ dataDirectory, powershell })
const credentials = await credentialStore.load()
const authenticator = new SeparateRequestAuthenticator(credentials)
const repository = new ManagerRepository(path.join(dataDirectory, "omw.sqlite"))
const instanceId = "legacy-instance"
const boundAt = "2026-09-22T00:00:00.000Z"
if (!repository.getInstance(instanceId)) {
  repository.createInstance({
    id: instanceId,
    kind: "headless",
    clientInvocationId: null,
    projectName: "legacy-project",
    projectDirectory: path.join(dataDirectory, "legacy-project"),
    state: "unreachable",
    endpoint: "http://127.0.0.1:42999",
    port: 42999,
    pid: null,
    creationTimeUtc: null,
    creationTimeTicks: null,
    executable: null,
    launchedAt: boundAt,
    healthVersion: null,
    stoppedAt: null,
    error: "legacy fixture",
    stderrSummary: null,
  })
  repository.replacePrimarySession(instanceId, {
    sessionId: "legacy-primary",
    title: "Legacy primary",
    source: "manual",
    boundAt,
  })
}

const runtime = {
  async launch() { throw new Error("legacy fixture does not launch Instances") },
  async cleanupLaunch() { return { stopped: false, reason: "not owned" } },
  async readiness() { throw new Error("legacy fixture Instance is unavailable") },
  async inspect() { return { processState: "not-found", running: false, matched: false, portOwnerMatched: false, portOwnedByOther: false } },
  async stop() { return { stopped: false, reason: "not owned" } },
  async sessions() { return [] },
  async children() { return [] },
  async summary() {
    return {
      activity: "unknown",
      busySessions: null,
      pendingQuestions: null,
      pendingPermissions: null,
      error: null,
      sessions: [],
    }
  },
  openUrl(instance) { return instance.endpoint },
}
const service = new ManagerService(repository, runtime)
await service.reconcile()
const origin = `http://127.0.0.1:${port}`
let resolveClosed
let rejectClosed
const closed = new Promise((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject })
let app
app = buildApp({
  service,
  authority: { hostname: "127.0.0.1", port },
  allowedOrigins: new Set([origin]),
  authenticator,
  launcherAuthenticator: authenticator,
  shutdownManager: () => { void app.close().then(resolveClosed, rejectClosed) },
})
app.addHook("onClose", async () => {
  await new Promise((resolve) => setTimeout(resolve, 500))
  repository.close()
  await writeFile(cleanupMarker, "closed\n", "utf8")
})

await app.listen({ host: "127.0.0.1", port })
await closed
