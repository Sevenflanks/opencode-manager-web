import assert from 'node:assert/strict'
import { randomBytes, createHash } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { dockerOwner } from '../worker/docker-owner.mjs'

// Docker official-interface ownership + independent watchdog; only this fresh
// project can be stopped. No real identity, provider or Kubernetes is involved.
const repo = fileURLToPath(new URL('../../', import.meta.url))
const directory = await mkdtemp(path.join(tmpdir(), 'omw-gateway-proof-'))
const project = `omw-verify-${randomBytes(8).toString('hex')}`
const binding = { context: 'desktop-linux', project, repo, image: `${project}:verification`, envFile: path.join(directory, '.env'), composeFile: path.join(directory, 'compose.json'), watchdogMilliseconds: 19 * 60000, watchdogEvidence: path.join(directory, 'watchdog.json') }
const owner = dockerOwner(binding)
const evidence = { project, status: 'running', checks: [], cleanup: null }
const save = () => writeFile(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2))
const secret = () => randomBytes(32).toString('base64')
const privateInput = { clientSecret: secret(), cookieSecret: secret(), sharedSecret: secret(), workers: { alpha: { password: secret() }, beta: { password: secret() } } }
const declaration = JSON.parse(await readFile(new URL('../../deploy/k8s/example.json', import.meta.url), 'utf8'))
declaration.issuer = 'https://idp.example.test'
const aliases = ['idp.example.test', declaration.authenticateHost, ...declaration.workers.flatMap(w => [w.managerHost, w.nativeHost]), ...declaration.workers.map(w => `omw-${w.name}.ai-tools.svc.cluster.local`)]
const image = 'pomerium/pomerium:v0.33.4@sha256:d6e1d438b3ee88e2391feead5e39463b89da58eee0e39e78c80b94ee498a23af'
let browser, timer, phase = 'setup'
const check = async (name, fn) => { phase = name; const result = await fn(); evidence.checks.push({ name, result }); await save(); console.log(`PASS ${name}`) }
async function render(label, roles) {
  const config = path.join(directory, `${label}.json`), out = path.join(directory, label)
  await writeFile(config, JSON.stringify({ ...declaration, ...(roles === undefined ? {} : { allowedRoles: roles }) }))
  execFileSync(process.execPath, [path.join(repo, 'scripts/k8s/render.mjs'), '--config', config, '--out', out, '--private', path.join(directory, 'private.json')], { stdio: 'pipe', timeout: 10000 })
  const generated = JSON.parse(await readFile(path.join(out, 'gateway-secret.json'), 'utf8')).stringData['config.json']
  // Exact generated config, including DNS targets and every policy byte.
  await writeFile(path.join(directory, 'config.json'), generated)
  return createHash('sha256').update(generated).digest('hex')
}
try {
  await writeFile(binding.envFile, '')
  await writeFile(path.join(directory, 'private.json'), JSON.stringify(privateInput), { mode: 384 })
  await writeFile(path.join(directory, 'fixture.json'), JSON.stringify({ clientSecret: privateInput.clientSecret, basics: declaration.workers.map(w => 'Basic ' + Buffer.from(`${w.browserUsername}:${privateInput.workers[w.name].password}`).toString('base64')) }), { mode: 384 })
  evidence.initialConfigHash = await render('default', undefined)
  execFileSync(process.env.OMW_TEST_OPENSSL ?? 'C:/Program Files/Git/usr/bin/openssl.exe', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(directory, 'tls.key'), '-out', path.join(directory, 'tls.crt'), '-days', '1', '-subj', '/CN=synthetic-omw', '-addext', `subjectAltName=${aliases.map(h => 'DNS:' + h).join(',')}`, '-addext', 'basicConstraints=critical,CA:TRUE'], { stdio: 'ignore', timeout: 15000 })
  const here = fileURLToPath(new URL('./fixtures/', import.meta.url)).replaceAll('\\', '/')
  const mount = directory.replaceAll('\\', '/') + ':/run/proof:ro'
  await writeFile(binding.composeFile, JSON.stringify({ services: {
    fixture: { image: 'node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8', init: true, command: ['node', '/fixture/oidc.mjs'], volumes: [here + ':/fixture:ro', mount], ports: ['127.0.0.1:443:443'], networks: { default: { aliases } } },
    gateway: { image, init: true, command: ['--config', '/run/proof/config.json'], environment: { SSL_CERT_FILE: '/run/proof/tls.crt' }, volumes: [mount] },
  } }))
  const bindingPath = path.join(directory, 'ownership.json'); await writeFile(bindingPath, JSON.stringify(binding))
  const watchdog = spawn(process.execPath, [path.join(repo, 'scripts/worker/watchdog.mjs'), bindingPath], { stdio: 'ignore', detached: true, windowsHide: true })
  await new Promise((resolve, reject) => { watchdog.once('spawn', resolve); watchdog.once('error', reject) }); watchdog.unref()
  await check('pinned-image', async () => { await owner.docker(['image', 'inspect', image], 20000); return { image } })
  await check('start', async () => { await owner.compose(['up', '-d', '--no-build'], 60000); return { loopback: true } })
  const require = createRequire(process.env.OMW_TEST_PLAYWRIGHT_PACKAGE ?? path.join(repo, 'apps/web/package.json'))
  const { chromium } = require('playwright-core')
  browser = await chromium.launch({ executablePath: process.env.OMW_TEST_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--host-resolver-rules=MAP *.example.test 127.0.0.1'], timeout: 20000 })
  timer = setTimeout(() => void browser.close(), 16 * 60000)
  async function newContext() {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' })
    await ctx.route('**/*', route => new URL(route.request().url()).hostname.endsWith('.example.test') ? route.continue() : route.abort())
    return ctx
  }
  await check('auth-readiness', async () => {
    let ready = false
    for (let n = 0; n < 30 && !ready; n++) {
      const ctx = await newContext()
      try { const page = await ctx.newPage(); await page.goto('https://alpha.example.test', { timeout: 4000 }); ready = new URL(page.url()).hostname === 'idp.example.test' } catch {} finally { await ctx.close() }
      if (!ready) await delay(1000)
    }
    assert.ok(ready, 'AUTH_READINESS'); return { ready }
  })
  async function login(user, host, expected) {
    const ctx = await newContext()
    try {
      const page = await ctx.newPage(); page.setDefaultTimeout(20000)
      await page.goto(`https://${host}`, { waitUntil: 'domcontentloaded', timeout: 25000 })
      await page.getByRole('button', { name: user, exact: true }).click()
      await page.waitForURL(u => u.hostname === host, { timeout: 25000 })
      const result = await page.evaluate(async () => { const r = await fetch('/echo', { method: 'POST', headers: { 'x-forwarded-user': 'forged', 'x-pomerium-claim-groups': 'admin', authorization: 'Basic forged' } }); return { status: r.status, ...(r.ok ? { echo: await r.json() } : {}) } })
      assert.equal(result.status, expected, `${user}:${host}`)
      if (expected === 200) { assert.equal(result.echo.basicMatches, true); assert.equal(result.echo.identityAbsent, true); assert.equal(result.echo.host, host); assert.equal(result.echo.origin, `https://${host}`) }
      return { user, host, status: result.status, ...(result.echo ? { upstreamVerified: true } : {}) }
    } finally { await ctx.close() }
  }
  for (const user of ['admin', 'operator', 'guest', 'missing', 'scalar', 'object', 'mixed', 'wrongcase', 'null']) await check(`default-${user}`, () => login(user, 'alpha.example.test', user === 'admin' ? 200 : 403))
  await check('native-admin', () => login('admin', 'beta-native.example.test', 200))
  await check('or-config', async () => { const hash = await render('or', ['admin', 'Operator']); await delay(5000); return { hash } })
  await check('or-admin', () => login('admin', 'alpha.example.test', 200))
  await check('or-operator', () => login('operator', 'beta.example.test', 200))
  await check('or-wrongcase', () => login('wrongcase', 'alpha-native.example.test', 403))
  await check('empty-config', async () => { const hash = await render('empty', []); await delay(5000); return { hash } })
  await check('empty-admin', () => login('admin', 'alpha.example.test', 403))
  await check('empty-operator', () => login('operator', 'beta-native.example.test', 403))
  evidence.status = 'passed'
} catch (error) {
  evidence.status = 'failed'; evidence.failedPhase = phase; evidence.error = error.name
  if (typeof error.actual === 'number') evidence.actualStatus = error.actual
  if (typeof error.expected === 'number') evidence.expectedStatus = error.expected
  // Record only known assertion labels, never browser URLs/query or Docker logs.
  evidence.assertion = String(error.message).split('\n')[0].replace(/https?:\/\/\S+/g, '[URL]').slice(0, 160)
  try {
    const logs = await owner.compose(['logs', '--no-color', '--tail', '80', 'gateway'], 10000)
    await writeFile(path.join(directory, 'private-gateway.log'), logs, { mode: 384 })
    evidence.gatewayErrors = logs.split('\n').flatMap(line => { try { const value = JSON.parse(line.slice(line.indexOf('{'))); return value.error ? [String(value.error).replace(/https?:\/\/[^\s"']+/g, '[URL]').replace(/[A-Za-z0-9_+/=-]{30,}/g, '[REDACTED]')] : [] } catch { return [] } })
  } catch {}
} finally {
  clearTimeout(timer)
  if (browser) { await browser.close().catch(() => {}); evidence.browserClosed = !browser.isConnected() }
  evidence.cleanup = await owner.cleanup()
  evidence.lifecycle = { selected_tier: 'external-launcher', owner_binding: { kind: 'official-interface-current-run', project }, final_disposition: { requested: 'Stop', status: evidence.cleanup.status }, lifecycle_result: { status: evidence.cleanup.status }, downstream_result: { status: evidence.status } }
  await save()
  console.log(JSON.stringify({ evidence: path.join(directory, 'evidence.json'), status: evidence.status, cleanup: evidence.cleanup.status }))
  if (evidence.status !== 'passed' || evidence.cleanup.status !== 'stopped') process.exitCode = 1
}
