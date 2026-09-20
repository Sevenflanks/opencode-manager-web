import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { DpapiCredentialStore } from "../../apps/manager/dist/src/credential-store.js"
import { isolatedPorts, prepareIsolatedEnvironment } from "../../apps/manager/dist/src/isolation.js"
import { ensureCredentials, probeManager, runManagerCli } from "../../packages/launcher/dist/src/manager-cli.js"
import { resolveExecutable } from "../../packages/launcher/dist/src/cli.js"

const OPENCODE = process.env.OMW_OPENCODE_EXECUTABLE
if (!OPENCODE) throw new Error("OMW_OPENCODE_EXECUTABLE must be set to the absolute OpenCode 1.18.31 executable path")
const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../..")
const MANAGER_ENTRY = path.join(REPOSITORY_ROOT, "apps/manager/dist/src/server.js")
const WEB_ROOT = path.join(REPOSITORY_ROOT, "apps/web/dist")
const LAUNCHER_ENTRY = path.join(REPOSITORY_ROOT, "packages/launcher/dist/src/manager-cli.js")
const PROCESS_HELPER = path.join(REPOSITORY_ROOT, "apps/manager/scripts/process-control.ps1")
const POWERSHELL = process.env.OMW_POWERSHELL_EXECUTABLE ?? "pwsh.exe"
const NODE_IMAGE = currentProcessImage()
const BOOTSTRAP_DEADLINE_MS = 15_000
const API_DEADLINE_MS = 5_000
const START_INSTANCE_DEADLINE_MS = 25_000
const STOP_DEADLINE_MS = 10_000
const OVERALL_DEADLINE_MS = 120_000
const startedAt = Date.now()

const result = {
  status: "failed",
  failure: null,
  openCodeVersion: null,
  lifecycle: {
    managerOwner: "official runManagerCli spawn contract plus retained current-run ChildProcess and exact PID/creation-time/executable/Manager-port binding",
    managerStop: "authenticated shutdown first; existing process-control.ps1 exact Stop fallback only for the retained binding",
    instanceStop: "Manager API exact persisted OpenCode identity; persisted current-run identity exact Stop fallback",
    foregroundTimeoutUsedAsBackground: false,
  },
  deadlinesMs: {
    overall: OVERALL_DEADLINE_MS,
    bootstrap: BOOTSTRAP_DEADLINE_MS,
    api: API_DEADLINE_MS,
    startInstance: START_INSTANCE_DEADLINE_MS,
    stop: STOP_DEADLINE_MS,
  },
  checks: {},
  counts: {},
  cleanup: {
    aInstanceStopped: false,
    bInstanceStopped: false,
    aManagerStopped: false,
    bManagerStopped: false,
    bFailedOwnerStopped: false,
    foreignListenerStopped: false,
    lockOwnerStopped: false,
    rootsRemoved: false,
  },
}

const managerOwners = []
const cleanupErrors = []
let base
let isolationA
let isolationB
let credentialsA
let credentialsB
let storeA
let storeB
let ownerA
let ownerB
let failedOwnerB
let instanceA
let instanceB
let foreignListener
let lockOwner
let projectA
let projectB
let primaryError

