import { isIP } from 'node:net'
import { createHmac } from 'node:crypto'
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const image = 'pomerium/pomerium:v0.33.4@sha256:d6e1d438b3ee88e2391feead5e39463b89da58eee0e39e78c80b94ee498a23af'
export const check = (ok, message) => { if (!ok) throw new Error(message) }
const text = v => typeof v === 'string' && v.length > 0
export const keys = (o, allowed) => check(o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every(k => allowed.includes(k)), 'UNKNOWN_CONFIGURATION_FIELD')
export const dnsName = v => typeof v === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(v)
const host = v => text(v) && v.length <= 253 && v.split('.').length >= 3 && v.split('.').every(dnsName)
export const labels = id => ({ 'app.kubernetes.io/part-of': 'omw', 'omw.io/identity': id })
export const workerLabels = { 'app.kubernetes.io/part-of': 'omw', 'omw.io/coordinator-worker': 'true' }
const selector = l => ({ matchLabels: l })
const peer = l => ({ podSelector: selector(l) }) // 不加 namespaceSelector，僅允許同 namespace。
const ports = (...values) => values.map(port => ({ protocol: 'TCP', port }))
const env = values => Object.entries(values).map(([name, value]) => ({ name, value: String(value) }))
const mount = (name, mountPath, extra = {}) => ({ name, mountPath, ...extra })
const security = { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } }
const resources = { requests: { cpu: '100m', memory: '256Mi', 'ephemeral-storage': '256Mi' }, limits: { cpu: '2', memory: '2Gi', 'ephemeral-storage': '4Gi' } }
const probe = (port, url) => ({ httpGet: { path: url, port }, periodSeconds: 5, timeoutSeconds: 2, failureThreshold: 6 })
const resource = (c, kind, name, spec, l, apiVersion = 'v1') => ({ apiVersion, kind, metadata: { name, namespace: c.namespace, labels: l }, spec })
const secretVolume = (name, secretName, secretKeys) => ({ name, secret: { secretName, defaultMode: 288, items: secretKeys.map(key => ({ key, path: key })) } })
const pod = (c, containers, volumes) => ({ automountServiceAccountToken: false, hostPID: false, shareProcessNamespace: false, securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } }, terminationGracePeriodSeconds: 30, imagePullSecrets: [{ name: c.imagePullSecret }], containers, volumes })
const container = (c, name, entry, values, mounts, health) => ({ name, image: c.workerImage, command: ['/usr/bin/tini', '--', 'node', entry], env: env(values), securityContext: security, resources, volumeMounts: mounts, startupProbe: { ...probe(health, '/health/live'), failureThreshold: 60 }, livenessProbe: probe(health, '/health/live'), readinessProbe: probe(health, '/health/ready') })

