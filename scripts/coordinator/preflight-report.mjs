// Post-cleanup analysis of literal observations. Never rewrites original evidence.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
const directory = path.resolve(process.argv[2])
const raw = await readFile(path.join(directory, 'evidence.json'))
const evidence = JSON.parse(raw)
const reconciliation = JSON.parse(await readFile(path.join(directory, 'reconciliation.json'), 'utf8'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const health = record => ({ payloadStatus: record.payloadStatus ?? (typeof record.status === 'string' ? record.status : null), httpStatus: typeof record.status === 'number' ? record.status : null })
const observation = ({ at, result: r, executionState, managerState }) => ({ at, execution: r.execution, capacity: r.capacity, executionHealth: health(r.executionHealth), managerHealth: health(r.managerHealth), ports: r.ports, coordinatorWorkers: r.coordinator.workers, executionRunning: executionState.Running, executionExitCode: executionState.ExitCode, managerRunning: managerState.Running })
const signals = evidence.observations.map(observation)
const first = signals[0], last = signals.at(-1)
// Available requires the actual control AND manager results. Truthy unknown is
// not readiness; health payload is reported separately from unavailable HTTP evidence.
function capacityAvailable(s) { return s.executionRunning && s.execution.status === 200 && s.execution.state === 'available' && s.capacity.status === 200 && s.capacity.state === 'available' && s.executionHealth.payloadStatus === 'ok' && s.managerHealth.payloadStatus === 'ok' }
assert.equal(capacityAvailable(first), false, 'EARLY_UNKNOWN_IS_NOT_READY')
assert.equal(first.execution.errorCode, 'ECONNREFUSED', 'INITIAL_CONTROL_LITERAL')
assert.equal(first.capacity.state, 'unknown', 'INITIAL_CAPACITY_LITERAL')
assert.ok(capacityAvailable(last), 'FINAL_AVAILABLE_LITERAL_REQUIRED')
assert.equal(last.execution.currentInstance, null, 'NO_INSTANCE_WAS_STARTED')
const readySignals = signals.filter(capacityAvailable)
assert.ok(readySignals.length >= 2, 'STABLE_READINESS_OBSERVATIONS')
assert.ok(readySignals.every(s => s.execution.epoch === last.execution.epoch), 'STABLE_EXECUTION_EPOCH')
const productChanges = []
const repo = new URL('../../', import.meta.url)
for (const before of evidence.sourceBefore) { const bytes = await readFile(new URL(before.file, repo)); if (hash(bytes) !== before.raw) productChanges.push(before.file) }
const commandSummary = commands => ({ total: commands.length, zero: commands.filter(c => c.exit === 0).length, nonzero: commands.filter(c => c.exit !== 0 && c.exit !== null).map(c => ({ operation: c.operation, exit: c.exit })), unknown: commands.filter(c => c.exit === null).map(c => ({ operation: c.operation, outcomeUnknown: Boolean(c.outcomeUnknown) })) })
const build = evidence.commands.find(c => c.operation === 'build')
const result = {
  scope: 'API-only-startup-diagnostic', project: evidence.project, originalEvidencePath: path.join(directory, 'evidence.json'), originalEvidenceSha256: hash(raw), originalEvidenceModified: false,
  originalSummary: evidence.diagnosis, reportCorrection: 'The probe spread health payload status over HTTP status; preserved observations still contain the literal health payload, but HTTP health statuses were not retained.',
  diagnosis: { classification: 'transient-execution-startup-not-ready', executionStayedRunning: signals.every(s => s.executionRunning), initialSafeErrorCode: first.execution.errorCode, recoveredControlAndManagerCapacity: true, repeatedAvailableObservations: readySignals.length, firstAvailableAfterExecutionStartMs: Date.parse(readySignals[0].at) - Date.parse(evidence.checkpoints[0].state.StartedAt), observationDeltaMs: Date.parse(readySignals[0].at) - Date.parse(first.at), initialUnknownIsNotStartReadiness: true, currentStartCapacityReady: true, startActuallyTested: false, modelReadinessClaim: false, namespacePersistentFailureObserved: false },
  signals, logs: evidence.checkpoints, image: evidence.image, productContentHash: evidence.productContentHash, productFileCount: evidence.productFileCount, productSourceUnchanged: !productChanges.length, productChanges, commands: commandSummary(evidence.commands), build: { exit: build.exit, durationMs: Date.parse(build.finished) - Date.parse(build.started), timeoutMs: build.timeoutMs, cacheEvidence: build.cacheEvidence },
  harnessEvidence: { atLaunchContentHash: hash(JSON.stringify(evidence.harnessBefore)), afterCleanupContentHash: hash(JSON.stringify(evidence.harnessAfter)), unchangedDuringRun: evidence.harnessSourceUnchangedDuringRun, postCleanupFixes: ['preflight-probe.mjs: separate HTTP status from payloadStatus', 'preflight.mjs: require both HTTP 200 and available capacity; health payload ok', 'preflight-report.mjs: independent replay of preserved observations'], runtimeConfirmationAfterFix: false },
  workloadDurationIncludingCleanupMs: Date.parse(evidence.finished) - Date.parse(evidence.workloadStarted), startRequests: evidence.startRequests, modelRequests: evidence.modelRequests, newCredentials: evidence.newCredentials,
  currentDockerCleanup: { originalStatus: evidence.cleanup.status, reconciledStatus: reconciliation.latestScopedCleanup.status, uncertainty: evidence.cleanup.uncertainCommands, createdContainers: reconciliation.createdContainers.length, everyObservedCreatedContainerDestroyed: reconciliation.allObservedCreatedContainersDestroyed, remaining: reconciliation.latestScopedCleanup.remaining, aliasRemoved: reconciliation.latestScopedCleanup.aliasRemoved, watchdogExit: evidence.watchdogExit, reconciliationCommands: commandSummary(reconciliation.commands) },
  previousBrowser: evidence.previousBrowser,
}
await writeFile(path.join(directory, 'preflight-report.json'), JSON.stringify(result, null, 2))
assert.equal(hash(await readFile(path.join(directory, 'evidence.json'))), hash(raw), 'RAW_EVIDENCE_CHANGED')
assert.ok(result.productSourceUnchanged, 'PRODUCT_SOURCE_CHANGED')
console.log(JSON.stringify(result, null, 2))
