import assert from 'node:assert/strict'
import test from 'node:test'
import { validateConfig, imagePatch, deploy, createPlan, releaseGate, hash, validatePlan, reconcile, managerInspection, workspaceInspection } from './deploy-core.mjs'
import { main, parseArgs, processRunner } from './deploy.mjs'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'

const digest = `sha256:${'a'.repeat(64)}`
const fixtureTemp = process.env.OMW_TEST_TMP_DIR ?? os.tmpdir()
const config = () => ({ repository: 'Sevenflanks/opencode-manager-web', namespace: 'ai-tools', context: 'operator-context', targets: ['omw-beta', 'omw-alpha'], tag: 'v0.8.0', sha: 'b'.repeat(40), expectedManagerVersion: '0.8.0', image: `registry.example.test/private/worker@${digest}`, configDigest: `sha256:${'c'.repeat(64)}` })
const deployment = () => ({ metadata: { name: 'omw-beta', namespace: 'ai-tools', uid: 'deployment-uid', resourceVersion: '12', generation: 1 }, spec: { replicas: 1, strategy: { type: 'Recreate' }, template: { spec: { containers: [{ name: 'manager', image: 'old' }, { name: 'execution', image: 'old' }] } } } })

test('tracer 1: wrong namespace/role/tag/SHA fail closed', () => {
  assert.doesNotThrow(() => validateConfig(config()))
  for (const change of [{ namespace: 'default' }, { targets: ['omw-gateway'] }, { targets: ['omw-alpha', 'omw-beta'] }, { tag: 'latest' }, { sha: 'main' }]) {
    assert.throws(() => validateConfig({ ...config(), ...change }))
  }
})

test('tracer 2: single CAS tests UID/RV/container names/old images, replaces only images', () => {
  const patch = imagePatch(deployment(), config().image)
  assert.deepEqual(patch.filter(p => p.op === 'replace').map(p => p.path), ['/spec/template/spec/containers/0/image', '/spec/template/spec/containers/1/image'])
  for (const field of ['/metadata/uid', '/metadata/resourceVersion', '/spec/template/spec/containers/0/name', '/spec/template/spec/containers/1/name', '/spec/template/spec/containers/0/image', '/spec/template/spec/containers/1/image']) assert.ok(patch.some(p => p.op === 'test' && p.path === field))
})

test('tracer 3: default deploy is offline preview, with no runner or journal writes', async () => {
  const result = await deploy({ config: config(), digest: 'plan-digest' }, { runner: () => assert.fail('process launch'), checkpoint: () => assert.fail('journal write') })
  assert.equal(result.status, 'preview')
})