try {
  assert.equal(process.platform, "win32", "This acceptance harness requires Windows DPAPI and exact process helpers")
  for (const required of [OPENCODE, MANAGER_ENTRY, WEB_ROOT, LAUNCHER_ENTRY, PROCESS_HELPER]) await access(required)
  const versionProbe = spawnSync(OPENCODE, ["--version"], { encoding: "utf8", timeout: 5_000, windowsHide: true })
  assert.equal(versionProbe.status, 0, versionProbe.stderr)
  result.openCodeVersion = versionProbe.stdout.trim()
  assert.equal(result.openCodeVersion, "1.18.31")

  base = await mkdtemp(path.join(tmpdir(), "omw-issue12-manager-ab-"))
  const sharedSyntheticConfig = path.join(base, "synthetic-shared-opencode.json")
  await writeFile(sharedSyntheticConfig, `${JSON.stringify({ plugin: [], mcp: {} }, null, 2)}\n`, "utf8")
  const sharedConfigHashBefore = await hashFile(sharedSyntheticConfig)
  const roots = await chooseDistinctFreeRoots(base)
  isolationA = await prepareIsolatedEnvironment({
    mode: "development",
    root: roots.a,
    sharedConfigFile: sharedSyntheticConfig,
    sourceEnvironment: { ...process.env, OMW_OPENCODE_EXECUTABLE: OPENCODE },
  })
  isolationB = await prepareIsolatedEnvironment({
    mode: "development",
    root: roots.b,
    sharedConfigFile: sharedSyntheticConfig,
    sourceEnvironment: { ...process.env, OMW_OPENCODE_EXECUTABLE: OPENCODE },
  })
  const managerPortA = Number(isolationA.environment.OMW_PORT)
  const managerPortB = Number(isolationB.environment.OMW_PORT)
  assert.notEqual(managerPortA, managerPortB)
  assert.notEqual(isolationA.environment.OMW_INSTANCE_PORT_MIN, isolationB.environment.OMW_INSTANCE_PORT_MIN)
  for (const key of ["root", "omwData", "configFile", "openCodeDatabase", "temporary", "xdgCache", "xdgState"]) {
    assert.notEqual(isolationA.paths[key], isolationB.paths[key], `${key} must be private per Manager`)
  }
  assert.equal(await hashFile(isolationA.paths.configFile), sharedConfigHashBefore)
  assert.equal(await hashFile(isolationB.paths.configFile), sharedConfigHashBefore)
  result.checks.sharedSyntheticConfigSnapshottedToPrivateTargets = true
  result.checks.distinctPrivatePathsAndPorts = true

  projectA = path.join(isolationA.paths.root, "project-a")
  projectB = path.join(isolationB.paths.root, "project-b")
  await Promise.all([
    mkdir(projectA, { recursive: true }),
    mkdir(projectB, { recursive: true }),
    writeFile(path.join(isolationA.paths.root, "a-content.txt"), "A current-run substitute content\n", "utf8"),
    writeFile(path.join(isolationB.paths.root, "b-content.txt"), "B current-run substitute content\n", "utf8"),
  ])
  credentialsA = syntheticCredentials("a")
  credentialsB = syntheticCredentials("b")
  storeA = new DpapiCredentialStore({ dataDirectory: isolationA.paths.omwData, dpapiTimeoutMs: 5_000 })
  storeB = new DpapiCredentialStore({ dataDirectory: isolationB.paths.omwData, dpapiTimeoutMs: 5_000 })
  await bounded(storeA.save(credentialsA), "save A real DPAPI credentials", API_DEADLINE_MS)
  await bounded(storeB.save(credentialsB), "save B real DPAPI credentials", API_DEADLINE_MS)
  assert.notEqual(credentialsA.manager.password, credentialsB.manager.password)
  assert.notEqual(credentialsA.launcherToken, credentialsB.launcherToken)
  assert.deepEqual(await bounded(storeA.load(), "load A real DPAPI credentials", API_DEADLINE_MS), credentialsA)
  assert.deepEqual(await bounded(storeB.load(), "load B real DPAPI credentials", API_DEADLINE_MS), credentialsB)
  result.checks.realDpapiCredentialsAndAuthAreDistinct = true

  ownerA = await launchRealManager("A", isolationA.environment)
  ownerB = await launchRealManager("B", isolationB.environment)
  assert.notEqual(ownerA.identity.pid, ownerB.identity.pid)
  assert.equal(await probeManager(origin(managerPortA), credentialsA.launcherToken), "omw")
  assert.equal(await probeManager(origin(managerPortB), credentialsB.launcherToken), "omw")
  assert.equal(await probeManager(origin(managerPortA), credentialsB.launcherToken), "foreign")
  assert.equal(await probeManager(origin(managerPortB), credentialsA.launcherToken), "foreign")
  await expectStatus(managerPortA, "/api/v1/launcher/identity", { launcherToken: credentialsB.launcherToken }, 401)
  await expectStatus(managerPortB, "/api/v1/launcher/identity", { launcherToken: credentialsA.launcherToken }, 401)
  result.checks.twoRealManagersBindDistinctPortsWithTokenRejection = true

  instanceA = await managerJson(managerPortA, "/api/v1/instances", {
    method: "POST",
    credentials: credentialsA,
    body: { directory: projectA },
    timeoutMs: START_INSTANCE_DEADLINE_MS,
    expectedStatus: 201,
  })
  const sessionA = await managerJson(managerPortA, `/api/v1/instances/${instanceA.id}/sessions`, {
    method: "POST",
    credentials: credentialsA,
    expectedStatus: 201,
  })
  assert.ok(sessionA.sessionId)
  const sessionsABefore = sessionList(await managerJson(managerPortA, `/api/v1/instances/${instanceA.id}/sessions`, { credentials: credentialsA }))
  assert.ok(sessionsABefore.some((session) => session.id === sessionA.sessionId))
  const overviewABefore = await healthyOverview(managerPortA, credentialsA)
  const targetABefore = requiredInstance(overviewABefore, instanceA.id)
  const managerIdentityABefore = await inspectIdentity(ownerA)
  assertRunningIdentity(managerIdentityABefore)
  const aCredentialHashBeforeB = await hashFile(storeA.filename)
  const aPrivateConfigHashBeforeB = await hashFile(isolationA.paths.configFile)
  const aContentHashBeforeB = await hashFile(path.join(isolationA.paths.root, "a-content.txt"))
  result.checks.aRealManagerHealthAndApiSessionTarget = true

  instanceB = await managerJson(managerPortB, "/api/v1/instances", {
    method: "POST",
    credentials: credentialsB,
    body: { directory: projectB },
    timeoutMs: START_INSTANCE_DEADLINE_MS,
    expectedStatus: 201,
  })
  const sessionB = await managerJson(managerPortB, `/api/v1/instances/${instanceB.id}/sessions`, {
    method: "POST",
    credentials: credentialsB,
    expectedStatus: 201,
  })
  assert.ok(sessionB.sessionId)
  assert.notEqual(sessionA.sessionId, sessionB.sessionId)
  await healthyOverview(managerPortB, credentialsB)
  await stopManagedInstance(managerPortB, credentialsB, isolationB, instanceB)
  result.cleanup.bInstanceStopped = true
  await stopManager(ownerB, credentialsB, true)
  result.cleanup.bManagerStopped = true
  result.checks.bRealManagerStartupSuccessApiSessionAndExactStop = true

  await assertAUnchanged({
    phase: "B success and Stop",
    isolation: isolationA,
    owner: ownerA,
    credentials: credentialsA,
    store: storeA,
    instance: instanceA,
    sessionId: sessionA.sessionId,
    targetBefore: targetABefore,
    managerIdentityBefore: managerIdentityABefore,
    credentialHashBefore: aCredentialHashBeforeB,
    privateConfigHashBefore: aPrivateConfigHashBeforeB,
    contentHashBefore: aContentHashBeforeB,
  })

  const failedOwnerStart = managerOwners.length
  const invalidBEnvironment = { ...isolationB.environment }
  delete invalidBEnvironment.OMW_INSTANCE_PORT_MAX
  await assert.rejects(
    bounded(runManagerCli([], invalidBEnvironment, managerCliDependencies("B failed startup")), "B failed Manager bootstrap", BOOTSTRAP_DEADLINE_MS),
    /readiness/,
  )
  assert.equal(managerOwners.length, failedOwnerStart + 1)
  failedOwnerB = managerOwners[failedOwnerStart]
  await waitForChildExit(failedOwnerB.child, STOP_DEADLINE_MS)
  assert.equal(await portReachable(managerPortB), false)
  result.cleanup.bFailedOwnerStopped = true
  result.checks.bRealManagerFailedStartupCleansCurrentRunOwner = true

  foreignListener = net.createServer((socket) => {
    socket.on("error", () => undefined)
    socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nNO", () => socket.destroy())
  })
  await listenAt(foreignListener, managerPortB)
  const ownersBeforeForeign = managerOwners.length
  await assert.rejects(
    bounded(runManagerCli([], isolationB.environment, managerCliDependencies("B foreign listener")), "B foreign-listener bootstrap", BOOTSTRAP_DEADLINE_MS),
    /非 OMW Manager/,
  )
  assert.equal(managerOwners.length, ownersBeforeForeign)
  assert.equal(await portReachable(managerPortB), true)
  await closeServer(foreignListener)
  foreignListener = undefined
  result.cleanup.foreignListenerStopped = true
  result.checks.bForeignListenerRejectedWithoutReplacement = true

  lockOwner = net.createServer((socket) => {
    socket.on("error", () => undefined)
    socket.destroy()
  })
  await listenPipe(lockOwner, managerLockName(await realpath(isolationB.paths.omwData)))
  const ownersBeforeLock = managerOwners.length
  await assert.rejects(
    bounded(runManagerCli([], isolationB.environment, managerCliDependencies("B lock collision")), "B lock-collision bootstrap", BOOTSTRAP_DEADLINE_MS),
    /另一個 OMW Manager 啟動仍在進行/,
  )
  assert.equal(managerOwners.length, ownersBeforeLock)
  assert.equal(await portReachable(managerPortB), false)
  closePipeOwner(lockOwner)
  lockOwner = undefined
  result.cleanup.lockOwnerStopped = true
  result.checks.bStartupLockCollisionDoesNotSpawnOrReplace = true

  const overviewAAfter = await assertAUnchanged({
    phase: "all B success/failure/foreign/lock cases",
    isolation: isolationA,
    owner: ownerA,
    credentials: credentialsA,
    store: storeA,
    instance: instanceA,
    sessionId: sessionA.sessionId,
    targetBefore: targetABefore,
    managerIdentityBefore: managerIdentityABefore,
    credentialHashBefore: aCredentialHashBeforeB,
    privateConfigHashBefore: aPrivateConfigHashBeforeB,
    contentHashBefore: aContentHashBeforeB,
  })
  assert.equal(await hashFile(sharedSyntheticConfig), sharedConfigHashBefore)
  result.checks.aUnaffectedByAllBManagerCases = true
  result.checks.syntheticSharedConfigSourceHashUnchangedAfterRealBootstrap = true
  result.counts.aInstancesBefore = overviewABefore.instances.length
  result.counts.aInstancesAfter = overviewAAfter.instances.length
  result.counts.aSessionsBefore = sessionsABefore.length
  result.counts.aSessionsAfter = sessionList(await managerJson(managerPortA, `/api/v1/instances/${instanceA.id}/sessions`, { credentials: credentialsA })).length
  result.status = "passed"
} catch (error) {
  primaryError = error
  result.failure = error instanceof Error ? error.message : String(error)
} finally {
  if (lockOwner) await collectCleanup("lock owner close", () => closePipeOwner(lockOwner), () => { result.cleanup.lockOwnerStopped = true })
  if (foreignListener) await collectCleanup("foreign listener close", () => closeServer(foreignListener), () => { result.cleanup.foreignListenerStopped = true })
  if (instanceB && !result.cleanup.bInstanceStopped && isolationB && credentialsB) {
    await collectCleanup("B instance exact stop", () => stopManagedInstance(Number(isolationB.environment.OMW_PORT), credentialsB, isolationB, instanceB), () => { result.cleanup.bInstanceStopped = true })
  }
  if (instanceA && !result.cleanup.aInstanceStopped && isolationA && credentialsA) {
    await collectCleanup("A instance exact stop", () => stopManagedInstance(Number(isolationA.environment.OMW_PORT), credentialsA, isolationA, instanceA), () => { result.cleanup.aInstanceStopped = true })
  }
  if (ownerB && !result.cleanup.bManagerStopped && credentialsB) {
    await collectCleanup("B Manager exact stop", () => stopManager(ownerB, credentialsB), () => { result.cleanup.bManagerStopped = true })
  }
  if (ownerA && !result.cleanup.aManagerStopped && credentialsA) {
    await collectCleanup("A Manager exact stop", () => stopManager(ownerA, credentialsA), () => { result.cleanup.aManagerStopped = true })
  }
  if (failedOwnerB && !result.cleanup.bFailedOwnerStopped) {
    await collectCleanup("B failed owner stop", () => failedOwnerB.stop(), () => { result.cleanup.bFailedOwnerStopped = true })
  }
  for (const owner of managerOwners) {
    if (!childExited(owner.child)) await collectCleanup(`${owner.label} residual exact stop`, () => owner.stop())
  }
  const expectedCleanup = (!instanceA || result.cleanup.aInstanceStopped)
    && (!instanceB || result.cleanup.bInstanceStopped)
    && (!ownerA || result.cleanup.aManagerStopped)
    && (!ownerB || result.cleanup.bManagerStopped)
    && (!failedOwnerB || result.cleanup.bFailedOwnerStopped)
    && (!foreignListener || result.cleanup.foreignListenerStopped)
    && (!lockOwner || result.cleanup.lockOwnerStopped)
    && managerOwners.every((owner) => childExited(owner.child))
  if (cleanupErrors.length === 0 && expectedCleanup && base) {
    await collectCleanup("current-run acceptance root removal", () => rm(base, { recursive: true, force: true }), () => { result.cleanup.rootsRemoved = true })
  }
  result.elapsedMs = Date.now() - startedAt
  result.checks.overallDeadlineObserved = result.elapsedMs <= OVERALL_DEADLINE_MS
  if (cleanupErrors.length || !expectedCleanup || !result.cleanup.rootsRemoved || !result.checks.overallDeadlineObserved) result.status = "failed"
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Issue 12 Manager-process acceptance cleanup failed; current-run root retained")
  if (primaryError) throw primaryError
  assert.equal(result.status, "passed")
}

