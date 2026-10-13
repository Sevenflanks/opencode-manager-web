// API-only startup checkpoint. No browser, gateway, Start, model or execution-PID helper.
import assert from 'node:assert/strict'
import { fork, execFileSync } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, mkdtemp, lstat } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { owner, label } from './owner.mjs'
import { selectSourceFiles, selectSourceRecords } from './source-selection.mjs'
const repo = fileURLToPath(new URL('../../', import.meta.url))
let args
try { args = parseArgs({ options: { 'skills-context': { type: 'string' }, help: { type: 'boolean', short: 'h' } }, allowPositionals: true, strict: true }) }
catch { throw Error('INVALID_PREFLIGHT_OPTIONS') }
if (args.values.help) { console.log('Usage: node scripts/coordinator/preflight.mjs <prior-run-directory> --skills-context <absolute-private-bundle-directory>'); process.exit(0) }
assert.equal(args.positionals.length, 1, 'PRIOR_RUN_DIRECTORY_REQUIRED')
const priorDirectory = path.resolve(args.positionals[0])
const skillsContext = args.values['skills-context']
assert.ok(skillsContext, 'SKILLS_CONTEXT_REQUIRED')
assert.ok(path.isAbsolute(skillsContext), 'SKILLS_CONTEXT_MUST_BE_ABSOLUTE')
const bundle = path.resolve(skillsContext)
try { assert.ok((await lstat(bundle)).isDirectory(), 'SKILLS_CONTEXT_NOT_DIRECTORY') }
catch { throw Error('SKILLS_CONTEXT_UNAVAILABLE') }
const prior = JSON.parse(await readFile(path.join(priorDirectory, 'evidence.json'), 'utf8'))
const priorSourceBefore = selectSourceRecords(prior.sourceBefore)
const expected = priorSourceBefore.filter(f => !f.file.startsWith('scripts/coordinator/'))
const sha = v => createHash('sha256').update(v).digest('hex')
async function records(root, files) {
  const result = []
  for (const file of files) { const bytes = await readFile(path.join(root, file)); result.push({ file, bytes: bytes.length, raw: sha(bytes), canonical: sha(bytes.toString('utf8').replaceAll('\r\n', '\n')) }) }
  return result
}
const files = selectSourceFiles(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: repo, encoding: 'utf8', timeout: 10000 }).split('\0').filter(Boolean).sort())
const before = await records(repo, files), products = before.filter(f => !f.file.startsWith('scripts/coordinator/'))
assert.deepEqual(products, expected, 'FROZEN_PRODUCT_SOURCE_MISMATCH')
const productHash = sha(JSON.stringify(products))
assert.equal(productHash, 'f22ccd3231c28a2c7911ad63d665019856f08b78331deb68f4abe8a85cfc096c', 'CANDIDATE_CONTENT_BINDING')
const snapshot = path.join(priorDirectory, 'source')
assert.deepEqual(await records(snapshot, expected.map(f => f.file)), expected, 'SNAPSHOT_PRODUCT_CONTENT_MISMATCH')
const snapshotRecords = await records(snapshot, priorSourceBefore.map(f => f.file))
assert.deepEqual(snapshotRecords, priorSourceBefore, 'ORIGINAL_SNAPSHOT_CHANGED')
const temp = path.join(tmpdir(), 'opencode')
await mkdir(temp, { recursive: true })
const directory = await mkdtemp(path.join(temp, 'omw118-preflight-'))
const project = `omw-coord-${randomBytes(8).toString('hex')}`, started = Date.now()
const binding = { project, context: 'desktop-linux', image: `${project}:verification`, deadline: started + 120000, watchdogDeadline: started + 300000, watchdogEvidence: path.join(directory, 'watchdog.json') }
const evidence = { project, directory, started: new Date(started).toISOString(), status: 'running', scope: 'API-only-preflight', productContentHash: productHash, productFileCount: products.length, sourceBefore: products, harnessBefore: before.filter(f => f.file.startsWith('scripts/coordinator/')), originalSnapshot: { directory: snapshot, fullContentHash: sha(JSON.stringify(snapshotRecords)), productContentHash: productHash }, previousBrowser: { status: 'unresolved', ownershipPath: path.join(priorDirectory, 'ownership.json'), browserConfigurationPath: path.join(priorDirectory, 'browser.json'), recoverableOwnerHandleRecorded: false, absoluteChromeUserDataDirRecorded: false, terminationPerformed: false, reason: 'Docker-only binding and browser HOME are not a recoverable Chrome owner handle or explicit userDataDir.' }, commands: [], resources: [], checkpoints: [], observations: [], startRequests: 0, modelRequests: 0, newCredentials: false }
const o = owner(binding, evidence.commands)
const save = () => writeFile(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2))
const persistBinding = () => writeFile(path.join(directory, 'ownership.json'), JSON.stringify(binding, null, 2))
const labs = ['--label', `${label}=${project}`]
const mount = (source, target) => ['--mount', `type=bind,source=${source.replaceAll('\\', '/')},target=${target},readonly`]
const volume = (source, target) => ['--mount', `type=volume,source=${source},target=${target}`]
const envs = values => Object.entries(values).flatMap(([k, v]) => ['-e', `${k}=${v}`])
const privateRoot = path.join(priorDirectory, 'runtime')
const secretMounts = names => names.flatMap(name => mount(path.join(privateRoot, name), `/run/proof/${name}`))
let watchdog, watchdogExit, execution, manager, coordinator, phase = 'image-content-binding'
async function container(name, options, command) {
  if (Date.now() >= binding.deadline) throw Error('PREFLIGHT_WHOLE_DEADLINE')
  const record = { kind: 'container', name: `${project}-${name}`, id: null, image: binding.image }
  evidence.resources.push(record); await save()
  const remaining = () => Math.max(1000, Math.min(120000, binding.deadline - Date.now()))
  record.id = await o.docker(['create', '--name', record.name, ...labs, ...options, binding.image, ...command], remaining()); await save()
  await o.docker(['start', record.id], remaining())
  return record.id
}
async function makeVolume(name) { const id = `${project}-${name}`; evidence.resources.push({ kind: 'volume', id }); await save(); await o.docker(['volume', 'create', ...labs, id]); return id }
async function state(id) { const f = JSON.parse(await o.docker(['container', 'inspect', id]))[0]; return { id: f.Id, image: f.Image, Running: f.State.Running, Status: f.State.Status, ExitCode: f.State.ExitCode, OOMKilled: f.State.OOMKilled, StartedAt: f.State.StartedAt, FinishedAt: f.State.FinishedAt, privatePID: f.HostConfig.PidMode === '', init: f.HostConfig.Init, publishedPorts: Object.keys(f.HostConfig.PortBindings ?? {}).length, address: f.NetworkSettings.Networks[project]?.IPAddress } }
async function logSignals(id) {
  const text = await o.docker(['logs', '--tail', '60', id], 10000)
  // Interpret exact known startup markers; never persist or print service logs.
  const definitions = [['namespace-owner', 'Execution supervisor 必須是專用 Linux PID namespace'], ['auth-seed', 'OMW_AUTH_SEED_FILE 初始化失敗'], ['profile', 'OMW_WORKER_PROFILE_SOURCE 初始化失敗'], ['dependencies', 'OMW_WORKER_DEPENDENCIES_SOURCE 初始化失敗'], ['github', 'OMW_GITHUB_TOKEN_FILE 初始化失敗'], ['profile-collision', 'OMW_WORKER_PROFILE_COLLISION'], ['profile-migration', 'OMW_WORKER_PROFILE_MIGRATION_RETRY']]
  return { inspectedTailLines: 60, nonemptyLines: text.split('\n').filter(Boolean).length, stages: definitions.filter(([, literal]) => text.includes(literal)).map(([stage]) => stage), errorCodes: ['EACCES', 'EPERM', 'ENOENT', 'ESRCH', 'EADDRINUSE', 'ERR_MODULE_NOT_FOUND'].filter(code => new RegExp(`\\b${code}\\b`).test(text)), rawLogsSaved: false }
}
try {
  await save(); await persistBinding()
  watchdog = fork(path.join(repo, 'scripts/coordinator/owner.mjs'), ['--watchdog', path.join(directory, 'ownership.json')], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true })
  watchdogExit = new Promise(resolve => watchdog.once('exit', resolve))
  // The old content ID was removed with its alias. One bounded same-snapshot
  // cache build is allowed; this is not another full integration attempt.
  await o.docker(['build', '--progress', 'plain', '--platform', 'linux/amd64', '--build-context', `worker-skills=${bundle}`, '--label', `${label}=${project}`, '-f', 'deploy/worker/Dockerfile', '-t', binding.image, snapshot], 120000)
  const image = JSON.parse(await o.docker(['image', 'inspect', binding.image]))[0]
  assert.equal(image.Config.Labels['io.omw.opencode.version'], '1.18.34'); assert.equal(image.Architecture, 'amd64'); assert.equal(image.Os, 'linux')
  evidence.image = { id: image.Id, alias: binding.image, productContentHash: productHash, snapshotFullContentHash: evidence.originalSnapshot.fullContentHash, platform: 'linux/amd64', opencodeLabel: '1.18.34', priorMissingImageId: prior.images.worker.id }
  // Independent workload bound starts after artifact preparation.
  binding.deadline = Date.now() + 120000; await persistBinding(); evidence.workloadStarted = new Date().toISOString(); await save()
  phase = 'startup'
  const networkRecord = { kind: 'network', name: project, id: null }; evidence.resources.push(networkRecord); await save()
  networkRecord.id = await o.docker(['network', 'create', ...labs, project]); await save()
  const subnet = JSON.parse(await o.docker(['network', 'inspect', networkRecord.id]))[0].IPAM.Config[0].Subnet
  evidence.allowedCidrs = [subnet]
  const coordDb = await makeVolume('coordinator-db'), home = await makeVolume('a-home'), db = await makeVolume('a-db'), workspace = await makeVolume('a-workspace')
  const init = await container('init', ['--user', 'root', ...volume(coordDb, '/data/coordinator'), ...volume(home, '/home/node'), ...volume(db, '/data/manager'), ...volume(workspace, '/workspace')], ['node', '-e', "const f=require('fs');for(const p of ['/data/coordinator','/home/node','/data/manager','/workspace'])f.chownSync(p,1000,1000);f.mkdirSync('/workspace/a');f.chownSync('/workspace/a',1000,1000);f.writeFileSync('/workspace/a/README.md','Synthetic Worker a');"])
  assert.equal(await o.docker(['wait', init], 10000), '0', 'OWNED_VOLUME_INITIALIZATION')
  coordinator = await container('coordinator', ['--init', '--network', project, '--network-alias', 'coordinator', ...secretMounts(['coordinator-basic', 'master']), ...volume(coordDb, '/data/coordinator'), ...envs({ OMW_MODE: 'coordinator', OMW_PUBLIC_ORIGIN: 'https://coordinator.example.test', OMW_BROWSER_USERNAME: 'omw-coordinator', OMW_BROWSER_PASSWORD_FILE: '/run/proof/coordinator-basic', OMW_DATA_DIR: '/data/coordinator', OMW_PORT: 4174, OMW_HEALTH_PORT: 4176, OMW_COORDINATOR_REGISTRATION_SECRET_FILE: '/run/proof/master', OMW_COORDINATOR_ALLOWED_CIDRS: subnet, OMW_COORDINATOR_NATIVE_HOST_SUFFIX: 'example.test', OMW_COORDINATOR_HEALTH_INTERVAL_MS: 1000, OMW_COORDINATOR_HEALTH_TIMEOUT_MS: 1000, OMW_COORDINATOR_HEALTH_FAILURE_THRESHOLD: 3 })], ['node', 'apps/manager/dist/src/server.js'])
  const common = { HOME: '/home/node', OMW_BROWSER_USERNAME: 'worker-a', OMW_BROWSER_PASSWORD_FILE: '/run/proof/a-basic', OMW_EXECUTION_TOKEN_FILE: '/run/proof/a-control', OMW_NATIVE_ORIGIN: 'https://omw-job-a-code.example.test', OMW_RUNTIME_PORT: 4096 }
  execution = await container('a-execution', ['--init', '--network', project, ...secretMounts(['a-basic', 'a-control']), ...volume(home, '/home/node'), ...volume(workspace, '/workspace'), ...envs({ ...common, OMW_EXECUTION_HOST: '127.0.0.1', OMW_EXECUTION_PORT: 4175, OMW_NATIVE_PORT: 4180, OMW_HEALTH_PORT: 4177, OMW_OPENCODE_EXECUTABLE: '/usr/local/bin/opencode' })], ['node', 'apps/manager/dist/src/worker/execution-server.js'])
  await delay(1000)
  const first = await state(execution)
  evidence.checkpoints.push({ stage: 'execution-after-start-before-manager', at: new Date().toISOString(), state: first, logSignals: await logSignals(execution) }); await save()
  if (!first.Running) { evidence.diagnosis = { classification: 'execution-container-exited-before-manager', startReadiness: false }; evidence.status = 'diagnosed'; }
  else {
    const generation = prior.checks.find(c => c.name === '02-formal-coordinator-two-real-worker-pairs').result.workers.find(w => w.id === 'a').generation
    manager = await container('a-manager', ['--init', '--network', `container:${execution}`, ...secretMounts(['a-basic', 'a-control', 'a-key']), ...volume(db, '/data/manager'), ...envs({ ...common, OMW_MODE: 'worker', OMW_PUBLIC_ORIGIN: 'https://coordinator.example.test', OMW_EXECUTION_ORIGIN: 'http://127.0.0.1:4175', OMW_DATA_DIR: '/data/manager', OMW_PORT: 4174, OMW_HEALTH_PORT: 4176, OMW_COORDINATOR_URL: 'http://coordinator:4174', OMW_COORDINATOR_WORKER_ID: 'a', OMW_COORDINATOR_WORKER_KIND: 'task', OMW_COORDINATOR_WORKER_NAME: 'Worker A', OMW_COORDINATOR_GENERATION: generation, OMW_COORDINATOR_ADVERTISE_ADDRESS: first.address, OMW_COORDINATOR_WORKER_KEY_FILE: '/run/proof/a-key', OMW_COORDINATOR_REGISTER_INTERVAL_MS: 1000 })], ['node', 'apps/manager/dist/src/server.js'])
    for (let attempt = 0; attempt < 3 && Date.now() < binding.deadline - 20000; attempt++) {
      phase = 'GET-only-execution-and-capacity'
      const helper = await container(`probe-${attempt}`, ['--init', '--network', `container:${execution}`, ...secretMounts(['a-basic', 'a-control', 'coordinator-basic']), ...mount(path.join(repo, 'scripts/coordinator/preflight-probe.mjs'), '/fixture/probe.mjs')], ['node', '/fixture/probe.mjs'])
      assert.equal(await o.docker(['wait', helper], 30000), '0', 'READONLY_PROBE_EXIT')
      const result = JSON.parse(await o.docker(['logs', helper], 10000))
      evidence.observations.push({ at: new Date().toISOString(), result, executionState: await state(execution), managerState: await state(manager) }); await save()
      if (result.execution.status === 200 && result.execution.state === 'available' && result.capacity.status === 200 && result.capacity.state === 'available' && result.executionHealth.status === 200 && result.executionHealth.payloadStatus === 'ok' && result.managerHealth.status === 200 && result.managerHealth.payloadStatus === 'ok' && result.coordinator.workers?.some(w => w.id === 'a' && w.health === 'online' && w.freshness === 'fresh' && w.capacity === 'available')) break
      await delay(1500)
    }
    const last = evidence.observations.at(-1)
    assert.ok(last, 'NO_STARTUP_CHECKPOINT_OBSERVED')
    evidence.checkpoints.push({ stage: 'final-start-readiness', execution: await state(execution), manager: await state(manager), coordinator: await state(coordinator), executionLogs: await logSignals(execution), managerLogs: await logSignals(manager) })
    const ready = last.result.execution.status === 200 && last.result.execution.state === 'available' && last.result.capacity.status === 200 && last.result.capacity.state === 'available' && last.result.executionHealth.status === 200 && last.result.executionHealth.payloadStatus === 'ok' && last.result.managerHealth.status === 200 && last.result.managerHealth.payloadStatus === 'ok'
    evidence.diagnosis = { classification: !last.executionState.Running ? 'execution-container-exited' : ready ? 'stage-ready-capacity-available' : last.result.execution.state === 'unknown' && last.result.executionHealth.status === 200 ? 'initialized-execution-returns-unknown' : 'startup-not-ready-or-transport-unavailable', startReadiness: ready, modelReadinessClaim: false }
    evidence.status = 'diagnosed'
  }
} catch (error) {
  evidence.status = 'failed'; evidence.failedPhase = phase
  evidence.errorCode = /^[A-Z_0-9-]{1,80}$/.test(error.message ?? '') ? error.message : 'PREFLIGHT_ERROR_REDACTED'
  if (execution) { try { evidence.checkpoints.push({ stage: 'failure', state: await state(execution), logSignals: await logSignals(execution) }) } catch {} }
} finally {
  evidence.cleanup = await o.cleanup()
  if (watchdog?.connected) watchdog.send('finalize')
  if (watchdogExit) evidence.watchdogExit = await Promise.race([watchdogExit, delay(30000).then(() => 'deadline')])
  const afterFiles = selectSourceFiles(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: repo, encoding: 'utf8', timeout: 10000 }).split('\0').filter(Boolean).sort())
  const after = await records(repo, afterFiles)
  evidence.sourceAfter = after.filter(f => !f.file.startsWith('scripts/coordinator/'))
  evidence.harnessAfter = after.filter(f => f.file.startsWith('scripts/coordinator/'))
  evidence.productSourceUnchanged = JSON.stringify(evidence.sourceAfter) === JSON.stringify(products)
  evidence.harnessSourceUnchangedDuringRun = JSON.stringify(evidence.harnessBefore) === JSON.stringify(evidence.harnessAfter)
  evidence.finished = new Date().toISOString(); evidence.lifecycle = { platform: 'Windows', selected_tier: 'external-launcher', owner_binding: { kind: 'official-interface-current-run', project, recordPath: path.join(directory, 'ownership.json') }, resourceScope: 'this-run-Docker-resources-only', final_disposition: { requested: 'Stop', status: evidence.cleanup.status }, lifecycle_result: { status: evidence.cleanup.status }, downstream_result: { status: evidence.status }, minimum_outcomes: Object.fromEntries(['ownership_binding', 'stdio', 'readiness', 'observation', 'disposition', 'cleanup_or_handoff', 'lifecycle_callback'].map(key => [key, 'owner handled'])) }
  await save()
  console.log(JSON.stringify({ evidence: path.join(directory, 'evidence.json'), status: evidence.status, diagnosis: evidence.diagnosis, cleanup: evidence.cleanup.status, previousBrowser: 'unresolved', productSourceUnchanged: evidence.productSourceUnchanged }))
  if (evidence.status !== 'diagnosed' || evidence.cleanup.status !== 'stopped' || !evidence.productSourceUnchanged) process.exitCode = 1
}