function fixture(options = {}) {
  const manifest = JSON.stringify({ schemaVersion: 2, config: { digest: config().configDigest }, layers: [] })
  const childDigest = hash(manifest)
  const index = JSON.stringify({ schemaVersion: 2, manifests: [{ digest: childDigest, platform: { os: 'linux', architecture: 'amd64' } }] })
  const c = { ...config(), image: `registry.example.test/private/worker@${hash(index)}` }
  const deployments = Object.fromEntries(['omw-beta', 'omw-alpha', 'omw-gateway'].map(name => {
    const d = deployment()
    d.metadata = { ...d.metadata, name, uid: `${name}-uid` }
    d.status = { observedGeneration: 1, readyReplicas: 1, updatedReplicas: 1 }
    if (name === 'omw-gateway') d.spec.template.spec.containers = [{ name: 'pomerium', image: 'gateway-image' }]
    return [name, d]
  }))
  const calls = [], records = [], data = Object.fromEntries(['omw-beta', 'omw-alpha'].map(name => [name, { ok: true, mode: 'worker', managerVersion: '0.7.0', publicCapacity: 'available', controlCapacity: 'available', epoch: `${name}-epoch`, execution: null, currentCount: 0, pendingCount: 0, namespaceMembers: 0, historyRevision: 'empty-history', history: [] }]))
  const inventories = Object.fromEntries(['omw-beta', 'omw-alpha'].map(name => [name, { ok: true, entries: [], profile: { configReadable: true, skills: 66 }, fileContentsRead: false, authDatabaseRead: false, contentOwnershipVerified: false }]))
  function resources() {
    const sets = [], pods = []
    for (const [name, d] of Object.entries(deployments)) {
      const rs = { metadata: { name: `${name}-rs`, namespace: 'ai-tools', uid: `${name}-rs-${d.metadata.generation}`, ownerReferences: [{ kind: 'Deployment', uid: d.metadata.uid, controller: true }] }, spec: { template: structuredClone(d.spec.template) } }
      sets.push(rs)
      pods.push({ metadata: { name: `${name}-pod`, namespace: 'ai-tools', uid: `${name}-pod-${d.metadata.generation}`, resourceVersion: '1', ownerReferences: [{ kind: 'ReplicaSet', uid: rs.metadata.uid, controller: true }] }, spec: structuredClone(d.spec.template.spec), status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: d.spec.template.spec.containers.map(v => ({ name: v.name, ready: true, state: { running: {} }, containerID: `${name}-${v.name}-${d.metadata.generation}`, restartCount: 0, imageID: d.metadata.generation > 1 ? `${c.image.split('@')[0]}@${childDigest}` : 'old-image-id' })) } })
    }
    options.resources?.(sets, pods)
    return { sets, pods }
  }
  const runner = async (executable, args, settings) => {
    calls.push({ executable, args, settings })
    options.onCall?.(executable, args)
    let result
    if (executable === 'gh') {
      const endpoint = args[1]
      if (endpoint.includes('/releases/tags/')) result = { tag_name: c.tag, draft: false, prerelease: false, published_at: '2026-10-09T00:00:00Z', ...options.release }
      else if (endpoint.includes('/git/ref/')) result = { object: { type: options.annotated ? 'tag' : 'commit', sha: options.annotated ? 'd'.repeat(40) : c.sha } }
      else if (endpoint.includes('/git/tags/')) result = { object: { type: options.tagLoop ? 'tag' : 'commit', sha: options.tagLoop ? 'd'.repeat(40) : c.sha } }
      else if (endpoint.includes('/runs?')) result = { workflow_runs: [{ id: 1, path: '.github/workflows/release.yml', head_repository: { full_name: c.repository }, head_sha: c.sha, status: 'completed', conclusion: 'success', ...options.run }] }
      else if (endpoint.includes('/jobs?')) result = { total_count: 1, jobs: [{ name: 'publish-release', status: 'completed', conclusion: 'success', ...options.job }] }
      else assert.fail(`unhandled gh ${endpoint}`)
    } else if (executable === 'npm') result = options.npmVersion ?? c.expectedManagerVersion
    else if (executable === 'docker') {
      if (options.registryFailure) return { code: 1, stdout: '401 Authorization: secret-value', stderr: 'secret-value' }
      if (args.includes('--raw')) return { code: 0, stdout: args.at(-1) === c.image ? index : manifest }
      result = { os: 'linux', architecture: 'amd64', config: { Labels: { 'org.opencontainers.image.revision': c.sha, 'org.opencontainers.image.version': c.expectedManagerVersion, ...options.labels } } }
    } else if (executable === 'kubectl') {
      assert.deepEqual(args.slice(0, 5), ['--context', c.context, '--namespace', 'ai-tools', '--request-timeout=25s'])
      const op = args[5], kind = args[6]
      if (op === 'get') {
        if (kind === 'deployment') result = deployments[args[7]]
        else if (kind === 'replicasets') result = { items: resources().sets }
        else if (kind === 'pods') result = { items: resources().pods }
        else assert.fail(`unexpected read ${kind}`)
      } else if (op === 'exec') {
        const target = kind.replace(/-pod$/, '')
        const script = args.at(-1)
        assert.ok(!script.includes("method: 'POST'"))
        if (args[8] === 'manager') result = data[target]
        else { assert.equal(args[8], 'execution'); result = inventories[target] }
      } else if (op === 'patch') {
        assert.equal(records.at(-1).status, 'intent', 'durable checkpoint must precede patch')
        const target = args[7]
        const patch = JSON.parse(await options.readPatch(args[args.indexOf('--patch-file') + 1]))
        assert.equal(patch.filter(v => v.op === 'replace').length, 2)
        const d = deployments[target]
        for (const change of patch.filter(v => v.op === 'replace')) d.spec.template.spec.containers[Number(change.path.split('/')[5])].image = change.value
        d.metadata.generation++; d.metadata.resourceVersion = String(Number(d.metadata.resourceVersion) + 1); d.status.observedGeneration = d.metadata.generation
        data[target].managerVersion = c.expectedManagerVersion
        data[target].epoch = `${target}-new-epoch`
        if (options.betaHealthFailure && target === 'omw-beta') data[target].publicCapacity = 'unknown'
        if (options.protectedDrift) deployments['omw-gateway'].spec.template.spec.containers[0].image = 'unexpected-change'
        if (options.lostReply) return { code: null, stdout: '', timedOut: true, producer: { rootPid: 456 } }
        result = d
      } else assert.fail(`write outside scope ${op}`)
    } else assert.fail(`unexpected ${executable}`)
    return { code: 0, stdout: JSON.stringify(result) }
  }
  const patchFiles = new Map()
  options.readPatch = async filename => patchFiles.get(filename)
  return { c, calls, records, data, inventories, deployments, runner, options, childDigest,
    execution: { execute: true, runner, maintenanceWindow: true, checkpoint: async record => records.push(structuredClone(record)), patchFile: async (target, patch) => { const filename = `${target}-patch`; patchFiles.set(filename, JSON.stringify(patch)); return filename }, rolloutTimeoutMs: 100, sleep: async () => {} } }
}

