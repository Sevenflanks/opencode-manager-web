import assert from 'node:assert/strict'
import test from 'node:test'
import { validateConfig, imagePatch, deploy, createPlan, releaseGate, hash, validatePlan, reconcile, clusterSnapshot, managerInspection, workspaceInspection } from './deploy-core.mjs'
import { main, parseArgs, processRunner } from './deploy.mjs'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

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

for (const [name, mutate, failure, phase] of [
  ['Pending Pod', (sets, pods) => { pods[0].status.phase = 'Pending'; pods[0].status.conditions[0].status = 'False' }, 'POD_NOT_READY', 'Pending'],
  ['CrashLoop Pod', (sets, pods) => { pods[0].status.conditions[0].status = 'False'; pods[0].status.containerStatuses[0].ready = false; pods[0].status.containerStatuses[0].state = { waiting: { reason: 'CrashLoopBackOff', message: 'synthetic-secret' } } }, 'POD_NOT_READY', 'Running'],
  ['missing statuses', (sets, pods) => { delete pods[0].status.containerStatuses }, 'POD_STATUS_UNKNOWN', 'Running'],
  ['missing entire status', (sets, pods) => { delete pods[0].status }, 'POD_STATUS_UNKNOWN', null],
  ['template mismatch', sets => { sets[0].spec.template.spec.containers[0].image = 'previous-template' }, 'POD_TEMPLATE_OWNER_MISMATCH', 'Running'],
]) for (const imageState of ['old', 'new', 'drift']) test(`readonly core/CLI observes ${name} with ${imageState} image; strict plan/deploy still refuse`, async () => {
  const scratch = await mkdtemp(path.join(fixtureTemp, 'omw-deploy-status-'))
  try {
    const { writeFile } = await import('node:fs/promises')
    const f = fixture(); const input = path.join(scratch, 'config.json'); await writeFile(input, JSON.stringify(f.c))
    const journal = path.join(scratch, 'run')
    const plan = await main(['plan', '--config', input, '--execute', '--out', journal], { runner: f.runner, print: () => {} })
    const stored = { status: 'unresolved', target: 'omw-beta', reason: 'PATCH_RESULT_UNKNOWN_READONLY_RECONCILE_REQUIRED', producer: { rootPid: 456, descendantExitVerified: false }, planDigest: plan.digest }
    await writeFile(path.join(journal, '0001.json'), JSON.stringify(stored))
    f.options.resources = mutate
    if (imageState !== 'old') f.deployments['omw-beta'].spec.template.spec.containers.forEach(v => { v.image = imageState === 'new' ? f.c.image : 'unexpected-image' })
    await assert.rejects(clusterSnapshot(f.c, f.runner, false), new RegExp(failure))
    await assert.rejects(createPlan(f.c, f.runner), new RegExp(failure))
    await assert.rejects(deploy(plan, { ...f.execution, ackDiscard: plan.digest }), new RegExp(failure))
    const observation = await reconcile(plan, f.runner)
    assert.equal(observation.status, 'readonly-observation')
    assert.equal(observation.completionClaimed, false)
    assert.equal(observation.targets[0].classification, imageState === 'old' ? 'old-image-observed-not-retry-authorization' : imageState === 'new' ? 'new-image-observed-not-completion-proof' : 'drift-or-unknown')
    assert.equal(observation.targets[0].current.uid, 'omw-beta-uid')
    const pod = observation.targets[0].current.podObservations[0]
    assert.equal(pod.uid, 'omw-beta-pod-1'); assert.equal(pod.ownerUid, 'omw-beta-rs-1'); assert.equal(pod.phase, phase)
    assert.equal(pod.validationError, failure)
    assert.equal(pod.ready, phase === null ? null : name === 'Pending Pod' || name === 'CrashLoop Pod' ? false : true)
    if (name.startsWith('missing')) assert.equal(pod.containers, null)
    if (name === 'CrashLoop Pod') assert.equal(pod.containers[0].state, 'waiting')
    const printed = []
    const status = await main(['status', '--journal', journal], { runner: f.runner, print: text => printed.push(JSON.parse(text)) })
    assert.equal(status.completionClaimed, false)
    assert.deepEqual(printed, [status])
    assert.deepEqual(status.journal.at(-1), { status: stored.status, target: stored.target, reason: stored.reason, producer: stored.producer })
    assert.equal(f.calls.filter(c => c.args[5] === 'patch').length, 0)
    assert.ok(f.calls.slice(-5).every(c => c.executable === 'kubectl' && c.args[5] === 'get'))
    assert.ok(!JSON.stringify(status).includes('synthetic-secret'))
    assert.deepEqual(JSON.parse(await readFile(path.join(journal, '0001.json'), 'utf8')), stored)
  } finally { await rm(scratch, { recursive: true, force: true }) }
})

