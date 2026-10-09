import { createHash } from 'node:crypto'

const sha256 = /^sha256:[a-f0-9]{64}$/
export const hash = value => `sha256:${createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex')}`
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  return JSON.stringify(value)
}
export function guard(condition, code) { if (!condition) throw new Error(code) }

export function validateConfig(c) {
  guard(c && c.repository === 'Sevenflanks/opencode-manager-web', 'REPOSITORY_INVALID')
  guard(c.namespace === 'ai-tools', 'NAMESPACE_INVALID')
  guard(typeof c.context === 'string' && /^[a-zA-Z0-9_.:@/-]{1,160}$/.test(c.context) && !c.context.startsWith('-'), 'CONTEXT_REQUIRED')
  guard(JSON.stringify(c.targets) === '["omw-beta"]' || JSON.stringify(c.targets) === '["omw-beta","omw-alpha"]', 'TARGET_ORDER_INVALID')
  guard(/^v\d+\.\d+\.\d+$/.test(c.tag) && c.expectedManagerVersion === c.tag.slice(1), 'RELEASE_VERSION_INVALID')
  guard(/^[a-f0-9]{40}$/.test(c.sha), 'RELEASE_SHA_INVALID')
  // 私有 registry 必須由 operator 指定；不提供 public repository fallback。
  guard(typeof c.image === 'string' && /^[a-z0-9.-]+(?::\d+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(c.image) && c.image.split('/')[0].includes('.') && !/^(docker\.io|ghcr\.io|registry\.npmjs\.org)\//.test(c.image), 'PRIVATE_DIGEST_REQUIRED')
  guard(sha256.test(c.configDigest), 'CONFIG_DIGEST_REQUIRED')
  guard(!Object.keys(c).some(k => !['repository', 'namespace', 'context', 'targets', 'tag', 'sha', 'expectedManagerVersion', 'image', 'configDigest'].includes(k)), 'CONFIG_FIELD_INVALID')
  return c
}

export function imagePatch(d, image) {
  const tests = [
    { op: 'test', path: '/metadata/uid', value: d.metadata.uid },
    { op: 'test', path: '/metadata/resourceVersion', value: d.metadata.resourceVersion },
  ]
  const containers = d.spec.template.spec.containers
  guard(containers.length === 2 && new Set(containers.map(c => c.name)).size === 2 && containers.every(c => ['manager', 'execution'].includes(c.name)), 'CONTAINERS_INVALID')
  for (const [i, c] of containers.entries()) tests.push({ op: 'test', path: `/spec/template/spec/containers/${i}/name`, value: c.name }, { op: 'test', path: `/spec/template/spec/containers/${i}/image`, value: c.image })
  return [...tests, ...containers.map((_, i) => ({ op: 'replace', path: `/spec/template/spec/containers/${i}/image`, value: image }))]
}

export async function deploy(plan, options = {}) {
  if (!options.execute) return { status: 'preview', planDigest: plan.digest, targets: plan.config.targets }
  validatePlan(plan)
  guard(options.ackDiscard === plan.digest && options.maintenanceWindow === true, 'DISCARD_AND_MAINTENANCE_ACK_REQUIRED')
  guard(typeof options.checkpoint === 'function' && typeof options.patchFile === 'function', 'PRIVATE_JOURNAL_REQUIRED')
  const { runner, checkpoint, patchFile } = options
  const c = plan.config
  const receipts = []
  try {
    const release = await releaseGate(c, runner)
    guard(hash(release) === hash(plan.release), 'RELEASE_FACTS_DRIFT')
    const image = await validateRemoteImage(c, runner)
    guard(hash(image) === hash(plan.image), 'IMAGE_FACTS_DRIFT')
    let baseline = plan.baseline
    for (const target of c.targets) {
      const fresh = await clusterSnapshot(c, runner)
      compareBaseline(baseline, fresh)
      const before = fresh[target]
      guard(before.containers.some(container => container.image !== c.image), 'ALREADY_TARGET_IMAGE_NEW_PLAN_REQUIRED')
      const data = await inspectWorker(c, before, runner)
      guard(hash(data) === hash(plan.data[target]), 'DATA_SNAPSHOT_DRIFT_NEW_PLAN_REQUIRED')
      // API clearance 與 patch 間沒有跨服務鎖；UID/RV guard 只能保護 Deployment，maintenance window 是必要契約。
      const final = await clusterSnapshot(c, runner)
      compareBaseline(fresh, final)
      const patch = imagePatchFromFacts(final[target], c.image)
      const filename = await patchFile(target, patch)
      await checkpoint({ status: 'intent', scope: 'images-only', target, planDigest: plan.digest, expected: final[target], patchDigest: hash(patch) })
      let receipt
      try {
        receipt = await jsonCommand(runner, 'kubectl', kube(c, ['patch', 'deployment', target, '--type=json', '--patch-file', filename, '-o', 'json']), 35_000)
      } catch (error) {
        // lost reply 可能已套用；同 journal 不重送、也不 auto rollback。
        await checkpoint({ status: 'unresolved', target, reason: 'PATCH_RESULT_UNKNOWN_READONLY_RECONCILE_REQUIRED', planDigest: plan.digest, ...(error.producer ? { producer: error.producer } : {}) })
        const unknown = new Error('PATCH_RESULT_UNKNOWN_READONLY_RECONCILE_REQUIRED')
        if (error.producer) unknown.producer = error.producer
        throw unknown
      }
      const received = deploymentFacts(receipt, target)
      guard(received.uid === before.uid && received.generation === before.generation + 1 && received.nonImageHash === before.nonImageHash && received.containers.every(v => v.image === c.image), 'PATCH_RECEIPT_INVALID')
      await checkpoint({ status: 'accepted', target, receipt: received, planDigest: plan.digest })
      const after = await waitHealthy(c, target, before, received, plan.image, runner, options)
      for (const name of names) if (name !== target) guard(hash(protectedFacts(after[name])) === hash(protectedFacts(baseline[name])), 'PROTECTED_RESOURCE_DRIFT')
      const health = await inspectWorker(c, after[target], runner)
      guard(health.managerVersion === c.expectedManagerVersion, 'MANAGER_VERSION_MISMATCH')
      const finalHealth = await clusterSnapshot(c, runner)
      for (const name of names) guard(hash(protectedFacts(finalHealth[name])) === hash(protectedFacts(after[name])), 'POSTVERIFY_IDENTITY_DRIFT')
      await checkpoint({ status: 'verified', target, receipt: finalHealth[target], health, planDigest: plan.digest })
      receipts.push({ target, podUid: finalHealth[target].pod.uid, generation: finalHealth[target].generation })
      baseline = finalHealth
    }
    await checkpoint({ status: 'complete', planDigest: plan.digest, receipts, pods: 'preserved', businessProof: false })
    return { status: 'complete', receipts, businessProof: false }
  } catch (error) {
    await checkpoint({ status: 'halted', planDigest: plan.digest, reason: safeCode(error), receipts, ...(error.producer ? { producer: error.producer } : {}) })
    throw error
  }
}

const names = ['omw-beta', 'omw-alpha', 'omw-gateway']
export const safeCode = error => /^[A-Z0-9_]{1,100}$/.test(error?.message) ? error.message : 'OPERATION_FAILED_DETAILS_SUPPRESSED'
export const kube = (c, args) => ['--context', c.context, '--namespace', 'ai-tools', '--request-timeout=25s', ...args]
async function command(runner, executable, args, timeout = 30_000) {
  try {
    const result = await runner(executable, args, { timeout })
    if (result?.timedOut) { const error = new Error('PRODUCER_TIMEOUT_UNRESOLVED'); error.producer = { rootPid: Number.isInteger(result.producer?.rootPid) ? result.producer.rootPid : null, descendantExitVerified: false }; throw error }
    guard(result && result.code === 0 && typeof result.stdout === 'string', 'COMMAND_FAILED_OR_UNKNOWN')
    return result.stdout
  } catch (error) { if (error.message === 'PRODUCER_TIMEOUT_UNRESOLVED') throw error; throw new Error('COMMAND_FAILED_OR_UNKNOWN') }
}
async function jsonCommand(runner, executable, args, timeout) {
  const output = await command(runner, executable, args, timeout)
  try { return JSON.parse(output) } catch { throw new Error('JSON_RESPONSE_UNKNOWN') }
}

export async function releaseGate(c, runner) {
  validateConfig(c)
  const api = endpoint => jsonCommand(runner, 'gh', ['api', `repos/${c.repository}/${endpoint}`])
  const release = await api(`releases/tags/${c.tag}`)
  guard(release.tag_name === c.tag && release.draft === false && release.prerelease === false && typeof release.published_at === 'string' && release.published_at.length > 0, 'RELEASE_NOT_PUBLISHED')
  let object = (await api(`git/ref/tags/${c.tag}`)).object
  const visited = new Set()
  for (let depth = 0; object?.type === 'tag' && depth < 8; depth++) {
    guard(/^[a-f0-9]{40}$/.test(object.sha) && !visited.has(object.sha), 'TAG_PEEL_INVALID')
    visited.add(object.sha)
    object = (await api(`git/tags/${object.sha}`)).object
  }
  guard(object?.type === 'commit' && object.sha === c.sha, 'RELEASE_TAG_SHA_MISMATCH')
  const runs = await api(`actions/workflows/release.yml/runs?head_sha=${c.sha}&per_page=100`)
  guard(Array.isArray(runs.workflow_runs), 'RELEASE_WORKFLOW_UNKNOWN')
  let runId
  for (const run of runs.workflow_runs.slice(0, 100)) {
    if (run.head_sha !== c.sha || run.path !== '.github/workflows/release.yml' || run.head_repository?.full_name !== c.repository || run.status !== 'completed' || run.conclusion !== 'success' || !Number.isSafeInteger(run.id)) continue
    const jobs = await api(`actions/runs/${run.id}/jobs?per_page=100`)
    guard(Array.isArray(jobs.jobs) && jobs.total_count <= 100, 'RELEASE_JOBS_UNKNOWN')
    if (jobs.jobs.some(j => j.name === 'publish-release' && j.status === 'completed' && j.conclusion === 'success')) { runId = run.id; break }
  }
  guard(runId !== undefined, 'PUBLISH_RELEASE_NOT_SUCCESSFUL')
  const version = await jsonCommand(runner, 'npm', ['view', `@sevenflanks/omw@${c.expectedManagerVersion}`, 'version', '--json', '--registry=https://registry.npmjs.org'])
  guard(version === c.expectedManagerVersion, 'NPM_VERSION_NOT_PUBLISHED')
  return { repository: c.repository, tag: c.tag, sha: object.sha, version, runId, job: 'publish-release', publishedAt: release.published_at }
}

export async function validateRemoteImage(c, runner) {
  const repository = c.image.split('@')[0]
  const digest = c.image.split('@')[1]
  const raw = async reference => {
    const text = (await command(runner, 'docker', ['--context', 'desktop-linux', 'buildx', 'imagetools', 'inspect', '--raw', reference])).trimEnd()
    guard(hash(text) === reference.split('@')[1], 'REMOTE_MANIFEST_DIGEST_MISMATCH')
    try { return JSON.parse(text) } catch { throw new Error('REMOTE_MANIFEST_UNKNOWN') }
  }
  const root = await raw(c.image)
  let childDigest = digest, manifest = root
  if (root.manifests) {
    const children = root.manifests.filter(m => m.platform?.os === 'linux' && m.platform?.architecture === 'amd64')
    guard(children.length === 1 && sha256.test(children[0].digest), 'AMD64_MANIFEST_UNKNOWN')
    childDigest = children[0].digest
    manifest = await raw(`${repository}@${childDigest}`)
  }
  guard(manifest.schemaVersion === 2 && manifest.config?.digest === c.configDigest && Array.isArray(manifest.layers), 'REMOTE_CONFIG_MISMATCH')
  const config = await jsonCommand(runner, 'docker', ['--context', 'desktop-linux', 'buildx', 'imagetools', 'inspect', '--format', '{{json .Image}}', `${repository}@${childDigest}`])
  guard(config.os === 'linux' && config.architecture === 'amd64' && config.config?.Labels?.['org.opencontainers.image.revision'] === c.sha && config.config?.Labels?.['org.opencontainers.image.version'] === c.expectedManagerVersion, 'IMAGE_SOURCE_LABEL_MISMATCH')
  return { reference: c.image, digest, childDigest, configDigest: c.configDigest, sourceSha: c.sha, sourceVersion: c.expectedManagerVersion, validation: 'remote-manifest-hash-and-config-reference-and-labels' }
}

function deploymentFacts(d, name) {
  guard(d?.metadata?.name === name && d.metadata.namespace === 'ai-tools' && typeof d.metadata.uid === 'string' && typeof d.metadata.resourceVersion === 'string' && Number.isSafeInteger(d.metadata.generation), 'DEPLOYMENT_IDENTITY_UNKNOWN')
  const containers = d.spec?.template?.spec?.containers
  guard(Array.isArray(containers) && containers.length > 0 && containers.every(v => typeof v.name === 'string' && typeof v.image === 'string'), 'DEPLOYMENT_CONTAINERS_UNKNOWN')
  if (name !== 'omw-gateway') {
    guard(d.spec.replicas === 1 && d.spec.strategy?.type === 'Recreate', 'RECREATE_ONE_REPLICA_REQUIRED')
    imagePatch(d, 'validation-only')
  }
  const nonImage = structuredClone(d.spec)
  for (const container of nonImage.template.spec.containers) delete container.image
  return { name, uid: d.metadata.uid, resourceVersion: d.metadata.resourceVersion, generation: d.metadata.generation,
    observedGeneration: d.status?.observedGeneration ?? null, readyReplicas: d.status?.readyReplicas ?? 0, updatedReplicas: d.status?.updatedReplicas ?? 0,
    specHash: hash(d.spec), nonImageHash: hash(nonImage), containers: containers.map((v, index) => ({ index, name: v.name, image: v.image })) }
}
const controller = (o, kind, uid) => o.metadata?.ownerReferences?.some(r => r.kind === kind && r.uid === uid && r.controller === true)
export async function clusterSnapshot(c, runner, requirePods = true) {
  return readCluster(c, runner, requirePods)
}
async function readCluster(c, runner, requirePods, observeOnly = false) {
  const deployments = []
  for (const name of names) deployments.push(await jsonCommand(runner, 'kubectl', kube(c, ['get', 'deployment', name, '-o', 'json'])))
  const sets = await jsonCommand(runner, 'kubectl', kube(c, ['get', 'replicasets', '-o', 'json']))
  const pods = await jsonCommand(runner, 'kubectl', kube(c, ['get', 'pods', '-o', 'json']))
  guard(Array.isArray(sets.items) && Array.isArray(pods.items), 'CLUSTER_LIST_UNKNOWN')
  const result = {}
  for (const d of deployments) {
    const facts = deploymentFacts(d, d.metadata.name)
    if (requirePods) guard(facts.observedGeneration === facts.generation && facts.readyReplicas === 1 && facts.updatedReplicas === 1, 'DEPLOYMENT_NOT_CURRENT_READY')
    const ownedSets = sets.items.filter(rs => controller(rs, 'Deployment', facts.uid) && rs.metadata.namespace === 'ai-tools')
    const ownedPods = pods.items.filter(p => ownedSets.some(rs => controller(p, 'ReplicaSet', rs.metadata.uid)) && p.metadata.namespace === 'ai-tools')
    const live = ownedPods.filter(p => !p.metadata.deletionTimestamp)
    if (requirePods) guard(ownedPods.length === 1 && live.length === 1, 'POD_IDENTITY_AMBIGUOUS')
    if (observeOnly) {
      // status 的不健康／未知 Pod 仍要可觀察；不得把這條容錯路徑供 plan/deploy 或 rollout 使用。
      const observations = ownedPods.map(p => observePod(p, ownedSets, d))
      facts.podObservations = observations.map(v => v.observation)
      facts.pod = live.length === 1 && ownedPods.length === 1 ? observations[0].verified : null
    } else facts.pod = live.length === 1 && ownedPods.length === 1 ? podFacts(live[0], ownedSets, d) : null
    result[facts.name] = facts
  }
  return result
}
function observePod(p, sets, d) {
  let verified = null, validationError = null
  try { verified = podFacts(p, sets, d) } catch (error) { validationError = safeCode(error) }
  const rs = sets.find(s => controller(p, 'ReplicaSet', s.metadata.uid))
  const ready = p.status?.conditions?.find(v => v.type === 'Ready')?.status
  const statuses = p.status?.containerStatuses
  return { verified, observation: {
    name: p.metadata.name ?? null, uid: p.metadata.uid ?? null, ownerUid: rs?.metadata.uid ?? null,
    phase: ['Pending', 'Running', 'Succeeded', 'Failed', 'Unknown'].includes(p.status?.phase) ? p.status.phase : null,
    ready: ready === 'True' ? true : ready === 'False' ? false : null, terminating: Boolean(p.metadata.deletionTimestamp), validationError,
    // 不帶出 raw status messages、termination logs 或任意 API body。
    containers: Array.isArray(statuses) ? statuses.map(v => ({
      name: v.name, ready: typeof v.ready === 'boolean' ? v.ready : null,
      state: v.state?.running ? 'running' : v.state?.waiting ? 'waiting' : v.state?.terminated ? 'terminated' : 'unknown',
      restarts: Number.isSafeInteger(v.restartCount) && v.restartCount >= 0 ? v.restartCount : null,
    })) : null,
  } }
}
function podFacts(p, sets, d) {
  const rs = sets.find(s => controller(p, 'ReplicaSet', s.metadata.uid))
  guard(rs && hash(rs.spec.template.spec) === hash(d.spec.template.spec), 'POD_TEMPLATE_OWNER_MISMATCH')
  const statuses = p.status?.containerStatuses
  guard(typeof p.metadata.uid === 'string' && typeof p.metadata.resourceVersion === 'string' && Array.isArray(statuses) && statuses.length === d.spec.template.spec.containers.length, 'POD_STATUS_UNKNOWN')
  guard(p.status.phase === 'Running' && p.status.conditions?.some(v => v.type === 'Ready' && v.status === 'True') && statuses.every(v => v.ready === true && typeof v.containerID === 'string' && v.containerID.length > 0 && typeof v.imageID === 'string' && v.state?.running), 'POD_NOT_READY')
  guard(new Set(statuses.map(v => v.name)).size === statuses.length && statuses.every(v => d.spec.template.spec.containers.some(c => c.name === v.name) && Number.isSafeInteger(v.restartCount) && v.restartCount >= 0), 'POD_STATUS_UNKNOWN')
  guard(hash(p.spec.containers.map(v => ({ name: v.name, image: v.image }))) === hash(d.spec.template.spec.containers.map(v => ({ name: v.name, image: v.image }))), 'POD_IMAGES_UNKNOWN')
  return { name: p.metadata.name, uid: p.metadata.uid, resourceVersion: p.metadata.resourceVersion, ownerUid: rs.metadata.uid,
    containers: statuses.map(v => ({ name: v.name, imageID: v.imageID, containerID: v.containerID, restarts: v.restartCount, ready: v.ready })).sort((a, b) => a.name.localeCompare(b.name)) }
}
function protectedFacts(d) { const { resourceVersion, observedGeneration, readyReplicas, updatedReplicas, pod, ...rest } = d; const { resourceVersion: podVersion, ...podRest } = pod ?? {}; return { ...rest, pod: pod ? podRest : null } }
function compareBaseline(expected, current) {
  for (const name of names) {
    guard(hash(protectedFacts(expected[name])) === hash(protectedFacts(current[name])), 'CLUSTER_FACTS_DRIFT_NEW_PLAN_REQUIRED')
    // Deployment RV 是 CAS authority；Pod RV 常因 status 變更，UID/containerID 才是資料身分。
    guard(expected[name].resourceVersion === current[name].resourceVersion, 'DEPLOYMENT_RESOURCE_VERSION_DRIFT')
  }
}
function imagePatchFromFacts(d, image) {
  return imagePatch({ metadata: { uid: d.uid, resourceVersion: d.resourceVersion }, spec: { template: { spec: { containers: d.containers } } } }, image)
}

export async function createPlan(c, runner) {
  validateConfig(c)
  const release = await releaseGate(c, runner)
  const image = await validateRemoteImage(c, runner)
  const baseline = await clusterSnapshot(c, runner)
  const data = {}
  for (const target of c.targets) data[target] = await inspectWorker(c, baseline[target], runner)
  const final = await clusterSnapshot(c, runner)
  compareBaseline(baseline, final)
  const body = { schema: 1, config: c, release, image, baseline, data, discard: 'Recreate replaces Pod emptyDir: manager history, execution HOME/auth copy, workspace. Content ownership is operator-confirmed, not automatically verified.' }
  return { ...body, digest: hash(body) }
}
export function validatePlan(plan) {
  guard(plan?.schema === 1, 'PLAN_SCHEMA_INVALID')
  validateConfig(plan.config)
  const { digest, ...body } = plan
  guard(digest === hash(body), 'PLAN_DIGEST_MISMATCH')
  guard(plan.baseline && plan.data && plan.image && plan.release, 'PLAN_INCOMPLETE')
  for (const target of plan.config.targets) guard(plan.baseline[target]?.pod && plan.data[target], 'PLAN_TARGET_INCOMPLETE')
}

async function waitHealthy(c, target, before, receipt, tuple, runner, options) {
  const deadline = (options.now ?? Date.now)() + (options.rolloutTimeoutMs ?? 120_000)
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  while ((options.now ?? Date.now)() < deadline) {
    // 對 transitional Pod status 僅重做 GET；transport failure 不當作 empty，也不重送 mutation。
    let current
    try { current = await clusterSnapshot(c, runner, false) } catch (error) {
      if (!['POD_NOT_READY', 'POD_STATUS_UNKNOWN', 'POD_TEMPLATE_OWNER_MISMATCH', 'POD_IMAGES_UNKNOWN'].includes(safeCode(error))) throw error
      await sleep(1000); continue
    }
    const d = current[target]
    guard(d.uid === before.uid && d.generation === receipt.generation && d.nonImageHash === before.nonImageHash && d.containers.every(v => v.image === c.image), 'ROLLOUT_DEPLOYMENT_DRIFT')
    if (d.observedGeneration === d.generation && d.readyReplicas === 1 && d.updatedReplicas === 1 && d.pod && d.pod.uid !== before.pod.uid) {
      guard(d.pod.containers.every(v => [tuple.digest, tuple.childDigest].some(value => v.imageID.endsWith(`@${value}`))), 'RUNTIME_DIGEST_MISMATCH')
      return current
    }
    await sleep(1000)
  }
  throw new Error('ROLLOUT_DEADLINE_UNRESOLVED')
}

export async function reconcile(plan, runner) {
  validatePlan(plan)
  const current = await readCluster(plan.config, runner, false, true)
  return { status: 'readonly-observation', completionClaimed: false, targets: plan.config.targets.map(target => {
    const old = plan.baseline[target], now = current[target]
    const sameOwner = old.uid === now.uid && old.nonImageHash === now.nonImageHash
    const classification = sameOwner && now.containers.every(v => v.image === plan.config.image) ? 'new-image-observed-not-completion-proof'
      : sameOwner && now.specHash === old.specHash ? 'old-image-observed-not-retry-authorization' : 'drift-or-unknown'
    return { target, classification, current: now }
  }), protected: names.filter(n => !plan.config.targets.includes(n)).map(name => {
    const { podObservations, ...snapshot } = current[name]
    return { name, unchanged: hash(protectedFacts(snapshot)) === hash(protectedFacts(plan.baseline[name])) }
  }) }
}

// 此 function 會以 Node 一次性送入 manager；default 邊界全部在函式內，toString() 不依賴 module closure。
// 只能 GET，秘密只存在該 Pod 的記憶體；測試僅注入 config loader／fetch／env，不替換 inspection 邏輯。
export async function managerInspection({ loadConfig = () => import('/opt/omw/apps/manager/dist/src/worker/config.js'), fetch: request = globalThis.fetch, env = process.env } = {}) {
  try {
    const { workerBrowserCredentials, workerSecret } = await loadConfig()
    const { username, password } = await workerBrowserCredentials(env)
    const token = await workerSecret(env, 'OMW_EXECUTION_TOKEN_FILE', 32)
    const basic = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
    const get = async (pathname, control = false) => {
      const response = await request(`http://127.0.0.1:${control ? 4175 : 4174}${pathname}`, { headers: { authorization: control ? `Bearer ${token}` : basic }, signal: AbortSignal.timeout(8000) })
      if (response.status !== 200) throw new Error('unavailable')
      return response.json()
    }
    const controlBefore = await get('/v1/execution', true)
    const connectivity = await get('/api/v1/connectivity')
    const managerVersion = connectivity.manager?.version
    if (typeof managerVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(managerVersion)) throw new Error('version unknown')
    const capacity = await get('/api/v1/worker/capacity')
    const overview = await get('/api/v1/overview?includeHidden=true&view=compact&scope=current')
    if (controlBefore.capacity !== 'available' || controlBefore.startupFailure || capacity.state !== 'available' || !Array.isArray(overview.instances) || overview.instances.length !== 0 || !Array.isArray(overview.notifications) || overview.notifications.length !== 0 || !Number.isSafeInteger(overview.history?.total) || overview.history.total < 0 || overview.history.total > 1000 || typeof overview.history.revision !== 'string') throw new Error('unknown or busy')
    const history = []
    let offset = 0
    do {
      const page = await get(`/api/v1/instances/history?includeHidden=true&offset=${offset}&revision=${encodeURIComponent(overview.history.revision)}`)
      if (page.revision !== overview.history.revision || page.total !== overview.history.total || !Array.isArray(page.instances)) throw new Error('history changed')
      for (const instance of page.instances) {
        if (instance.state !== 'stopped' || typeof instance.id !== 'string' || typeof instance.projectDirectory !== 'string' || (instance.primarySession !== null && typeof instance.primarySession?.sessionId !== 'string')) throw new Error('unknown history')
        history.push({ id: instance.id, state: instance.state, projectDirectory: instance.projectDirectory, sessionId: instance.primarySession?.sessionId ?? null, trackingHidden: instance.trackingHidden === true })
      }
      if (page.nextOffset === null) break
      if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset || page.nextOffset > 1000) throw new Error('history incomplete')
      offset = page.nextOffset
    } while (history.length <= 1000)
    if (history.length !== overview.history.total || new Set(history.map(v => v.id)).size !== history.length) throw new Error('history incomplete')
    const after = await get('/v1/execution', true)
    const finalCapacity = await get('/api/v1/worker/capacity')
    const finalOverview = await get('/api/v1/overview?includeHidden=true&view=compact&scope=current')
    if (after.capacity !== 'available' || after.startupFailure || after.epoch !== controlBefore.epoch || JSON.stringify(after.execution) !== JSON.stringify(controlBefore.execution) || finalCapacity.state !== 'available' || !Array.isArray(finalOverview.instances) || finalOverview.instances.length !== 0 || !Array.isArray(finalOverview.notifications) || finalOverview.notifications.length !== 0 || finalOverview.history?.revision !== overview.history.revision || finalOverview.history?.total !== overview.history.total) throw new Error('state changed')
    const execution = after.execution === null ? null : { instanceId: after.execution.instanceId, directory: after.execution.directory }
    return { ok: true, managerVersion, mode: connectivity.mode, publicCapacity: capacity.state, controlCapacity: after.capacity, epoch: after.epoch, execution, currentCount: 0, pendingCount: 0, namespaceMembers: 0,
      namespaceZeroBasis: 'GET /v1/execution available iff no namespace processes and no mutation', historyRevision: overview.history.revision, history }
  } catch { return { ok: false } }
}

// 只列 metadata，不開啟檔案、不跟 symlink、不讀 auth/DB；limit/permission error 都是 unknown。
export async function workspaceInspection() {
  try {
    const fs = await import('node:fs/promises')
    const entries = []
    const visit = async (directory, depth) => {
      if (depth > 32 || entries.length > 5000) throw new Error('limit')
      for (const name of (await fs.readdir(directory)).sort()) {
        const filename = `${directory}/${name}`
        const info = await fs.lstat(filename)
        if (!info.isFile() && !info.isDirectory()) throw new Error('unknown type')
        entries.push({ path: filename.slice('/workspace'.length), type: info.isDirectory() ? 'directory' : 'file', size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, inode: info.ino, mode: info.mode })
        if (info.isDirectory()) await visit(filename, depth + 1)
      }
    }
    const root = await fs.lstat('/workspace')
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('unknown root')
    await visit('/workspace', 0)
    if (entries.length > 5000) throw new Error('limit')
    const profile = process.env.OMW_WORKER_PROFILE_DIR
    if (profile !== '/home/node/.config/omw-profile') throw new Error('unknown profile')
    await fs.access(`${profile}/opencode.json`, 4)
    const skills = await fs.readdir(`${profile}/skills`)
    if (skills.length === 0) throw new Error('profile missing')
    return { ok: true, entries, profile: { configReadable: true, skills: skills.length }, fileContentsRead: false, authDatabaseRead: false, contentOwnershipVerified: false }
  } catch { return { ok: false } }
}
function validateInspection(data) {
  guard(data?.ok === true && data.mode === 'worker' && /^\d+\.\d+\.\d+$/.test(data.managerVersion) && data.publicCapacity === 'available' && data.controlCapacity === 'available' && data.currentCount === 0 && data.pendingCount === 0 && data.namespaceMembers === 0 && typeof data.epoch === 'string' && data.epoch.length > 0 && typeof data.historyRevision === 'string' && Array.isArray(data.history), 'WORKER_BUSY_OR_METADATA_UNKNOWN')
  guard(data.execution === null || (typeof data.execution?.instanceId === 'string' && typeof data.execution?.directory === 'string'), 'EXECUTION_IDENTITY_UNKNOWN')
  guard(data.history.every(h => h.state === 'stopped' && typeof h.id === 'string' && typeof h.projectDirectory === 'string' && (h.sessionId === null || typeof h.sessionId === 'string')), 'HISTORY_METADATA_UNKNOWN')
}
async function inspectWorker(c, facts, runner) {
  guard(facts.pod, 'POD_REQUIRED_FOR_INSPECTION')
  const inspect = async (container, fn) => jsonCommand(runner, 'kubectl', kube(c, ['exec', facts.pod.name, '-c', container, '--', 'node', '--input-type=module', '-e', `const result=await (${fn.toString()})();process.stdout.write(JSON.stringify(result));`]), 110_000)
  const before = await inspect('manager', managerInspection)
  validateInspection(before)
  const inventory = await inspect('execution', workspaceInspection)
  guard(inventory?.ok === true && inventory.fileContentsRead === false && inventory.authDatabaseRead === false && inventory.contentOwnershipVerified === false && inventory.profile?.configReadable === true && Number.isSafeInteger(inventory.profile.skills) && inventory.profile.skills > 0 && Array.isArray(inventory.entries), 'FILESYSTEM_METADATA_UNKNOWN')
  guard(inventory.entries.length <= 5000 && inventory.entries.every(e => typeof e.path === 'string' && e.path.startsWith('/') && ['file', 'directory'].includes(e.type) && ['size', 'mtimeMs', 'ctimeMs', 'inode', 'mode'].every(k => Number.isFinite(e[k]))), 'FILESYSTEM_METADATA_UNKNOWN')
  const after = await inspect('manager', managerInspection)
  validateInspection(after)
  guard(hash(before) === hash(after), 'WORKER_STATE_DRIFT_NEW_PLAN_REQUIRED')
  // 接口只存窄欄位；不將 kubectl 或 HTTP body/error 原樣寫入 journal。
  return { managerVersion: after.managerVersion, epoch: after.epoch, execution: after.execution, publicCapacity: after.publicCapacity, namespaceMembers: 0, currentCount: 0, pendingCount: 0,
    historyRevision: after.historyRevision, history: after.history.map(h => ({ id: h.id, state: h.state, projectDirectory: h.projectDirectory, sessionId: h.sessionId, trackingHidden: h.trackingHidden })),
    workspace: inventory.entries.map(e => Object.fromEntries(['path', 'type', 'size', 'mtimeMs', 'ctimeMs', 'inode', 'mode'].map(k => [k, e[k]]))),
    profile: { configReadable: true, skills: inventory.profile.skills }, contentOwnershipVerified: false }
}