test('plan gate peels annotated tag, validates remote tuple, snapshots identities and never mutates', async () => {
  const f = fixture({ annotated: true })
  const plan = await createPlan(f.c, f.runner)
  validatePlan(plan)
  assert.equal(plan.image.childDigest, f.childDigest)
  assert.equal(plan.baseline['omw-beta'].pod.ownerUid, 'omw-beta-rs-1')
  assert.equal(plan.data['omw-alpha'].contentOwnershipVerified, false)
  assert.ok(f.calls.every(call => call.executable !== 'kubectl' || ['get', 'exec'].includes(call.args[5])))
  assert.ok(f.calls.every(call => !['push', 'build', 'apply', 'delete', 'scale'].some(arg => call.args.includes(arg))))
})

for (const [name, options, code] of [
  ['draft release', { release: { draft: true } }, 'RELEASE_NOT_PUBLISHED'],
  ['unpublished release', { release: { published_at: null } }, 'RELEASE_NOT_PUBLISHED'],
  ['failed workflow', { run: { conclusion: 'failure' } }, 'PUBLISH_RELEASE_NOT_SUCCESSFUL'],
  ['wrong workflow SHA', { run: { head_sha: 'e'.repeat(40) } }, 'PUBLISH_RELEASE_NOT_SUCCESSFUL'],
  ['foreign repository', { run: { head_repository: { full_name: 'someone/else' } } }, 'PUBLISH_RELEASE_NOT_SUCCESSFUL'],
  ['wrong workflow path', { run: { path: '.github/workflows/other.yml' } }, 'PUBLISH_RELEASE_NOT_SUCCESSFUL'],
  ['skipped publish job', { job: { conclusion: 'skipped' } }, 'PUBLISH_RELEASE_NOT_SUCCESSFUL'],
  ['release-please alone', { job: { name: 'release-please' } }, 'PUBLISH_RELEASE_NOT_SUCCESSFUL'],
  ['missing npm version', { npmVersion: '0.7.0' }, 'NPM_VERSION_NOT_PUBLISHED'],
  ['annotated cycle', { annotated: true, tagLoop: true }, 'TAG_PEEL_INVALID'],
]) test(`gate rejects ${name} before kubectl`, async () => {
  const f = fixture(options)
  await assert.rejects(createPlan(f.c, f.runner), new RegExp(code))
  assert.ok(!f.calls.some(c => c.executable === 'kubectl'))
})

test('tag commit mismatch refuses even successful workflow', async () => {
  const f = fixture()
  await assert.rejects(releaseGate({ ...f.c, sha: 'e'.repeat(40) }, f.runner), /RELEASE_TAG_SHA_MISMATCH/)
})
test('registry 401 is unknown, not absent; no stdout/stderr credential leakage', async () => {
  const f = fixture({ registryFailure: true })
  await assert.rejects(createPlan(f.c, f.runner), error => error.message === 'COMMAND_FAILED_OR_UNKNOWN' && !error.message.includes('secret-value'))
  assert.ok(!f.calls.some(c => c.executable === 'kubectl'))
})
test('remote source labels must match immutable release SHA', async () => {
  const f = fixture({ labels: { 'org.opencontainers.image.revision': 'e'.repeat(40) } })
  await assert.rejects(createPlan(f.c, f.runner), /IMAGE_SOURCE_LABEL_MISMATCH/)
})