export function validate(c) {
  keys(c, ['namespace', 'workerImage', 'imagePullSecret', 'authenticateHost', 'issuer', 'gatewayConfigSecret', 'gatewayService', 'ingressClassName', 'edgePeer', 'dnsPeer', 'httpsEgress', 'allowedRoles', 'coordinator', 'standaloneWorkers'])
  check(c.namespace === 'ai-tools', 'NAMESPACE_MUST_BE_AI_TOOLS')
  check(typeof c.workerImage === 'string' && /^[^\s]+@sha256:[a-f0-9]{64}$/.test(c.workerImage), 'PINNED_WORKER_IMAGE_REQUIRED')
  for (const k of ['imagePullSecret', 'gatewayConfigSecret', 'ingressClassName']) check(dnsName(c[k]), 'RESOURCE_NAME_REQUIRED')
  check(c.gatewayConfigSecret.startsWith('omw-') && c.gatewayService === 'omw-gateway', 'OWNED_EXISTING_GATEWAY_REQUIRED')
  for (const p of [c.edgePeer, c.dnsPeer]) {
    keys(p, ['namespaceSelector', 'podSelector'])
    for (const s of [p.namespaceSelector, p.podSelector]) {
      keys(s, ['matchLabels'])
      check(s.matchLabels && Object.keys(s.matchLabels).length > 0 && Object.values(s.matchLabels).every(text), 'EXPLICIT_PEER_SELECTORS_REQUIRED')
    }
  }
  keys(c.httpsEgress, ['mode', 'cidrs'])
  check(['allow443', 'cidrs'].includes(c.httpsEgress.mode), 'HTTPS_EGRESS_MODE_REQUIRED')
  if (c.httpsEgress.mode === 'cidrs') check(Array.isArray(c.httpsEgress.cidrs) && c.httpsEgress.cidrs.length > 0 && c.httpsEgress.cidrs.every(ipv4Cidr), 'EXPLICIT_IPV4_CIDRS_REQUIRED')
  const roles = c.allowedRoles === undefined ? ['admin'] : c.allowedRoles
  check(Array.isArray(roles) && roles.every(r => text(r) && r.trim() === r), 'ROLE_ARRAY_REQUIRED')
  const q = c.coordinator
  keys(q, ['host', 'browserUsername', 'secretName', 'registrationSecretName', 'allowedCidrs', 'registryClaimName', 'healthIntervalMs', 'healthTimeoutMs', 'failureThreshold'])
  check(text(q.browserUsername) && !/[:\r\n\0]/.test(q.browserUsername), 'BROWSER_USERNAME_REQUIRED')
  for (const k of ['secretName', 'registrationSecretName']) check(dnsName(q[k]) && q[k].startsWith('omw-'), 'OWNED_SECRET_REFERENCE_REQUIRED')
  check(new Set([q.secretName, q.registrationSecretName, c.gatewayConfigSecret]).size === 3, 'SEPARATE_SECRET_REFERENCES_REQUIRED')
  check(Array.isArray(q.allowedCidrs) && q.allowedCidrs.length > 0 && q.allowedCidrs.every(coordinatorCidr), 'EXPLICIT_CANONICAL_IPV4_CIDRS_REQUIRED')
  if (q.registryClaimName !== undefined) check(dnsName(q.registryClaimName), 'EXISTING_REGISTRY_CLAIM_REQUIRED')
  for (const k of ['healthIntervalMs', 'healthTimeoutMs', 'failureThreshold']) if (q[k] !== undefined) check(Number.isSafeInteger(q[k]) && q[k] > 0, 'POSITIVE_HEALTH_SETTING_REQUIRED')
  check((q.healthIntervalMs ?? 15000) <= 3600000 && (q.healthTimeoutMs ?? 3000) <= 10000 && (q.failureThreshold ?? 3) <= 100, 'BOUNDED_HEALTH_SETTINGS_REQUIRED')
  const issuer = new URL(c.issuer)
  check(issuer.protocol === 'https:' && !issuer.username && !issuer.password && !issuer.search && !issuer.hash, 'HTTPS_ISSUER_REQUIRED')
  check(host(c.authenticateHost) && host(q.host), 'FLAT_HOST_REQUIRED')
  const parent = c.authenticateHost.split('.').slice(1).join('.')
  check(parent.length <= 190, 'BOUNDED_NATIVE_PARENT_REQUIRED')
  const hosts = [c.authenticateHost, q.host], names = new Set(), secrets = new Set([q.secretName, q.registrationSecretName, c.gatewayConfigSecret])
  check(c.standaloneWorkers === undefined || Array.isArray(c.standaloneWorkers), 'STANDALONE_ARRAY_REQUIRED')
  for (const w of c.standaloneWorkers ?? []) {
    keys(w, ['name', 'managerHost', 'nativeHost', 'secretName', 'browserUsername'])
    check(dnsName(w.name) && !['gateway', 'coordinator'].includes(w.name) && !names.has(w.name), 'UNIQUE_WORKER_REQUIRED')
    names.add(w.name)
    check(dnsName(w.secretName) && !secrets.has(w.secretName) && text(w.browserUsername) && !/[:\r\n\0]/.test(w.browserUsername), 'ISOLATED_STANDALONE_AUTH_REQUIRED')
    secrets.add(w.secretName)
    hosts.push(w.managerHost, w.nativeHost)
  }
  // 保留整個 class（含格式錯誤的 wildcard matches），不依賴 route priority 避開衝突。
  check(hosts.every(h => host(h) && h.split('.').slice(1).join('.') === parent && !/^omw-job-.*-code\./.test(h)) && new Set(hosts).size === hosts.length, 'UNIQUE_FLAT_NONCLASS_HOSTS_REQUIRED')
  return { roles, parent }
}

