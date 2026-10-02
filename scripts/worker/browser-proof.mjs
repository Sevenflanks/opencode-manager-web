import assert from "node:assert/strict"
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"

const require = createRequire(new URL("../../apps/web/package.json", import.meta.url))
const option = (name) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined }
const exists = async (filename) => { try { await access(filename); return true } catch { return false } }
async function executable(chromium) {
  const explicit = option("--browser-executable")
  const candidates = explicit ? [explicit] : [
    ...(process.platform === "win32" ? ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"] : []),
    chromium.executablePath(),
  ]
  for (const filename of candidates) if (await exists(filename)) return filename
  throw new Error("--browser 需要既有 Chrome/Chromium；可傳 --browser-executable <path>，不自動下載。")
}
async function bounded(action, timeout, name) {
  let timer
  try { return await Promise.race([action(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} deadline exceeded`)), timeout) })]) }
  finally { clearTimeout(timer) }
}

export async function browserProof({ origins, password, evidenceDirectory, screenshotReferences, deadline, onOutcome }) {
  // Library 模式讓秘密不出現在 CLI／URL／storage state，且 browser handle 由本次 runner finally 持有。
  const { chromium } = require("playwright-core")
  const executablePath = await executable(chromium)
  const profile = await mkdtemp(path.join(os.tmpdir(), "omw-compose-browser-"))
  const outcome = { status: "running", kind: "live Compose；無 API mock／無 LLM", viewport: { width: 390, height: 844 }, steps: [],
    nativeAssets: { javascript: 0, stylesheet: 0 }, transport: { sseResponses: 0, webSockets: 0, webSocketFrames: 0 }, oauthStarted: false,
    lifecycle: { owner: "本輪 Playwright browser handle", disposition: "Stop", status: "planned" } }
  let browser, context, workTimer, stopBrowser, nativePage, startAt
  const safeText = (text) => String(text).replaceAll(password, "[REDACTED]")
    .replace(/https?:\/\/[^\s"'<>]+/g, "[URL]").replace(/(?:Basic|Bearer)\s+\S+/gi, "[REDACTED]")
  const diagnostics = outcome.diagnostics = { pageErrors: [], console: [], endpoints: [], providerReads: [], failedEndpoints: [], failedRequests: [] }
  const record = (list, value) => { if (list.length < 40) list.push(value) }
  const endpoint = (url) => { const parsed = new URL(url); return { origin: parsed.origin === origins.native ? "native" : "external", pathname: parsed.pathname } }
  const errorMessage = (text) => {
    // Console 可能含任意 app payload；只保留可辨識的 JS／transport 錯誤片語，不序列化 args／stack。
    return String(text).match(/(?:Failed to fetch|Failed to load resource|net::ERR_[A-Z_]+|Cannot read properties of (?:undefined|null)|[^\s]+ is not a function|Unauthorized|Not Found)/)?.[0] ?? "message omitted"
  }
  const safeDom = async (page, name) => {
    const dom = await page.evaluate(() => ({ title: document.title, rootChildren: document.querySelector("#root")?.childElementCount ?? 0,
      text: document.body.innerText.slice(0, 4000), controls: [...document.querySelectorAll("button, [role=button], [role=dialog], input, textarea")].slice(0, 50).map((element) => ({
        tag: element.tagName, role: element.getAttribute("role"), label: element.getAttribute("aria-label"), text: element.textContent?.slice(0, 120),
        visible: !!(element.getClientRects().length),
      })) }))
    const filename = path.join(evidenceDirectory, `${name}.dom.json`)
    await writeFile(filename, safeText(JSON.stringify(dom, null, 2)))
    outcome.safeDomPath = filename
  }
  const screenshot = async (page, name) => {
    if (name === "omw-ready") await page.waitForFunction(() => !document.getAnimations().some((animation) => animation.playState === "running" && animation.effect?.getComputedTiming().iterations !== Infinity))
    const filename = path.join(evidenceDirectory, `${name}.png`)
    await page.screenshot({ path: filename, fullPage: true, animations: "disabled", timeout: 10_000 })
    screenshotReferences.push({ outcome: name, path: filename, kind: "live Compose mobile UI；無 auth code" })
    await onOutcome(outcome)
  }
  let oauthBlocked = 0, failure
  try {
    await Promise.all(["AppData/Roaming", "AppData/Local", "Temp", "xdg/data", "xdg/config", "xdg/cache"].map((folder) => mkdir(path.join(profile, folder), { recursive: true })))
    const env = Object.fromEntries(["SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "LANG", "LC_ALL"]
      .flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]))
    browser = await chromium.launch({ executablePath, headless: true, timeout: 20_000, env: {
      ...env, HOME: profile, USERPROFILE: profile, APPDATA: path.join(profile, "AppData/Roaming"), LOCALAPPDATA: path.join(profile, "AppData/Local"),
      TEMP: path.join(profile, "Temp"), TMP: path.join(profile, "Temp"), XDG_DATA_HOME: path.join(profile, "xdg/data"),
      XDG_CONFIG_HOME: path.join(profile, "xdg/config"), XDG_CACHE_HOME: path.join(profile, "xdg/cache"),
    } })
    let closePromise
    stopBrowser = () => closePromise ??= browser.close()
    // 有限工作期獨立於 selector 等待；timeout 也走 exact browser handle 關閉，不掃描／殺其他瀏覽器。
    workTimer = setTimeout(() => { void stopBrowser().catch(() => undefined) }, Math.min(150_000, Math.max(1, deadline - Date.now())))
    context = await browser.newContext({ viewport: outcome.viewport, isMobile: true, hasTouch: true, locale: "en-US", serviceWorkers: "block" })
    const authorization = `Basic ${Buffer.from(`worker:${password}`).toString("base64")}`
    await context.route("**/*", async (route) => {
      const request = route.request(), url = new URL(request.url())
      if (![origins.manager, origins.native].includes(url.origin)) return await route.abort("blockedbyclient")
      // 只允許 provider 方法的 readonly GET；不發 OAuth start，不接收或記錄 device code。
      if (url.origin === origins.native && request.method() !== "GET" && /\/(?:auth|provider|integration)(?:\/|$)/.test(url.pathname)) {
        oauthBlocked++
        return await route.abort("blockedbyclient")
      }
      await route.continue({ headers: { ...request.headers(), authorization } })
    })
    context.on("response", (response) => {
      const url = new URL(response.url())
      if (url.origin !== origins.native) return
      record(diagnostics.endpoints, { pathname: url.pathname, method: response.request().method(), status: response.status() })
      if (response.request().method() === "GET" && /\/(?:auth|provider|integration)(?:\/|$)/.test(url.pathname)) {
        record(diagnostics.providerReads, { pathname: url.pathname, status: response.status() })
      }
      if (response.status() >= 400) record(diagnostics.failedEndpoints, { pathname: url.pathname, method: response.request().method(), status: response.status() })
      if (response.status() !== 200) return
      const type = response.headers()["content-type"] ?? ""
      if (/javascript/.test(type)) outcome.nativeAssets.javascript++
      if (/text\/css/.test(type)) outcome.nativeAssets.stylesheet++
      if (/text\/event-stream/.test(type)) outcome.transport.sseResponses++
    })
    context.on("requestfailed", (request) => record(diagnostics.failedRequests, { ...endpoint(request.url()), method: request.method(), error: errorMessage(request.failure()?.errorText) }))
    context.on("page", (page) => {
      page.on("pageerror", (error) => record(diagnostics.pageErrors, { name: error.name, message: errorMessage(error.message) }))
      page.on("console", (message) => { if (["error", "warning"].includes(message.type())) record(diagnostics.console, { type: message.type(), message: errorMessage(message.text()) }) })
      page.on("websocket", (socket) => {
        outcome.transport.webSockets++
        socket.on("framereceived", () => { outcome.transport.webSocketFrames++ })
      })
    })
    const page = await context.newPage()
    page.setDefaultTimeout(20_000)
    await page.goto(origins.manager, { waitUntil: "domcontentloaded", timeout: 30_000 })
    await page.getByRole("heading", { name: "Worker", exact: true }).waitFor()
    await page.getByRole("button", { name: "啟動 Instance", exact: true }).first().click()
    const panel = page.getByRole("dialog", { name: "啟動 Instance", exact: true })
    await panel.locator(".browse-form input").fill("/workspace/verification-project")
    await panel.locator(".browse-form").getByRole("button", { name: "瀏覽", exact: true }).click()
    await panel.locator(".current-directory code").filter({ hasText: "/workspace/verification-project" }).waitFor()
    outcome.steps.push("mobile browse 真 Worker Project")
    startAt = Date.now()
    outcome.start = { status: "pending" }
    const [startResponse] = await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/instances" && response.request().method() === "POST"),
      panel.getByRole("button", { name: "啟動全新 Instance", exact: true }).click(),
    ])
    outcome.start = { status: startResponse.status(), milliseconds: Date.now() - startAt }
    if (startResponse.status() !== 201) {
      const body = await startResponse.json().catch(() => ({}))
      outcome.start.code = /^[A-Z_]+$/.test(body?.error?.code ?? "") ? body.error.code : "unknown"
      assert.fail(`Worker Start returned ${startResponse.status()}; code=${outcome.start.code}`)
    }
    const instance = await startResponse.json()
    assert.equal(instance.state, "ready")
    outcome.instanceId = instance.id
    const healthResponse = await fetch(`${origins.native}/global/health`, { headers: { authorization }, signal: AbortSignal.timeout(10_000), redirect: "error" })
    assert.equal(healthResponse.status, 200)
    outcome.opencodeVersion = (await healthResponse.json()).version
    assert.equal(outcome.opencodeVersion, "1.18.34")
    await page.getByRole("heading", { name: "verification-project", exact: true }).waitFor()
    await page.getByRole("link", { name: "開啟原生 OpenCode Web", exact: true }).waitFor()
    outcome.steps.push("mobile Start → OMW ready／native root link")
    await page.locator(".start-panel-overlay").waitFor({ state: "detached" })
    await screenshot(page, "omw-ready")
    await page.getByRole("button", { name: "New Session", exact: true }).click()
    const [openedResponse, native] = await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/instances/${instance.id}/sessions` && response.request().method() === "POST"),
      context.waitForEvent("page", { timeout: 25_000 }),
      page.getByRole("alertdialog").getByRole("button", { name: "建立並開啟", exact: true }).click(),
    ])
    assert.equal(openedResponse.status(), 201)
    nativePage = native
    const opened = await openedResponse.json()
    assert.ok(opened.sessionId)
    outcome.sessionId = opened.sessionId
    native.setDefaultTimeout(20_000)
    await native.waitForURL((url) => url.origin === origins.native && url.pathname.includes(opened.sessionId), { timeout: 30_000 })
    await native.locator("body").waitFor()
    await native.waitForFunction(() => document.querySelector("#root")?.childElementCount > 0, undefined, { timeout: 30_000 })
    await native.getByRole("button", { name: "Send", exact: true }).waitFor({ state: "visible", timeout: 30_000 })
    await native.locator('[contenteditable="true"]').waitFor({ state: "visible" })
    await native.locator("button:not([aria-label]):not([role=tab])").filter({ hasText: /\S/ }).waitFor({ state: "visible" })
    assert.ok(outcome.nativeAssets.javascript > 0, "native JavaScript assets 必須真實載入")
    assert.ok(outcome.nativeAssets.stylesheet > 0, "native CSS assets 必須真實載入")
    outcome.steps.push("mobile New Session → native session composer 就緒／JS+CSS")
    await safeDom(native, "native-session")
    await screenshot(native, "native-session")
    await native.getByRole("button", { name: "Home", exact: true }).click()
    await native.getByRole("textbox", { name: "Search sessions", exact: true }).waitFor({ state: "visible" })
    await safeDom(native, "native-home")
    await screenshot(native, "native-home")
    await native.locator("button:visible").filter({ hasText: /^Settings$/ }).click()
    await native.getByRole("dialog").waitFor({ state: "visible" })
    await safeDom(native, "native-settings")
    await screenshot(native, "native-settings")
    const settings = native.getByRole("dialog")
    outcome.nativeUiVersion = await settings.innerText().then((text) => text.match(/\bv\d+\.\d+\.\d+\b/)?.[0] ?? "unknown")
    await settings.getByRole("tab", { name: "Providers", exact: true }).click()
    await settings.getByRole("heading", { name: "Providers", exact: true }).waitFor()
    await safeDom(native, "native-providers")
    // 真 mobile 入口在 Home → Settings → Providers 的 provider row；Connect 只顯示方法，不選 OAuth method。
    await settings.locator(".settings-v2-provider-row").filter({ has: native.getByText("OpenAI", { exact: true }) })
      .getByRole("button", { name: "Connect", exact: true }).click()
    const dialog = native.getByRole("dialog")
    await dialog.getByRole("button", { name: /ChatGPT Pro\/Plus\s*Headless/i }).waitFor({ state: "visible" })
    assert.equal(oauthBlocked, 0, "瀏覽方法不能觸發 OAuth")
    if (outcome.transport.webSockets > 0) {
      const frameDeadline = Date.now() + 10_000
      while (outcome.transport.webSocketFrames === 0) {
        assert.ok(Date.now() < frameDeadline, "native UI WebSocket first frame deadline exceeded")
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    outcome.transport.websocketRequirement = outcome.transport.webSockets > 0 ? "真 UI 使用 WS，已接收 frame；不記錄 payload" : "此主要流程沒有 WebSocket call；另以 native /event 驗證 SSE"
    outcome.steps.push("native Home → Settings → Providers → OpenAI Connect → ChatGPT headless 方法顯示；未開始 OAuth")
    await safeDom(native, "native-openai-methods")
    await screenshot(native, "native-openai-methods")
    await native.close()
    await page.getByRole("button", { name: "Instance 操作", exact: true }).click()
    await page.getByRole("button", { name: "停止 Instance", exact: true }).click()
    const [stopResponse] = await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/instances/${instance.id}/stop` && response.request().method() === "POST"),
      page.getByRole("alertdialog").getByRole("button", { name: "停止 Instance", exact: true }).click(),
    ])
    assert.equal(stopResponse.status(), 200)
    assert.equal((await stopResponse.json()).state, "stopped")
    outcome.steps.push("mobile OMW Stop confirmed stopped")
    assert.equal(diagnostics.pageErrors.length, 0, "browser flow 不可隱藏 pageerror")
    outcome.status = "passed"
  } catch (error) {
    failure = error
    outcome.status = "failed"
    if (outcome.start?.status === "pending") outcome.start.milliseconds = Date.now() - startAt
    if (nativePage && !nativePage.isClosed()) {
      try { await safeDom(nativePage, "native-failure"); await screenshot(nativePage, "native-failure") }
      catch { outcome.failureCapture = "unavailable" }
    }
  } finally {
    clearTimeout(workTimer)
    try {
      if (context) await bounded(() => context.close(), 10_000, "browser context close")
    } catch (error) { failure ??= error }
    try {
      if (stopBrowser) await bounded(stopBrowser, 15_000, "browser close")
      outcome.lifecycle.status = "stopped"
      await rm(profile, { recursive: true, force: true })
      outcome.lifecycle.profileRemoved = true
    } catch (error) { outcome.lifecycle.status = "unresolved"; outcome.lifecycle.profilePath = profile; failure ??= error }
    if (failure) outcome.status = "failed"
    outcome.oauthRequestsBlocked = oauthBlocked
    await onOutcome(outcome)
  }
  if (failure) throw failure
  return outcome
}