for (const [field, value] of [['publicCapacity', 'unknown'], ['controlCapacity', 'occupied'], ['currentCount', 1], ['pendingCount', 1], ['namespaceMembers', null], ['history', null]]) test(`plan rejects busy/unknown ${field}`, async () => {
  const f = fixture(); f.data['omw-beta'][field] = value
  await assert.rejects(createPlan(f.c, f.runner), /WORKER_BUSY_OR_METADATA_UNKNOWN/)
  assert.equal(f.calls.filter(c => c.args.includes('patch')).length, 0)
})
test('unknown workspace metadata refuses plan', async () => {
  const f = fixture(); f.inventories['omw-beta'] = { ok: false }
  await assert.rejects(createPlan(f.c, f.runner), /FILESYSTEM_METADATA_UNKNOWN/)
})
test('foreign owner UID cannot be adopted based on Pod prefix', async () => {
  const f = fixture({ resources: (sets, pods) => { pods[0].metadata.ownerReferences[0].uid = 'foreign-rs' } })
  await assert.rejects(createPlan(f.c, f.runner), /POD_IDENTITY_AMBIGUOUS/)
})

test('deploy beta then alpha: exactly one images-only CAS each, receipts and preserved Pods', async () => {
  const f = fixture(); const plan = await createPlan(f.c, f.runner)
  const result = await deploy(plan, { ...f.execution, ackDiscard: plan.digest })
  assert.equal(result.status, 'complete')
  assert.deepEqual(f.calls.filter(c => c.args[5] === 'patch').map(c => c.args[7]), ['omw-beta', 'omw-alpha'])
  assert.deepEqual(f.records.map(r => r.status), ['intent', 'accepted', 'verified', 'intent', 'accepted', 'verified', 'complete'])
  assert.equal(f.records.at(-1).pods, 'preserved')
  assert.equal(result.businessProof, false)
})
test('beta-only never patches alpha', async () => {
  const f = fixture(); f.c.targets = ['omw-beta']; const plan = await createPlan(f.c, f.runner)
  await deploy(plan, { ...f.execution, ackDiscard: plan.digest })
  assert.equal(f.calls.filter(c => c.args[5] === 'patch').length, 1)
})
for (const [name, changes] of [['missing discard ack', { ackDiscard: undefined }], ['wrong plan digest', { ackDiscard: 'wrong' }], ['missing maintenance window', { maintenanceWindow: false }], ['missing private journal', { checkpoint: undefined }]]) test(`deploy rejects ${name} before command`, async () => {
  const f = fixture(); const plan = await createPlan(f.c, f.runner); const count = f.calls.length
  await assert.rejects(deploy(plan, { ...f.execution, ackDiscard: plan.digest, ...changes }))
  assert.equal(f.calls.length, count)
})
for (const [name, drift] of [
  ['Pod UID', f => { f.options.resources = (sets, pods) => { pods[0].metadata.uid = 'new-foreign-uid' } }],
  ['resourceVersion', f => { f.deployments['omw-beta'].metadata.resourceVersion = '99' }],
  ['history IDs', f => { f.data['omw-beta'].history.push({ id: 'new-history', state: 'stopped', projectDirectory: '/workspace/new', sessionId: null }) }],
  ['workspace new files', f => { f.inventories['omw-beta'].entries.push({ path: '/new.txt', type: 'file', size: 0, mtimeMs: 1, ctimeMs: 1, inode: 1, mode: 1 }) }],
  ['control epoch', f => { f.data['omw-beta'].epoch = 'new-epoch' }],
]) test(`fresh ${name} drift requires a new plan, never patches`, async () => {
  const f = fixture(); const plan = await createPlan(f.c, f.runner); drift(f)
  await assert.rejects(deploy(plan, { ...f.execution, ackDiscard: plan.digest }), /DRIFT/)
  assert.equal(f.calls.filter(c => c.args[5] === 'patch').length, 0)
})
test('beta postverify failure never proceeds to alpha', async () => {
  const f = fixture({ betaHealthFailure: true }); const plan = await createPlan(f.c, f.runner)
  await assert.rejects(deploy(plan, { ...f.execution, ackDiscard: plan.digest }), /WORKER_BUSY_OR_METADATA_UNKNOWN/)
  assert.deepEqual(f.calls.filter(c => c.args[5] === 'patch').map(c => c.args[7]), ['omw-beta'])
  assert.equal(f.records.at(-1).status, 'halted')
})
test('lost reply records unresolved, never resends/rolls back; readonly reconcile is not success', async () => {
  const f = fixture({ lostReply: true }); const plan = await createPlan(f.c, f.runner)
  await assert.rejects(deploy(plan, { ...f.execution, ackDiscard: plan.digest }), /PATCH_RESULT_UNKNOWN/)
  assert.equal(f.calls.filter(c => c.args[5] === 'patch').length, 1)
  assert.equal(f.records.find(r => r.status === 'unresolved').reason, 'PATCH_RESULT_UNKNOWN_READONLY_RECONCILE_REQUIRED')
  assert.deepEqual(f.records.find(r => r.status === 'unresolved').producer, { rootPid: 456, descendantExitVerified: false })
  const observation = await reconcile(plan, f.runner)
  assert.equal(observation.targets[0].classification, 'new-image-observed-not-completion-proof')
  assert.equal(f.calls.filter(c => c.args[5] === 'patch').length, 1)
})
test('non-target/gateway drift after patch blocks alpha', async () => {
  const f = fixture({ protectedDrift: true }); const plan = await createPlan(f.c, f.runner)
  await assert.rejects(deploy(plan, { ...f.execution, ackDiscard: plan.digest }), /PROTECTED_RESOURCE_DRIFT/)
  assert.equal(f.calls.filter(c => c.args[5] === 'patch').length, 1)
})
test('plan tampering fails hash binding', async () => {
  const f = fixture(); const plan = await createPlan(f.c, f.runner); plan.data['omw-beta'].epoch = 'tampered'
  await assert.rejects(deploy(plan, { ...f.execution, ackDiscard: plan.digest }), /PLAN_DIGEST_MISMATCH/)
})
test('CLI parser defaults readonly and rejects unknown/duplicate/unsafe mutation options', () => {
  assert.equal(parseArgs([]).phase, 'help')
  assert.equal(parseArgs(['plan', '--config', 'fixture.json']).execute, undefined)
  for (const args of [['deploy', '--plan', 'p', '--execute'], ['plan', '--config', 'c', '--out', 'o'], ['plan', '--config', 'c', '--config', 'c'], ['plan', '--config', 'c', '--namespace', 'default'], ['status', '--journal', 'j', '--execute']]) assert.throws(() => parseArgs(args))
})

