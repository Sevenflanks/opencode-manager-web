import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { build, buildWorker, buildJobIngress, deriveWorkerKey, coordinatorSecrets, workerSecrets, validate, validateWorker } from './coordinator-resources.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const config = JSON.parse(await readFile(new URL('../../deploy/k8s/coordinator/example.json', import.meta.url), 'utf8'))
const worker = JSON.parse(await readFile(new URL('../../deploy/k8s/coordinator/worker.example.json', import.meta.url), 'utf8'))
const c = () => structuredClone(config), w = () => structuredClone(worker)
const find = (items, kind, name) => items.find(r => r.kind === kind && r.metadata.name === name)
const env = container => Object.fromEntries(container.env.map(e => [e.name, e.value ?? e.valueFrom]))
const job = () => ({ apiVersion: 'batch/v1', kind: 'Job', metadata: { namespace: 'ai-tools', name: 'omw-job-example-a', uid: '12345678-abcd-4321-abcd-123456789abc', labels: { 'app.kubernetes.io/part-of': 'omw', 'omw.io/identity': 'omw-job-example-a', 'omw.io/coordinator-worker': 'true' } } })
// Synthetic test-only values; real credentials are never read by this suite.
const registrationSecret = 'synthetic-registration-secret-000001'
const values = { clientSecret: 'synthetic-oidc', cookieSecret: Buffer.alloc(32, 1).toString('base64'), sharedSecret: Buffer.alloc(32, 2).toString('base64'), coordinatorPassword: 'synthetic-coordinator-password', registrationSecret }

test('Coordinator has no cluster authority; private/control ports are never Services', () => {
  const { items } = build(c())
  assert.equal(items.some(r => /Role|ServiceAccount|Job|PersistentVolume/.test(r.kind)), false)
  const p = find(items, 'Deployment', 'omw-coordinator').spec.template.spec
  assert.equal(p.automountServiceAccountToken, false)
  assert.equal(p.hostPID, false)
  assert.equal(p.shareProcessNamespace, false)
  assert.equal(p.containers.length, 1)
  assert.deepEqual(p.containers[0].command, ['/usr/bin/tini', '--', 'node', 'apps/manager/dist/src/server.js'])
  assert.equal(p.securityContext.runAsUser, 1000)
  const e = env(p.containers[0])
  assert.equal(e.OMW_MODE, 'coordinator')
  assert.equal(e.OMW_PUBLIC_ORIGIN, 'https://coordinator.example.test')
  assert.equal(e.OMW_COORDINATOR_ALLOWED_CIDRS, '10.42.0.0/16')
  assert.equal(e.OMW_COORDINATOR_NATIVE_HOST_SUFFIX, 'example.test')
  assert.equal(e.OMW_COORDINATOR_REGISTRATION_SECRET_FILE, '/run/registration/registration_secret')
  assert.equal(e.OMW_COORDINATOR_HEALTH_FAILURE_THRESHOLD, '3')
  assert.deepEqual(items.filter(r => r.kind === 'Service').flatMap(r => r.spec.ports.map(p => p.port)).sort(), [4174, 8080])
  assert.deepEqual(p.volumes.find(v => v.name === 'registry'), { name: 'registry', emptyDir: {} })
  const persistent = c(); persistent.coordinator.registryClaimName = 'omw-registry-existing'
  assert.equal(find(build(persistent).items, 'Deployment', 'omw-coordinator').spec.template.spec.volumes.find(v => v.name === 'registry').persistentVolumeClaim.claimName, 'omw-registry-existing')
})