function ipv4Cidr(v) {
  if (typeof v !== 'string') return false
  const [ip, prefix, extra] = v.split('/')
  return extra === undefined && isIP(ip) === 4 && /^(?:0|[1-9]\d?)$/.test(prefix ?? '') && Number(prefix) <= 32
}

function coordinatorCidr(v) {
  if (!ipv4Cidr(v)) return false
  const [ip, prefix] = v.split('/')
  if (Number(prefix) === 0) return false
  const address = ip.split('.').reduce((n, octet) => n * 256 + Number(octet), 0) >>> 0
  const mask = (0xffffffff << (32 - Number(prefix))) >>> 0
  return ((address & mask) >>> 0) === address
}

// 沿用 base renderer 已實測的 policy。PPL 會 flatten scalar groups，
// 必須檢查可信 session 的 raw ID token，才能保留 array 型別邊界。
export function policy(roles) {
  return `package pomerium.policy\ndefault allow = [false, ["user-unauthenticated"]]\nallow = [true, ["claim-ok"]] { permitted }\nelse = [false, ["claim-unauthorized"]] {\n  session := get_databroker_record("type.googleapis.com/session.Session", input.session.id)\n  object.get(session, "user_id", "") != ""\n}\npermitted {\n  session := get_databroker_record("type.googleapis.com/session.Session", input.session.id)\n  raw := object.get(session, ["id_token", "raw"], "")\n  [_, claims, _] := io.jwt.decode(raw)\n  groups := claims.groups\n  is_array(groups)\n  count([x | x := groups[_]; not is_string(x)]) == 0\n  allowed := ${JSON.stringify(roles)}\n  groups[_] == allowed[_]\n}\n`
}