test('public CLI creates exclusive private journal, preview has no commands; finally removes fixtures', async () => {
  const scratch = await mkdtemp(path.join(fixtureTemp, 'omw-deploy-test-'))
  try {
    const { writeFile } = await import('node:fs/promises')
    const f = fixture(); const input = path.join(scratch, 'config.json'); await writeFile(input, JSON.stringify(f.c))
    await main(['plan', '--config', input], { runner: f.runner, print: () => {} })
    assert.deepEqual(await readdir(scratch), ['config.json'], 'default plan does not persist artifacts')
    const out = path.join(scratch, 'plan')
    const plan = await main(['plan', '--config', input, '--execute', '--out', out], { runner: f.runner, print: () => {} })
    assert.ok((await readdir(out)).includes('plan.json'))
    const count = f.calls.length
    const result = await main(['deploy', '--plan', path.join(out, 'plan.json')], { runner: () => assert.fail('preview process launch'), print: () => {} })
    assert.equal(result.status, 'preview'); assert.equal(f.calls.length, count)
    assert.equal((await readdir(scratch)).length, 2)
    await assert.rejects(main(['plan', '--config', input, '--execute', '--out', out], { runner: f.runner, print: () => {} }), /EEXIST/)
    assert.equal(JSON.parse(await readFile(path.join(out, 'plan.json'), 'utf8')).digest, plan.digest)
  } finally { await rm(scratch, { recursive: true, force: true }) }
})

test('real runner executes argument arrays with shell disabled and suppresses stderr', async () => {
  const result = await processRunner(process.execPath, ['-e', 'process.stdout.write(process.argv[1]);process.stderr.write("synthetic-secret")', 'space & ; $value'], { timeout: 5000 })
  assert.equal(result.code, 0); assert.equal(result.stdout, 'space & ; $value')
  assert.ok(!JSON.stringify(result).includes('synthetic-secret'))
})

