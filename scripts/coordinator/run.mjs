import assert from 'node:assert/strict'
import { randomBytes, randomUUID, createHash, createHmac } from 'node:crypto'
import { fork, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile, readFile, copyFile, chmod, lstat } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { parseArgs } from 'node:util'
import https from 'node:https'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { owner, label } from './owner.mjs'
import { build, coordinatorSecrets, image as gatewayImage } from '../k8s/coordinator-resources.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url))
let args
try { args = parseArgs({ options: { 'skills-context': { type: 'string' }, 'confirm-native-scope': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } }, allowPositionals: true, strict: true }) }
catch { throw Error('INVALID_RUN_OPTIONS') }
if (args.values.help) { console.log('Usage: node scripts/coordinator/run.mjs --skills-context <absolute-private-bundle-directory> [--confirm-native-scope]'); process.exit(0) }
assert.equal(args.positionals.length, 0, 'UNSUPPORTED_RUN_OPTION')
const skillsContext = args.values['skills-context']
assert.ok(skillsContext, 'SKILLS_CONTEXT_REQUIRED')
assert.ok(path.isAbsolute(skillsContext), 'SKILLS_CONTEXT_MUST_BE_ABSOLUTE')
const bundle = path.resolve(skillsContext)
try { assert.ok((await lstat(bundle)).isDirectory(), 'SKILLS_CONTEXT_NOT_DIRECTORY') }
catch { throw Error('SKILLS_CONTEXT_UNAVAILABLE') }
const temp = path.join(tmpdir(), 'opencode')
await mkdir(temp, { recursive: true })
const directory = await mkdtemp(path.join(temp, 'omw118-formal-'))
const runtime = path.join(directory, 'runtime'), snapshot = path.join(directory, 'source')
await mkdir(runtime); await mkdir(snapshot)
const project = `omw-coord-${randomBytes(8).toString('hex')}`
const confirmNativeScope = args.values['confirm-native-scope'] ?? false
const started = Date.now(), deadline = started + (confirmNativeScope ? 6 : 20) * 60000
const binding = { project, context: 'desktop-linux', image: `${project}:verification`, deadline, watchdogDeadline: started + (confirmNativeScope ? 8 : 22) * 60000, watchdogEvidence: path.join(directory, 'watchdog.json'), browserOwnerRecord: path.join(directory, 'browser-owner.json') }
const evidence = { project, directory, sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', timeout: 10000 }).trim(), started: new Date(started).toISOString(), status: 'running', checks: [], resources: [], commands: [], cleanup: null }
evidence.runScope = confirmNativeScope ? 'bounded-native-scope-confirmation-only' : 'full-integration'
const o = owner(binding, evidence.commands), workers = {}, targets = {}
const secret = () => randomBytes(32).toString('base64url')
const master = secret(), coordinatorPassword = secret(), fixtureControl = secret()
const save = () => writeFile(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2))
// Docker mounts remain read-only. Only the launcher's two dynamic fixture maps
// are host-writable; Windows treats mode 0444 as a persistent read-only attribute.
const privateWrite = (name, value) => writeFile(path.join(runtime, name), typeof value === 'string' ? value : JSON.stringify(value), { mode: ['targets.json', 'routes.json'].includes(name) ? 0o644 : 0o444 })
const sha = value => createHash('sha256').update(value).digest('hex')
const labs = () => ['--label', `${label}=${project}`]
const mount = (source, target) => ['--mount', `type=bind,source=${source.replaceAll('\\', '/')},target=${target},readonly`]
const volume = (source, target) => ['--mount', `type=volume,source=${source},target=${target}`]
const envs = values => Object.entries(values).flatMap(([k, v]) => ['-e', `${k}=${v}`])
let watchdog, browserChild, browserReady, browserExit, browserClosed = false, cert, loopback, phase = 'source-snapshot', coordinator, gateway, network
const calls = new Map(); let sequence = 0
const inspect = async id => JSON.parse(await o.docker(['inspect', id]))[0]
const facts = async id => { const f = await inspect(id); return { id: f.Id, startedAt: f.State.StartedAt, image: f.Image, init: f.HostConfig.Init, privatePID: f.HostConfig.PidMode === '', published: Object.keys(f.HostConfig.PortBindings ?? {}).length, address: f.NetworkSettings.Networks[project]?.IPAddress } }
async function create(name, image, options, command, start = true) {
  const full = `${project}-${name}`
  // Binding is durable before create, including containers whose CLI result is lost.
  evidence.resources.push({ kind: 'container', name: full, id: null, image }); await save()
  const id = await o.docker(['create', '--name', full, ...labs(), ...options, image, ...command], 120000)
  evidence.resources.at(-1).id = id; await save()
  if (start) await o.docker(['start', id], 120000)
  return id
}
async function makeVolume(name) { const id = `${project}-${name}`; evidence.resources.push({ kind: 'volume', id }); await save(); await o.docker(['volume', 'create', ...labs(), id]); return id }
async function until(fn, timeout = 60000) { const end = Math.min(deadline, Date.now() + timeout); while (Date.now() < end) { const value = await fn(); if (value) return value; await delay(500) } throw Error('READINESS_DEADLINE') }
async function check(name, fn) { phase = name; const result = await fn(); evidence.checks.push({ name, result }); await save(); console.log(`PASS ${name}`) }
function browserCall(action, fields = {}, timeout = 60000) {
  return new Promise((resolve, reject) => { if (!browserChild?.connected) return reject(Object.assign(Error('BROWSER_OWNER_NOT_CONNECTED'), { browserStage: evidence.browserProgress })); const id = ++sequence, timer = setTimeout(() => { calls.delete(id); reject(Object.assign(Error('BROWSER_REQUEST_DEADLINE'), { browserStage: evidence.browserProgress, action })) }, timeout); calls.set(id, { resolve, reject, timer }); browserChild.send({ id, action, ...fields }, error => { if (error && calls.has(id)) { calls.delete(id); clearTimeout(timer); reject(Error('BROWSER_IPC_FAILED')) } }) })
}
async function direct(m) {
  return new Promise((resolve, reject) => {
    const bytes = Buffer.from(JSON.stringify(m))
    const request = https.request({ hostname: loopback, port: 443, servername: 'idp.example.test', ca: cert, method: 'POST', path: '/__fixture/request', headers: { host: 'idp.example.test', authorization: `Bearer ${fixtureControl}`, 'content-type': 'application/json', 'content-length': bytes.length }, signal: AbortSignal.timeout(15000), agent: false }, response => { let data = ''; response.on('data', chunk => { data += chunk; if (data.length > 1000000) request.destroy() }); response.on('end', () => { try { assert.equal(response.statusCode, 200, 'FIXTURE_REQUEST'); resolve(JSON.parse(data)) } catch (e) { reject(e) } }); response.on('error', reject) }); request.on('error', reject); request.end(bytes)
  })
}
const api = (id, pathname, method = 'GET', body) => browserCall('api', { pathname: `${workers[id].prefix}/api/v1/${pathname}`, method, body })
const overview = async () => (await direct({ target: 'coordinator', pathname: '/api/v1/coordinator/overview' })).body
async function activeInstance(id, instanceId, throughBrowser = true) {
  const pathname = 'overview?view=compact&scope=current'
  const result = throughBrowser ? await api(id, pathname) : await direct({ target: 'coordinator', pathname: `${workers[id].prefix}/api/v1/${pathname}` })
  assert.equal(result.status, 200, 'CURRENT_OVERVIEW_STATUS')
  const rows = result.body?.instances?.filter(i => i.id === instanceId) ?? []
  assert.equal(rows.length, 1, 'EXACT_ACTIVE_INSTANCE_MISSING'); assert.equal(rows[0].state, 'ready', 'ACTIVE_INSTANCE_NOT_READY')
  return rows[0]
}
const healthMetadataReady = async count => until(async () => {
  let x
  try { x = await overview() } catch { return false } // Startup/renewal only, within this one run's bounded readiness.
  return x?.workers?.length === count && x.workers.every(w => w.health === 'online' && w.freshness === 'fresh' && ['available', 'occupied'].includes(w.capacity?.state)) && x
})
async function initialStartReady(w, count) {
  const container = await create(`${w.id}-readiness`, binding.image, ['--init', '--network', `container:${w.execution}`, ...mount(path.join(runtime, `${w.id}-control`), '/run/control'), ...mount(path.join(repo, 'scripts/coordinator/start-readiness.mjs'), '/fixture/ready.mjs')], ['node', '/fixture/ready.mjs'])
  const helperExit = await o.docker(['wait', container], 30000)
  const execution = JSON.parse(await o.docker(['logs', container], 10000))
  evidence.startReadiness ??= []; evidence.startReadiness.push({ workerId: w.id, helperExit, execution }); await save()
  assert.equal(helperExit, '0', 'INITIAL_EXECUTION_NOT_READY'); assert.equal(execution.ready, true)
  const state = await until(async () => { const x = await overview(); return x?.workers?.length === count && x.workers.find(worker => worker.id === w.id && worker.generation === w.generation)?.capacity?.state === 'available' && x })
  return { workerId: w.id, executionReady: true, capacity: state.workers.find(worker => worker.id === w.id).capacity }
}
async function sourceRecords(copy = false) {
  // The completion report is an output of verification, not one of the frozen
  // 391 product inputs. Keep subsequent runs comparable after writing it.
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: repo, encoding: 'utf8', timeout: 10000 }).split('\0').filter(file => file && file !== 'docs/coordinator-local-verification.md').sort()
  const result = []
  for (const file of files) {
    const content = await readFile(path.join(repo, file))
    result.push({ file, bytes: content.length, raw: sha(content), canonical: sha(content.toString('utf8').replaceAll('\r\n', '\n')) })
    if (copy) { const target = path.join(snapshot, file); await mkdir(path.dirname(target), { recursive: true }); await copyFile(path.join(repo, file), target) }
  }
  return result
}
async function launchWorker(id, kind) {
  const w = workers[id] = { id, kind, generation: randomUUID(), nativeHost: `omw-job-${id}-code.example.test`, password: secret(), control: secret() }
  w.prefix = `/api/v1/coordinator/workers/${id}/${w.generation}/proxy`
  w.key = createHmac('sha256', master).update(id).digest('base64url')
  const home = await makeVolume(`${id}-home`), db = await makeVolume(`${id}-db`), workspace = await makeVolume(`${id}-workspace`)
  for (const [name, value] of [['basic', w.password], ['control', w.control], ['key', w.key]]) await privateWrite(`${id}-${name}`, value)
  const init = await create(`${id}-init`, binding.image, ['--user', 'root', ...volume(home, '/home/node'), ...volume(db, '/data/manager'), ...volume(workspace, '/workspace')], ['node', '-e', `const f=require('fs');for(const p of ['/home/node','/data/manager','/workspace'])f.chownSync(p,1000,1000);f.mkdirSync('/workspace/${id}');f.chownSync('/workspace/${id}',1000,1000);f.writeFileSync('/workspace/${id}/README.md','Synthetic Worker ${id}');`])
  assert.equal(await o.docker(['wait', init]), '0', 'VOLUME_INIT')
  const common = { HOME: '/home/node', OMW_BROWSER_USERNAME: `worker-${id}`, OMW_BROWSER_PASSWORD_FILE: `/run/proof/${id}-basic`, OMW_EXECUTION_TOKEN_FILE: `/run/proof/${id}-control`, OMW_NATIVE_ORIGIN: `https://${w.nativeHost}`, OMW_RUNTIME_PORT: 4096 }
  const workerMounts = ['basic', 'control', 'key'].flatMap(name => mount(path.join(runtime, `${id}-${name}`), `/run/proof/${id}-${name}`))
  w.execution = await create(`${id}-execution`, binding.image, ['--init', '--network', project, ...workerMounts, ...volume(home, '/home/node'), ...volume(workspace, '/workspace'), ...envs({ ...common, OMW_EXECUTION_HOST: '127.0.0.1', OMW_EXECUTION_PORT: 4175, OMW_NATIVE_PORT: 4180, OMW_HEALTH_PORT: 4177, OMW_OPENCODE_EXECUTABLE: '/usr/local/bin/opencode' })], ['node', 'apps/manager/dist/src/worker/execution-server.js'])
  // The controlled launcher obtains the current IP only after engine allocation.
  w.address = (await facts(w.execution)).address
  assert.match(w.address, /^\d+\.\d+\.\d+\.\d+$/, 'ALLOCATED_IPV4')
  targets[id] = { address: w.address, username: `worker-${id}`, password: w.password, control: w.control }
  await privateWrite('targets.json', targets)
  w.managerOptions = ['--init', '--network', `container:${w.execution}`, ...workerMounts, ...volume(db, '/data/manager'), ...envs({ ...common, OMW_MODE: 'worker', OMW_PUBLIC_ORIGIN: 'https://coordinator.example.test', OMW_EXECUTION_ORIGIN: 'http://127.0.0.1:4175', OMW_DATA_DIR: '/data/manager', OMW_PORT: 4174, OMW_HEALTH_PORT: 4176, OMW_COORDINATOR_URL: 'http://coordinator:4174', OMW_COORDINATOR_WORKER_ID: id, OMW_COORDINATOR_WORKER_KIND: kind, OMW_COORDINATOR_WORKER_NAME: `Worker ${id.toUpperCase()}`, OMW_COORDINATOR_GENERATION: w.generation, OMW_COORDINATOR_ADVERTISE_ADDRESS: w.address, OMW_COORDINATOR_WORKER_KEY_FILE: `/run/proof/${id}-key`, OMW_COORDINATOR_REGISTER_INTERVAL_MS: 1000 })]
  w.manager = await create(`${id}-manager`, binding.image, w.managerOptions, ['node', 'apps/manager/dist/src/server.js'])
  return w
}
function runtimeIdentity(instance) { const match = /\/runtime\/([^/]+)\/([^/]+)$/.exec(instance.endpoint); assert.ok(match, 'RUNTIME_IDENTITY_MISSING'); return { epoch: match[1], instanceId: match[2], pid: instance.pid, launchedAt: instance.launchedAt, endpoint: instance.endpoint } }
async function inspectRuntime(id) {
  const w = workers[id]
  const container = await create(`${id}-inspect-${randomBytes(3).toString('hex')}`, binding.image, ['--init', '--network', `container:${w.execution}`, ...mount(path.join(runtime, `${id}-control`), '/run/control'), ...mount(path.join(repo, 'scripts/coordinator/inspect-execution.mjs'), '/fixture/inspect.mjs')], ['node', '/fixture/inspect.mjs', JSON.stringify({ epoch: w.identity.epoch, instanceId: w.instance })])
  assert.equal(await o.docker(['wait', container], 25000), '0', 'EXECUTION_INSPECT_HELPER')
  return JSON.parse(await o.docker(['logs', container]))
}
function emptyNamespace(id, inspected) {
  const w = workers[id], b = inspected.body, e = inspected.execution
  assert.equal(inspected.status, 200, 'STOP_INSPECT_STATUS'); assert.equal(e.status, 200, 'STOP_EXECUTION_STATUS')
  assert.equal(e.body.epoch, w.identity.epoch, 'STOP_CHANGED_EXECUTION_EPOCH'); assert.equal(e.body.capacity, 'available', 'STOP_NAMESPACE_NOT_AVAILABLE')
  // Supervisor currently retains its last accepted identity after Stop. Accept
  // only that exact retained id or null, never a replacement; availability is
  // obtained from a real namespaceProcesses() observation, not a missing count.
  assert.ok(e.body.currentInstance === null || e.body.currentInstance === w.instance, 'STOP_FOREIGN_CURRENT_INSTANCE')
  assert.equal(b.processState, 'not-found', 'STOP_PROCESS_STILL_PRESENT'); assert.equal(b.running, false); assert.equal(b.portAvailable, true, 'STOP_PORT_OCCUPIED')
  if (b.managedProcessCount !== undefined) assert.equal(b.managedProcessCount, 0, 'STOP_NAMESPACE_COUNT_NONZERO')
  return { managedProcessCount: b.managedProcessCount ?? null, countAvailable: b.managedProcessCount !== undefined, executionCapacity: e.body.capacity, currentInstance: e.body.currentInstance, processState: b.processState, portAvailable: b.portAvailable, namespaceEmptyProof: 'actual-execution-capacity-available-and-fresh-inspect-port-available', epochUnchanged: true }
}
try {
   const before = await sourceRecords(true); evidence.sourceBefore = before; evidence.sourceContentHash = sha(JSON.stringify(before)); evidence.productContentHash = sha(JSON.stringify(before.filter(r => !r.file.startsWith('scripts/coordinator/')))); evidence.harnessContentHash = sha(JSON.stringify(before.filter(r => r.file.startsWith('scripts/coordinator/')))); assert.equal(evidence.productContentHash, 'f22ccd3231c28a2c7911ad63d665019856f08b78331deb68f4abe8a85cfc096c', 'FROZEN_PRODUCT_HASH_CHANGED'); await save()
  await writeFile(path.join(directory, 'ownership.json'), JSON.stringify(binding, null, 2))
  watchdog = fork(path.join(repo, 'scripts/coordinator/owner.mjs'), ['--watchdog', path.join(directory, 'ownership.json')], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true })
  await check('01-immutable-full-image-build', async () => {
    evidence.dockerVersion = JSON.parse(await o.docker(['version', '--format', '{{json .}}']))
    evidence.hostNodeVersion = process.version
    evidence.compiledLockHash = sha(await readFile(path.join(repo, 'deploy/worker/skills-bundle/compiled-lock.json')))
    // Current fixture changes stay host-mounted. An older immutable full source
    // snapshot is a cache input only after every product byte matches this round;
    // do not label its old harness bytes as the current harness hash.
    const cacheDirectory = path.join(temp, 'omw118-formal-JwqhH6'), cacheEvidence = JSON.parse(await readFile(path.join(cacheDirectory, 'evidence.json'), 'utf8'))
    const cachedProducts = cacheEvidence.sourceBefore.filter(r => !r.file.startsWith('scripts/coordinator/'))
    assert.deepEqual(cachedProducts, evidence.sourceBefore.filter(r => !r.file.startsWith('scripts/coordinator/')), 'CACHE_PRODUCT_CONTENT_MISMATCH')
    for (const record of cacheEvidence.sourceBefore) assert.equal(sha(await readFile(path.join(cacheDirectory, 'source', record.file))), record.raw, 'IMMUTABLE_CACHE_SNAPSHOT_CHANGED')
    evidence.imageSnapshotFullHash = sha(JSON.stringify(cacheEvidence.sourceBefore)); evidence.imageSnapshotProductHash = sha(JSON.stringify(cachedProducts)); evidence.imageSnapshotHarnessHash = sha(JSON.stringify(cacheEvidence.sourceBefore.filter(r => r.file.startsWith('scripts/coordinator/'))))
    await o.docker(['build', '--progress=plain', '--platform', 'linux/amd64', '--build-context', `worker-skills=${bundle}`, '--label', `${label}=${project}`, '-f', 'deploy/worker/Dockerfile', '-t', binding.image, path.join(cacheDirectory, 'source')], 120000)
    const image = JSON.parse(await o.docker(['image', 'inspect', binding.image]))[0]
    const gateway = JSON.parse(await o.docker(['image', 'inspect', gatewayImage]))[0]
    assert.equal(image.Architecture, 'amd64'); assert.equal(image.Os, 'linux')
    assert.equal(image.Config.Labels['io.omw.opencode.version'], '1.18.34')
    evidence.images = { worker: { id: image.Id, image: binding.image, platform: 'linux/amd64', opencode: '1.18.34' }, gateway: { id: gateway.Id, image: gatewayImage, platform: `${gateway.Os}/${gateway.Architecture}` } }
    const after = await sourceRecords(); evidence.sourceAfterBuild = after
    assert.deepEqual(after, before, 'SOURCE_CHANGED_BY_BUILD')
    return { sourceUnchanged: true, sourceContentHash: evidence.sourceContentHash, ...evidence.images }
  })
  await check('02-formal-coordinator-two-real-worker-pairs', async () => {
    evidence.resources.push({ kind: 'network', name: project, id: null }); await save()
    network = await o.docker(['network', 'create', ...labs(), project]); evidence.resources.at(-1).id = network
    const subnet = JSON.parse(await o.docker(['network', 'inspect', network]))[0].IPAM.Config[0].Subnet
    evidence.allowedCidrs = [subnet]
    const bytes = randomBytes(2); loopback = `127.79.${bytes[0]}.${bytes[1] || 1}`
    const listener = net.createServer(); await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(443, loopback, resolve) }); await new Promise(resolve => listener.close(resolve))
    evidence.loopback = loopback
    await privateWrite('coordinator-basic', coordinatorPassword); await privateWrite('master', master)
    const db = await makeVolume('coordinator-db')
    const init = await create('coordinator-init', binding.image, ['--user', 'root', ...volume(db, '/data/coordinator')], ['node', '-e', "require('fs').chownSync('/data/coordinator',1000,1000)"])
    assert.equal(await o.docker(['wait', init]), '0')
    coordinator = await create('coordinator', binding.image, ['--init', '--network', project, '--network-alias', 'coordinator', '--network-alias', 'omw-coordinator.ai-tools.svc.cluster.local', ...['coordinator-basic', 'master'].flatMap(name => mount(path.join(runtime, name), `/run/proof/${name}`)), ...volume(db, '/data/coordinator'), ...envs({ OMW_MODE: 'coordinator', OMW_PUBLIC_ORIGIN: 'https://coordinator.example.test', OMW_BROWSER_USERNAME: 'omw-coordinator', OMW_BROWSER_PASSWORD_FILE: '/run/proof/coordinator-basic', OMW_DATA_DIR: '/data/coordinator', OMW_PORT: 4174, OMW_HEALTH_PORT: 4176, OMW_COORDINATOR_REGISTRATION_SECRET_FILE: '/run/proof/master', OMW_COORDINATOR_ALLOWED_CIDRS: subnet, OMW_COORDINATOR_NATIVE_HOST_SUFFIX: 'example.test', OMW_COORDINATOR_HEALTH_INTERVAL_MS: 1000, OMW_COORDINATOR_HEALTH_TIMEOUT_MS: 1000, OMW_COORDINATOR_HEALTH_FAILURE_THRESHOLD: 3 })], ['node', 'apps/manager/dist/src/server.js'])
    targets.coordinator = { address: 'coordinator', username: 'omw-coordinator', password: coordinatorPassword }
    await launchWorker('a', 'task'); await launchWorker('b', 'resident')
    const declaration = JSON.parse(await readFile(path.join(repo, 'deploy/k8s/coordinator/example.json'), 'utf8'))
    declaration.issuer = 'https://idp.example.test'; declaration.coordinator.allowedCidrs = [subnet]
    const generated = build(declaration).gateway
    const gatewayConfig = coordinatorSecrets(declaration, generated, { clientSecret: secret(), cookieSecret: randomBytes(32).toString('base64'), sharedSecret: randomBytes(32).toString('base64'), coordinatorPassword, registrationSecret: master })[0].stringData['config.json']
    const parsed = JSON.parse(gatewayConfig)
    await privateWrite('config.json', gatewayConfig); evidence.gatewayConfigHash = sha(gatewayConfig)
    await privateWrite('fixture.json', { clientSecret: parsed.idp_client_secret, control: fixtureControl, deadline: binding.watchdogDeadline })
    await privateWrite('routes.json', ['auth.example.test', 'coordinator.example.test', workers.a.nativeHost, workers.b.nativeHost])
    execFileSync('C:/Program Files/Git/usr/bin/openssl.exe', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(runtime, 'tls.key'), '-out', path.join(runtime, 'tls.crt'), '-days', '1', '-subj', '/CN=synthetic-omw', '-addext', 'subjectAltName=DNS:*.example.test', '-addext', 'basicConstraints=critical,CA:TRUE'], { stdio: 'ignore', timeout: 15000 })
    cert = await readFile(path.join(runtime, 'tls.crt')); await chmod(path.join(runtime, 'tls.key'), 0o444)
    await create('edge', binding.image, ['--init', '--network', project, ...['idp.example.test', 'auth.example.test', 'coordinator.example.test'].flatMap(host => ['--network-alias', host]), '-p', `${loopback}:443:443`, ...mount(runtime, '/run/proof'), ...mount(path.join(repo, 'scripts/coordinator/edge.mjs'), '/fixture/edge.mjs')], ['node', '/fixture/edge.mjs'])
    gateway = await create('gateway', gatewayImage, ['--init', '--network', project, '--network-alias', 'gateway', ...mount(runtime, '/run/proof'), '-e', 'SSL_CERT_FILE=/run/proof/tls.crt'], ['--config', '/run/proof/config.json'])
    evidence.gatewayBefore = await facts(gateway)
    const state = await healthMetadataReady(2)
    await initialStartReady(workers.a, 2); await initialStartReady(workers.b, 2)
    const proofs = []
    for (const w of Object.values(workers)) {
      const nonce = randomBytes(24).toString('base64url')
      const response = await direct({ target: w.id, pathname: `/api/v1/worker/identity?nonce=${nonce}` })
      assert.equal(response.status, 200, 'IDENTITY_STATUS')
      assert.equal(response.body.id, w.id); assert.equal(response.body.generation, w.generation); assert.equal(response.body.nonce, nonce)
      assert.equal(response.body.proof, createHmac('sha256', w.key).update(JSON.stringify(['omw-worker-proof-v1', nonce, w.id, w.generation])).digest('base64url'), 'IDENTITY_HMAC')
      proofs.push({ id: w.id, actualNonceReturned: true, perWorkerHmacVerified: true })
    }
    const coordinatorFacts = await inspect(coordinator)
    assert.ok(!coordinatorFacts.Mounts.some(m => /docker.sock|kube|serviceaccount/.test(m.Destination)), 'COORDINATOR_INFRA_CAPABILITY')
    return { workers: state.workers.map(w => ({ id: w.id, generation: w.generation, address: w.address, kind: w.kind, health: w.health, freshness: w.freshness, capacity: w.capacity })), proofs, formalRegistration: true, noCoordinatorEngineAccess: true, classRouteCount: parsed.routes.length, rendererRoutesUnchanged: true }
  })
  await writeFile(path.join(directory, 'browser.json'), JSON.stringify({ repo, directory, deadline, loopback, coordinatorHost: 'coordinator.example.test' }))
  browserChild = fork(path.join(repo, 'scripts/coordinator/browser.mjs'), [path.join(directory, 'browser.json')], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true })
  browserExit = new Promise(resolve => browserChild.once('exit', code => {
    evidence.browserUnexpectedExit = !browserClosed
    for (const [id, pending] of calls) { clearTimeout(pending.timer); calls.delete(id); pending.reject(Object.assign(Error('BROWSER_OWNER_EXIT'), { browserStage: evidence.browserProgress })) }
    resolve(code)
  }))
  browserReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('BROWSER_LAUNCH_DEADLINE')), 35000)
    browserChild.once('error', () => { clearTimeout(timer); reject(Error('BROWSER_OWNER_SPAWN_FAILED')) })
    browserExit.then(() => { clearTimeout(timer); if (!evidence.browser) reject(Error('BROWSER_OWNER_EXIT_DURING_STARTUP')) })
    browserChild.on('message', m => {
      if (m.progress) { evidence.browserProgress = m.progress; void save() }
      if (m.ready) { clearTimeout(timer); evidence.browser = m; resolve(m) }
      if (m.closeResult) { evidence.browserCloseResult = m.closeResult; browserClosed = Boolean(m.closed) }
      if (m.error && !m.id) { clearTimeout(timer); const error = Object.assign(Error(m.error), { browserStage: m.stage }); reject(error); for (const [id, pending] of calls) { clearTimeout(pending.timer); calls.delete(id); pending.reject(error) } }
      if (m.id && calls.has(m.id)) { const pending = calls.get(m.id); calls.delete(m.id); clearTimeout(pending.timer); m.error ? pending.reject(Object.assign(Error(m.error), { browserStage: m.stage, assertion: m.assertion })) : pending.resolve(m.result) }
    })
  })
  await browserReady
  await check(confirmNativeScope ? '03-bounded-native-scope-confirmation' : '03-synthetic-admin-formal-ui-A-B', async () => {
    await until(async () => { try { return await browserCall('login', {}, 60000) } catch (e) { if (e.browserStage !== 'login') throw e; return false } }, 90000)
    const out = []
    for (const id of confirmNativeScope ? ['a'] : ['a', 'b']) {
      const w = workers[id], result = await browserCall('start', { worker: { id, generation: w.generation, nativeHost: w.nativeHost, prefix: w.prefix } }, 180000)
      w.instance = result.instance.id; w.session = result.sessionId; w.identity = runtimeIdentity(result.instance); w.projectDirectory = result.instance.projectDirectory
      out.push({ id, ...result, identity: w.identity })
    }
    if (confirmNativeScope) return { workers: out, boundedConfirmationOnly: true }
    const wrongInstance = await api('b', `instances/${workers.a.instance}`)
    const wrongSession = await browserCall('native-read', { workerId: 'b', pathname: `/session/${workers.a.session}?${new URLSearchParams({ directory: workers.b.projectDirectory })}` })
    assert.equal(wrongInstance.status, 404); assert.equal(wrongSession.status, 404)
    await browserCall('screenshot-native', { workerId: 'b' })
    return { workers: out, wrongInstance: wrongInstance.status, wrongSession: wrongSession.status, realUI: true, realNativeUI: true, promptsSent: 0 }
  })
  if (!confirmNativeScope) {
  await check('04-third-worker-dynamic-registration-fixed-gateway', async () => {
    assert.equal((await overview()).workers.length, 2)
    const coordinatorBeforeC = await facts(coordinator)
    const w = await launchWorker(`c-${randomBytes(3).toString('hex')}`, 'resident')
    const routes = JSON.parse(await readFile(path.join(runtime, 'routes.json'), 'utf8')); routes.push(w.nativeHost); await privateWrite('routes.json', routes)
    await healthMetadataReady(3); await initialStartReady(w, 3)
    const after = await facts(gateway)
    assert.equal(after.id, evidence.gatewayBefore.id); assert.equal(after.startedAt, evidence.gatewayBefore.startedAt); assert.equal(sha(await readFile(path.join(runtime, 'config.json'))), evidence.gatewayConfigHash)
    assert.deepEqual(await facts(coordinator), coordinatorBeforeC, 'C_REQUIRED_COORDINATOR_RELOAD')
    const nonce = randomBytes(24).toString('base64url'), proof = await direct({ target: w.id, pathname: `/api/v1/worker/identity?nonce=${nonce}` })
    assert.equal(proof.status, 200); assert.equal(proof.body.id, w.id); assert.equal(proof.body.generation, w.generation); assert.equal(proof.body.nonce, nonce); assert.equal(proof.body.proof, createHmac('sha256', w.key).update(JSON.stringify(['omw-worker-proof-v1', nonce, w.id, w.generation])).digest('base64url'))
    const result = await browserCall('start', { worker: { id: w.id, generation: w.generation, nativeHost: w.nativeHost, prefix: w.prefix } }, 180000)
    w.instance = result.instance.id; w.session = result.sessionId; w.identity = runtimeIdentity(result.instance); w.projectDirectory = result.instance.projectDirectory
    const layout = await browserCall('layout', { lastWorker: w.id })
    return { id: w.id, addressAllocatedAfterAB: w.address, generation: w.generation, instanceId: w.instance, sessionId: w.session, startStatus: result.startStatus, sessionStatus: result.sessionStatus, openStatus: result.openStatus, native: result.native, nativePaths: result.nativePaths, layout, gatewayUnchanged: true, configUnchanged: true, coordinatorNotReloaded: true, newActualNonceProofVerified: true, edgeExactRouteAdded: true }
  })
  await check('05-native-SSE-over-30-seconds', async () => { const result = await browserCall('sse', { workerId: 'b' }, 47000); assert.equal(result.status, 200); assert.ok(result.firstEvent && result.durationMs > 30000 && result.ongoing); return { nativeSSE: result, nativeWSClaim: false, WS: '既有 backend TCP tests；本輪不宣稱 native UI WebSocket frames' } })
  await check('06-idle-coordinator-restart-identity-no-replay', async () => {
    const metricsBefore = await browserCall('metrics'), identities = {}
    for (const [id, w] of Object.entries(workers)) {
      const inspected = await inspectRuntime(id)
      assert.equal(inspected.status, 200); assert.equal(inspected.execution.status, 200); assert.equal(inspected.execution.body.epoch, w.identity.epoch)
       assert.equal(inspected.execution.body.currentInstance, w.instance); assert.equal(inspected.body.running, true); assert.equal(inspected.body.rootRunning, true); assert.equal(inspected.body.portOwnerMatched, true)
       assert.equal(inspected.execution.body.currentPid, w.identity.pid, 'IDLE_PID_CHANGED'); assert.equal(inspected.execution.body.currentDirectory, w.projectDirectory, 'IDLE_PROJECT_CHANGED')
      assert.ok(Number.isSafeInteger(inspected.body.managedProcessCount) && inspected.body.managedProcessCount >= 1, 'IDLE_NAMESPACE_COUNT_MISSING')
      identities[id] = { container: await facts(w.execution), runtime: inspected.body, execution: inspected.execution.body }
    }
    await o.docker(['restart', '--time', '3', coordinator], 30000); await healthMetadataReady(3)
    for (const [id, w] of Object.entries(workers)) {
      assert.deepEqual(await facts(w.execution), identities[id].container)
      const detail = await activeInstance(id, w.instance); assert.deepEqual(runtimeIdentity(detail), w.identity)
      assert.equal(detail.projectDirectory, w.projectDirectory); assert.equal(detail.primarySession?.sessionId, w.session)
      const session = await direct({ target: id, port: 4180, host: w.nativeHost, pathname: `/session/${w.session}?${new URLSearchParams({ directory: w.projectDirectory })}` }); assert.equal(session.status, 200); assert.equal(session.body.id, w.session); assert.equal(session.body.directory, w.projectDirectory); assert.ok(!session.body.parentID)
      const runtime = await inspectRuntime(id); assert.equal(runtime.status, 200); assert.deepEqual(runtime.execution.body, identities[id].execution); assert.equal(runtime.body.managedProcessCount, identities[id].runtime.managedProcessCount); assert.equal(runtime.body.running, true); assert.equal(runtime.body.rootRunning, true); assert.ok(runtime.body.portOwnerMatched)
    }
    const metricsAfter = await browserCall('metrics'); assert.equal(metricsAfter.mutations.length, metricsBefore.mutations.length)
    return { executions: identities, instanceSessionRuntimeUnchanged: true, proxyMutationCountBefore: metricsBefore.mutations.length, proxyMutationCountAfter: metricsAfter.mutations.length, fullLLMContinuityClaim: false }
  })
  await check('07-owned-manager-pause-isolation-offline-unknown', async () => {
    await o.docker(['pause', workers.a.manager])
    const unstable = await until(async () => { const x = await overview(); return x.workers.find(w => w.id === 'a').health === 'unstable' && x }, 15000)
    const offline = await until(async () => { const x = await overview(); return x.workers.find(w => w.id === 'a').health === 'offline' && x }, 20000)
    const a = offline.workers.find(w => w.id === 'a'), b = offline.workers.find(w => w.id === 'b')
    assert.ok(a.consecutiveFailures >= 3 && a.endedAt && a.diagnosticCode === 'WORKER_RESULT_UNKNOWN'); assert.equal(b.health, 'online')
    assert.equal((await browserCall('native-read', { workerId: 'b', pathname: '/global/health' })).status, 200)
    await o.docker(['unpause', workers.a.manager]); const restored = await healthMetadataReady(3)
     assert.equal(restored.workers.find(w => w.id === 'a').endedAt, null)
     assert.ok(restored.workers.every(w => workers[w.id].generation === w.generation), 'RECOVERY_GENERATION_CHANGED')
    return { unstableObserved: true, failureThreshold: a.consecutiveFailures, endedAt: a.endedAt, diagnosticCode: a.diagnosticCode, bStillUsable: true, restored: true, taskCompletionClaim: false, generationsUnchanged: restored.workers.every(w => workers[w.id].generation === w.generation) }
  })
  await check('08-live-entry-auth-origin-host-denials', async () => {
    const results = []
    for (const [name, request, expected] of [
      ['no-basic', { target: 'coordinator', pathname: '/', auth: false }, 401],
      ['forged-headers-no-basic', { target: 'coordinator', pathname: '/', auth: false, headers: { 'x-pomerium-claim-groups': 'admin', 'x-forwarded-user': 'forged' } }, 401],
      ['unknown-native', { target: 'coordinator', pathname: '/', host: 'omw-job-unregistered-code.example.test' }, 404],
      ['malformed-class', { target: 'coordinator', pathname: '/', host: 'omw-job--code.example.test' }, 404],
      ['foreign-host', { target: 'coordinator', pathname: '/', host: 'foreign.example.test' }, 404],
      ['cross-worker-origin', { target: 'coordinator', pathname: '/global/health', host: workers.a.nativeHost, origin: `https://${workers.b.nativeHost}` }, 403],
      ['cross-site', { target: 'coordinator', pathname: '/', headers: { 'sec-fetch-site': 'cross-site' } }, 403],
    ]) { const r = await direct(request); assert.equal(r.status, expected, name); results.push({ name, status: r.status }) }
    const browserCross = await browserCall('native-read', { workerId: 'b', pathname: '/global/health', headers: { 'sec-fetch-site': 'cross-site' } })
    // Chromium owns Sec-Fetch-Site and does not allow JS to forge it; direct case above is authoritative.
    const publicEntry = await browserCall('public-denials', {}, 60000)
    return { results, publicEntry, browserRequestStatus: browserCross.status, forbiddenHeaderControlledByBrowser: true, fallbackClaim: false }
  })
  await check('09-public-stop-exact-empty-namespaces', async () => {
    const stopped = []
    for (const [id, w] of Object.entries(workers)) {
      const result = await api(id, `instances/${w.instance}/stop`, 'POST', {})
      assert.equal(result.status, 200); assert.equal(result.body.state, 'stopped'); w.stopped = true
      const inspected = await inspectRuntime(id)
      stopped.push({ workerId: id, status: result.status, ...emptyNamespace(id, inspected) })
    }
    const metrics = await browserCall('metrics'); assert.equal(metrics.promptsSent, 0)
    evidence.metrics = metrics
    return { stopped, promptsSent: 0, taskRunner: false, JobExitClaim: false }
  })
  } else {
    await check('04-confirmation-public-stop-A', async () => {
      const w = workers.a, stop = await api('a', `instances/${w.instance}/stop`, 'POST', {})
      assert.equal(stop.status, 200); assert.equal(stop.body.state, 'stopped'); w.stopped = true
      return { status: stop.status, ...emptyNamespace('a', await inspectRuntime('a')) }
    })
  }
  await check('10-source-unchanged-final', async () => { const after = await sourceRecords(); evidence.sourceAfter = after; assert.deepEqual(after, evidence.sourceBefore, 'SOURCE_CHANGED'); return { rawUnchanged: true, canonicalUnchanged: true, fileCount: after.length } })
  evidence.status = 'passed'
} catch (error) {
  evidence.status = 'failed'; evidence.failedPhase = phase; evidence.error = error.message?.replace(/https?:\/\/\S+/g, '[URL]').slice(0, 160); evidence.browserStage = error.browserStage; evidence.assertion = error.assertion
  if (error.diagnostic) await writeFile(path.join(directory, 'private-command-diagnostic.txt'), error.diagnostic, { mode: 0o600 })
  if (error.output) await writeFile(path.join(directory, 'private-command-output.txt'), error.output, { mode: 0o600 })
  try { evidence.browserCheckpoint = JSON.parse(await readFile(path.join(directory, 'browser-progress.json'), 'utf8')) } catch {}
  // Failure diagnostics are GET-only: collect safe codes/state, never replay a
  // successful Start/Session and never persist a generic response/error body.
  if (phase.startsWith('03') || phase.startsWith('04')) {
    evidence.workerFailureSignals = []
    for (const w of Object.values(workers)) {
      try {
        const capacity = await direct({ target: w.id, pathname: '/api/v1/worker/capacity' }), ov = await direct({ target: w.id, pathname: '/api/v1/overview?view=compact' }), f = await inspect(w.execution)
        evidence.workerFailureSignals.push({ id: w.id, capacityStatus: capacity.status, capacityState: capacity.body?.state, safeErrorCode: /^[A-Z][A-Z0-9_]{0,80}$/.test(capacity.body?.error?.code ?? '') ? capacity.body.error.code : null, overviewStatus: ov.status, instances: ov.body?.instances?.map(i => ({ id: i.id, state: i.state, primarySessionId: i.primarySession?.sessionId ?? null })), execution: { Running: f.State.Running, ExitCode: f.State.ExitCode, OOMKilled: f.State.OOMKilled } })
      } catch { evidence.workerFailureSignals.push({ id: w.id, errorCode: 'DIAGNOSTIC_GET_UNAVAILABLE' }) }
    }
  }
  try { evidence.sourceAfterFailure = await sourceRecords(); evidence.sourceUnchangedOnFailure = JSON.stringify(evidence.sourceBefore) === JSON.stringify(evidence.sourceAfterFailure) } catch {}
} finally {
  // A later verification failure does not replay a successful Start/Session.
  // Stop only the exact ids captured by this run, before owned Docker cleanup.
  if (evidence.status !== 'passed' && evidence.browserCheckpoint?.completedWorkers) {
    evidence.failureStops = []
    for (const item of evidence.browserCheckpoint.completedWorkers) {
      const w = workers[item.id]
      if (!w || w.generation !== item.generation || !item.instanceId || w.stopped) continue
      let stopStage = 'current-overview'
      try {
        const detail = await activeInstance(item.id, item.instanceId, false)
        w.instance = item.instanceId; w.identity = runtimeIdentity(detail)
        stopStage = 'public-stop'
        const stop = await direct({ target: 'coordinator', pathname: `${w.prefix}/api/v1/instances/${item.instanceId}/stop`, method: 'POST', origin: 'https://coordinator.example.test', headers: { 'x-omw-csrf': '1' }, body: {} })
        assert.equal(stop.status, 200, 'FAILURE_STOP_STATUS'); assert.equal(stop.body.state, 'stopped'); w.stopped = true
        stopStage = 'fresh-execution-inspect'
        const after = await inspectRuntime(item.id)
        evidence.failureStops.push({ workerId: item.id, instanceId: item.instanceId, status: stop.status, ...emptyNamespace(item.id, after) })
      } catch (error) { evidence.failureStops.push({ workerId: item.id, instanceId: item.instanceId, errorCode: 'PUBLIC_STOP_UNCONFIRMED', stage: stopStage, assertion: String(error.message).split('\n')[0].replace(/https?:\/\/\S+/g, '[URL]').slice(0, 100), fallback: 'owned-Docker-namespace-cleanup' }) }
    }
  }
  if (browserChild?.connected) browserChild.send({ action: 'close' })
  if (browserExit) { const exit = await Promise.race([browserExit, delay(30000).then(() => 'deadline')]); evidence.browserExit = exit; evidence.browserClosed = browserClosed && exit !== 'deadline' }
  for (const pending of calls.values()) { clearTimeout(pending.timer); pending.reject(Error('FINALIZED')) }
  evidence.cleanup = await o.cleanup()
  if (watchdog?.connected) watchdog.send('finalize')
  if (watchdog) evidence.watchdogExit = await Promise.race([new Promise(resolve => watchdog.once('exit', resolve)), delay(30000).then(() => 'deadline')])
  evidence.lifecycle = { platform: 'Windows', selected_tier: 'external-launcher', owner_binding: { kind: 'official-interface-current-run', project, recordPath: path.join(directory, 'ownership.json') }, final_disposition: { requested: 'Stop', status: evidence.cleanup.status }, lifecycle_result: { status: evidence.cleanup.status }, downstream_result: { status: evidence.status }, os_inspection_performed: false, lifecycle_shell_calls: [], minimum_outcomes: Object.fromEntries(['ownership_binding', 'stdio', 'readiness', 'observation', 'disposition', 'cleanup_or_handoff', 'lifecycle_callback'].map(key => [key, 'owner handled'])) }
  evidence.lifecycle.resourceScope = 'Docker-owned-resources'
  if (browserChild && !evidence.browserClosed) evidence.browserLifecycle = { failure_kind: 'unexpected-owner-exit-or-close-unconfirmed', cleanup_attempt: 'attempted', cleanup_result: 'unresolved', evidence_paths: [path.join(directory, 'evidence.json')], final_disposition: { requested: 'Stop', status: 'unresolved' }, next_owner: 'main-session', unresolved_reason: 'No exact-handle browser close acknowledgement was received; no PID inference or global browser cleanup is authorized.', unresolved_items: ['browser-descendant-exit-proof'], lifecycle_result: { status: 'unresolved' }, downstream_result: { status: evidence.status } }
  evidence.finished = new Date().toISOString(); await save()
  console.log(JSON.stringify({ evidence: path.join(directory, 'evidence.json'), status: evidence.status, failedPhase: evidence.failedPhase, cleanup: evidence.cleanup.status }))
  if (evidence.status !== 'passed' || evidence.cleanup.status !== 'stopped' || (browserChild && !evidence.browserClosed)) process.exitCode = 1
}