const removal = ['Authorization', 'X-Pomerium-Jwt-Assertion', 'X-Pomerium-Claim-Groups', 'X-Pomerium-Claim-Email', 'X-Forwarded-User', 'X-Forwarded-Email', 'X-Auth-Request-User', 'X-Auth-Request-Email', 'X-Id-Token', 'X-Access-Token']
export function build(c) {
  const { roles, parent } = validate(c), q = c.coordinator
  const route = (from, to) => ({ from: `https://${from}`, to, preserve_host_header: true, pass_identity_headers: false, allow_websockets: true, timeout: '0s', idle_timeout: '0s', remove_request_headers: [...removal], sub_policies: [{ rego: [policy(roles)] }] })
  const to = `http://omw-coordinator.${c.namespace}.svc.cluster.local:4174`
  const gateway = { services: 'all', insecure_server: true, address: ':8080', authenticate_service_url: `https://${c.authenticateHost}`, idp_provider: 'oidc', idp_provider_url: c.issuer, idp_client_id: 'omw', idp_scopes: ['openid', 'profile', 'email', 'groups'], databroker_storage_type: 'memory', cookie_secure: true, cookie_http_only: true, routes: [route(q.host, to), route(`omw-job-*-code.${parent}`, to), ...(c.standaloneWorkers ?? []).flatMap(w => [[w.managerHost, 4174], [w.nativeHost, 4180]].map(([h, port]) => route(h, `http://omw-${w.name}.${c.namespace}.svc.cluster.local:${port}`)))] }
  const items = [], coord = labels('coordinator'), gate = labels('gateway')
  const add = (kind, name, spec, l, api = 'v1') => items.push(resource(c, kind, name, spec, l, api))
  const coordEnv = { OMW_MODE: 'coordinator', OMW_PUBLIC_ORIGIN: `https://${q.host}`, OMW_BROWSER_USERNAME: q.browserUsername, OMW_BROWSER_PASSWORD_FILE: '/run/omw/browser_password', OMW_DATA_DIR: '/data/coordinator', OMW_PORT: 4174, OMW_HEALTH_PORT: 4176, OMW_COORDINATOR_REGISTRATION_SECRET_FILE: '/run/registration/registration_secret', OMW_COORDINATOR_ALLOWED_CIDRS: q.allowedCidrs.join(','), OMW_COORDINATOR_NATIVE_HOST_SUFFIX: parent }
  for (const [k, e] of [['healthIntervalMs', 'HEALTH_INTERVAL_MS'], ['healthTimeoutMs', 'HEALTH_TIMEOUT_MS'], ['failureThreshold', 'HEALTH_FAILURE_THRESHOLD']]) if (q[k] !== undefined) coordEnv[`OMW_COORDINATOR_${e}`] = q[k]
  const coordinator = container(c, 'coordinator', 'apps/manager/dist/src/server.js', coordEnv, [mount('browser-auth', '/run/omw', { readOnly: true }), mount('registration', '/run/registration', { readOnly: true }), mount('registry', '/data/coordinator')], 4176)
  add('Deployment', 'omw-coordinator', { replicas: 1, strategy: { type: 'Recreate' }, selector: selector(coord), template: { metadata: { labels: coord }, spec: pod(c, [coordinator], [secretVolume('browser-auth', q.secretName, ['browser_password']), secretVolume('registration', q.registrationSecretName, ['registration_secret']), { name: 'registry', ...(q.registryClaimName ? { persistentVolumeClaim: { claimName: q.registryClaimName } } : { emptyDir: {} }) }]) } }, coord, 'apps/v1')
  add('Service', 'omw-coordinator', { type: 'ClusterIP', selector: coord, ports: [{ name: 'manager', port: 4174, targetPort: 4174 }] }, coord)
  const dns = { to: [c.dnsPeer], ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] }
  const https = { ports: ports(443), ...(c.httpsEgress.mode === 'cidrs' ? { to: c.httpsEgress.cidrs.map(cidr => ({ ipBlock: { cidr } })) } : {}) }
  add('NetworkPolicy', 'omw-coordinator', { podSelector: selector(coord), policyTypes: ['Ingress', 'Egress'], ingress: [{ from: [peer(gate), peer(workerLabels)], ports: ports(4174) }], egress: [dns, { to: [peer(workerLabels)], ports: ports(4174, 4176, 4180) }] }, coord, 'networking.k8s.io/v1')
  add('NetworkPolicy', 'omw-coordinator-workers', { podSelector: selector(workerLabels), policyTypes: ['Ingress', 'Egress'], ingress: [{ from: [peer(coord)], ports: ports(4174, 4176, 4180) }], egress: [dns, https, { to: [peer(coord)], ports: ports(4174) }] }, labels('coordinator-workers'), 'networking.k8s.io/v1')
  const gatewayContainer = { name: 'pomerium', image, args: ['--config=/etc/pomerium/config.json'], securityContext: security, resources, volumeMounts: [mount('config', '/etc/pomerium', { readOnly: true })], readinessProbe: { tcpSocket: { port: 8080 }, periodSeconds: 5 } }
  add('Deployment', 'omw-gateway', { replicas: 1, strategy: { type: 'Recreate' }, selector: selector(gate), template: { metadata: { labels: gate }, spec: pod(c, [gatewayContainer], [secretVolume('config', c.gatewayConfigSecret, ['config.json'])]) } }, gate, 'apps/v1')
  add('Service', c.gatewayService, { type: 'ClusterIP', selector: gate, ports: [{ name: 'http', port: 8080, targetPort: 8080 }] }, gate)
  add('NetworkPolicy', 'omw-gateway', { podSelector: selector(gate), policyTypes: ['Ingress', 'Egress'], ingress: [{ from: [c.edgePeer], ports: ports(8080) }], egress: [dns, https, { to: [peer(coord)], ports: ports(4174) }, ...(c.standaloneWorkers ?? []).map(w => ({ to: [peer(labels(w.name))], ports: ports(4174, 4180) }))] }, gate, 'networking.k8s.io/v1')
  const ingress = exactIngress(c, 'omw-gateway', [c.authenticateHost, q.host, ...(c.standaloneWorkers ?? []).flatMap(w => [w.managerHost, w.nativeHost])], gate)
  items.push(ingress)
  return { items, gateway }
}