function managerApiFixture(connectivityOverride = {}) {
  const responses = {
    '/v1/execution': { epoch: 'epoch', execution: null, capacity: 'available' },
    '/api/v1/connectivity': {
      checkedAt: '2026-10-09T00:00:00Z', mode: 'worker', remoteAccess: 'disabled',
      manager: { localUrl: 'http://127.0.0.1:4174', publicUrl: 'https://worker.example.test', version: '0.8.0' },
      tailscale: { state: 'unavailable', dnsName: null, version: null },
      serve: { state: 'not-configured', managerMapped: null, mappedInstancePorts: null, expectedInstancePorts: 1, funnel: 'disabled' },
      registration: { state: 'not-configured', trigger: null, diagnostic: null }, nodeVersion: 'v24.15.0',
      privateValue: 'synthetic-secret', ...connectivityOverride,
    },
    '/api/v1/worker/capacity': { state: 'available' },
    '/api/v1/overview': { instances: [], notifications: [], history: { total: 0, revision: 'empty' } },
    '/api/v1/instances/history': { instances: [], total: 0, revision: 'empty', nextOffset: null },
  }
  const calls = []
  const env = { OMW_BROWSER_USERNAME: 'fixture', OMW_BROWSER_PASSWORD_FILE: '/fixture/password', OMW_EXECUTION_TOKEN_FILE: '/fixture/control' }
  const boundaries = { env, loadConfig: async () => ({
    workerBrowserCredentials: async actualEnv => { assert.equal(actualEnv, env); return { username: 'fixture', password: 'synthetic-secret' } },
    workerSecret: async (actualEnv, key, length) => { assert.equal(actualEnv, env); assert.equal(key, 'OMW_EXECUTION_TOKEN_FILE'); assert.equal(length, 32); return 'synthetic-control' },
  }), fetch: async (url, opts) => {
    assert.equal(opts.method, undefined); calls.push(new URL(url).pathname)
    return { status: 200, json: async () => responses[new URL(url).pathname] }
  } }
  return { responses, calls, boundaries }
}

test('one-shot manager probe GET-only fixture APIs do not emit credentials/body/error', async () => {
  const { responses, calls, boundaries } = managerApiFixture()
  const result = await managerInspection(boundaries)
  assert.equal(result.ok, true); assert.equal(result.namespaceMembers, 0)
  assert.equal(result.managerVersion, '0.8.0')
  assert.equal(JSON.parse(JSON.stringify(result)).managerVersion, '0.8.0', 'version survives the actual exec JSON wire')
  assert.ok(!JSON.stringify(result).includes('synthetic'))
  responses['/v1/execution'].capacity = 'unknown'
  assert.deepEqual(await managerInspection(boundaries), { ok: false })
  responses['/v1/execution'].capacity = 'available'
  responses['/api/v1/instances/history'].nextOffset = 0
  assert.deepEqual(await managerInspection(boundaries), { ok: false })
  assert.ok(calls.every(v => !/start|stop|inspect$/.test(v)))
})

test('actual nested connectivity version is authoritative; flat version is never a fallback', async () => {
  const { boundaries } = managerApiFixture({ managerVersion: '9.9.9' })
  assert.equal((await managerInspection(boundaries)).managerVersion, '0.8.0')
})
for (const [name, override] of [
  ['missing manager', { manager: undefined, managerVersion: '0.8.0' }],
  ['missing nested version', { manager: { localUrl: 'http://127.0.0.1:4174', publicUrl: null }, managerVersion: '0.8.0' }],
  ['null version', { manager: { version: null } }],
  ['non-string version', { manager: { version: 800 } }],
  ['malformed version', { manager: { version: 'unknown' } }],
]) test(`real manager inspection fails closed for ${name}`, async () => {
  const { boundaries } = managerApiFixture(override)
  assert.deepEqual(await managerInspection(boundaries), { ok: false })
})