test('third Job changes only exact ingress: class route, callback and IdP configuration stay fixed', () => {
  const before = build(c())
  const third = w(); third.id = 'third'; third.secretName = 'omw-third-auth'; third.keySecretName = 'omw-third-key'; delete third.nativeHost
  const created = job(); created.metadata.name = 'omw-job-third'; created.metadata.labels['omw.io/identity'] = 'omw-job-third'
  const ingress = buildJobIngress(c(), third, created)
  assert.equal(ingress.spec.rules[0].host, 'omw-job-third-code.example.test')
  assert.deepEqual(ingress.spec.rules[0].http.paths[0].backend, { service: { name: 'omw-gateway', port: { number: 8080 } } })
  assert.deepEqual(ingress.metadata.ownerReferences, [{ apiVersion: 'batch/v1', kind: 'Job', name: 'omw-job-third', uid: '12345678-abcd-4321-abcd-123456789abc', controller: true, blockOwnerDeletion: false }])
  assert.deepEqual(build(c()).gateway, before.gateway)
  assert.equal(before.gateway.routes.length, 2)
  assert.deepEqual(before.gateway.routes.map(r => [r.from, r.to]), [['https://coordinator.example.test', 'http://omw-coordinator.ai-tools.svc.cluster.local:4174'], ['https://omw-job-*-code.example.test', 'http://omw-coordinator.ai-tools.svc.cluster.local:4174']])
  assert.equal(before.gateway.authenticate_service_url, 'https://auth.example.test')
  assert.equal(before.gateway.idp_client_id, 'omw')
  assert.equal('cookie_domain' in before.gateway, false)
  for (const r of before.gateway.routes) {
    assert.equal(r.preserve_host_header, true)
    assert.equal(r.pass_identity_headers, false)
    assert.equal(r.allow_websockets, true)
    assert.equal(r.timeout, '0s'); assert.equal(r.idle_timeout, '0s')
    assert.equal('allow_any_authenticated_user' in r || 'allow_public_unauthenticated_access' in r, false)
  }
  for (const i of [...before.items.filter(r => r.kind === 'Ingress'), ingress]) assert.equal(i.spec.rules.some(r => r.host.includes('*')), false)
})

test('malformed IDs, foreign parents, class collisions and unknown owner UID fail closed', () => {
  for (const id of ['', '-a', 'a-', 'A', 'a.b', '*', 'a'.repeat(41)]) { const x = w(); x.id = id; delete x.nativeHost; assert.throws(() => validateWorker(c(), x)) }
  for (const nativeHost of ['other-example-a-code.example.test', 'omw-job--code.example.test', 'omw-job-a.b-code.example.test', 'omw-job-example-a-code.other.test', '*.example.test']) { const x = w(); x.nativeHost = nativeHost; assert.throws(() => buildWorker(c(), x)) }
  for (const host of ['*.example.test', 'coordinator.other.test', 'omw-job--code.example.test']) { const x = c(); x.coordinator.host = host; assert.throws(() => build(x)) }
  for (const change of [j => delete j.metadata.uid, j => { j.metadata.uid = 'UNKNOWN' }, j => { j.metadata.namespace = 'other' }, j => { j.metadata.name = 'other' }, j => { delete j.metadata.labels }]) { const j = job(); change(j); assert.throws(() => buildJobIngress(c(), w(), j)) }
})

test('NetworkPolicies protect only owned project peers and permit only the three fixed remote ports', () => {
  const { items } = build(c())
  const coord = find(items, 'NetworkPolicy', 'omw-coordinator').spec
  const workers = find(items, 'NetworkPolicy', 'omw-coordinator-workers').spec
  const gateway = find(items, 'NetworkPolicy', 'omw-gateway').spec
  for (const r of [coord, workers, gateway]) {
    assert.equal(r.podSelector.matchLabels['app.kubernetes.io/part-of'], 'omw')
    assert.deepEqual(r.policyTypes, ['Ingress', 'Egress'])
  }
  assert.deepEqual(workers.ingress[0].ports.map(p => p.port), [4174, 4176, 4180])
  assert.deepEqual(workers.ingress[0].from, [{ podSelector: { matchLabels: { 'app.kubernetes.io/part-of': 'omw', 'omw.io/identity': 'coordinator' } } }])
  assert.deepEqual(coord.egress[1].to, [{ podSelector: { matchLabels: { 'app.kubernetes.io/part-of': 'omw', 'omw.io/coordinator-worker': 'true' } } }])
  assert.deepEqual(coord.egress[1].ports.map(p => p.port), [4174, 4176, 4180])
  assert.deepEqual(workers.egress[2].ports.map(p => p.port), [4174])
  assert.deepEqual(gateway.egress[2].ports.map(p => p.port), [4174])
  assert.deepEqual(gateway.ingress[0].from, [config.edgePeer])
  for (const cidrs of [[], ['::1/128'], ['10.42.0.1'], ['10.42.0.1/33'], ['999.1.1.1/8'], ['10.0.0.0/8\n'], ['0.0.0.0/0'], ['10.42.0.1/16']]) { const x = c(); x.coordinator.allowedCidrs = cidrs; assert.throws(() => validate(x)) }
  for (const [key, value] of [['healthTimeoutMs', 10001], ['healthIntervalMs', 3600001], ['failureThreshold', 101]]) { const x = c(); x.coordinator[key] = value; assert.throws(() => build(x)) }
})