function exactIngress(c, name, hosts, l) {
  const r = resource(c, 'Ingress', name, { ingressClassName: c.ingressClassName, rules: hosts.map(host => ({ host, http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: c.gatewayService, port: { number: 8080 } } } }] } })) }, l, 'networking.k8s.io/v1')
  r.metadata.annotations = { 'ingress.softleader.com.tw/automanaged': 'true' }
  return r
}

export function validateWorker(c, w) {
  const { parent } = validate(c)
  keys(w, ['id', 'kind', 'name', 'secretName', 'keySecretName', 'browserUsername', 'nativeHost', 'seed', 'taskCommands', 'ttlSecondsAfterFinished'])
  check(typeof w.id === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(w.id), 'SHORT_DNS_WORKER_ID_REQUIRED')
  check(['task', 'resident'].includes(w.kind), 'WORKER_KIND_REQUIRED')
  check(w.name === undefined || (text(w.name) && w.name.length <= 80 && !/[\r\n\0]/.test(w.name)), 'WORKER_NAME_REQUIRED')
  const nativeHost = `omw-job-${w.id}-code.${parent}`
  check(host(nativeHost) && (w.nativeHost === undefined || w.nativeHost === nativeHost), 'EXACT_NATIVE_HOST_REQUIRED')
  check(text(w.browserUsername) && !/[:\r\n\0]/.test(w.browserUsername), 'BROWSER_USERNAME_REQUIRED')
  for (const k of ['secretName', 'keySecretName']) check(dnsName(w[k]) && w[k].startsWith('omw-'), 'OWNED_SECRET_REFERENCE_REQUIRED')
  const refs = [w.secretName, w.keySecretName, c.coordinator.secretName, c.coordinator.registrationSecretName, c.gatewayConfigSecret, ...(c.standaloneWorkers ?? []).map(x => x.secretName)]
  check(new Set(refs).size === refs.length, 'ISOLATED_WORKER_SECRET_REQUIRED')
  if (w.seed) {
    keys(w.seed, ['claimName', 'subPath', 'authFile', 'patFile'])
    check(dnsName(w.seed.claimName) && text(w.seed.subPath) && !/^[\/\\]|^[a-zA-Z]:/.test(w.seed.subPath) && !w.seed.subPath.split(/[\/\\]/).includes('..'), 'READONLY_SEED_REFERENCE_REQUIRED')
    for (const k of ['authFile', 'patFile']) if (w.seed[k] !== undefined) check(/^[\w.-]+$/.test(w.seed[k]) && !['.', '..'].includes(w.seed[k]), 'SEED_FILENAME_REQUIRED')
  }
  if (w.taskCommands !== undefined) {
    check(w.kind === 'task', 'TASK_COMMANDS_ONLY_FOR_JOB')
    keys(w.taskCommands, ['manager', 'execution'])
    for (const k of ['manager', 'execution']) check(Array.isArray(w.taskCommands[k]) && w.taskCommands[k].length > 0 && w.taskCommands[k].every(v => text(v) && !v.includes('\0')), 'BOTH_EXTERNAL_EXIT_COMMANDS_REQUIRED')
  }
  if (w.ttlSecondsAfterFinished !== undefined) check(Number.isSafeInteger(w.ttlSecondsAfterFinished) && w.ttlSecondsAfterFinished >= 0, 'NONNEGATIVE_TTL_REQUIRED')
  return nativeHost
}

