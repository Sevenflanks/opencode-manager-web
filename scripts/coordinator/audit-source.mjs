// Compare the run's actual file bytes, not HEAD alone. Later harness edits are explicit.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const repo = fileURLToPath(new URL('../../', import.meta.url)), directory = path.resolve(process.argv[2])
const previous = JSON.parse(await readFile(path.join(directory, 'evidence.json'), 'utf8'))
const hash = value => createHash('sha256').update(value).digest('hex')
const changes = [], harnessChanges = []
for (const before of previous.sourceBefore) {
  let content
  try { content = await readFile(path.join(repo, before.file)) } catch { changes.push({ file: before.file, missing: true }); continue }
  const raw = hash(content), canonical = hash(content.toString('utf8').replaceAll('\r\n', '\n'))
  if (raw !== before.raw) (before.file.startsWith('scripts/coordinator/') ? harnessChanges : changes).push({ file: before.file, rawChanged: true, canonicalChanged: canonical !== before.canonical })
}
const commands = previous.commands
const build = commands.find(c => c.operation === 'build'), create = commands.find(c => c.operation === 'create')
const reconciliation = JSON.parse(await readFile(path.join(directory, 'reconciliation.json'), 'utf8'))
const late = reconciliation.createdContainers[0]
const result = { productSourceUnchanged: !changes.length, checkedFiles: previous.sourceBefore.filter(f => !f.file.startsWith('scripts/coordinator/')).length, changes, postRunHarnessChanges: harnessChanges, commandExits: { total: commands.length, zero: commands.filter(c => c.exit === 0).length, nonzero: commands.filter(c => c.exit !== 0 && c.exit !== null).map(c => ({ operation: c.operation, exit: c.exit })), unknown: commands.filter(c => c.exit === null).map(c => ({ operation: c.operation, outcomeUnknown: c.outcomeUnknown })) }, build: { exit: build.exit, durationMs: Date.parse(build.finished) - Date.parse(build.started), timeoutMs: build.timeoutMs }, create: { exit: create.exit, outcomeUnknown: create.outcomeUnknown, timeoutMs: create.timeoutMs, engineCreateAfterInvocationMs: late ? late.createdTimeNano / 1000000 - Date.parse(create.started) : null, createdId: late?.id, destroyed: late?.destroyedTimeNano !== null }, phasePasses: previous.checks.length, originalStatus: previous.status, originalCleanupStatus: previous.cleanup?.status ?? 'not-reported', remaining: reconciliation.latestScopedCleanup.remaining, imageAliasRemoved: reconciliation.latestScopedCleanup.aliasRemoved }
result.productContentHash = hash(JSON.stringify(previous.sourceBefore.filter(f => !f.file.startsWith('scripts/coordinator/'))))
result.images = previous.images
result.gatewayConfigHash = previous.gatewayConfigHash
result.dockerLifecycle = { status: reconciliation.latestScopedCleanup.status, createdContainers: reconciliation.createdContainers.length, allObservedCreatedContainersDestroyed: reconciliation.allObservedCreatedContainersDestroyed }
result.browserLifecycle = previous.browser ? { status: previous.browserClosed === true ? 'stopped' : 'unresolved', exit: previous.browserExit, closeAcknowledged: previous.browserClosed === true, failure_kind: previous.browserClosed === true ? null : 'unexpected-owner-exit-or-close-unconfirmed', cleanup_attempt: 'attempted', cleanup_result: previous.browserClosed === true ? 'stopped' : 'unresolved', evidence_paths: [path.join(directory, 'evidence.json')], final_disposition: { requested: 'Stop', status: previous.browserClosed === true ? 'stopped' : 'unresolved' }, next_owner: previous.browserClosed === true ? null : 'main-session', unresolved_reason: previous.browserClosed === true ? null : 'Browser child exit does not prove its Chrome descendant exit; no current-run close acknowledgement was received.', unresolved_items: previous.browserClosed === true ? [] : ['browser-descendant-exit-proof'], lifecycle_result: { status: previous.browserClosed === true ? 'stopped' : 'unresolved' }, downstream_result: { status: previous.status } } : { status: 'not-launched' }
if (reconciliation.browserOwnerObservation?.status === 'stopped' && reconciliation.browserOwnerObservation.serverCloseObserved && reconciliation.browserOwnerObservation.processExited && !reconciliation.browserOwnerObservation.closeError) {
  result.reconciledBrowserLifecycle = { status: 'stopped', proof: reconciliation.browserOwnerObservation, originalIpcAcknowledgement: previous.browserClosed === true, originalEvidenceModified: false }
}
await writeFile(path.join(directory, 'source-audit.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
assert.ok(result.productSourceUnchanged, 'PRODUCT_SOURCE_CHANGED')
