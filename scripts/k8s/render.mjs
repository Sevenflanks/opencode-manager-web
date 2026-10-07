import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const image = 'pomerium/pomerium:v0.33.4@sha256:d6e1d438b3ee88e2391feead5e39463b89da58eee0e39e78c80b94ee498a23af'
const check = (ok, message) => { if (!ok) throw new Error(message) }
const text = v => typeof v === 'string' && v.length > 0
const workerSecret = (v, minLength) => text(v) && v.length >= minLength && Buffer.byteLength(v, 'utf8') <= 4096 && !/[\r\n\0]/.test(v)
const name = v => typeof v === 'string' && /^[a-z][a-z0-9-]{0,40}[a-z0-9]$/.test(v)
const keys = (o, allowed) => check(o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every(k => allowed.includes(k)), 'UNKNOWN_CONFIGURATION_FIELD')
const labels = id => ({ 'app.kubernetes.io/part-of': 'omw', 'omw.io/identity': id })
const selector = id => ({ matchLabels: labels(id) })
const peer = id => ({ podSelector: selector(id) })
const ports = (...values) => values.map(port => ({ protocol: 'TCP', port }))
const security = { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } }
const resources = { requests: { cpu: '100m', memory: '256Mi', 'ephemeral-storage': '256Mi' }, limits: { cpu: '2', memory: '2Gi', 'ephemeral-storage': '4Gi' } }
const env = values => Object.entries(values).map(([name, value]) => ({ name, value: String(value) }))
const mount = (name, mountPath, extra = {}) => ({ name, mountPath, ...extra })
function validate(c) {
  keys(c, ['namespace', 'workerImage', 'imagePullSecret', 'authenticateHost', 'issuer', 'gatewayConfigSecret', 'ingressClassName', 'edgePeer', 'dnsPeer', 'httpsEgress', 'workers', 'allowedRoles'])
  check(c.namespace === 'ai-tools', 'NAMESPACE_MUST_BE_AI_TOOLS')
  check(/^[^\s]+@sha256:[a-f0-9]{64}$/.test(c.workerImage), 'PINNED_WORKER_IMAGE_REQUIRED')
  for (const k of ['imagePullSecret', 'gatewayConfigSecret', 'ingressClassName']) check(name(c[k]), 'RESOURCE_NAME_REQUIRED')
  check(c.gatewayConfigSecret.startsWith('omw-'), 'GENERATED_SECRET_MUST_BE_OWNED')
  for (const p of [c.edgePeer, c.dnsPeer]) {
    keys(p, ['namespaceSelector', 'podSelector'])
    for (const s of [p.namespaceSelector, p.podSelector]) {
      keys(s, ['matchLabels'])
      check(s.matchLabels && Object.keys(s.matchLabels).length > 0 && Object.values(s.matchLabels).every(text), 'EXPLICIT_PEER_SELECTORS_REQUIRED')
    }
  }
  keys(c.httpsEgress, ['mode', 'cidrs'])
  check(['allow443', 'cidrs'].includes(c.httpsEgress.mode), 'HTTPS_EGRESS_MODE_REQUIRED')
  if (c.httpsEgress.mode === 'cidrs') check(Array.isArray(c.httpsEgress.cidrs) && c.httpsEgress.cidrs.length > 0 && c.httpsEgress.cidrs.every(v => {
    const [ip, prefix, extra] = String(v).split('/')
    return !extra && isIP(ip) && /^\d+$/.test(prefix) && Number(prefix) <= (isIP(ip) === 4 ? 32 : 128)
  }), 'VALID_CIDRS_REQUIRED')
  const roles = c.allowedRoles === undefined ? ['admin'] : c.allowedRoles
  check(Array.isArray(roles) && roles.every(r => text(r) && r.trim() === r), 'ROLE_ARRAY_REQUIRED')
  check(Array.isArray(c.workers) && c.workers.length > 0, 'WORKERS_REQUIRED')
  const hosts = [c.authenticateHost], names = new Set(), secrets = new Set()
  for (const w of c.workers) {
    keys(w, ['name', 'managerHost', 'nativeHost', 'secretName', 'browserUsername', 'seed'])
    check(name(w.name) && w.name !== 'gateway' && !names.has(w.name), 'DUPLICATE_OR_INVALID_WORKER_NAME')
    names.add(w.name)
    check(name(w.secretName) && !secrets.has(w.secretName) && w.secretName !== c.gatewayConfigSecret && text(w.browserUsername) && !/[:\r\n\0]/.test(w.browserUsername), 'ISOLATED_BASIC_SECRET_REQUIRED')
    secrets.add(w.secretName)
    hosts.push(w.managerHost, w.nativeHost)
    if (w.seed) {
      keys(w.seed, ['claimName', 'subPath', 'authFile', 'patFile'])
      check(name(w.seed.claimName) && text(w.seed.subPath) && !w.seed.subPath.startsWith('/') && !w.seed.subPath.split('/').includes('..'), 'DEDICATED_SEED_PATH_REQUIRED')
      for (const key of ['authFile', 'patFile']) if (w.seed[key] !== undefined) check(/^[\w.-]+$/.test(w.seed[key]) && !['.', '..'].includes(w.seed[key]), 'SEED_FILENAME_REQUIRED')
    }
  }
  const parent = String(c.authenticateHost).split('.').slice(1).join('.')
  check(parent.includes('.') && hosts.every(h => typeof h === 'string' && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(h) && h.split('.').slice(1).join('.') === parent) && new Set(hosts).size === hosts.length, 'UNIQUE_FLAT_HOSTS_REQUIRED')
  const issuer = new URL(c.issuer)
  check(issuer.protocol === 'https:' && !issuer.username && !issuer.password && !issuer.search && !issuer.hash, 'HTTPS_ISSUER_REQUIRED')
  return roles
}