export function buildWorker(c, w) {
  const nativeHost = validateWorker(c, w), id = `omw-job-${w.id}`, l = { ...labels(id), ...workerLabels }
  const common = { OMW_BROWSER_USERNAME: w.browserUsername, OMW_BROWSER_PASSWORD_FILE: '/run/omw/browser_password', OMW_EXECUTION_TOKEN_FILE: '/run/omw/execution_token', OMW_NATIVE_ORIGIN: `https://${nativeHost}`, OMW_RUNTIME_PORT: 4096 }
  const manager = container(c, 'manager', 'apps/manager/dist/src/server.js', { ...common, OMW_MODE: 'worker', OMW_DATA_DIR: '/data/manager', OMW_PUBLIC_ORIGIN: `https://${c.coordinator.host}`, OMW_EXECUTION_ORIGIN: 'http://127.0.0.1:4175', OMW_PORT: 4174, OMW_HEALTH_PORT: 4176, OMW_COORDINATOR_URL: 'http://omw-coordinator:4174', OMW_COORDINATOR_WORKER_ID: w.id, OMW_COORDINATOR_WORKER_KIND: w.kind, ...(w.name ? { OMW_COORDINATOR_WORKER_NAME: w.name } : {}), OMW_COORDINATOR_WORKER_KEY_FILE: '/run/worker-key/worker_key' }, [mount('auth', '/run/omw', { readOnly: true }), mount('worker-key', '/run/worker-key', { readOnly: true }), mount('manager-data', '/data/manager')], 4176)
  manager.env.push({ name: 'OMW_COORDINATOR_GENERATION', valueFrom: { fieldRef: { fieldPath: 'metadata.uid' } } }, { name: 'OMW_COORDINATOR_ADVERTISE_ADDRESS', valueFrom: { fieldRef: { fieldPath: 'status.podIP' } } })
  const execution = container(c, 'execution', 'apps/manager/dist/src/worker/execution-server.js', { ...common, OMW_EXECUTION_HOST: '127.0.0.1', OMW_EXECUTION_PORT: 4175, OMW_NATIVE_PORT: 4180, OMW_HEALTH_PORT: 4177, OMW_OPENCODE_EXECUTABLE: '/usr/local/bin/opencode', ...(w.seed?.authFile ? { OMW_AUTH_SEED_FILE: `/seed/${w.seed.authFile}` } : {}), ...(w.seed?.patFile ? { OMW_GITHUB_TOKEN_FILE: `/seed/${w.seed.patFile}` } : {}) }, [mount('auth', '/run/omw', { readOnly: true }), mount('execution-home', '/home/node'), mount('workspace', '/workspace'), ...(w.seed ? [mount('seed', '/seed', { readOnly: true, subPath: w.seed.subPath })] : [])], 4177)
  if (w.taskCommands) for (const item of [manager, execution]) item.command = ['/usr/bin/tini', '--', ...w.taskCommands[item.name]]
  const template = { metadata: { labels: l, annotations: { 'omw.io/exit-contract': w.taskCommands ? 'external-starter-owned-both-containers' : 'resident-commands-do-not-complete-job' } }, spec: { ...pod(c, [manager, execution], [secretVolume('auth', w.secretName, ['browser_password', 'execution_token']), secretVolume('worker-key', w.keySecretName, ['worker_key']), ...['manager-data', 'execution-home', 'workspace'].map(name => ({ name, emptyDir: {} })), ...(w.seed ? [{ name: 'seed', persistentVolumeClaim: { claimName: w.seed.claimName, readOnly: true } }] : [])]), restartPolicy: w.kind === 'task' ? 'Never' : 'Always' } }
  // 沒有外部退出契約時只輸出 template，避免誤認兩個常駐 server 會完成 Job。
  const workload = w.kind === 'task' ? (w.taskCommands ? resource(c, 'Job', id, { backoffLimit: 0, ...(w.ttlSecondsAfterFinished !== undefined ? { ttlSecondsAfterFinished: w.ttlSecondsAfterFinished } : {}), template }, l, 'batch/v1') : undefined) : resource(c, 'Deployment', id, { replicas: 1, strategy: { type: 'Recreate' }, selector: selector(l), template }, l, 'apps/v1')
  return { template, workload }
}