function managerCliDependencies(label) {
  return {
    ensureCredentials,
    probe: probeManager,
    spawnManager: (entry, options) => spawnOwnedManager(label, entry, options),
    managerEntry: async () => await realpath(MANAGER_ENTRY),
    webRoot: async () => await realpath(WEB_ROOT),
    resolveExecutable,
    launcherPath: () => LAUNCHER_ENTRY,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now: Date.now,
    output: () => undefined,
    diagnostic: () => undefined,
    runOpenCode: async () => { throw new Error("TUI/provider dispatch is outside this acceptance scope") },
  }
}

function spawnOwnedManager(label, entry, options) {
  const child = spawn(process.execPath, [entry], options)
  assert.ok(child.pid, `${label} Manager did not report a PID`)
  const owner = {
    label,
    child,
    port: Number(options.env?.OMW_PORT),
    identity: null,
    preserved: false,
    stopped: false,
    preserve() {
      owner.preserved = true
      child.unref()
    },
    async stop() {
      if (childExited(child)) { owner.stopped = true; return }
      if (owner.identity) {
        const stopped = await processControl("Stop", owner.identity, owner.port)
        if (stopped.stopped !== true) throw new Error(`${label} exact Stop refused: ${stopped.reason ?? "unknown"}`)
      } else {
        // This is the official current-run ChildProcess owner path used before identity publication.
        if (!child.kill()) throw new Error(`${label} current-run ChildProcess refused Stop`)
      }
      await waitForChildExit(child, STOP_DEADLINE_MS)
      owner.stopped = true
    },
  }
  managerOwners.push(owner)
  return owner
}