// Normalized Pomerium claims lose scalar/array distinctions. Only the validated
// session's original ID token can enforce the issue's malformed-claim boundary.
function policy(roles) {
  return `package pomerium.policy\ndefault allow = [false, ["user-unauthenticated"]]\nallow = [true, ["claim-ok"]] { permitted }\nelse = [false, ["claim-unauthorized"]] {\n  session := get_databroker_record("type.googleapis.com/session.Session", input.session.id)\n  object.get(session, "user_id", "") != ""\n}\npermitted {\n  session := get_databroker_record("type.googleapis.com/session.Session", input.session.id)\n  raw := object.get(session, ["id_token", "raw"], "")\n  [_, claims, _] := io.jwt.decode(raw)\n  groups := claims.groups\n  is_array(groups)\n  count([x | x := groups[_]; not is_string(x)]) == 0\n  allowed := ${JSON.stringify(roles)}\n  groups[_] == allowed[_]\n}\n`
}
function build(c, roles) {
  const items = []
  const add = (kind, id, spec, apiVersion = 'v1') => items.push({ apiVersion, kind, metadata: { name: `omw-${id}`, namespace: c.namespace, labels: labels(id), ...(kind === 'Ingress' ? { annotations: { 'ingress.softleader.com.tw/automanaged': 'true' } } : {}) }, spec })
  const https = { ports: ports(443), ...(c.httpsEgress.mode === 'cidrs' ? { to: c.httpsEgress.cidrs.map(cidr => ({ ipBlock: { cidr } })) } : {}) }
  const dns = { to: [c.dnsPeer], ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] }
  function deployment(id, containers, volumes) {
    add('Deployment', id, { replicas: 1, strategy: { type: 'Recreate' }, selector: selector(id), template: { metadata: { labels: labels(id) }, spec: { automountServiceAccountToken: false, hostPID: false, shareProcessNamespace: false, securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } }, terminationGracePeriodSeconds: 30, imagePullSecrets: [{ name: c.imagePullSecret }], containers, volumes } } }, 'apps/v1')
  }
  for (const w of c.workers) {
    const common = { OMW_BROWSER_USERNAME: w.browserUsername, OMW_BROWSER_PASSWORD_FILE: '/run/omw/browser_password', OMW_EXECUTION_TOKEN_FILE: '/run/omw/execution_token', OMW_NATIVE_ORIGIN: `https://${w.nativeHost}`, OMW_RUNTIME_PORT: 4096 }
    const probe = (port, url) => ({ httpGet: { path: url, port }, periodSeconds: 5, timeoutSeconds: 2, failureThreshold: 6 })
    const container = (id, entry, values, mounts, health) => ({ name: id, image: c.workerImage, command: ['/usr/bin/tini', '--', 'node', entry], env: env({ ...common, ...values, OMW_HEALTH_PORT: health }), securityContext: security, resources, volumeMounts: [mount('auth', '/run/omw', { readOnly: true }), ...mounts], startupProbe: { ...probe(health, '/health/live'), failureThreshold: 60 }, livenessProbe: probe(health, '/health/live'), readinessProbe: probe(health, '/health/ready') })
    const seedEnv = w.seed ? { ...(w.seed.authFile ? { OMW_AUTH_SEED_FILE: `/seed/${w.seed.authFile}` } : {}), ...(w.seed.patFile ? { OMW_GITHUB_TOKEN_FILE: `/seed/${w.seed.patFile}` } : {}) } : {}
    deployment(w.name, [
      container('manager', 'apps/manager/dist/src/server.js', { OMW_MODE: 'worker', OMW_DATA_DIR: '/data/manager', OMW_PUBLIC_ORIGIN: `https://${w.managerHost}`, OMW_EXECUTION_ORIGIN: 'http://127.0.0.1:4175', OMW_PORT: 4174 }, [mount('manager-data', '/data/manager')], 4176),
      container('execution', 'apps/manager/dist/src/worker/execution-server.js', { OMW_EXECUTION_HOST: '127.0.0.1', OMW_EXECUTION_PORT: 4175, OMW_NATIVE_PORT: 4180, OMW_OPENCODE_EXECUTABLE: '/usr/local/bin/opencode', ...seedEnv }, [mount('execution-home', '/home/node'), mount('workspace', '/workspace'), ...(w.seed ? [mount('seed', '/seed', { readOnly: true, subPath: w.seed.subPath })] : [])], 4177),
    ], [{ name: 'auth', secret: { secretName: w.secretName, defaultMode: 288 } }, ...['manager-data', 'execution-home', 'workspace'].map(name => ({ name, emptyDir: {} })), ...(w.seed ? [{ name: 'seed', persistentVolumeClaim: { claimName: w.seed.claimName, readOnly: true } }] : [])])
    add('Service', w.name, { type: 'ClusterIP', selector: labels(w.name), ports: [{ name: 'manager', port: 4174, targetPort: 4174 }, { name: 'native', port: 4180, targetPort: 4180 }] })
    add('NetworkPolicy', w.name, { podSelector: selector(w.name), policyTypes: ['Ingress', 'Egress'], ingress: [{ from: [peer('gateway')], ports: ports(4174, 4180) }], egress: [dns, https] }, 'networking.k8s.io/v1')
  }
  deployment('gateway', [{ name: 'pomerium', image, args: ['--config=/etc/pomerium/config.json'], securityContext: security, resources, volumeMounts: [mount('config', '/etc/pomerium', { readOnly: true })], readinessProbe: { tcpSocket: { port: 8080 }, periodSeconds: 5 } }], [{ name: 'config', secret: { secretName: c.gatewayConfigSecret, defaultMode: 288 } }])
  add('Service', 'gateway', { type: 'ClusterIP', selector: labels('gateway'), ports: [{ name: 'http', port: 8080, targetPort: 8080 }] })
  add('NetworkPolicy', 'gateway', { podSelector: selector('gateway'), policyTypes: ['Ingress', 'Egress'], ingress: [{ from: [c.edgePeer], ports: ports(8080) }], egress: [dns, https, ...c.workers.map(w => ({ to: [peer(w.name)], ports: ports(4174, 4180) }))] }, 'networking.k8s.io/v1')
  add('Ingress', 'gateway', { ingressClassName: c.ingressClassName, rules: [c.authenticateHost, ...c.workers.flatMap(w => [w.managerHost, w.nativeHost])].map(host => ({ host, http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'omw-gateway', port: { number: 8080 } } } }] } })) }, 'networking.k8s.io/v1')
  const gateway = { services: 'all', insecure_server: true, address: ':8080', authenticate_service_url: `https://${c.authenticateHost}`, idp_provider: 'oidc', idp_provider_url: c.issuer, idp_client_id: 'omw', idp_scopes: ['openid', 'profile', 'email', 'groups'], databroker_storage_type: 'memory', cookie_secure: true, cookie_http_only: true, routes: c.workers.flatMap(w => [[w.managerHost, 4174], [w.nativeHost, 4180]].map(([host, port]) => ({ from: `https://${host}`, to: `http://omw-${w.name}.${c.namespace}.svc.cluster.local:${port}`, preserve_host_header: true, pass_identity_headers: false, allow_websockets: true, timeout: '0s', idle_timeout: '0s', remove_request_headers: ['Authorization', 'X-Pomerium-Jwt-Assertion', 'X-Pomerium-Claim-Groups', 'X-Pomerium-Claim-Email', 'X-Forwarded-User', 'X-Forwarded-Email', 'X-Auth-Request-User', 'X-Auth-Request-Email', 'X-Id-Token', 'X-Access-Token'], sub_policies: [{ rego: [policy(roles)] }] }))) }
  return { items, gateway }
}