test('Worker Pod UID/IP are downward fields; execution sees neither registration master nor worker key', () => {
  const { template, workload } = buildWorker(c(), w())
  assert.equal(workload, undefined) // No misleading auto-completing HelloTask Job.
  const [manager, execution] = template.spec.containers
  const m = env(manager), e = env(execution)
  assert.deepEqual(m.OMW_COORDINATOR_GENERATION, { fieldRef: { fieldPath: 'metadata.uid' } })
  assert.deepEqual(m.OMW_COORDINATOR_ADVERTISE_ADDRESS, { fieldRef: { fieldPath: 'status.podIP' } })
  assert.equal(m.OMW_COORDINATOR_URL, 'http://omw-coordinator:4174')
  assert.equal(m.OMW_PUBLIC_ORIGIN, 'https://coordinator.example.test')
  assert.equal(m.OMW_NATIVE_ORIGIN, 'https://omw-job-example-a-code.example.test')
  assert.equal(e.OMW_EXECUTION_HOST, '127.0.0.1')
  assert.equal(e.OMW_EXECUTION_PORT, '4175')
  assert.equal(execution.volumeMounts.some(m => m.name === 'worker-key'), false)
  assert.equal(Object.keys(e).some(k => k.startsWith('OMW_COORDINATOR_')), false)
  assert.equal(JSON.stringify(template).includes(config.coordinator.registrationSecretName), false)
  assert.equal(manager.volumeMounts.some(m => m.name === 'workspace'), false)
  const x = w(); x.seed = { claimName: 'omw-protected-seed', subPath: '.', authFile: 'auth.json' }
  const seeded = buildWorker(c(), x).template.spec
  assert.equal(seeded.volumes.find(v => v.name === 'seed').persistentVolumeClaim.readOnly, true)
  assert.equal(seeded.containers[1].volumeMounts.find(v => v.name === 'seed').readOnly, true)
  for (const subPath of ['../private', '/shared', 'C:\\shared', '..\\other']) { x.seed.subPath = subPath; assert.throws(() => buildWorker(c(), x)) }
})

test('only supplied two-container exit commands yield a non-retrying Job; resident is Deployment', () => {
  const x = w(); x.taskCommands = { manager: ['node', '/external/manager-exit.mjs'], execution: ['node', '/external/execution-task.mjs'] }
  const { workload } = buildWorker(c(), x)
  assert.equal(workload.kind, 'Job')
  assert.equal(workload.spec.backoffLimit, 0)
  assert.equal(workload.spec.template.spec.restartPolicy, 'Never')
  assert.equal(workload.spec.ttlSecondsAfterFinished, 600)
  assert.deepEqual(workload.spec.template.spec.containers.map(c => c.command), [['/usr/bin/tini', '--', 'node', '/external/manager-exit.mjs'], ['/usr/bin/tini', '--', 'node', '/external/execution-task.mjs']])
  delete x.taskCommands.execution; assert.throws(() => buildWorker(c(), x))
  const resident = w(); resident.kind = 'resident'
  assert.equal(buildWorker(c(), resident).workload.kind, 'Deployment')
})