async function launchRealManager(label, environment) {
  const before = managerOwners.length
  assert.equal(await portReachable(Number(environment.OMW_PORT)), false, `${label} Manager port must be free before launch`)
  assert.equal(await bounded(runManagerCli([], environment, managerCliDependencies(label)), `${label} official Manager bootstrap`, BOOTSTRAP_DEADLINE_MS), 0)
  assert.equal(managerOwners.length, before + 1, `${label} bootstrap must spawn exactly one Manager`)
  const owner = managerOwners[before]
  assert.equal(owner.preserved, true, `${label} official bootstrap must publish Preserve only after readiness`)
  owner.identity = await processControl("Describe", { pid: owner.child.pid, executable: NODE_IMAGE }, owner.port)
  assert.equal(owner.identity.pid, owner.child.pid)
  assertRunningIdentity(await inspectIdentity(owner))
  return owner
}

async function stopManager(owner, credentials, requireGraceful = false) {
  if (childExited(owner.child)) { owner.stopped = true; return }
  let gracefulError
  try {
    await managerJson(owner.port, "/api/v1/manager/shutdown", { method: "POST", credentials, expectedStatus: 202 })
    await waitForChildExit(owner.child, STOP_DEADLINE_MS)
  } catch (cause) {
    gracefulError = cause
    await owner.stop()
  }
  assert.equal(childExited(owner.child), true)
  assert.equal(await portReachable(owner.port), false)
  if (owner.identity) {
    const finalIdentity = await processControl("Inspect", owner.identity, owner.port)
    assert.equal(finalIdentity.running, false)
  }
  owner.stopped = true
  if (gracefulError && requireGraceful) throw gracefulError
}

