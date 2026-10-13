// Independent bounded browser owner. IPC loss/TTL closes its exact Chrome handle.
// Library instead of CLI: callback URLs and cookie values must never become snapshots/logs.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { nativeScope } from './native-scope.mjs'
const cfg = JSON.parse(await readFile(process.argv[2], 'utf8'))
const require = createRequire(path.join(cfg.repo, 'apps/web/package.json'))
const { chromium } = require('playwright-core')
let browser, server, launchPromise, context, page, closing = false, closePromise, serverCloseObserved = false, processExited = false
const nativePages = new Map(), mutations = [], blocked = [], assets = new Map()
const requests = new WeakMap(), checkpoints = [], completedWorkers = new Map()
let stage = 'launch'
const progress = async (value, detail = {}) => {
  stage = value
  checkpoints.push({ stage, at: new Date().toISOString(), ...detail })
  const facts = { stage, checkpoints, mutations: [...mutations], mutationCount: mutations.length, blocked: [...blocked], nativeWorkers: [...nativePages.keys()], completedWorkers: [...completedWorkers.values()] }
  await writeFile(path.join(cfg.directory, 'browser-progress.json'), JSON.stringify(facts, null, 2))
  if (process.connected) process.send({ progress: stage })
}
const ownerPath = path.join(cfg.directory, 'browser-owner.json')
const ownerBinding = { kind: 'PlaywrightBrowserServer', ownerRecord: ownerPath, recovery: 'Current child IPC close; official BrowserServer.close() on the exact retained handle. Endpoint permits read-only connection but Browser.close() alone is not server termination.', deadline: Math.min(cfg.deadline, Date.now() + 20 * 60000), status: 'prelaunch' }
const writeOwner = () => writeFile(ownerPath, JSON.stringify(ownerBinding, null, 2), { mode: 0o600 })
async function close() {
  if (closePromise) return closePromise
  closing = true
  closePromise = (async () => {
    let closeError = false
    try {
      // A cancellation during startup still waits for the official launch result
      // and finalizes that exact server, rather than losing a late Chrome handle.
      if (launchPromise) server = await launchPromise.catch(() => undefined)
      await context?.close().catch(() => { closeError = true })
      await browser?.close().catch(() => { closeError = true })
      await server?.close().catch(() => { closeError = true })
    } finally {
      clearTimeout(ttl)
      const child = server?.process()
      processExited ||= Boolean(child && (child.exitCode !== null || child.signalCode !== null))
      const confirmed = Boolean(server && serverCloseObserved && processExited && !closeError)
      ownerBinding.status = confirmed ? 'stopped' : server ? 'unresolved' : 'no-server-launched'
      Object.assign(ownerBinding, { serverCloseObserved, processExited, closeError, finished: new Date().toISOString() })
      await writeOwner().catch(() => {})
      if (process.connected) { process.send({ closed: confirmed, closeResult: { status: ownerBinding.status, serverCloseObserved, processExited, closeError } }); process.disconnect() }
    }
  })()
  return closePromise
}
const ttl = setTimeout(() => void close().catch(() => {}), Math.max(1000, ownerBinding.deadline - Date.now()))
process.on('disconnect', () => void close().catch(() => {})); process.on('SIGTERM', () => void close().catch(() => {}))
// Pending Playwright event promises can reject before another awaited event.
// Never let that bypass this owner's exact-handle browser finalizer.
function fatal(code) { void (async () => { await progress(`${stage}:${code}`).catch(() => {}); if (process.connected) process.send({ error: code, stage }); await close(); process.exitCode = 1 })().catch(() => { process.exitCode = 1 }) }
process.on('unhandledRejection', () => fatal('BROWSER_UNHANDLED_REJECTION'))
process.on('uncaughtException', () => fatal('BROWSER_UNCAUGHT_EXCEPTION'))
try {
  await writeOwner()
  const profile = path.join(cfg.directory, 'browser-home')
  for (const d of ['AppData/Roaming', 'AppData/Local', 'Temp']) await mkdir(path.join(profile, d), { recursive: true })
  const env = Object.fromEntries(['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'].flatMap(k => process.env[k] === undefined ? [] : [[k, process.env[k]]]))
  launchPromise = chromium.launchServer({ host: '127.0.0.1', port: 0, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, timeout: 30000,
    env: { ...env, HOME: profile, USERPROFILE: profile, APPDATA: path.join(profile, 'AppData/Roaming'), LOCALAPPDATA: path.join(profile, 'AppData/Local'), TEMP: path.join(profile, 'Temp'), TMP: path.join(profile, 'Temp') },
    args: [`--host-resolver-rules=MAP *.example.test ${cfg.loopback}`, '--no-proxy-server'] })
  server = await launchPromise
  server.on('close', () => { serverCloseObserved = true })
  server.process().once('exit', () => { processExited = true })
  Object.assign(ownerBinding, { status: 'launched', wsEndpoint: server.wsEndpoint() }); await writeOwner()
  if (closing) { await close(); throw Error('BROWSER_CLOSED_DURING_STARTUP') }
  browser = await chromium.connect(server.wsEndpoint(), { timeout: 10000 })
  context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', locale: 'zh-TW', viewport: { width: 1360, height: 900 } })
  context.setDefaultTimeout(20000); context.setDefaultNavigationTimeout(30000)
  await context.route('**/*', route => {
    const request = route.request(), u = new URL(request.url())
    const own = u.protocol === 'https:' && u.hostname.endsWith('.example.test') && !u.port
    const staticAsset = request.method() === 'GET' && u.protocol === 'https:' && ['app.opencode.ai', 'opencode.ai', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'].includes(u.hostname)
    if (!own && !staticAsset) { blocked.push({ method: request.method(), host: u.hostname }); return route.abort() }
    return route.continue()
  })
  context.on('request', request => {
    const u = new URL(request.url())
    if (u.hostname === cfg.coordinatorHost && request.method() === 'POST' && /\/proxy\/api\/v1\//.test(u.pathname)) {
      const entry = { path: u.pathname, status: null }; mutations.push(entry); requests.set(request, entry)
    }
  })
  context.on('response', response => {
    const request = response.request(), u = new URL(request.url())
    if (requests.has(request)) requests.get(request).status = response.status()
    if (response.status() === 200 && ['script', 'stylesheet'].includes(request.resourceType())) {
      const counts = assets.get(u.hostname) ?? { script: 0, stylesheet: 0 }; counts[request.resourceType()]++; assets.set(u.hostname, counts)
    }
  })
  page = await context.newPage()
  process.send({ ready: true, browserVersion: browser.version(), playwrightVersion: require('playwright-core/package.json').version, ownerRecord: ownerPath, ownerKind: ownerBinding.kind })
  const login = async (target, user = 'admin', p = page) => {
    await p.goto(target, { waitUntil: 'domcontentloaded' })
    await p.getByRole('button', { name: user, exact: true }).click()
    await p.waitForURL(u => u.hostname === cfg.coordinatorHost)
  }
  async function uiStart(w) {
    await progress(`workspace-${w.id}`)
    await page.goto(`https://${cfg.coordinatorHost}`, { waitUntil: 'domcontentloaded' })
    await page.locator('#coordinator-worker-filter').selectOption(JSON.stringify([w.id, w.generation]))
    assert.equal(await page.locator('#coordinator-worker-filter').inputValue(), JSON.stringify([w.id, w.generation]), 'FILTER_WRONG_EXECUTION')
    await progress(`selectworker-${w.id}`, { workerId: w.id, generation: w.generation })
    await page.getByRole('button', { name: '管理此 Worker', exact: true }).click()
    const workspace = page.locator('.coordinator-workspace')
    await workspace.getByRole('button', { name: '啟動 Instance', exact: true }).click()
    const panel = page.getByRole('dialog', { name: '啟動 Instance' })
    await panel.locator('.current-directory code').getByText('/workspace', { exact: true }).waitFor()
    await panel.getByRole('button', { name: w.id, exact: true }).waitFor()
    await progress(`panel-${w.id}`, { directory: '/workspace', marker: w.id })
    await panel.getByRole('button', { name: '啟動全新 Instance', exact: true }).click()
    const confirmation = page.getByRole('alertdialog')
    await confirmation.getByRole('heading', { name: '啟動新的 Instance？', exact: true }).waitFor()
    const scope = `（${w.id}，執行識別 ${w.generation}）`
    assert.ok((await confirmation.textContent()).includes(scope), 'START_WRONG_WORKER_GENERATION')
    const startResponse = page.waitForResponse(r => new URL(r.url()).pathname === `${w.prefix}/api/v1/instances` && r.request().method() === 'POST', { timeout: 60000 })
    const [start] = await Promise.all([startResponse, confirmation.getByRole('button', { name: '啟動', exact: true }).click()])
    const instance = await start.json()
    await progress(`Startresponse-${w.id}`, { status: start.status(), errorCode: /^[A-Z][A-Z0-9_]{0,80}$/.test(instance?.error?.code ?? '') ? instance.error.code : null, instanceId: instance?.id ?? null })
    assert.equal(start.status(), 201, 'START_NOT_201'); assert.equal(instance.state, 'ready', 'START_NOT_READY')
    completedWorkers.set(w.id, { id: w.id, generation: w.generation, instanceId: instance.id, sessionId: null })
    await progress(`session-${w.id}`)
    await workspace.getByRole('button', { name: instance.primarySession ? 'New Session' : '建立入口 Session', exact: true }).click()
    const sessionConfirmation = page.getByRole('alertdialog')
    await sessionConfirmation.getByRole('heading', { name: '建立 New Session？', exact: true }).waitFor()
    assert.ok((await sessionConfirmation.textContent()).includes(scope), 'SESSION_WRONG_WORKER_GENERATION')
    await progress(`Sessionconfirmation-${w.id}`, { workerId: w.id, generation: w.generation, instanceId: instance.id })
    const sessionResponse = page.waitForResponse(r => new URL(r.url()).pathname === `${w.prefix}/api/v1/instances/${instance.id}/sessions` && r.request().method() === 'POST', { timeout: 60000 })
    const popupPromise = page.waitForEvent('popup')
    const [sessionResult, popup] = await Promise.all([sessionResponse, popupPromise, sessionConfirmation.getByRole('button', { name: '建立並開啟', exact: true }).click()])
    const session = await sessionResult.json()
    await progress(`Sessionresponse-${w.id}`, { status: sessionResult.status(), errorCode: /^[A-Z][A-Z0-9_]{0,80}$/.test(session?.error?.code ?? '') ? session.error.code : null, instanceId: session?.instanceId ?? null, sessionId: session?.sessionId ?? null })
    assert.equal(sessionResult.status(), 201, 'SESSION_NOT_201'); assert.ok(session.sessionId, 'SESSION_ID_MISSING'); assert.equal(session.instanceId, instance.id, 'SESSION_WRONG_INSTANCE')
    const sessionUrl = new URL(session.url), apiScope = nativeScope(session.url, w.nativeHost, instance.projectDirectory, session.sessionId)
    await progress(`SessionURL-${w.id}`, { workerId: w.id, ...apiScope })
    completedWorkers.set(w.id, { id: w.id, generation: w.generation, instanceId: instance.id, sessionId: session.sessionId })
    await progress(`native-${w.id}`)
    await popup.waitForURL(u => u.hostname === w.nativeHost, { timeout: 60000 })
    await popup.locator('[contenteditable="true"],textarea').first().waitFor({ timeout: 90000 })
    const result = await popup.evaluate(async ({ sessionId, directory }) => {
      const hResponse = await fetch('/global/health'), h = await hResponse.json()
      const sResponse = await fetch(`/session/${sessionId}?${new URLSearchParams({ directory })}`), s = await sResponse.json()
      const mResponse = await fetch(`/session/${sessionId}/message?${new URLSearchParams({ directory })}`), messages = await mResponse.json()
      return { healthStatus: hResponse.status, health: { healthy: h.healthy, version: h.version }, sessionStatus: sResponse.status, messageStatus: mResponse.status, sessionId: s.id, directory: s.directory, root: !s.parentID, messages: messages.length, composer: !!document.querySelector('[contenteditable="true"],textarea'), secureContext: window.isSecureContext, visibleFrontendVersions: [...new Set((document.body.innerText.match(/\bv?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.]+)?\b/g) ?? []))] }
    }, { sessionId: session.sessionId, directory: instance.projectDirectory })
    await progress(`native-metadata-${w.id}`, { workerId: w.id, sessionId: result.sessionId, directory: result.directory, healthStatus: result.healthStatus, health: result.health, sessionStatus: result.sessionStatus, messageStatus: result.messageStatus, messages: result.messages })
    assert.equal(result.healthStatus, 200, 'NATIVE_HEALTH_STATUS'); assert.equal(result.health.healthy, true); assert.equal(result.health.version, '1.18.34', 'RUNTIME_VERSION')
    assert.equal(result.sessionStatus, 200, 'NATIVE_SESSION_STATUS'); assert.equal(result.messageStatus, 200, 'NATIVE_MESSAGE_STATUS'); assert.equal(result.directory, instance.projectDirectory, 'NATIVE_METADATA_WRONG_PROJECT')
    assert.equal(result.sessionId, session.sessionId, 'NATIVE_WRONG_SESSION'); assert.equal(result.messages, 0, 'PROMPT_OR_MESSAGE_PRESENT'); assert.ok(result.root && result.composer && result.secureContext)
    await progress(`nativecomposer-${w.id}`, { workerId: w.id, sessionId: session.sessionId, composer: result.composer, messages: result.messages, directory: result.directory, health: result.health })
    nativePages.set(w.id, popup)
    // First exercise App's exact existing Instance+Session tab reuse. It sends
    // no open-url request; waiting for a popup here would misdiagnose real UI.
    const tabCount = context.pages().length, mutationCount = mutations.length
    await workspace.getByRole('button', { name: '進入入口 Session', exact: true }).click()
    await page.waitForTimeout(300)
    const reusedUrl = new URL(popup.url())
    assert.equal(reusedUrl.origin, `https://${w.nativeHost}`, 'REUSE_FOREIGN_ORIGIN')
    await progress(`reuse-pathname-${w.id}`, { pathname: reusedUrl.pathname, expectedProject: instance.projectDirectory, expectedSessionId: session.sessionId, apiPathname: apiScope.pathname })
    const reusedScope = nativeScope(popup.url(), w.nativeHost, instance.projectDirectory, session.sessionId, result)
    await progress(`reuse-route-${w.id}`, { host: reusedUrl.hostname, ...reusedScope, apiPathname: apiScope.pathname, sameOrigin: reusedUrl.origin === sessionUrl.origin, pageCountBefore: tabCount, pageCountAfter: context.pages().length, mutationCountBefore: mutationCount, mutationCountAfter: mutations.length })
    assert.equal(popup.isClosed(), false, 'REUSED_PAGE_CLOSED')
    assert.equal(reusedUrl.origin, sessionUrl.origin, 'REUSE_FOREIGN_ORIGIN'); assert.equal(reusedUrl.username + reusedUrl.password, '', 'REUSE_URL_CREDENTIALS')
    assert.equal(context.pages().length, tabCount, 'REUSE_CREATED_NEW_TAB'); assert.equal(mutations.length, mutationCount, 'REUSE_REPLAYED_REQUEST')
    // Closing only this synthetic native page makes a subsequent open-url real,
    // without re-sending Start or creating another Session.
    await popup.close()
    await progress(`open-entry-${w.id}`)
    const openResponse = page.waitForResponse(r => new URL(r.url()).pathname === `${w.prefix}/api/v1/instances/${instance.id}/open-url` && r.request().method() === 'POST')
    const secondPopup = page.waitForEvent('popup')
    const [mapped, opened] = await Promise.all([openResponse, secondPopup, workspace.getByRole('button', { name: '進入入口 Session', exact: true }).click()])
    const mappedBody = await mapped.json()
    assert.equal(mapped.status(), 200); const openScope = nativeScope(mappedBody.url, w.nativeHost, instance.projectDirectory, session.sessionId)
    assert.equal(mappedBody.instanceId, instance.id); assert.equal(mappedBody.sessionId, session.sessionId)
    await opened.waitForURL(u => u.origin === `https://${w.nativeHost}` && u.pathname.endsWith(`/session/${session.sessionId}`)); await opened.locator('[contenteditable="true"],textarea').first().waitFor({ timeout: 90000 })
    const openedMetadata = await opened.evaluate(async ({ sessionId, directory }) => {
      const r = await fetch(`/session/${sessionId}?${new URLSearchParams({ directory })}`), s = await r.json()
      return { sessionStatus: r.status, sessionId: s.id, directory: s.directory }
    }, { sessionId: session.sessionId, directory: instance.projectDirectory })
    const openedScope = nativeScope(opened.url(), w.nativeHost, instance.projectDirectory, session.sessionId, openedMetadata)
    await progress(`open-entry-response-${w.id}`, { status: mapped.status(), instanceId: mappedBody.instanceId, sessionId: mappedBody.sessionId, apiPathname: openScope.pathname, ...openedScope })
    nativePages.set(w.id, opened)
    const nativeAssets = assets.get(w.nativeHost) ?? { script: 0, stylesheet: 0 }
    // OpenCode may serve HTML with its JS/CSS hosted on app.opencode.ai.
    const publicAssets = assets.get('app.opencode.ai') ?? { script: 0, stylesheet: 0 }
    assert.ok(nativeAssets.script + publicAssets.script > 0 && nativeAssets.stylesheet + publicAssets.stylesheet > 0, 'NATIVE_ASSETS_MISSING')
    return { instance, sessionId: session.sessionId, native: result, nativePaths: { sessionApi: apiScope, reused: reusedScope, openApi: openScope, opened: openedScope }, assets: { native: nativeAssets, public: publicAssets }, startStatus: start.status(), sessionStatus: sessionResult.status(), openStatus: mapped.status(), existingTabReusedWithoutRequest: true }
  }
  process.on('message', async message => {
    try {
      if (message.action === 'close') { await close(); return }
      if (closing) throw Error('BROWSER_CLOSING')
      await progress(message.action)
      let result
      if (message.action === 'login') { await login(`https://${cfg.coordinatorHost}`); await page.getByRole('tab', { name: 'Instance 總覽', exact: true }).waitFor(); result = { defaultInstances: await page.getByRole('tab', { name: 'Instance 總覽', exact: true }).getAttribute('aria-selected'), role: await page.locator('.coordinator-role').textContent() } }
      if (message.action === 'api') result = await page.evaluate(async m => { const r = await fetch(m.pathname, { method: m.method ?? 'GET', headers: { 'x-omw-csrf': '1', ...(m.headers ?? {}), ...(m.body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(m.body === undefined ? {} : { body: JSON.stringify(m.body) }), signal: AbortSignal.timeout(m.timeout ?? 50000) }); const text = await r.text(); let body; try { body = JSON.parse(text) } catch { body = null } return { status: r.status, body } }, message)
      if (message.action === 'start') result = await uiStart(message.worker)
      if (message.action === 'layout') {
        await page.goto(`https://${cfg.coordinatorHost}`, { waitUntil: 'domcontentloaded' })
        await page.getByRole('tab', { name: 'Worker 管理', exact: true }).click()
        await page.locator(`.coordinator-worker[data-worker-id="${message.lastWorker}"]`).waitFor()
        const desktop = await page.locator('.coordinator-worker').count()
        await page.screenshot({ path: path.join(cfg.directory, 'coordinator-tabs.png') })
        await page.setViewportSize({ width: 390, height: 844 })
        const mobile = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, credentials: [...document.querySelectorAll('input[type="password"]')].length, workers: document.querySelectorAll('.coordinator-worker').length }))
        assert.equal(mobile.overflow, false, 'MOBILE_OVERFLOW'); assert.equal(mobile.credentials, 0)
        await page.getByRole('tab', { name: 'Instance 總覽', exact: true }).click()
        await page.setViewportSize({ width: 1360, height: 900 })
        result = { desktopWorkers: desktop, mobile, defaultInstances: true }
      }
      if (message.action === 'screenshot-native') { await nativePages.get(message.workerId).screenshot({ path: path.join(cfg.directory, 'native-composer.png') }); result = { captured: true } }
      if (message.action === 'native-read') result = await nativePages.get(message.workerId).evaluate(async m => { const r = await fetch(m.pathname, { signal: AbortSignal.timeout(10000), ...(m.headers ? { headers: m.headers } : {}) }); let body; try { body = await r.json() } catch { body = null } return { status: r.status, body } }, message)
      if (message.action === 'sse') result = await nativePages.get(message.workerId).evaluate(async () => { const controller = new AbortController(), started = Date.now(), timer = setTimeout(() => controller.abort(), 42000); let reader; try { const r = await fetch('/event', { signal: controller.signal }); reader = r.body.getReader(); const first = await reader.read(); if (first.done) throw Error('SSE_ENDED'); await new Promise(resolve => setTimeout(resolve, 32000)); const next = await reader.read(); return { status: r.status, firstEvent: new TextDecoder().decode(first.value).includes('data:'), durationMs: Date.now() - started, ongoing: !next.done } } finally { clearTimeout(timer); controller.abort(); await reader?.cancel().catch(() => {}) } })
      if (message.action === 'metrics') result = { mutations, blocked, promptsSent: mutations.filter(x => /\/(prompt|message)(\/|$)/.test(x.path)).length }
      if (message.action === 'public-denials') {
        const anonymous = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' })
        try {
          await anonymous.route('**/*', route => new URL(route.request().url()).hostname.endsWith('.example.test') ? route.continue() : route.abort())
          const p = await anonymous.newPage()
          await p.goto(`https://${cfg.coordinatorHost}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
          assert.equal(new URL(p.url()).hostname, 'idp.example.test', 'UNAUTH_PUBLIC_COORDINATOR_REACHED')
          await p.getByRole('button', { name: 'admin', exact: true }).waitFor({ timeout: 10000 })
          assert.equal(await p.locator('.coordinator-workspace,.coordinator-tabs').count(), 0)
          result = { unauthenticatedRedirectedToSyntheticIdP: true, coordinatorNotRendered: true }
          const unknown = await p.goto(`https://omw-job-unregistered-code.example.test`, { waitUntil: 'domcontentloaded', timeout: 10000 })
          assert.equal(unknown.status(), 404, 'PUBLIC_UNKNOWN_NATIVE_FALLBACK')
          result.unknownNativeStatus = unknown.status()
        } finally { await anonymous.close() }
      }
      if (process.connected) process.send({ id: message.id, result })
    } catch (error) { await progress(`${stage}:failed`).catch(() => {}); if (process.connected) process.send({ id: message.id, error: 'BROWSER_ACTION_FAILED', stage, assertion: String(error.message).split('\n')[0].replace(/https?:\/\/\S+/g, '[URL]').replace(/[A-Za-z0-9_+=/-]{60,}/g, '[REDACTED]').slice(0, 120), mutationCount: mutations.length }) }
  })
} catch { if (process.connected) process.send({ error: 'BROWSER_LAUNCH_FAILED', stage }); await close() }