for (const [name, reply, failure] of [
  ['API unreachable', { code: 1, stdout: 'synthetic-secret', stderr: 'synthetic-secret' }, 'COMMAND_FAILED_OR_UNKNOWN'],
  ['invalid API JSON', { code: 0, stdout: 'synthetic-secret' }, 'JSON_RESPONSE_UNKNOWN'],
]) test(`CLI status prints stored journal before rejecting ${name}`, async () => {
  const scratch = await mkdtemp(path.join(fixtureTemp, 'omw-deploy-status-'))
  try {
    const { writeFile } = await import('node:fs/promises')
    const f = fixture(); const input = path.join(scratch, 'config.json'); await writeFile(input, JSON.stringify(f.c))
    const journal = path.join(scratch, 'run')
    await main(['plan', '--config', input, '--execute', '--out', journal], { runner: f.runner, print: () => {} })
    const printed = [], before = await readdir(journal)
    await assert.rejects(main(['status', '--journal', journal], { runner: async (exe, args) => { assert.equal(exe, 'kubectl'); assert.equal(args[5], 'get'); return reply }, print: text => printed.push(JSON.parse(text)) }), new RegExp(failure))
    assert.equal(printed.length, 1)
    assert.equal(printed[0].status, 'unresolved'); assert.equal(printed[0].reason, failure)
    assert.equal(printed[0].completionClaimed, false)
    assert.deepEqual(printed[0].journal, [{ status: 'planned', target: null, reason: null, producer: null }])
    assert.ok(!JSON.stringify(printed).includes('synthetic-secret'))
    assert.deepEqual(await readdir(journal), before)
  } finally { await rm(scratch, { recursive: true, force: true }) }
})

test('real runner executes argument arrays with shell disabled and suppresses stderr', async () => {
  const result = await processRunner(process.execPath, ['-e', 'process.stdout.write(process.argv[1]);process.stderr.write("synthetic-secret")', 'space & ; $value'], { timeout: 5000 })
  assert.equal(result.code, 0); assert.equal(result.stdout, 'space & ; $value')
  assert.ok(!JSON.stringify(result).includes('synthetic-secret'))
})

async function controlledStdout(bytes, width) {
  const child = new EventEmitter()
  child.stdout = new PassThrough(); child.stderr = new PassThrough()
  child.kill = () => {}; child.unref = () => {}
  // 固定 byte 邊界，不靠 OS pipe 時序；只替換 spawn，執行未修改的公開 runner 本體。
  const ownedSpawn = () => {
    queueMicrotask(() => {
      child.stdout.once('end', () => child.emit('close', 0))
      for (let offset = 0; offset < bytes.length; offset += width) child.stdout.write(bytes.subarray(offset, offset + width))
      child.stderr.end('synthetic-private-stderr')
      child.stdout.end()
    })
    return child
  }
  const runner = vm.runInNewContext(`(${processRunner.toString()})`, { spawn: ownedSpawn, process, path, Buffer, StringDecoder, setTimeout, clearTimeout })
  try { return await runner(process.execPath, ['controlled-stdout'], { timeout: 1000 }) }
  finally {
    child.stdout.destroy(); child.stderr.destroy()
    assert.equal(child.stdout.destroyed && child.stderr.destroyed, true)
  }
}

for (const format of ['JSON', 'text']) test(`unaltered runner preserves deterministic split UTF-8 ${format} and hash`, async () => {
  const filename = '/中文目錄/測試😀🚀.txt'
  const text = format === 'JSON' ? JSON.stringify({ entries: [{ path: filename }] }) : `ASCII prefix\n${filename}\n最後🙂`
  for (const width of [1, 2, 3, 4, 7]) {
    const result = await controlledStdout(Buffer.from(text), width)
    assert.equal(result.code, 0); assert.equal(result.timedOut, false)
    if (format === 'JSON') assert.equal(JSON.parse(result.stdout).entries[0].path, filename, `byte width ${width}`)
    assert.equal(result.stdout, text, `byte width ${width}`)
    assert.equal(hash(result.stdout), hash(text))
    assert.ok(!JSON.stringify(result).includes('synthetic-private'))
  }
})