test('private render isolates Basic, master secret and distinct deterministic per-worker HMAC keys', () => {
  const publicResult = build(c())
  const secrets = coordinatorSecrets(c(), publicResult.gateway, values)
  const privateGateway = JSON.parse(secrets[0].stringData['config.json'])
  for (const r of privateGateway.routes) {
    assert.equal(r.set_request_headers.Authorization, 'Basic ' + Buffer.from('omw-coordinator:synthetic-coordinator-password').toString('base64'))
    assert.equal(r.remove_request_headers.includes('Authorization'), false)
  }
  const credentials = { registrationSecret, password: 'synthetic-worker-A-password', executionToken: 'synthetic-worker-A-control-token-0001' }
  const a = workerSecrets(c(), w(), credentials)
  const second = w(); second.id = 'example-b'; second.secretName = 'omw-job-example-b-auth-v1'; second.keySecretName = 'omw-job-example-b-key-v1'; delete second.nativeHost
  const b = workerSecrets(c(), second, { ...credentials, password: 'synthetic-worker-B-password', executionToken: 'synthetic-worker-B-control-token-0002' })
  assert.notEqual(a[1].stringData.worker_key, b[1].stringData.worker_key)
  assert.equal(a[1].stringData.worker_key, '3xFLZb_ZURLNMuDgww-5cJIpQx6vxMgGwQZ59jWmsQU')
  assert.equal(deriveWorkerKey(registrationSecret, 'example-a'), '3xFLZb_ZURLNMuDgww-5cJIpQx6vxMgGwQZ59jWmsQU')
  assert.match(a[1].stringData.worker_key, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(a[0].stringData.browser_password, 'synthetic-worker-A-password')
  assert.equal(JSON.stringify(a).includes(registrationSecret), false)
  assert.equal(JSON.stringify(publicResult).includes(values.coordinatorPassword), false)
  assert.equal(JSON.stringify(publicResult).includes('Basic '), false)
  assert.equal(JSON.stringify(buildWorker(c(), w())).includes(a[1].stringData.worker_key), false)
  assert.throws(() => workerSecrets(c(), w(), { ...credentials, executionToken: registrationSecret }))
})

test('existing standalone exact routes remain isolated; roles reject scalar/null and empty list is deny-all', () => {
  const x = c(); x.standaloneWorkers = [{ name: 'alpha', managerHost: 'alpha.example.test', nativeHost: 'alpha-native.example.test', secretName: 'omw-alpha-auth', browserUsername: 'omw' }]
  const { items, gateway } = build(x)
  assert.equal(gateway.routes[2].from, 'https://alpha.example.test')
  assert.equal(gateway.routes[3].to, 'http://omw-alpha.ai-tools.svc.cluster.local:4180')
  assert.deepEqual(find(items, 'Ingress', 'omw-gateway').spec.rules.map(r => r.host), ['auth.example.test', 'coordinator.example.test', 'alpha.example.test', 'alpha-native.example.test'])
  for (const allowedRoles of ['admin', null, [1]]) { const x = c(); x.allowedRoles = allowedRoles; assert.throws(() => build(x)) }
  const denied = c(); denied.allowedRoles = []
  assert.match(build(denied).gateway.routes[0].sub_policies[0].rego[0], /allowed := \[\]/)
})

test('actual public/private CLIs render offline, keep secrets out of public files/stdout and reject missing UID', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'opencode', 'omw-coordinator-render-test-'))
  // Trap subprocess/network attempts at the actual CLI boundary, not by trusting a counter.
  const hook = path.join(dir, 'offline-hook.mjs')
  await writeFile(hook, `import cp from 'node:child_process';import http from 'node:http';import https from 'node:https';import net from 'node:net';import {syncBuiltinESMExports} from 'node:module';const deny=()=>{throw new Error('OFFLINE_ONLY')};for(const k of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[k]=deny;http.request=http.get=https.request=https.get=deny;net.connect=net.createConnection=deny;globalThis.fetch=deny;syncBuiltinESMExports();`)
  const run = (script, args) => spawnSync(process.execPath, ['--import', pathToFileURL(hook).href, path.join(root, 'scripts/k8s', script), ...args], { cwd: root, encoding: 'utf8', timeout: 15000 })
  const configPath = path.join(root, 'deploy/k8s/coordinator/example.json'), workerPath = path.join(root, 'deploy/k8s/coordinator/worker.example.json')
  const out = path.join(dir, 'public')
  const r = run('coordinator-render.mjs', ['--config', configPath, '--out', out])
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual((await readdir(out)).sort(), ['gateway-public.json', 'inventory.json', 'kustomization.yaml', 'resources.json'])
  assert.equal(JSON.parse(await readFile(path.join(out, 'resources.json'), 'utf8')).items.some(r => r.kind === 'Secret'), false)
  assert.deepEqual(JSON.parse(await readFile(path.join(out, 'kustomization.yaml'), 'utf8')).resources, ['resources.json'])
  const refs = {}
  for (const [field, value] of Object.entries(values)) { const p = path.join(dir, field); await writeFile(p, value); refs[field + 'File'] = p }
  const privatePath = path.join(dir, 'private.json'); await writeFile(privatePath, JSON.stringify(refs))
  const privateOut = path.join(dir, 'private')
  const p = run('coordinator-render.mjs', ['--config', configPath, '--out', privateOut, '--private', privatePath])
  assert.equal(p.status, 0, p.stderr)
  assert.equal((await readFile(path.join(privateOut, 'private-secrets.json'), 'utf8')).includes(registrationSecret), true)
  for (const file of ['gateway-public.json', 'resources.json', 'inventory.json', 'kustomization.yaml']) {
    const content = await readFile(path.join(privateOut, file), 'utf8')
    assert.equal(content.includes(registrationSecret) || content.includes(values.coordinatorPassword) || content.includes('Basic '), false)
  }
  assert.equal((p.stdout + p.stderr).includes(registrationSecret), false)
  const workerRefs = { registrationSecretFile: refs.registrationSecretFile }
  for (const [field, value] of Object.entries({ password: 'synthetic-worker-A-password', executionToken: 'synthetic-worker-A-control-token-0001' })) {
    const file = path.join(dir, 'worker-' + field); await writeFile(file, value); workerRefs[field + 'File'] = file
  }
  const workerPrivate = path.join(dir, 'worker-private.json'); await writeFile(workerPrivate, JSON.stringify(workerRefs))
  const privateWorkerOut = path.join(dir, 'private-worker')
  const wp = run('coordinator-job.mjs', ['--config', configPath, '--worker', workerPath, '--out', privateWorkerOut, '--private', workerPrivate])
  assert.equal(wp.status, 0, wp.stderr)
  const bundle = JSON.parse(await readFile(path.join(privateWorkerOut, 'private-secrets.json'), 'utf8'))
  assert.equal(bundle.items[1].stringData.worker_key, '3xFLZb_ZURLNMuDgww-5cJIpQx6vxMgGwQZ59jWmsQU')
  const publicWorker = await readFile(path.join(privateWorkerOut, 'worker-pod-template.json'), 'utf8')
  assert.equal(publicWorker.includes('synthetic-worker-A-password') || publicWorker.includes(bundle.items[1].stringData.worker_key), false)
  assert.equal(JSON.stringify(bundle).includes(registrationSecret), false)
  assert.equal((wp.stdout + wp.stderr).includes(bundle.items[1].stringData.worker_key), false)
  const j = run('coordinator-job.mjs', ['--config', configPath, '--worker', workerPath, '--out', path.join(dir, 'job')])
  assert.equal(j.status, 0, j.stderr)
  assert.deepEqual(await readdir(path.join(dir, 'job')), ['worker-pod-template.json'])
  const badJob = path.join(dir, 'bad-job.json'); const missing = job(); delete missing.metadata.uid; await writeFile(badJob, JSON.stringify(missing))
  const bad = run('coordinator-job.mjs', ['--config', configPath, '--worker', workerPath, '--out', path.join(dir, 'bad'), '--created-job', badJob])
  assert.equal(bad.status, 1)
  const repeat = run('coordinator-render.mjs', ['--config', configPath, '--out', out]); assert.equal(repeat.status, 1)
  // Compare generated artifacts to the established renderer rather than a second handwritten oracle.
  const baseOut = path.join(dir, 'base')
  const base = run('render.mjs', ['--config', path.join(root, 'deploy/k8s/example.json'), '--out', baseOut])
  assert.equal(base.status, 0, base.stderr)
  const established = JSON.parse(await readFile(path.join(baseOut, 'gateway-public.json'), 'utf8'))
  assert.deepEqual(JSON.parse(await readFile(path.join(out, 'gateway-public.json'), 'utf8')).routes[0].sub_policies, established.routes[0].sub_policies)
})