async function stopManagedInstance(managerPort, credentials, isolation, instance) {
  try {
    await managerJson(managerPort, `/api/v1/instances/${instance.id}/stop`, { method: "POST", credentials })
  } catch (cause) {
    const identity = persistedInstanceIdentity(isolation.paths.omwData, instance.id)
    if (!identity) throw cause
    const stopped = await processControl("Stop", identity, identity.port)
    if (stopped.stopped !== true) throw cause
  }
  await waitForPort(instance.port, false, STOP_DEADLINE_MS)
}

function persistedInstanceIdentity(dataDirectory, id) {
  const database = new DatabaseSync(path.join(dataDirectory, "omw.sqlite"), { readOnly: true })
  try {
    const row = database.prepare("SELECT pid, creation_time_ticks AS creationTimeTicks, executable, port FROM managed_instances WHERE id = ?").get(id)
    if (!row?.pid || !row.creationTimeTicks || !row.executable || !row.port) return null
    return { pid: Number(row.pid), creationTimeTicks: String(row.creationTimeTicks), executable: String(row.executable), port: Number(row.port) }
  } finally {
    database.close()
  }
}

async function assertAUnchanged(options) {
  const port = Number(options.isolation.environment.OMW_PORT)
  const overview = await healthyOverview(port, options.credentials)
  const target = requiredInstance(overview, options.instance.id)
  assert.equal(target.pid, options.targetBefore.pid, `${options.phase}: A instance PID changed`)
  assert.equal(target.port, options.targetBefore.port, `${options.phase}: A instance port changed`)
  assert.equal(target.endpoint, options.targetBefore.endpoint, `${options.phase}: A instance endpoint changed`)
  const sessions = sessionList(await managerJson(port, `/api/v1/instances/${options.instance.id}/sessions`, { credentials: options.credentials }))
  assert.ok(sessions.some((session) => session.id === options.sessionId), `${options.phase}: A Session target disappeared`)
  assert.deepEqual(await inspectIdentity(options.owner), options.managerIdentityBefore, `${options.phase}: A Manager exact owner changed`)
  assert.equal(await hashFile(options.store.filename), options.credentialHashBefore, `${options.phase}: A credentials changed`)
  assert.deepEqual(await bounded(options.store.load(), `${options.phase}: load A DPAPI credentials`, API_DEADLINE_MS), options.credentials)
  assert.equal(await hashFile(options.isolation.paths.configFile), options.privateConfigHashBefore, `${options.phase}: A private config changed`)
  assert.equal(await hashFile(path.join(options.isolation.paths.root, "a-content.txt")), options.contentHashBefore, `${options.phase}: A content changed`)
  return overview
}

