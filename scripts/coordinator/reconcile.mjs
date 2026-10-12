// Post-failure official-ID audit. Keeps the original failure/uncertainty unchanged.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createRequire } from 'node:module'
import { owner, label } from './owner.mjs'
const directory = path.resolve(process.argv[2])
const binding = JSON.parse(await readFile(path.join(directory, 'ownership.json'), 'utf8'))
const previous = JSON.parse(await readFile(path.join(directory, 'evidence.json'), 'utf8'))
assert.equal(binding.project, previous.project)
let browserOwnerObservation, browserRecovery
if (process.argv.includes('--recover-current-browser')) {
  const ownerPath = path.join(directory, 'browser-owner.json'), recoveryPath = path.join(directory, 'browser-recovery.json')
  assert.equal(path.resolve(binding.browserOwnerRecord), ownerPath, 'CURRENT_BROWSER_RECORD_MISMATCH')
  const b = JSON.parse(await readFile(ownerPath, 'utf8'))
  assert.equal(b.kind, 'PlaywrightBrowserServer', 'OFFICIAL_BROWSER_OWNER_REQUIRED')
  assert.equal(path.resolve(b.ownerRecord), ownerPath, 'BROWSER_RECORD_SCOPE_MISMATCH')
  const endpoint = new URL(b.wsEndpoint)
  assert.ok(endpoint.protocol === 'ws:' && endpoint.hostname === '127.0.0.1' && !endpoint.username && !endpoint.password, 'LOCAL_OWNER_ENDPOINT_REQUIRED')
  browserRecovery = { scope: 'recorded-current-run-browser-only', status: 'connecting', launchPerformed: false, terminationPerformed: false, profileMatched: false, closeProtocolAcknowledged: false, rawErrorSaved: false }
  await writeFile(recoveryPath, JSON.stringify(browserRecovery), { flag: 'wx', mode: 0o600 })
  const bounded = promise => Promise.race([promise, delay(10000).then(() => { throw Error('BROWSER_RECOVERY_DEADLINE') })])
  let browser
  try {
    const require = createRequire(new URL('../../apps/web/package.json', import.meta.url))
    browser = await require('playwright-core').chromium.connect(b.wsEndpoint, { timeout: 10000 })
    const cdp = await bounded(browser.newBrowserCDPSession())
    const { arguments: args } = await bounded(cdp.send('Browser.getBrowserCommandLine'))
    const profileArg = args.find(value => value.startsWith('--user-data-dir='))
    assert.ok(profileArg, 'RECOVERY_PROFILE_MISSING')
    const relative = path.relative(path.join(directory, 'browser-home'), path.resolve(profileArg.slice('--user-data-dir='.length)))
    assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'RECOVERY_PROFILE_OUTSIDE_CURRENT_RUN')
    browserRecovery.profileMatched = true
    browserRecovery.status = 'owned-browser-close-requested'
    await writeFile(recoveryPath, JSON.stringify(browserRecovery))
    // CDP addresses this positively identified fixture Chrome, not a PID/name.
    // A disconnected transport is NOT accepted as OS process termination proof.
    browserRecovery.closeCommandIssued = true; browserRecovery.terminationPerformed = null
    await writeFile(recoveryPath, JSON.stringify(browserRecovery))
    await bounded(cdp.send('Browser.close'))
    browserRecovery.terminationPerformed = true; browserRecovery.closeProtocolAcknowledged = true
    browserRecovery.status = 'awaiting-official-owner-process-exit-proof'
  } catch (error) {
    browserRecovery.status = 'unresolved'
    browserRecovery.closeOutcomeUnknown = browserRecovery.closeCommandIssued === true && !browserRecovery.closeProtocolAcknowledged
    browserRecovery.safeErrorCode = /ECONNREFUSED/.test(String(error.message)) ? 'ECONNREFUSED' : /timeout|DEADLINE/i.test(String(error.message)) ? 'BROWSER_RECOVERY_DEADLINE' : 'BROWSER_RECOVERY_UNCONFIRMED'
  } finally {
    if (browser) await bounded(browser.close()).catch(() => {})
    await writeFile(recoveryPath, JSON.stringify(browserRecovery, null, 2))
  }
}
if (process.argv.includes('--await-browser-finalize') || browserRecovery) {
  const browserOwnerPath = path.join(directory, 'browser-owner.json')
  assert.equal(path.resolve(binding.browserOwnerRecord), browserOwnerPath, 'CURRENT_BROWSER_RECORD_MISMATCH')
  const end = browserRecovery ? Date.now() + 15000 : Math.min(Date.now() + 8 * 60000, binding.watchdogDeadline + 30000)
  do {
    try {
      const b = JSON.parse(await readFile(browserOwnerPath, 'utf8'))
      browserOwnerObservation = { recordPath: browserOwnerPath, status: b.status, serverCloseObserved: b.serverCloseObserved === true, processExited: b.processExited === true, closeError: b.closeError ?? null }
      if (b.status === 'stopped' && b.serverCloseObserved && b.processExited && !b.closeError) break
    } catch {}
    await delay(1000)
  } while (Date.now() < end)
}
const commands = [], o = owner(binding, commands), until = new Date().toISOString()
const raw = await o.docker(['events', '--since', previous.started, '--until', until, '--filter', `label=${label}=${binding.project}`, '--format', '{{json .}}'], 30000)
const events = raw.split('\n').filter(Boolean).map(line => JSON.parse(line)).map(e => ({ type: e.Type, action: e.Action, id: e.Actor?.ID, name: e.Actor?.Attributes?.name, timeNano: e.timeNano, ownerLabel: e.Actor?.Attributes?.[label] }))
const cleanup = await o.cleanup()
const created = events.filter(e => e.type === 'container' && e.action === 'create')
const destroyed = events.filter(e => e.type === 'container' && e.action === 'destroy')
const accounted = created.map(c => ({ id: c.id, name: c.name, createdTimeNano: c.timeNano, destroyedTimeNano: destroyed.find(d => d.id === c.id)?.timeNano ?? null }))
const result = { project: binding.project, originalStatus: previous.status, originalCleanupStatus: previous.cleanup?.status ?? 'not-reported', originalUncertainCommands: previous.cleanup?.uncertainCommands ?? null, browserRecovery, browserOwnerObservation, events, createdContainers: accounted, allObservedCreatedContainersDestroyed: accounted.length > 0 && accounted.every(c => c.destroyedTimeNano !== null), latestScopedCleanup: cleanup, commands, auditUntil: until, originalEvidenceModified: false }
await writeFile(path.join(directory, 'reconciliation.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
if (cleanup.status !== 'stopped' || !result.allObservedCreatedContainersDestroyed || (browserOwnerObservation && browserOwnerObservation.status !== 'stopped')) process.exitCode = 1