test('unaltered runner preserves ASCII and flushes incomplete final UTF-8 bytes in text fallback', async () => {
  const ascii = 'ASCII only\nspace & ; $value'
  assert.equal((await controlledStdout(Buffer.from(ascii), 1)).stdout, ascii)
  const bytes = Buffer.concat([Buffer.from('最後😀:'), Buffer.from([0xf0, 0x9f, 0x99])])
  for (const width of [1, 2, bytes.length]) {
    const result = await controlledStdout(bytes, width)
    assert.equal(result.stdout, bytes.toString('utf8'), `end flush at byte width ${width}`)
    assert.ok(result.stdout.endsWith('\uFFFD'), 'incomplete final bytes are not silently dropped')
  }
  const atLimit = Buffer.concat([Buffer.alloc(3_999_999, 0x61), Buffer.from([0xe4])])
  const excess = await controlledStdout(atLimit, 65_536)
  assert.equal(excess.stdout, ''); assert.equal(excess.timedOut, true)
  assert.equal(excess.producer.reason, 'output-limit', 'end flush must not bypass the decoded output cap')
})

for (const format of ['ASCII', 'UTF-8']) test(`unaltered runner accepts exactly 4 MB ${format} and redacts one byte over limit`, async () => {
  const text = format === 'ASCII' ? 'a'.repeat(4_000_000) : `${'中'.repeat(1_333_333)}!`
  assert.equal(Buffer.byteLength(text), 4_000_000)
  const exact = await controlledStdout(Buffer.from(text), 65_536)
  assert.equal(exact.code, 0); assert.equal(exact.stdout, text)
  const excess = await controlledStdout(Buffer.from(`${text}x`), 65_536)
  assert.equal(excess.code, null); assert.equal(excess.stdout, ''); assert.equal(excess.timedOut, true)
  assert.equal(excess.producer.reason, 'output-limit'); assert.equal(excess.producer.descendantExitVerified, false)
  assert.ok(!JSON.stringify(excess).includes('synthetic-private'))
})

test('public CLI plan and deploy preserve Unicode workspace snapshot across different byte splits', async () => {
  const scratch = await mkdtemp(path.join(fixtureTemp, 'omw-deploy-unicode-'))
  try {
    const { writeFile } = await import('node:fs/promises')
    const f = fixture(), filename = '/中文目錄/測試😀🚀.txt'
    for (const inventory of Object.values(f.inventories)) inventory.entries.push({ path: filename, type: 'file', size: 1, mtimeMs: 1, ctimeMs: 1, inode: 1, mode: 1 })
    const reference = await createPlan(f.c, f.runner)
    const input = path.join(scratch, 'config.json'); await writeFile(input, JSON.stringify(f.c))
    let width = 1
    const runner = async (exe, args, opts) => {
      const reply = await f.runner(exe, args, opts)
      assert.equal(reply.code, 0)
      return controlledStdout(Buffer.from(reply.stdout), width)
    }
    const plan = await main(['plan', '--config', input], { runner, print: () => {} })
    assert.equal(plan.data['omw-beta'].workspace[0].path, filename)
    assert.equal(hash(plan.data), hash(reference.data)); assert.equal(plan.digest, reference.digest)
    width = 2
    const planFile = path.join(scratch, 'plan.json'); await writeFile(planFile, JSON.stringify(plan))
    const output = path.join(scratch, 'run')
    const deployRunner = async (exe, args, opts) => {
      if (exe === 'kubectl' && args[5] === 'patch') {
        const files = (await readdir(output)).filter(v => /^\d{4}\.json$/.test(v)).sort()
        f.records.push(JSON.parse(await readFile(path.join(output, files.at(-1)), 'utf8')))
      }
      return runner(exe, args, opts)
    }
    f.options.readPatch = file => readFile(file, 'utf8')
    const result = await main(['deploy', '--plan', planFile, '--execute', '--out', output, '--ack-discard', plan.digest, '--maintenance-window'], { runner: deployRunner, print: () => {} })
    assert.equal(result.status, 'complete')
    assert.deepEqual(f.calls.filter(c => c.args[5] === 'patch').map(c => c.args[7]), ['omw-beta', 'omw-alpha'])
  } finally { await rm(scratch, { recursive: true, force: true }) }
})