function outsideCheckout(checkout, resolvedPath) {
  const relative = path.relative(checkout, resolvedPath)
  // ..private 仍在 checkout 內；不同 Windows 磁碟的 relative 則是絕對路徑。
  return relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)
}

async function main() {
  const args = process.argv.slice(2)
  check(args.length === 4 || args.length === 6, 'USAGE_RENDER_CONFIG_OUT_OPTIONAL_PRIVATE')
  const options = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, i) => [args[i * 2], args[i * 2 + 1]]))
  check(Object.keys(options).every(k => ['--config', '--out', '--private'].includes(k)) && options['--config'] && options['--out'], 'INVALID_ARGUMENTS')
  const c = JSON.parse(await readFile(options['--config'], 'utf8'))
  const { items, gateway } = build(c, validate(c))
  const checkout = await realpath(root)
  const out = path.resolve(options['--out'])
  const parent = await realpath(path.dirname(out))
  check(outsideCheckout(checkout, parent), 'OUTPUT_MUST_BE_OUTSIDE_CHECKOUT')
  const privatePath = options['--private'] ? await realpath(options['--private']) : undefined
  if (privatePath) check(outsideCheckout(checkout, privatePath), 'PRIVATE_INPUT_MUST_BE_OUTSIDE_CHECKOUT')
  // New directory only: never overwrite a prior secret/config or follow its symlinks.
  await mkdir(out, { mode: 448 })
  await mkdir(path.join(out, 'base'))
  const write = (file, data) => writeFile(path.join(out, file), JSON.stringify(data, null, 2) + '\n', { mode: 384, flag: 'wx' })
  await write('base/resources.json', { apiVersion: 'v1', kind: 'List', items })
  await write('base/kustomization.yaml', { apiVersion: 'kustomize.config.k8s.io/v1beta1', kind: 'Kustomization', resources: ['resources.json'] })
  await write('kustomization.yaml', { apiVersion: 'kustomize.config.k8s.io/v1beta1', kind: 'Kustomization', resources: ['base'] })
  await write('gateway-public.json', gateway)
  await write('inventory.json', items.map(r => ({ kind: r.kind, name: r.metadata.name, namespace: r.metadata.namespace })))
  if (privatePath) {
    const secret = JSON.parse(await readFile(privatePath, 'utf8'))
    keys(secret, ['clientSecret', 'cookieSecret', 'sharedSecret', 'workers'])
    for (const k of ['clientSecret', 'cookieSecret', 'sharedSecret']) check(text(secret[k]), 'PRIVATE_SECRET_REQUIRED')
    for (const k of ['cookieSecret', 'sharedSecret']) check(Buffer.from(secret[k], 'base64').length === 32, 'BASE64_32_BYTE_SECRET_REQUIRED')
    gateway.idp_client_secret = secret.clientSecret
    gateway.cookie_secret = secret.cookieSecret
    gateway.shared_secret = secret.sharedSecret
    const workerSecrets = [], controlTokens = new Set()
    for (const [index, w] of c.workers.entries()) {
      const credentials = secret.workers?.[w.name]
      keys(credentials, ['password', 'executionToken'])
      // 不 trim 秘密：gateway Basic 與 Worker 掛載檔必須使用同一原值；拒絕首尾空白避免讀檔正規化分歧。
      check(workerSecret(credentials.password, 16) && credentials.password.trim() === credentials.password, 'BASIC_PASSWORD_REQUIRED')
      if (credentials.executionToken !== undefined) {
        check(w.secretName.startsWith('omw-'), 'GENERATED_SECRET_MUST_BE_OWNED')
        check(workerSecret(credentials.executionToken, 32) && !/\s/.test(credentials.executionToken) && !controlTokens.has(credentials.executionToken), 'UNIQUE_CONTROL_TOKEN_REQUIRED')
        controlTokens.add(credentials.executionToken)
        workerSecrets.push({ apiVersion: 'v1', kind: 'Secret', metadata: { name: w.secretName, namespace: c.namespace, labels: labels(w.name) }, type: 'Opaque', immutable: true, stringData: { browser_password: credentials.password, execution_token: credentials.executionToken } })
      }
      for (const route of gateway.routes.slice(index * 2, index * 2 + 2)) {
        // Envoy removal wins when the same header is both set and removed.
        // Setting Authorization alone replaces the browser's untrusted value.
        route.remove_request_headers = route.remove_request_headers.filter(h => h !== 'Authorization')
        route.set_request_headers = { Authorization: `Basic ${Buffer.from(`${w.browserUsername}:${credentials.password}`).toString('base64')}` }
      }
    }
    await write('gateway-secret.json', { apiVersion: 'v1', kind: 'Secret', metadata: { name: c.gatewayConfigSecret, namespace: c.namespace, labels: labels('gateway') }, type: 'Opaque', immutable: true, stringData: { 'config.json': JSON.stringify(gateway) } })
    if (workerSecrets.length) await write('worker-secrets.json', { apiVersion: 'v1', kind: 'List', items: workerSecrets })
  }
  console.log(JSON.stringify({ resources: items.length, workers: c.workers.length, publicHash: createHash('sha256').update(JSON.stringify(items)).digest('hex') }))
}
main().catch(() => { console.error('OMW_K8S_RENDER_FAILED: validate configuration, external paths and fresh output directory'); process.exitCode = 1 })