test('unaltered serialized manager helper parses without args and executes with injected boundaries', async () => {
  const scratch = await mkdtemp(path.join(fixtureTemp, 'omw-deploy-test-'))
  try {
    const { writeFile } = await import('node:fs/promises')
    const filename = path.join(scratch, 'manager-probe.mjs')
    await writeFile(filename, `const result=await (${managerInspection.toString()})();process.stdout.write(JSON.stringify(result));`)
    const syntax = await processRunner(process.execPath, ['--check', filename], { timeout: 5000 })
    assert.equal(syntax.code, 0)
    const serialized = vm.runInNewContext(`(${managerInspection.toString()})`, { Buffer, AbortSignal })
    const { boundaries } = managerApiFixture()
    assert.equal((await serialized(boundaries)).managerVersion, '0.8.0')
  } finally { await rm(scratch, { recursive: true, force: true }) }
})

test('unsupported build phase with absent skills never falls through to Docker/public image', async () => {
  await assert.rejects(main(['build', '--execute', '--out', 'fixture'], { runner: () => assert.fail('build unavailable') }), /PHASE_INVALID/)
})
for (const [name, mutate] of [
  ['not Recreate', f => { f.deployments['omw-beta'].spec.strategy.type = 'RollingUpdate' }],
  ['not one replica', f => { f.deployments['omw-beta'].spec.replicas = 2 }],
  ['wrong container names', f => { f.deployments['omw-beta'].spec.template.spec.containers[1].name = 'unknown' }],
  ['unobserved generation', f => { f.deployments['omw-beta'].status.observedGeneration = 0 }],
  ['duplicate container statuses', f => { f.options.resources = (sets, pods) => { pods[0].status.containerStatuses[1].name = 'manager' } }],
]) test(`plan rejects ${name}`, async () => {
  const f = fixture(); mutate(f)
  await assert.rejects(createPlan(f.c, f.runner))
  assert.ok(!f.calls.some(c => c.args[5] === 'patch'))
})
test('new runtime digest outside recorded tuple blocks alpha', async () => {
  const f = fixture(); const plan = await createPlan(f.c, f.runner)
  f.options.resources = (sets, pods) => { if (f.deployments['omw-beta'].metadata.generation > 1) pods[0].status.containerStatuses[0].imageID = `registry.example.test/private/worker@sha256:${'f'.repeat(64)}` }
  await assert.rejects(deploy(plan, { ...f.execution, ackDiscard: plan.digest }), /RUNTIME_DIGEST_MISMATCH/)
  assert.equal(f.calls.filter(c => c.args[5] === 'patch').length, 1)
})
test('rollout deadline unresolved never retries a mutation', async () => {
  const f = fixture(); const plan = await createPlan(f.c, f.runner)
  let clock = 0
  f.options.onCall = (exe, args) => { if (exe === 'kubectl' && args[5] === 'get' && f.deployments['omw-beta'].metadata.generation > 1) f.deployments['omw-beta'].status.observedGeneration = 1 }
  await assert.rejects(deploy(plan, { ...f.execution, ackDiscard: plan.digest, now: () => clock, rolloutTimeoutMs: 2000, sleep: async ms => { clock += ms } }), /ROLLOUT_DEADLINE_UNRESOLVED/)
  assert.equal(f.calls.filter(c => c.args[5] === 'patch').length, 1)
})
test('Pod identity drift during health inspection is rejected before verified receipt', async () => {
  const f = fixture(); const plan = await createPlan(f.c, f.runner)
  f.options.onCall = (exe, args) => {
    if (exe === 'kubectl' && args[5] === 'exec' && f.deployments['omw-beta'].metadata.generation > 1) f.options.resources = (sets, pods) => { pods[0].metadata.uid = 'substituted-after-rollout' }
  }
  await assert.rejects(deploy(plan, { ...f.execution, ackDiscard: plan.digest }), /POSTVERIFY_IDENTITY_DRIFT/)
  assert.equal(f.records.filter(r => r.status === 'verified').length, 0)
  assert.equal(f.calls.filter(c => c.args[5] === 'patch').length, 1)
})