export function buildJobIngress(c, w, createdJob) {
  const nativeHost = validateWorker(c, w), id = `omw-job-${w.id}`
  check(w.kind === 'task' && createdJob?.apiVersion === 'batch/v1' && createdJob.kind === 'Job', 'CREATED_JOB_REQUIRED')
  const m = createdJob.metadata
  check(m?.name === id && m.namespace === c.namespace && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(m.uid ?? '') && m.labels?.['app.kubernetes.io/part-of'] === 'omw' && m.labels?.['omw.io/identity'] === id && m.labels?.['omw.io/coordinator-worker'] === 'true', 'CURRENT_OWNED_JOB_UID_REQUIRED')
  const ingress = exactIngress(c, `${id}-code`, [nativeHost], { ...labels(id), ...workerLabels })
  ingress.metadata.ownerReferences = [{ apiVersion: 'batch/v1', kind: 'Job', name: m.name, uid: m.uid, controller: true, blockOwnerDeletion: false }]
  return ingress
}

const secretText = (v, length) => text(v) && v.length >= length && Buffer.byteLength(v) <= 4096 && v.trim() === v && !/[\r\n\0]/.test(v)
export function deriveWorkerKey(registrationSecret, workerId) {
  check(secretText(registrationSecret, 32) && !/\s/.test(registrationSecret) && typeof workerId === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(workerId), 'VALID_DERIVATION_INPUT_REQUIRED')
  return createHmac('sha256', registrationSecret).update(workerId, 'utf8').digest('base64url')
}
const secret = (c, name, id, stringData) => ({ apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace: c.namespace, labels: labels(id) }, type: 'Opaque', immutable: true, stringData })
export function coordinatorSecrets(c, gateway, values) {
  keys(values, ['clientSecret', 'cookieSecret', 'sharedSecret', 'coordinatorPassword', 'registrationSecret', 'standalonePasswords'])
  check(secretText(values.clientSecret, 1) && secretText(values.coordinatorPassword, 16), 'PRIVATE_PASSWORD_REQUIRED')
  deriveWorkerKey(values.registrationSecret, 'validation')
  check(values.coordinatorPassword !== values.registrationSecret, 'SEPARATE_COORDINATOR_CREDENTIALS_REQUIRED')
  for (const k of ['cookieSecret', 'sharedSecret']) check(typeof values[k] === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(values[k]) && Buffer.from(values[k], 'base64').length === 32, 'BASE64_32_BYTE_SECRET_REQUIRED')
  gateway = structuredClone(gateway)
  Object.assign(gateway, { idp_client_secret: values.clientSecret, cookie_secret: values.cookieSecret, shared_secret: values.sharedSecret })
  const basic = (r, username, password) => {
    // base gateway harness 已確認 removal 優先於 setting，不能同時保留 Authorization removal。
    r.remove_request_headers = r.remove_request_headers.filter(h => h !== 'Authorization')
    r.set_request_headers = { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` }
  }
  for (const r of gateway.routes.slice(0, 2)) basic(r, c.coordinator.browserUsername, values.coordinatorPassword)
  for (const [i, w] of (c.standaloneWorkers ?? []).entries()) {
    const password = values.standalonePasswords?.[w.name]
    check(secretText(password, 16), 'EXISTING_STANDALONE_PASSWORD_REQUIRED')
    for (const r of gateway.routes.slice(2 + i * 2, 4 + i * 2)) basic(r, w.browserUsername, password)
  }
  return [secret(c, c.gatewayConfigSecret, 'gateway', { 'config.json': JSON.stringify(gateway) }), secret(c, c.coordinator.secretName, 'coordinator', { browser_password: values.coordinatorPassword }), secret(c, c.coordinator.registrationSecretName, 'coordinator', { registration_secret: values.registrationSecret })]
}
export function workerSecrets(c, w, values) {
  validateWorker(c, w)
  keys(values, ['registrationSecret', 'password', 'executionToken'])
  check(secretText(values.password, 16) && secretText(values.executionToken, 32) && !/\s/.test(values.executionToken) && values.password !== values.executionToken && values.password !== values.registrationSecret && values.executionToken !== values.registrationSecret, 'INDEPENDENT_WORKER_CREDENTIALS_REQUIRED')
  const key = deriveWorkerKey(values.registrationSecret, w.id)
  check(values.password !== key && values.executionToken !== key, 'INDEPENDENT_WORKER_CREDENTIALS_REQUIRED')
  return [secret(c, w.secretName, `omw-job-${w.id}`, { browser_password: values.password, execution_token: values.executionToken }), secret(c, w.keySecretName, `omw-job-${w.id}`, { worker_key: key })]
}

export const list = items => ({ apiVersion: 'v1', kind: 'List', items })
const root = fileURLToPath(new URL('../../', import.meta.url))
const outside = (base, p) => { const rel = path.relative(base, p); return rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel) }
export async function externalFile(file) {
  const resolved = await realpath(file)
  check(outside(await realpath(root), resolved), 'PRIVATE_INPUT_MUST_BE_OUTSIDE_CHECKOUT')
  return resolved
}
export async function readPrivate(file, fields) {
  const refs = JSON.parse(await readFile(await externalFile(file), 'utf8'))
  keys(refs, fields.map(f => f + 'File').concat('standalonePasswordFiles'))
  const values = {}
  for (const field of fields) {
    check(text(refs[field + 'File']) && path.isAbsolute(refs[field + 'File']), 'ABSOLUTE_PRIVATE_FILE_REQUIRED')
    values[field] = await readFile(await externalFile(refs[field + 'File']), 'utf8')
  }
  if (refs.standalonePasswordFiles) {
    check(typeof refs.standalonePasswordFiles === 'object' && !Array.isArray(refs.standalonePasswordFiles), 'PASSWORD_FILE_MAP_REQUIRED')
    values.standalonePasswords = {}
    for (const [name, p] of Object.entries(refs.standalonePasswordFiles)) {
      check(dnsName(name) && typeof p === 'string' && path.isAbsolute(p), 'ABSOLUTE_PRIVATE_FILE_REQUIRED')
      values.standalonePasswords[name] = await readFile(await externalFile(p), 'utf8')
    }
  }
  return values
}
export async function outputDirectory(dir) {
  const out = path.resolve(dir), parent = await realpath(path.dirname(out))
  check(outside(await realpath(root), parent), 'OUTPUT_MUST_BE_OUTSIDE_CHECKOUT')
  await mkdir(out, { mode: 448 }) // 僅新目錄，避免覆寫既有秘密或跟隨其 symlink。
  return (file, value) => writeFile(path.join(out, file), JSON.stringify(value, null, 2) + '\n', { mode: 384, flag: 'wx' })
}
export function options(args, allowed, required) {
  check(args.length % 2 === 0, 'PAIRED_ARGUMENTS_REQUIRED')
  const result = {}
  for (let i = 0; i < args.length; i += 2) {
    check(allowed.includes(args[i]) && !Object.hasOwn(result, args[i]) && text(args[i + 1]), 'INVALID_ARGUMENTS')
    result[args[i]] = args[i + 1]
  }
  check(required.every(k => result[k]), 'REQUIRED_ARGUMENTS_MISSING')
  return result
}