async function healthyOverview(port, credentials) {
  const overview = await managerJson(port, "/api/v1/overview", { credentials })
  assert.ok(Array.isArray(overview.instances))
  return overview
}

function requiredInstance(overview, id) {
  const instance = overview.instances.find((candidate) => candidate.id === id)
  assert.ok(instance, `Manager overview missing instance ${id}`)
  assert.equal(instance.state, "ready")
  assert.equal(instance.stopAllowed, true)
  return instance
}

function sessionList(response) {
  assert.ok(Array.isArray(response.roots))
  assert.ok(Array.isArray(response.unknownParent))
  return [...response.roots, ...response.unknownParent]
}

async function expectStatus(port, pathname, options, expectedStatus) {
  await managerJson(port, pathname, { ...options, expectedStatus, returnErrorBody: true })
}

async function managerJson(port, pathname, options = {}) {
  const method = options.method ?? "GET"
  const headers = {}
  if (options.credentials) {
    headers.authorization = `Basic ${Buffer.from(`${options.credentials.manager.username}:${options.credentials.manager.password}`).toString("base64")}`
  }
  if (options.launcherToken) headers["x-omw-launcher-token"] = options.launcherToken
  if (["POST", "PATCH", "DELETE"].includes(method) && options.credentials) {
    headers.origin = origin(port)
    headers["x-omw-csrf"] = "1"
  }
  if (options.body !== undefined) headers["content-type"] = "application/json"
  const response = await fetch(`${origin(port)}${pathname}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: "error",
    signal: AbortSignal.timeout(options.timeoutMs ?? API_DEADLINE_MS),
  })
  const text = await response.text()
  const expectedStatus = options.expectedStatus ?? 200
  assert.equal(response.status, expectedStatus, `${method} ${pathname}: ${text}`)
  if (!text) return null
  return JSON.parse(text)
}

async function processControl(action, identity, port) {
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", PROCESS_HELPER, "-Action", action, "-ProcessId", String(identity.pid)]
  if (identity.creationTimeTicks) args.push("-ExpectedCreationTicks", identity.creationTimeTicks)
  args.push("-ExpectedExecutable", identity.executable)
  if (port) args.push("-Port", String(port))
  const completed = spawnSync(POWERSHELL, args, { encoding: "utf8", timeout: STOP_DEADLINE_MS, maxBuffer: 64 * 1024, windowsHide: true })
  assert.equal(completed.status, 0, completed.stderr || completed.error?.message)
  return JSON.parse(completed.stdout)
}

async function inspectIdentity(owner) {
  return await processControl("Inspect", owner.identity, owner.port)
}

function assertRunningIdentity(identity) {
  assert.deepEqual(identity, { processState: "running", running: true, matched: true, portOwnerMatched: true, portOwnedByOther: false })
}

async function chooseDistinctFreeRoots(root) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const a = path.join(root, `a-${randomBytes(6).toString("hex")}`)
    const b = path.join(root, `b-${randomBytes(6).toString("hex")}`)
    const portsA = isolatedPorts(a)
    const portsB = isolatedPorts(b)
    if (portsA.manager === portsB.manager || portsA.instanceMin === portsB.instanceMin) continue
    if (await portReachable(portsA.manager) || await portReachable(portsB.manager)) continue
    return { a, b }
  }
  throw new Error("Could not select distinct free A/B isolation identities within 100 bounded attempts")
}

function syntheticCredentials(label) {
  return {
    manager: { username: `issue12-${label}`, password: `synthetic-${label}-${randomBytes(18).toString("hex")}` },
    launcherToken: `synthetic-${label}-${randomBytes(24).toString("hex")}`,
  }
}

function managerLockName(dataDirectory) {
  const identity = createHash("sha256").update(dataDirectory.toLowerCase()).update("\0").update("manager-start.lock").digest("hex")
  return `\\\\.\\pipe\\omw-${identity}`
}

function currentProcessImage() {
  const completed = spawnSync(POWERSHELL, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    `[Diagnostics.Process]::GetProcessById(${process.pid}).MainModule.FileName`,
  ], { encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024, windowsHide: true })
  assert.equal(completed.status, 0, completed.stderr || completed.error?.message)
  const image = completed.stdout.trim()
  assert.ok(path.isAbsolute(image), "current Node process image must be absolute")
  return image
}

function origin(port) { return `http://127.0.0.1:${port}` }
function childExited(child) { return child.exitCode !== null || child.signalCode !== null }

function bounded(promise, label, timeoutMs) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs} ms`)), timeoutMs) }),
  ]).finally(() => clearTimeout(timer))
}

async function waitForChildExit(child, timeoutMs) {
  if (childExited(child)) return
  await bounded(new Promise((resolve, reject) => {
    child.once("exit", resolve)
    child.once("error", reject)
  }), `PID ${child.pid} exit`, timeoutMs)
}

async function waitForPort(port, expectedOpen, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await portReachable(port) === expectedOpen) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`port ${port} did not become ${expectedOpen ? "open" : "closed"} within ${timeoutMs} ms`)
}

function portReachable(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port })
    let settled = false
    const finish = (value) => { if (!settled) { settled = true; socket.destroy(); resolve(value) } }
    socket.setTimeout(300, () => finish(false))
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
  })
}

function listenAt(server, port) {
  return bounded(new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", resolve)
  }), `listen on ${port}`, API_DEADLINE_MS)
}

function listenPipe(server, pipe) {
  return bounded(new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen({ path: pipe, exclusive: true }, resolve)
  }), "acquire B manager-start lock", API_DEADLINE_MS)
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve()
  return bounded(new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
    server.closeAllConnections?.()
  }), "close current-run listener", API_DEADLINE_MS)
}

function closePipeOwner(server) {
  if (!server.listening) return
  server.close()
  assert.equal(server.listening, false, "current-run named-pipe lock owner must stop accepting synchronously")
}

async function hashFile(filename) {
  return createHash("sha256").update(await readFile(filename)).digest("hex")
}

async function collectCleanup(label, operation, onSuccess = () => undefined) {
  try {
    await bounded(operation(), label, STOP_DEADLINE_MS)
    onSuccess()
  } catch (error) {
    cleanupErrors.push(new Error(`${label} failed: ${error instanceof Error ? error.message : String(error)}`))
  }
}