test('workspace probe reads only metadata/profile accessibility; unknown symlinks fail closed', async () => {
  const operations = []
  const info = type => ({ size: 0, mtimeMs: 1, ctimeMs: 1, ino: 42, mode: 16877, isDirectory: () => type === 'directory', isFile: () => type === 'file', isSymbolicLink: () => type === 'symlink' })
  let type = 'file'
  const filesystem = {
    lstat: async filename => { operations.push(['lstat', filename]); return info(filename === '/workspace' ? 'directory' : type) },
    readdir: async filename => { operations.push(['readdir', filename]); return filename === '/workspace' ? ['public.txt'] : ['fixture-skill'] },
    access: async filename => operations.push(['access', filename]),
    readFile: () => assert.fail('never read file/auth/DB content'),
  }
  const source = workspaceInspection.toString().replace("await import('node:fs/promises')", 'filesystem')
  const inspect = vm.runInNewContext(`(${source})`, { filesystem, process: { env: { OMW_WORKER_PROFILE_DIR: '/home/node/.config/omw-profile' } } })
  const result = await inspect()
  assert.equal(result.ok, true); assert.equal(result.entries[0].path, '/public.txt'); assert.equal(result.contentOwnershipVerified, false)
  assert.ok(operations.every(v => v[1].startsWith('/workspace') || v[1].startsWith('/home/node/.config/omw-profile')))
  type = 'symlink'
  assert.deepEqual(JSON.parse(JSON.stringify(await inspect())), { ok: false })
})

test('public CLI persists checkpoint-before-patch and reads the same journal in readonly status', async () => {
  const scratch = await mkdtemp(path.join(fixtureTemp, 'omw-deploy-test-'))
  try {
    const { writeFile } = await import('node:fs/promises')
    const f = fixture(); const plan = await createPlan(f.c, f.runner)
    const filename = path.join(scratch, 'plan.json'); await writeFile(filename, JSON.stringify(plan))
    const output = path.join(scratch, 'run')
    const runner = async (exe, args, opts) => {
      if (exe === 'kubectl' && args[5] === 'patch') {
        const files = (await readdir(output)).filter(v => /^\d{4}\.json$/.test(v)).sort()
        f.records.push(JSON.parse(await readFile(path.join(output, files.at(-1)), 'utf8')))
      }
      return f.runner(exe, args, opts)
    }
    f.options.readPatch = file => readFile(file, 'utf8')
    const result = await main(['deploy', '--plan', filename, '--execute', '--out', output, '--ack-discard', plan.digest, '--maintenance-window'], { runner, print: () => {} })
    assert.equal(result.status, 'complete')
    const count = f.calls.filter(c => c.args[5] === 'patch').length
    const status = await main(['status', '--journal', output], { runner: f.runner, print: () => {} })
    assert.equal(status.completionClaimed, false)
    assert.equal(status.journal.at(-1).status, 'complete')
    assert.equal(f.calls.filter(c => c.args[5] === 'patch').length, count)
  } finally { await rm(scratch, { recursive: true, force: true }) }
})

test('CLI lost reply leaves durable unresolved facts and sanitized producer identity', async () => {
  const scratch = await mkdtemp(path.join(fixtureTemp, 'omw-deploy-test-'))
  try {
    const { writeFile } = await import('node:fs/promises')
    const f = fixture({ lostReply: true }); const plan = await createPlan(f.c, f.runner)
    const filename = path.join(scratch, 'plan.json'); await writeFile(filename, JSON.stringify(plan))
    const output = path.join(scratch, 'run')
    const runner = async (exe, args, opts) => {
      if (exe === 'kubectl' && args[5] === 'patch') {
        const files = (await readdir(output)).filter(v => /^\d{4}\.json$/.test(v)).sort()
        f.records.push(JSON.parse(await readFile(path.join(output, files.at(-1)), 'utf8')))
      }
      return f.runner(exe, args, opts)
    }
    f.options.readPatch = file => readFile(file, 'utf8')
    await assert.rejects(main(['deploy', '--plan', filename, '--execute', '--out', output, '--ack-discard', plan.digest, '--maintenance-window'], { runner, print: () => {} }), /PATCH_RESULT_UNKNOWN/)
    const status = await main(['status', '--journal', output], { runner: f.runner, print: () => {} })
    const unresolved = status.journal.find(v => v.status === 'unresolved')
    assert.equal(unresolved.producer.descendantExitVerified, false)
    assert.equal(status.completionClaimed, false)
    assert.equal(f.calls.filter(c => c.args[5] === 'patch').length, 1)
    const files = (await readdir(output)).filter(v => /^\d{4}\.json$/.test(v))
    for (const file of files) assert.ok(!(await readFile(path.join(output, file), 'utf8')).includes('secret-value'))
  } finally { await rm(scratch, { recursive: true, force: true }) }
})
