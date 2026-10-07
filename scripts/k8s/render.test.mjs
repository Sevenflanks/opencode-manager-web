import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, access, rm, unlink, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cli = new URL('./render.mjs', import.meta.url)
const example = new URL('../../deploy/k8s/example.json', import.meta.url)
const privateInput = () => ({ clientSecret: 'synthetic-client-secret', cookieSecret: Buffer.alloc(32, 1).toString('base64'), sharedSecret: Buffer.alloc(32, 2).toString('base64'), workers: { alpha: { password: 'synthetic-alpha-password', executionToken: 'synthetic-control-alpha-token-0001' }, beta: { password: 'synthetic-beta-password', executionToken: 'synthetic-control-beta-token-00002' } } })
async function render(change = () => {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'omw-k8s-proof-'))
  const config = JSON.parse(await readFile(example, 'utf8'))
  change(config)
  await writeFile(path.join(dir, 'input.json'), JSON.stringify(config))
  const result = spawnSync(process.execPath, [cli.pathname.replace(/^\/(\w:)/, '$1'), '--config', path.join(dir, 'input.json'), '--out', path.join(dir, 'render')], { encoding: 'utf8' })
  return { dir, result, resources: result.status === 0 ? JSON.parse(await readFile(path.join(dir, 'render/base/resources.json'), 'utf8')).items : [] }
}
test('invalid declarations fail closed without echoing supplied secrets', async () => {
  for (const mutate of [
    c => { c.workers[1].name = c.workers[0].name },
    c => { c.workers[1].nativeHost = c.workers[0].managerHost },
    c => { c.namespace = 'default' },
    c => { c.gatewayConfigSecret = 'shared-secret' },
    c => { c.allowedRoles = 'admin' },
    c => { c.edgePeer.namespaceSelector = {} },
    c => { c.workers[0].auth = 'none' },
    c => { c.clientSecret = 'SYNTHETIC_MUST_NOT_APPEAR' },
    c => { c.httpsEgress = { mode: 'cidrs', cidrs: ['not-a-cidr'] } },
  ]) {
    const { result } = await render(mutate)
    assert.notEqual(result.status, 0)
    assert.doesNotMatch(result.stdout + result.stderr, /SYNTHETIC_MUST_NOT_APPEAR/)
  }
})
test('network policy allows only gateway ingress, DNS and declared HTTPS; no worker control service', async () => {
  const { resources } = await render()
  const worker = resources.find(r => r.kind === 'NetworkPolicy' && r.metadata.name === 'omw-alpha')
  assert.deepEqual(worker.spec.ingress[0].from, [{ podSelector: { matchLabels: { 'app.kubernetes.io/part-of': 'omw', 'omw.io/identity': 'gateway' } } }])
  assert.deepEqual(worker.spec.ingress[0].ports.map(p => p.port), [4174, 4180])
  assert.deepEqual(worker.spec.egress[1], { ports: [{ protocol: 'TCP', port: 443 }] })
  assert.equal(resources.some(r => ['Namespace', 'PersistentVolume', 'PersistentVolumeClaim', 'StorageClass'].includes(r.kind)), false)
  assert.deepEqual(resources.find(r => r.kind === 'Ingress').metadata.annotations, { 'ingress.softleader.com.tw/automanaged': 'true' })
})
test('policy render retains empty deny-all and exact-case OR roles with original claim type guard', async () => {
  for (const roles of [undefined, [], ['admin', 'Operator']]) {
    const { dir, result } = await render(c => { if (roles !== undefined) c.allowedRoles = roles })
    assert.equal(result.status, 0)
    const gateway = JSON.parse(await readFile(path.join(dir, 'render/gateway-public.json'), 'utf8'))
    const rego = gateway.routes[0].sub_policies[0].rego[0]
    assert.ok(rego.includes(`allowed := ${JSON.stringify(roles ?? ['admin'])}`))
    assert.match(rego, /is_array\(groups\)/)
    assert.match(rego, /object.get\(session, \["id_token", "raw"\]/)
    assert.match(rego, /not is_string\(x\)/)
    assert.equal(gateway.cookie_domain, undefined)
    assert.equal(gateway.idp_client_id, 'omw')
    for (const route of gateway.routes) {
      assert.equal(route.pass_identity_headers, false)
      assert.equal(route.preserve_host_header, true)
      assert.equal(route.allow_websockets, true)
      assert.equal(route.timeout, '0s')
      assert.deepEqual(route.sub_policies, gateway.routes[0].sub_policies)
    }
  }
})
test('first login omits seed flags, seeded workers mount only readonly dedicated source', async () => {
  const { resources, result } = await render(c => { c.workers[1].seed = { claimName: 'omw-seed', subPath: 'protected/omw', authFile: 'auth.json', patFile: 'pat' } })
  assert.equal(result.status, 0)
  const pods = resources.filter(r => r.kind === 'Deployment' && r.metadata.name !== 'omw-gateway').map(r => r.spec.template.spec)
  assert.equal(pods[0].containers[1].env.some(e => e.name === 'OMW_AUTH_SEED_FILE'), false)
  assert.deepEqual(pods[1].volumes.find(v => v.name === 'seed').persistentVolumeClaim, { claimName: 'omw-seed', readOnly: true })
  assert.equal(pods[1].containers[0].volumeMounts.some(v => v.name === 'seed'), false)
  assert.equal(pods[1].containers[1].volumeMounts.find(v => v.name === 'seed').readOnly, true)
})
test('private generator isolates immutable gateway Secret and never prints credentials', async () => {
  const { dir } = await render()
  const privateFile = path.join(dir, 'private.json')
  const input = privateInput()
  await writeFile(privateFile, JSON.stringify(input))
  const out = path.join(dir, 'private-render')
  const result = spawnSync(process.execPath, [cli.pathname.replace(/^\/(\w:)/, '$1'), '--config', path.join(dir, 'input.json'), '--out', out, '--private', privateFile], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-/)
  const secret = JSON.parse(await readFile(path.join(out, 'gateway-secret.json'), 'utf8'))
  assert.equal(secret.immutable, true)
  const config = JSON.parse(secret.stringData['config.json'])
  assert.ok(config.idp_client_secret === input.clientSecret)
  assert.ok(config.cookie_secret === input.cookieSecret)
  assert.ok(config.shared_secret === input.sharedSecret)
  assert.ok(config.routes[0].set_request_headers.Authorization === 'Basic ' + Buffer.from(`omw:${input.workers.alpha.password}`).toString('base64'))
  assert.ok(config.routes[2].set_request_headers.Authorization === 'Basic ' + Buffer.from(`omw:${input.workers.beta.password}`).toString('base64'))
  const workerSecrets = JSON.parse(await readFile(path.join(out, 'worker-secrets.json'), 'utf8')).items
  assert.equal(workerSecrets.length, 2)
  for (const [index, worker] of ['alpha', 'beta'].entries()) {
    assert.ok(workerSecrets[index].stringData.browser_password === input.workers[worker].password)
    assert.ok(workerSecrets[index].stringData.execution_token === input.workers[worker].executionToken)
  }
  assert.ok(workerSecrets[0].stringData.execution_token !== workerSecrets[1].stringData.execution_token)
  assert.ok(workerSecrets.every(s => s.immutable && s.metadata.name.startsWith('omw-')))
  for (const file of ['base/resources.json', 'gateway-public.json', 'kustomization.yaml']) assert.doesNotMatch(await readFile(path.join(out, file), 'utf8'), /synthetic-|gateway-secret.json|worker-secrets.json/)
  for (const [label, mutate] of [
    ['duplicate-token', p => { p.workers.beta.executionToken = p.workers.alpha.executionToken }],
    ['blank-token', p => { p.workers.alpha.executionToken = '' }],
  ]) {
    const p = JSON.parse(await readFile(privateFile, 'utf8')); mutate(p)
    const invalid = path.join(dir, `${label}.json`); await writeFile(invalid, JSON.stringify(p))
    const rejected = spawnSync(process.execPath, [cli.pathname.replace(/^\/(\w:)/, '$1'), '--config', path.join(dir, 'input.json'), '--out', path.join(dir, label), '--private', invalid], { encoding: 'utf8' })
    assert.notEqual(rejected.status, 0)
    assert.doesNotMatch(rejected.stdout + rejected.stderr, /synthetic-/)
  }
})
test('private CLI rejects checkout-local ..private directories without leaking input or creating output', async () => {
  const checkout = fileURLToPath(new URL('../../', import.meta.url))
  const privateDir = await mkdtemp(path.join(checkout, '..private-'))
  const privateFile = path.join(privateDir, 'gateway.json')
  let dir
  try {
    const fixture = await render()
    dir = fixture.dir
    assert.equal(fixture.result.status, 0, fixture.result.stderr)
    await writeFile(privateFile, JSON.stringify(privateInput()), { flag: 'wx' })
    const out = path.join(dir, 'private-render')
    const result = spawnSync(process.execPath, [fileURLToPath(cli), '--config', path.join(dir, 'input.json'), '--out', out, '--private', privateFile], { encoding: 'utf8' })
    assert.notEqual(result.status, 0, 'checkout-local ..private input must fail closed')
    assert.equal(result.stdout, '')
    assert.equal(result.stderr.trim(), 'OMW_K8S_RENDER_FAILED: validate configuration, external paths and fresh output directory')
    for (const value of [privateFile, privateDir, out, 'synthetic-', 'Basic ']) assert.ok(!(result.stdout + result.stderr).includes(value))
    await assert.rejects(access(out), { code: 'ENOENT' })
  } finally {
    await unlink(privateFile).catch(error => { if (error.code !== 'ENOENT') throw error })
    await rmdir(privateDir)
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})
test('private CLI rejects unusable Worker credentials before writing either Secret', async t => {
  for (const [label, mutate] of [
    ['short-password', p => { p.workers.alpha.password = 'x' }],
    ['below-minimum-password', p => { p.workers.alpha.password = 'x'.repeat(15) }],
    ['nul-password', p => { p.workers.alpha.password += '\0' }],
    ['newline-password', p => { p.workers.alpha.password += '\n' }],
    ['leading-password-whitespace', p => { p.workers.alpha.password = ' ' + p.workers.alpha.password }],
    ['trailing-password-whitespace', p => { p.workers.alpha.password += '\t' }],
    ['blank-password', p => { p.workers.alpha.password = ' '.repeat(16) }],
    ['short-token', p => { p.workers.alpha.executionToken = 'y' }],
    ['below-minimum-token', p => { p.workers.alpha.executionToken = 'y'.repeat(31) }],
    ['nul-token', p => { p.workers.alpha.executionToken += '\0' }],
    ['token-whitespace', p => { p.workers.alpha.executionToken += ' ' }],
    ['token-internal-whitespace', p => { p.workers.alpha.executionToken += '\ty' }],
    ['nul-username', (p, c) => { c.workers[0].browserUsername += '\0' }],
    ['unowned-generated-secret', (p, c) => { c.workers[0].secretName = 'shared-worker-auth' }],
    ['oversized-password-file', p => { p.workers.alpha.password = '界'.repeat(1366) }],
    ['oversized-token-file', p => { p.workers.alpha.executionToken = '界'.repeat(1366) }],
    ['later-worker-invalid', p => { p.workers.beta.password = 'x' }],
  ]) {
    await t.test(label, async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'omw-k8s-invalid-'))
      const config = JSON.parse(await readFile(example, 'utf8')), input = privateInput()
      mutate(input, config)
      await writeFile(path.join(dir, 'input.json'), JSON.stringify(config))
      await writeFile(path.join(dir, 'private.json'), JSON.stringify(input))
      const out = path.join(dir, 'render')
      const result = spawnSync(process.execPath, [cli.pathname.replace(/^\/(\w:)/, '$1'), '--config', path.join(dir, 'input.json'), '--out', out, '--private', path.join(dir, 'private.json')], { encoding: 'utf8' })
      assert.notEqual(result.status, 0, 'invalid credentials must fail closed')
      assert.doesNotMatch(result.stdout + result.stderr, /synthetic-|Basic /)
      for (const file of ['gateway-secret.json', 'worker-secrets.json']) {
        await assert.rejects(access(path.join(out, file)), { code: 'ENOENT' })
      }
    })
  }
})
test('private CLI preserves minimum-length credentials and refuses to overwrite a prior render', async () => {
  const { dir } = await render()
  const input = privateInput()
  input.workers.alpha.password = 'a'.repeat(7) + ' ' + 'b'.repeat(8)
  input.workers.alpha.executionToken = 'a'.repeat(32)
  const privateFile = path.join(dir, 'private.json'), out = path.join(dir, 'private-render')
  await writeFile(privateFile, JSON.stringify(input))
  const args = [cli.pathname.replace(/^\/(\w:)/, '$1'), '--config', path.join(dir, 'input.json'), '--out', out, '--private', privateFile]
  const first = spawnSync(process.execPath, args, { encoding: 'utf8' })
  assert.equal(first.status, 0, first.stderr)
  const before = await readFile(path.join(out, 'worker-secrets.json'), 'utf8')
  const workers = JSON.parse(before).items
  assert.ok(workers[0].stringData.browser_password === input.workers.alpha.password)
  assert.ok(workers[0].stringData.execution_token === input.workers.alpha.executionToken)
  const gatewayBefore = await readFile(path.join(out, 'gateway-secret.json'), 'utf8')
  const gateway = JSON.parse(JSON.parse(gatewayBefore).stringData['config.json'])
  assert.ok(gateway.routes[0].set_request_headers.Authorization === 'Basic ' + Buffer.from(`omw:${input.workers.alpha.password}`).toString('base64'))
  input.workers.alpha.password = 'changed-synthetic-password'
  await writeFile(privateFile, JSON.stringify(input))
  const second = spawnSync(process.execPath, args, { encoding: 'utf8' })
  assert.notEqual(second.status, 0)
  assert.ok(await readFile(path.join(out, 'worker-secrets.json'), 'utf8') === before)
  assert.ok(await readFile(path.join(out, 'gateway-secret.json'), 'utf8') === gatewayBefore)
  assert.doesNotMatch(first.stdout + first.stderr + second.stdout + second.stderr, /synthetic-|Basic /)
})
test('public CLI renders isolated two-container Workers without Secrets or private control exposure', async () => {
  const { result, resources } = await render()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(resources.filter(r => r.kind === 'Secret').length, 0)
  const workers = resources.filter(r => r.kind === 'Deployment' && r.metadata.name !== 'omw-gateway')
  assert.equal(workers.length, 2)
  for (const d of workers) {
    assert.equal(d.spec.replicas, 1)
    assert.equal(d.spec.strategy.type, 'Recreate')
    const pod = d.spec.template.spec
    assert.equal(pod.containers.length, 2)
    assert.equal(pod.automountServiceAccountToken, false)
    assert.equal(pod.shareProcessNamespace, false)
    for (const c of pod.containers) {
      assert.equal(c.command[0], '/usr/bin/tini')
      assert.equal(c.readinessProbe.httpGet.path, '/health/ready')
      assert.equal(c.livenessProbe.httpGet.path, '/health/live')
      assert.equal(c.readinessProbe.httpGet.httpHeaders, undefined)
    }
    const service = resources.find(r => r.kind === 'Service' && r.metadata.name === d.metadata.name)
    assert.deepEqual(service.spec.selector, d.spec.selector.matchLabels)
    assert.deepEqual(service.spec.ports.map(p => p.port), [4174, 4180])
  }
  assert.notDeepEqual(workers[0].spec.selector, workers[1].spec.selector)
  for (const r of resources) {
    assert.equal(r.metadata.namespace, 'ai-tools')
    assert.equal(r.metadata.labels['app.kubernetes.io/part-of'], 'omw')
    assert.match(r.metadata.name, /^omw-/)
  }
})