for (const reason of ['deadline', 'output-limit']) test(`unaltered runner abandons owned finite Node fixture on ${reason}, redacts output and closes`, { timeout: 10_000 }, async () => {
  let child, closed
  // 不改 runner 本體；只包 spawn 邊界保留當次 handle，仍啟動真 Node，且 fixture 不產生 descendants。
  const ownedSpawn = (executable, args, options) => {
    assert.equal(executable, process.execPath); assert.equal(options.shell, false)
    child = spawn(executable, args, options)
    closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
    return child
  }
  const runner = vm.runInNewContext(`(${processRunner.toString()})`, { spawn: ownedSpawn, process, path, Buffer, StringDecoder, setTimeout, clearTimeout })
  // 即使 test interruption 或 runner 的 kill 失效，也在 2 秒內自行退出。
  const script = `setTimeout(() => process.exit(0), 2000); process.stderr.write('synthetic-private-stderr'); process.stdout.write(${reason === 'output-limit' ? "'synthetic-private-stdout'.repeat(200_000)" : "'synthetic-private-stdout'"});`
  try {
    const result = await runner(process.execPath, ['-e', script], { timeout: reason === 'deadline' ? 500 : 1500 })
    assert.equal(result.code, null); assert.equal(result.stdout, ''); assert.equal(result.timedOut, true)
    assert.equal(result.producer.reason, reason); assert.equal(result.producer.rootPid, child.pid)
    assert.equal(result.producer.descendantExitVerified, false)
    assert.ok(!JSON.stringify(result).includes('synthetic-private'))
  } finally {
    if (closed) {
      let timer
      try {
        await Promise.race([closed, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('OWNED_FIXTURE_CLOSE_DEADLINE')), 6000) })])
        assert.ok(child.exitCode !== null || child.signalCode !== null, 'current-run child close/exit confirmed')
      } finally { clearTimeout(timer) }
    }
  }
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
for (const transition of ['Pending', 'missing status']) test(`post-patch ${transition} retries GET to Ready, verifies beta before alpha and never repatches`, async () => {
  const f = fixture(); const plan = await createPlan(f.c, f.runner)
  const pending = new Set(), transitions = [], sleeps = []
  let clock = 0
  f.options.onCall = (exe, args) => {
    if (exe === 'kubectl' && args[5] === 'patch') {
      const target = args[7]
      if (target === 'omw-alpha') assert.ok(f.records.some(r => r.status === 'verified' && r.target === 'omw-beta'))
      pending.add(target)
    }
  }
  f.options.resources = (sets, pods) => {
    for (const target of pending) {
      // 只在 patch 後 generation=2 且 observedGeneration 已追上時改 Pod，確實觸及 waitHealthy catch。
      if (f.deployments[target].metadata.generation !== 2) continue
      assert.equal(f.deployments[target].status.observedGeneration, 2)
      const pod = pods.find(p => p.metadata.name === `${target}-pod`)
      if (transition === 'Pending') { pod.status.phase = 'Pending'; pod.status.conditions[0].status = 'False' }
      else delete pod.status
      transitions.push(target)
    }
  }
  const result = await deploy(plan, { ...f.execution, ackDiscard: plan.digest, now: () => clock, rolloutTimeoutMs: 3000, sleep: async ms => {
    assert.equal(ms, 1000)
    const target = [...pending][0]
    assert.ok(transitions.includes(target), 'retry follows an observed transitional Pod')
    assert.equal(f.records.at(-1).status, 'accepted'); assert.equal(f.records.at(-1).target, target)
    sleeps.push(target); pending.delete(target); clock += ms
  } })
  assert.equal(result.status, 'complete')
  assert.deepEqual(sleeps, ['omw-beta', 'omw-alpha'])
  assert.deepEqual(f.calls.filter(c => c.args[5] === 'patch').map(c => c.args[7]), ['omw-beta', 'omw-alpha'])
  assert.deepEqual(f.records.map(r => [r.status, r.target ?? null]), [['intent', 'omw-beta'], ['accepted', 'omw-beta'], ['verified', 'omw-beta'], ['intent', 'omw-alpha'], ['accepted', 'omw-alpha'], ['verified', 'omw-alpha'], ['complete', null]])
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
