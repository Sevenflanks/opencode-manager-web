import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { createServer as createHttpServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"
import { createServer } from "vite"

const enabled = process.env.OMW_BROWSER_TEST === "1"
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const workerConnectivity = {
  checkedAt: "2026-10-02T00:00:00Z", mode: "worker",
  capabilities: { launcher: false, tailscale: false, credentialUpdate: false, managerShutdown: false, maxInstances: 1, nativeWeb: true },
  nativeWebOrigin: "https://native.example.test",
  manager: { localUrl: "http://127.0.0.1:4174", publicUrl: null },
  tailscale: { state: "unavailable", dnsName: null, version: null },
  serve: { state: "not-configured", managerMapped: null, mappedInstancePorts: null, expectedInstancePorts: 0, funnel: "unknown" },
  registration: { state: "not-configured", trigger: null, diagnostic: null }, nodeVersion: "24",
}
const instanceFixture = (id, state = "ready", bound = false) => ({
  id, kind: "headless", projectName: "Worker Project", projectDirectory: "/projects/demo", state,
  endpoint: "http://execution:4096", port: 4096, pid: state === "stopped" ? null : 123,
  launchedAt: "2026-10-02T00:00:00Z", healthVersion: "1.2.27", stopAllowed: state !== "stopped",
  error: null, remoteUrlUnavailableReason: null, trackingHidden: false,
  recovery: { recheckAllowed: true, resumeAllowed: state === "stopped" && bound, hideAllowed: true, removeAllowed: state === "stopped" },
  summary: { activity: "none-reported", busySessions: 0, pendingQuestions: 0, pendingPermissions: 0, error: null },
  primarySummary: { scope: bound ? "known" : "unbound", activity: "none-reported", busySessions: 0, retrySessions: 0, pendingQuestions: 0, pendingPermissions: 0, error: null },
  sessions: [], primarySession: bound ? { sessionId: "ses-root", title: "Saved work", source: "manual", boundAt: "2026-10-02T00:00:00Z" } : null,
})

test("Worker mobile components preserve supported workflows", { skip: !enabled, timeout: 90_000 }, async t => {
  assert.ok(process.env.OMW_BROWSER_EXECUTABLE, "Set OMW_BROWSER_EXECUTABLE to installed Chrome/Chromium")
  const profile = await mkdtemp(path.join(tmpdir(), "omw-worker-browser-"))
  let server
  let httpServer
  let browser
  try {
    // 本測試持有 server/browser handle；同一 test process 的 finally 完成 Stop，不接觸既有服務。
    // Vite 將 port: 0 視為預設 port；由本測試的 HTTP server 取得真正的 ephemeral port，避免平行測試互搶。
    server = await createServer({ root: webRoot, server: { middlewareMode: true, hmr: false } })
    httpServer = createHttpServer(server.middlewares)
    await new Promise((resolve, reject) => {
      httpServer.once("error", reject)
      httpServer.listen(0, "127.0.0.1", resolve)
    })
    const origin = `http://127.0.0.1:${httpServer.address().port}`
    await Promise.all(["AppData/Roaming", "AppData/Local", "Temp"].map(folder => mkdir(path.join(profile, folder), { recursive: true })))
    const env = Object.fromEntries(["SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "LANG", "LC_ALL"]
      .flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]]))
    browser = await chromium.launch({ executablePath: process.env.OMW_BROWSER_EXECUTABLE, headless: true, env: {
      ...env, HOME: profile, USERPROFILE: profile, APPDATA: path.join(profile, "AppData/Roaming"),
      LOCALAPPDATA: path.join(profile, "AppData/Local"), TEMP: path.join(profile, "Temp"), TMP: path.join(profile, "Temp"),
    } })
    let page
    let connectivity = structuredClone(workerConnectivity)
    let connectivityFailure = false
    let connectivityHold = null
    let instances = []
    let shortcuts = [{ id: "project", name: "Worker shortcut", directory: "/projects/demo" }]
    let stopped = []
    let capacity = { state: "available", maxInstances: 1 }
    let capacityStatus = 200
    let capacityNetworkFailure = false
    let capacityHold = null
    let overviewStatus = 200
    let startRefusal = false
    let startDirectoryRefusal = false
    let shortcutSaveFailure = false
    let canonicalDirectories = {}
    const capacityRequests = []
    const overviewRequests = []
    const resumedIds = []
    const apiEvents = []
    const startedDirectories = []
    const directoryRequests = []
    const unsupportedRequests = []
    const routeApi = async route => {
      const url = new URL(route.request().url())
      apiEvents.push(`${route.request().method()} ${url.pathname}`)
      if (/settings\/credentials|manager\/shutdown|connectivity\/(register|enable)|launcher/.test(url.pathname)) unsupportedRequests.push(url.pathname)
      if (url.pathname === "/api/v1/connectivity") {
        if (connectivityHold) await connectivityHold
        if (connectivityFailure) return route.fulfill({ status: 503, json: { error: { code: "HTTP_ERROR", message: "unavailable" } } })
        return route.fulfill({ json: connectivity })
      }
      if (url.pathname === "/api/v1/worker/capacity") {
        capacityRequests.push(route.request())
        if (capacityHold) await capacityHold
        if (capacityNetworkFailure) return route.abort("failed")
        return route.fulfill({ status: capacityStatus, json: capacity, headers: { "cache-control": "no-store" } })
      }
      if (url.pathname === "/api/v1/overview") {
        overviewRequests.push(url)
        return route.fulfill({ status: overviewStatus, json: {
        shortcuts,
        instances: instances.filter(item => (!item.trackingHidden || url.searchParams.get("includeHidden") === "true") && (!url.searchParams.get("q") || item.projectDirectory.includes(url.searchParams.get("q")))),
        history: { total: stopped.length, revision: String(stopped.length) },
        } })
      }
      if (url.pathname === "/api/v1/instances/history") return route.fulfill({ json: { instances: stopped, total: stopped.length, nextOffset: null, revision: String(stopped.length) } })
      if (url.pathname === "/api/v1/directories") {
        const directory = url.searchParams.get("path")
        directoryRequests.push(directory)
        const current = canonicalDirectories[directory] ?? directory
        return route.fulfill({ json: { current, parent: current === "/workspace" ? null : "/workspace", children: [], errors: [] } })
      }
      if (url.pathname.startsWith("/api/v1/shortcuts/") && route.request().method() === "DELETE") {
        shortcuts = shortcuts.filter(shortcut => shortcut.id !== decodeURIComponent(url.pathname.split("/").at(-1)))
        return route.fulfill({ status: 204 })
      }
      if (url.pathname === "/api/v1/shortcuts" && route.request().method() === "POST") {
        if (shortcutSaveFailure) return route.fulfill({ status: 400, json: { error: { code: "DIRECTORY_NOT_FOUND", message: "internal execution detail" } } })
        const shortcut = { id: "new-shortcut", ...route.request().postDataJSON() }
        shortcuts.push(shortcut)
        return route.fulfill({ json: shortcut })
      }
      if (url.pathname === "/api/v1/instances" && route.request().method() === "POST") {
        if (startRefusal) return route.fulfill({ status: 503, json: { error: { code: "WORKER_CAPACITY_UNAVAILABLE", message: "internal execution detail" } } })
        if (startDirectoryRefusal) return route.fulfill({ status: 400, json: { error: { code: "WORKER_DIRECTORY_OUTSIDE_WORKSPACE", message: "internal execution detail" } } })
        startedDirectories.push(route.request().postDataJSON().directory)
        instances = [instanceFixture("new-live"), ...instances]
        capacity = { state: "occupied", maxInstances: 1 }
        return route.fulfill({ json: instances[0] })
      }
      if (url.pathname.endsWith("/resume")) {
        resumedIds.push(decodeURIComponent(url.pathname.split("/").at(-2)))
        instances = [instanceFixture("resumed-live", "ready", true), ...instances]
        capacity = { state: "occupied", maxInstances: 1 }
        return route.fulfill({ json: instances[0] })
      }
      if (url.pathname.endsWith("/recheck")) {
        instances = [instanceFixture("lost", "ready", true)]
        capacity = { state: "occupied", maxInstances: 1 }
        return route.fulfill({ json: instances[0] })
      }
      if (url.pathname.endsWith("/stop")) {
        const item = { ...instances[0], state: "stopped", stopAllowed: false, recovery: { recheckAllowed: false, resumeAllowed: true, hideAllowed: false, removeAllowed: true } }
        instances = []
        stopped = [item]
        capacity = { state: "available", maxInstances: 1 }
        return route.fulfill({ json: item })
      }
      if (url.pathname.endsWith("/tracking")) {
        instances = [{ ...instances[0], trackingHidden: route.request().postDataJSON().hidden }]
        return route.fulfill({ json: instances[0] })
      }
      if (url.pathname.endsWith("/primary-session")) {
        instances = [instanceFixture("session-live", "ready", true)]
        return route.fulfill({ json: { instanceId: "session-live", sessionId: "ses-root" } })
      }
      if (url.pathname.endsWith("/primary-todos")) return route.fulfill({ json: { instanceId: decodeURIComponent(url.pathname.split("/").at(-2)), sessionId: "ses-root", todos: [{ content: "Verify Worker task", status: "in_progress", priority: "high" }] } })
      if (url.pathname.endsWith("/open-url")) return route.fulfill({ json: { instanceId: instances[0].id, sessionId: "ses-root", url: "https://native.example.test/project/session/ses-root" } })
      if (url.pathname.endsWith("/sessions") && route.request().method() === "POST") {
        instances = [instanceFixture("session-live", "ready", true)]
        return route.fulfill({ json: { instanceId: "session-live", sessionId: "ses-root", url: "https://native.example.test/project/session/ses-root" } })
      }
      if (url.pathname.endsWith("/sessions")) return route.fulfill({ json: { roots: [{ id: "ses-root", title: "Saved work" }], unknownParent: [] } })
      if (/^\/api\/v1\/instances\/[^/]+$/.test(url.pathname)) return route.fulfill({ json: [...instances, ...stopped].find(item => item.id === decodeURIComponent(url.pathname.split("/").at(-1))) ?? null })
      return route.fulfill({ status: 404 })
    }
    const freshPage = async () => {
      await page?.context().close()
      page = await browser.newPage({ viewport: { width: 390, height: 844 } })
      page.setDefaultTimeout(5_000)
      await page.route("**/api/v1/**", routeApi)
      await page.context().route("https://native.example.test/**", route => route.fulfill({ contentType: "text/html", body: "<h1>Native root</h1>" }))
    }
    t.beforeEach(async () => {
      connectivity = structuredClone(workerConnectivity)
      connectivityFailure = false
      connectivityHold = null
      instances = []
      shortcuts = [{ id: "project", name: "Worker shortcut", directory: "/projects/demo" }]
      stopped = []
      capacity = { state: "available", maxInstances: 1 }
      capacityStatus = 200
      capacityNetworkFailure = false
      capacityHold = null
      overviewStatus = 200
      startRefusal = false
      startDirectoryRefusal = false
      shortcutSaveFailure = false
      canonicalDirectories = {}
      capacityRequests.length = 0
      overviewRequests.length = 0
      resumedIds.length = 0
      apiEvents.length = 0
      startedDirectories.length = 0
      directoryRequests.length = 0
      unsupportedRequests.length = 0
      await freshPage()
    })

    await t.test("Worker default workspace is browse-only, keyboard accessible, and custom workspace shortcut takes precedence", async () => {
      shortcuts = []
      await page.goto(origin)
      await page.getByRole("button", { name: "啟動 Instance", exact: true }).first().click()
      let panel = page.getByRole("dialog", { name: "啟動 Instance" })
      const defaultWorkspace = panel.getByRole("button", { name: /預設工作目錄/ })
      await defaultWorkspace.waitFor()
      await panel.locator(".current-directory code").getByText("/workspace", { exact: true }).waitFor()
      assert.deepEqual(directoryRequests, ["/workspace"], "first open browses root automatically via GET only")
      assert.equal(await panel.locator(".shortcut-card").count(), 1)
      assert.equal(await panel.getByText("尚無目錄捷徑，仍可直接瀏覽既有目錄。", { exact: true }).count(), 0)
      assert.equal(await panel.getByText("1 個", { exact: true }).count(), 1)
      assert.equal(await panel.getByRole("button", { name: "編輯目錄捷徑" }).count(), 0)
      assert.equal(await panel.getByRole("button", { name: "移除目錄捷徑" }).count(), 0)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true)
      await page.setViewportSize({ width: 1440, height: 900 })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true)
      assert.equal(await defaultWorkspace.isVisible(), true)
      await page.setViewportSize({ width: 390, height: 844 })
      await defaultWorkspace.focus()
      await defaultWorkspace.press("Enter")
      await panel.locator(".current-directory code").getByText("/workspace", { exact: true }).waitFor()
      assert.deepEqual(directoryRequests, ["/workspace", "/workspace"])
      await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/directories"),
        defaultWorkspace.click(),
      ])
      assert.deepEqual(directoryRequests, ["/workspace", "/workspace", "/workspace"])
      assert.deepEqual(startedDirectories, [])
      assert.equal(apiEvents.some(event => /^(POST|PATCH|DELETE) \/api\/v1\/shortcuts/.test(event)), false)

      await page.getByRole("button", { name: "關閉啟動面板" }).click()
      shortcuts = [{ id: "workspace", name: "我的工作區", directory: "/workspace" }]
      await page.goto(origin)
      await page.getByRole("button", { name: "啟動 Instance", exact: true }).first().click()
      panel = page.getByRole("dialog", { name: "啟動 Instance" })
      assert.equal(await panel.locator(".shortcut-card").count(), 1)
      assert.equal(await panel.getByRole("button", { name: /預設工作目錄/ }).count(), 0)
      assert.equal(await panel.getByRole("button", { name: /我的工作區/ }).count(), 1)
      assert.equal(await panel.getByRole("button", { name: "編輯目錄捷徑" }).count(), 1)
      assert.equal(await panel.getByRole("button", { name: "移除目錄捷徑" }).count(), 1)
      await panel.getByRole("button", { name: "編輯目錄捷徑" }).click()
      assert.equal(await panel.getByRole("textbox", { name: "目錄捷徑名稱" }).inputValue(), "我的工作區")
      await panel.getByRole("button", { name: "取消", exact: true }).click()
      await panel.getByRole("button", { name: "移除目錄捷徑" }).click()
      await page.getByRole("alertdialog").getByRole("button", { name: "移除捷徑", exact: true }).click()
      await panel.getByRole("button", { name: /預設工作目錄/ }).waitFor()
      assert.equal(await panel.locator(".shortcut-card").count(), 1)
      assert.equal(shortcuts.length, 0)

      connectivity = { ...workerConnectivity, mode: "loopback" }
      shortcuts = []
      await page.goto(origin)
      await page.getByRole("button", { name: "啟動 Instance", exact: true }).first().click()
      panel = page.getByRole("dialog", { name: "啟動 Instance" })
      assert.equal(await panel.getByRole("button", { name: /預設工作目錄/ }).count(), 0)
      await panel.getByText("尚無目錄捷徑，仍可直接瀏覽既有目錄。", { exact: true }).waitFor()
    })

    await t.test("Worker first browse waits for mode and preserves confirmed directory and drafts while shortcut form has deliberate focus", async () => {
      let release
      connectivityHold = new Promise(resolve => { release = resolve })
      await page.goto(origin)
      await page.getByRole("button", { name: "啟動 Instance", exact: true }).first().click()
      const panel = page.getByRole("dialog", { name: "啟動 Instance" })
      assert.deepEqual(directoryRequests, [])
      connectivityHold = null
      release()
      await panel.locator(".current-directory code").getByText("/workspace", { exact: true }).waitFor()
      assert.deepEqual(directoryRequests, ["/workspace"])
      assert.equal(await panel.getByRole("textbox", { name: "目錄捷徑名稱" }).count(), 0)
      assert.equal(await panel.locator(".shortcut-form").isVisible(), false)
      assert.equal(await panel.getByRole("button", { name: "新增捷徑", exact: true }).getAttribute("aria-expanded"), "false")
      assert.equal(await panel.evaluate(el => el.contains(document.activeElement) && document.activeElement.tagName !== "INPUT"), true)
      const pathInput = panel.getByRole("textbox", { name: "瀏覽並啟動" })
      await pathInput.fill("/workspace/project")
      await panel.getByRole("button", { name: "瀏覽", exact: true }).click()
      await panel.locator(".current-directory code").getByText("/workspace/project", { exact: true }).waitFor()
      await panel.getByRole("button", { name: "關閉啟動面板" }).click()
      await panel.waitFor({ state: "hidden" })
      await page.getByRole("button", { name: "啟動 Instance", exact: true }).first().click()
      assert.equal(await pathInput.inputValue(), "/workspace/project")
      assert.deepEqual(directoryRequests, ["/workspace", "/workspace/project"])
      await pathInput.fill("/workspace/draft")
      await panel.getByRole("button", { name: "關閉啟動面板" }).click()
      await panel.waitFor({ state: "hidden" })
      await page.getByRole("button", { name: "啟動 Instance", exact: true }).first().click()
      assert.equal(await pathInput.inputValue(), "/workspace/draft")
      assert.deepEqual(directoryRequests, ["/workspace", "/workspace/project"])
      assert.equal(await panel.getByRole("button", { name: "啟動全新 Instance", exact: true }).count(), 0)
      await panel.getByRole("button", { name: "編輯目錄捷徑" }).click()
      const name = panel.getByRole("textbox", { name: "目錄捷徑名稱" })
      assert.equal(await name.inputValue(), "Worker shortcut")
      assert.equal(await name.evaluate(el => el === document.activeElement), true)
      await panel.getByRole("button", { name: "取消", exact: true }).click()
      assert.equal(await panel.locator(".shortcut-form").isVisible(), false)
      const add = panel.getByRole("button", { name: "新增捷徑", exact: true })
      assert.equal(await add.evaluate(el => el === document.activeElement), true)
      await add.click()
      assert.equal(await add.getAttribute("aria-expanded"), "true")
      await name.fill("New shortcut")
      await panel.getByRole("textbox", { name: "目錄捷徑目錄", exact: true }).fill("/workspace/new")
      await panel.getByRole("button", { name: "新增目錄", exact: true }).click()
      await panel.getByRole("button", { name: /New shortcut/ }).waitFor()
      assert.equal(await panel.locator(".shortcut-form").isVisible(), false)
      assert.deepEqual(startedDirectories, [])
    })

    await t.test("Worker workspace guidance uses canonical browse results and root recovery remains GET-only after Start refusal", async () => {
      canonicalDirectories = { "/workspace/link": "/external/project", "/external/alias": "/workspace/real" }
      await page.goto(origin)
      await page.getByRole("button", { name: "啟動 Instance", exact: true }).first().click()
      const panel = page.getByRole("dialog", { name: "啟動 Instance" })
      await panel.getByText("Instance 只能在 /workspace 或其子目錄啟動", { exact: true }).waitFor()
      await panel.locator(".current-directory code").getByText("/workspace", { exact: true }).waitFor()
      const pathInput = panel.getByRole("textbox", { name: "瀏覽並啟動", exact: true })
      const browseButton = panel.getByRole("button", { name: "瀏覽", exact: true })
      const root = panel.getByRole("button", { name: "回到 /workspace", exact: true })
      await pathInput.fill("/external/unconfirmed")
      assert.equal(await panel.locator(".workspace-directory-warning").count(), 0, "draft is not canonical evidence")
      await pathInput.fill("/workspace/link")
      await browseButton.click()
      await panel.locator(".current-directory code").getByText("/external/project", { exact: true }).waitFor()
      await panel.locator(".workspace-directory-warning").waitFor()
      await root.click()
      await panel.locator(".current-directory code").getByText("/workspace", { exact: true }).waitFor()
      assert.equal(await panel.locator(".workspace-directory-warning").count(), 0)
      await pathInput.fill("/workspace-sibling")
      await browseButton.click()
      await panel.locator(".workspace-directory-warning").waitFor()
      await panel.getByRole("button", { name: "新增捷徑", exact: true }).click()
      await panel.getByRole("textbox", { name: "目錄捷徑名稱", exact: true }).fill("Outside shortcut")
      await panel.getByRole("textbox", { name: "目錄捷徑目錄", exact: true }).fill("/workspace-sibling")
      await panel.getByRole("button", { name: "新增目錄", exact: true }).click()
      await panel.getByRole("button", { name: /Outside shortcut/ }).waitFor()
      await pathInput.fill("/external/alias")
      await browseButton.click()
      await panel.locator(".current-directory code").getByText("/workspace/real", { exact: true }).waitFor()
      assert.equal(await panel.locator(".workspace-directory-warning").count(), 0, "canonical result decides, not the requested path")
      startDirectoryRefusal = true
      await panel.getByRole("button", { name: "啟動全新 Instance", exact: true }).click()
      await panel.getByRole("alert").filter({ hasText: "請選擇 /workspace 或其子目錄" }).waitFor()
      const beforeRoot = apiEvents.length
      await root.click()
      await panel.locator(".current-directory code").getByText("/workspace", { exact: true }).waitFor()
      assert.equal(apiEvents.slice(beforeRoot).some(event => /^(POST|PATCH|DELETE) /.test(event)), false)
      assert.equal(await panel.getByRole("alert").filter({ hasText: "請選擇 /workspace 或其子目錄" }).isVisible(), true, "navigation must not reinterpret Start outcome as stopped")
      assert.equal(await page.locator(".toast-error").count(), 0)
      assert.deepEqual(startedDirectories, [])
      assert.equal(apiEvents.filter(event => event === "POST /api/v1/instances").length, 1, "only the explicit Start requests a mutation")
    })

    await t.test("Worker shortcut save failures retain their global error independently of panel Start errors", async () => {
      shortcutSaveFailure = true
      await page.goto(origin)
      await page.getByRole("button", { name: "啟動 Instance", exact: true }).first().click()
      const panel = page.getByRole("dialog", { name: "啟動 Instance" })
      await panel.getByRole("button", { name: "新增捷徑", exact: true }).click()
      await panel.getByRole("textbox", { name: "目錄捷徑名稱", exact: true }).fill("Missing shortcut")
      await panel.getByRole("textbox", { name: "目錄捷徑目錄", exact: true }).fill("/workspace/missing")
      await panel.getByRole("button", { name: "新增目錄", exact: true }).click()
      await page.locator(".toast-error").waitFor()
      await panel.locator(".lifecycle-error").waitFor()
      await panel.press("Escape")
      await panel.waitFor({ state: "hidden" })
      assert.equal(await page.locator(".toast-error").isVisible(), true, "closing Start panel only clears Start-owned errors")
      assert.deepEqual(startedDirectories, [])
    })

    await t.test("Worker identity is clear across viewport sizes and stale connectivity remains degraded", async () => {
      await page.goto(origin)
      const modeHeading = page.getByRole("heading", { name: "Worker · 單機", exact: true })
      await modeHeading.waitFor()
      const signal = page.locator(".connectivity-signal")
      assert.equal(await signal.locator(".lucide-server-icon").count(), 1)
      assert.equal(await signal.locator(".lucide-wifi-icon").count(), 0)
      assert.equal(await signal.getAttribute("aria-hidden"), "true")
      assert.equal(await page.locator(".topbar-brand .eyebrow").innerText(), "WORKER · 執行管理")
      assert.doesNotMatch(await page.locator(".topbar-brand").innerText(), /WINDOWS/)
      assert.equal(await page.locator(".connectivity").getAttribute("data-tone"), "ready")
      const mobileHeadingBox = await modeHeading.boundingBox()
      assert.ok(mobileHeadingBox && mobileHeadingBox.width > 0)
      await page.setViewportSize({ width: 1440, height: 900 })
      await modeHeading.waitFor({ state: "visible" })
      assert.equal(await page.locator(".topbar-brand .eyebrow").innerText(), "WORKER · 執行管理")
      assert.equal(await page.locator(".connectivity").getAttribute("data-tone"), "ready")
      await page.setViewportSize({ width: 390, height: 844 })
      await page.getByText("獨立運作，未由 Coordinator 管理。每次使用一個 Instance；Project 目錄位於 Worker 執行環境。", { exact: true }).waitFor()
      assert.doesNotMatch(await page.locator(".connectivity").innerText(), /Tailscale|Serve|離線|本機/)
      connectivityFailure = true
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))
      await page.getByRole("heading", { name: "連線資料已過期", exact: true }).waitFor()
      assert.equal(await page.locator(".connectivity").getAttribute("data-tone"), "unknown")
      assert.equal(await signal.locator(".lucide-server-icon").count(), 1)
      assert.equal(await signal.locator(".lucide-wifi-icon").count(), 0)
      assert.equal(await page.locator(".topbar-brand .eyebrow").innerText(), "WORKER · 執行管理")
      connectivity = { ...workerConnectivity, mode: "tailnet", tailscale: { state: "connected", dnsName: null, version: null }, registration: { state: "idle", trigger: null, diagnostic: null } }
      connectivityFailure = false
      await freshPage()
      await page.goto(origin)
      await page.getByRole("heading", { name: "本機 Tailscale 在線", exact: true }).waitFor()
      assert.equal(await page.locator(".connectivity").getAttribute("data-mode"), "tailnet")
      assert.equal(await page.locator(".connectivity-signal .lucide-wifi-icon").count(), 1)
      assert.equal(await page.locator(".connectivity-signal .lucide-server-icon").count(), 0)
      assert.equal(await page.locator(".topbar-brand .eyebrow").innerText(), "WINDOWS · 連線管理")
      connectivity = structuredClone(workerConnectivity)
      await freshPage()
      await page.goto(origin)
      await page.getByRole("button", { name: "OMW 設定", exact: true }).click()
      const settings = page.getByRole("dialog", { name: "OMW 設定" })
      await settings.getByRole("checkbox", { name: "頁面開啟期間通知所有 Instance 的待回答與待授權" }).waitFor()
      await settings.getByText("Worker 帳密由部署設定管理。原生 Web 會由瀏覽器另行要求登入。", { exact: true }).waitFor()
      assert.equal(await settings.locator("input[type=password]").count(), 0)
      assert.equal(await settings.getByRole("button", { name: "停止 OMW" }).count(), 0)
      assert.doesNotMatch(await settings.innerText(), /launcher|TUI/)
      assert.deepEqual(unsupportedRequests, [])
      await settings.getByRole("button", { name: "關閉 OMW 設定" }).click()
    })

    await t.test("unbound ready Instance opens credential-free native root on its own origin", async () => {
      instances = [instanceFixture("live")]
      await page.goto(origin)
      await page.getByRole("button", { name: /Worker Project/ }).click()
      const link = page.getByRole("link", { name: "開啟原生 OpenCode Web", exact: true })
      await link.waitFor()
      assert.equal(await link.getAttribute("href"), "https://native.example.test/")
      assert.match(await link.getAttribute("rel"), /noopener/)
      assert.match(await link.getAttribute("rel"), /noreferrer/)
      await page.context().route("https://native.example.test/**", route => route.fulfill({ contentType: "text/html", body: "<h1>Native root</h1>" }))
      const popupPromise = page.waitForEvent("popup")
      await link.click()
      const popup = await popupPromise
      await popup.getByRole("heading", { name: "Native root" }).waitFor()
      assert.equal(popup.url(), "https://native.example.test/")
      assert.equal(await popup.evaluate(() => window.opener), null)
      await popup.close()
      await page.getByText("Provider 登入與重新登入請在原生 OpenCode Web 中操作。", { exact: true }).waitFor()
    })

    await t.test("one live slot blocks a second start while stopped history leaves the slot free", async () => {
      instances = [instanceFixture("live")]
      capacity = { state: "occupied", maxInstances: 1 }
      stopped = [instanceFixture("old", "stopped", true)]
      await page.goto(origin)
      await page.getByRole("button", { name: "啟動 Instance", exact: true }).first().click()
      const panel = page.getByRole("dialog", { name: "啟動 Instance" })
      await panel.getByRole("button", { name: /Worker shortcut/ }).click()
      const start = panel.getByRole("button", { name: "啟動全新 Instance", exact: true })
      await start.waitFor()
      assert.equal(await start.isDisabled(), true)
      await panel.getByText("Worker 目前執行環境已占用；請先停止目前的 Instance，再啟動或接續。", { exact: true }).waitFor()
      await panel.getByRole("button", { name: "關閉啟動面板" }).click()
      instances = []
      capacity = { state: "available", maxInstances: 1 }
      await page.goto(origin)
      await page.getByRole("button", { name: "啟動 Instance", exact: true }).first().click()
      await panel.getByRole("button", { name: /Worker shortcut/ }).click()
      await start.waitFor()
      assert.equal(await start.isEnabled(), true)
      await start.click()
      await page.getByRole("heading", { name: "demo", exact: true }).waitFor()
      assert.deepEqual(startedDirectories, ["/projects/demo"])
    })

    await t.test("historical unknown records hidden by tracking and search do not block an available current execution", async () => {
      instances = [{ ...instanceFixture("hidden", "unreachable"), trackingHidden: true }]
      await page.goto(origin)
      const search = page.getByRole("textbox", { name: "搜尋", exact: true })
      await search.fill("no-match")
      await search.press("Enter")
      await page.getByRole("button", { name: "清除篩選", exact: true }).waitFor()
      await page.getByRole("button", { name: "啟動 Instance", exact: true }).first().click()
      const panel = page.getByRole("dialog", { name: "啟動 Instance" })
      await panel.getByRole("button", { name: /Worker shortcut/ }).click()
      const beforeStart = capacityRequests.length
      await panel.getByRole("button", { name: "啟動全新 Instance", exact: true }).click()
      await page.getByRole("heading", { name: "demo", exact: true }).waitFor()
      assert.deepEqual(startedDirectories, ["/projects/demo"])
      assert.ok(capacityRequests.length > beforeStart, "manual start must fetch fresh execution capacity")
      const startEvent = apiEvents.indexOf("POST /api/v1/instances")
      assert.equal(apiEvents[startEvent - 1], "GET /api/v1/worker/capacity")
      assert.equal(overviewRequests.some(url => url.searchParams.get("includeHidden") === "true"), false, "start must not read all historical records to count capacity")
      await page.getByRole("button", { name: "返回列表", exact: true }).click()
      await page.getByRole("checkbox", { name: "顯示已停止追蹤" }).check()
      await page.locator('[data-instance-id="hidden"]').getByText(/已失聯/).waitFor()
      assert.equal(instances.find(item => item.id === "hidden").state, "unreachable")
    })

    await t.test("Worker technical entry describes the browser-reachable native origin, not loopback", async () => {
      instances = [instanceFixture("live")]
      await page.goto(origin)
      await page.getByRole("button", { name: /Worker Project/ }).click()
      await page.getByText("技術資訊", { exact: true }).click()
      assert.doesNotMatch(await page.locator(".technical-info").innerText(), /127\.0\.0\.1|execution:4096/)
      await page.locator(".technical-info").getByText("https://native.example.test/", { exact: true }).waitFor()
    })

    await t.test("bound unreachable Instance can request safe re-identification and resume", async () => {
      instances = [{ ...instanceFixture("lost", "unreachable", true), recovery: { recheckAllowed: true, resumeAllowed: true, hideAllowed: true, removeAllowed: false } },
        { ...instanceFixture("older-unknown", "unreachable"), trackingHidden: true }]
      await page.goto(origin)
      await page.getByRole("button", { name: /Worker Project/ }).click()
      assert.equal(await page.getByRole("link", { name: "開啟原生 OpenCode Web", exact: true }).count(), 0)
      await page.getByText("Instance 操作", { exact: true }).click()
      // 公開 recovery metadata 授權接續；API 會重新辨識舊程序，不由 UI 將 unreachable 當 stopped。
      const resumeButton = page.getByRole("button", { name: "接續對話", exact: true })
      assert.equal(await resumeButton.isEnabled(), true)
      await resumeButton.click()
      const beforeResume = capacityRequests.length
      await page.getByRole("alertdialog").getByRole("button", { name: "接續對話", exact: true }).click()
      await page.locator(".technical-info").getByText("resumed-live", { exact: true }).waitFor({ state: "attached" })
      await page.getByRole("heading", { name: "Saved work", exact: true }).waitFor()
      assert.deepEqual(resumedIds, ["lost"])
      assert.ok(capacityRequests.length > beforeResume, "resume must fetch fresh capacity")
      const resumeEvent = apiEvents.indexOf("POST /api/v1/instances/lost/resume")
      assert.equal(apiEvents[resumeEvent - 1], "GET /api/v1/worker/capacity")
      assert.equal(instances.find(item => item.id === "lost").state, "unreachable")
      assert.equal(instances.find(item => item.id === "older-unknown").state, "unreachable")
    })

    await t.test("occupied, unknown, failed and missing capacity fail closed for manual start and resume", async () => {
      instances = [{ ...instanceFixture("lost", "unreachable", true), recovery: { recheckAllowed: true, resumeAllowed: true, hideAllowed: true, removeAllowed: false } }]
      for (const unavailable of [
        { state: "occupied", maxInstances: 1 }, { state: "unknown", maxInstances: 1 },
        { state: "available" }, { maxInstances: 1 }, { state: "available", maxInstances: 2 }, null,
        { error: { code: "WORKER_CAPACITY_UNAVAILABLE", message: "internal execution detail" } },
        { error: { code: "HTTP_ERROR", message: "missing capacity endpoint" } },
        { networkFailure: true },
      ]) {
        capacity = unavailable
        capacityStatus = unavailable?.error ? unavailable.error.code === "HTTP_ERROR" ? 404 : 503 : 200
        capacityNetworkFailure = unavailable?.networkFailure === true
        await freshPage()
        await page.goto(origin)
        await page.getByRole("button", { name: "啟動 Instance", exact: true }).first().click()
        const panel = page.getByRole("dialog", { name: "啟動 Instance" })
        await panel.getByRole("button", { name: /Worker shortcut/ }).click()
        const status = unavailable?.state === "occupied" ? "Worker 目前執行環境已占用；請先停止目前的 Instance，再啟動或接續。"
          : "無法確認 Worker 目前執行環境容量；請重新整理或重新檢查後再啟動或接續。"
        await panel.getByRole("status").getByText(status, { exact: true }).waitFor()
        assert.equal(await panel.getByRole("button", { name: "啟動全新 Instance", exact: true }).isDisabled(), true)
        await panel.getByRole("button", { name: "關閉啟動面板" }).click()
        await page.getByRole("button", { name: /Worker Project/ }).click()
        await page.getByText("Instance 操作", { exact: true }).click()
        assert.equal(await page.getByRole("button", { name: "接續對話", exact: true }).isDisabled(), true)
        assert.deepEqual(startedDirectories, [])
        assert.deepEqual(resumedIds, [])
      }
    })

    await t.test("panel recheck restores stale connectivity with fresh capacity and occupied returns to the list without mutations", async () => {
      await page.clock.install()
      capacity = { state: "unknown", maxInstances: 1 }
      await page.goto(origin)
      await page.getByRole("button", { name: "啟動 Instance", exact: true }).first().click()
      const panel = page.getByRole("dialog", { name: "啟動 Instance" })
      await panel.getByRole("button", { name: /預設工作目錄/ }).click()
      connectivityFailure = true
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))
      await page.getByRole("heading", { name: "連線資料已過期", exact: true }).waitFor({ state: "attached" })
      connectivityFailure = false
      capacity = { state: "available", maxInstances: 1 }
      let release
      capacityHold = new Promise(resolve => { release = resolve })
      const retry = panel.getByRole("button", { name: "重新檢查", exact: true })
      const before = capacityRequests.length
      const pendingCapacity = page.waitForRequest(request => new URL(request.url()).pathname === "/api/v1/worker/capacity")
      await retry.click()
      await pendingCapacity
      assert.equal(await retry.isDisabled(), true)
      assert.equal(await panel.getByRole("button", { name: "啟動全新 Instance", exact: true }).isDisabled(), true)
      await retry.evaluate(button => { button.click(); button.click() })
      assert.equal(capacityRequests.length, before + 1)
      capacityHold = null
      release()
      await panel.getByText("Worker 目前執行環境可用，可啟動或接續 Instance。", { exact: true }).waitFor()
      assert.equal(await panel.getByRole("button", { name: "啟動全新 Instance", exact: true }).isEnabled(), true)
      await panel.getByRole("button", { name: "關閉啟動面板" }).click()
      capacity = { state: "occupied", maxInstances: 1 }
      instances = [instanceFixture("occupied")]
      await page.goto(origin)
      await page.getByRole("button", { name: "啟動 Instance", exact: true }).first().click()
      await panel.getByRole("button", { name: "返回 Instance 清單", exact: true }).click()
      await panel.waitFor({ state: "hidden" })
      assert.equal(await page.locator(".app-root").getAttribute("data-mobile-view"), "list")
      assert.equal(apiEvents.some(event => /^(POST|PATCH|DELETE) /.test(event)), false)
      assert.deepEqual(startedDirectories, [])
    })

    await t.test("capacity refresh follows overview, polling and recheck while stale overview still refuses mutations and native root", async () => {
      await page.clock.install()
      instances = [{ ...instanceFixture("lost", "unreachable", true), recovery: { recheckAllowed: true, resumeAllowed: true, hideAllowed: true, removeAllowed: false } }]
      capacity = { state: "unknown", maxInstances: 1 }
      await page.goto(origin)
      await page.getByRole("button", { name: /Worker Project/ }).click()
      await page.getByText("Instance 操作", { exact: true }).click()
      await page.locator(".lifecycle-note").getByText(/無法確認 Worker/).waitFor()
      await page.getByRole("button", { name: "重新檢查", exact: true }).click()
      await page.locator(".lifecycle-note").getByText(/執行環境已占用/).waitFor()
      await page.getByRole("link", { name: "開啟原生 OpenCode Web", exact: true }).waitFor()
      capacity = { state: "available", maxInstances: 1 }
      const beforePoll = capacityRequests.length
      await page.clock.runFor(5_000)
      await page.locator(".lifecycle-note").getByText(/執行環境可用/).waitFor()
      assert.equal(capacityRequests.length, beforePoll + 1, "one capacity request per overview poll; no separate polling loop")
      capacityNetworkFailure = true
      await page.getByRole("button", { name: "重新整理", exact: true }).first().click()
      await page.locator(".lifecycle-note").getByText(/無法確認 Worker/).waitFor()
      capacityNetworkFailure = false
      await page.getByRole("button", { name: "重新整理", exact: true }).first().click()
      await page.locator(".lifecycle-note").getByText(/執行環境可用/).waitFor()
      overviewStatus = 503
      await page.getByRole("button", { name: "重新整理", exact: true }).first().click()
      await page.locator('.overview-freshness[data-state="failed"]').waitFor()
      assert.equal(await page.getByRole("link", { name: "開啟原生 OpenCode Web", exact: true }).count(), 0)
      assert.equal(await page.getByRole("button", { name: "停止 Instance", exact: true }).isDisabled(), true)
      assert.deepEqual(startedDirectories, [])
      assert.deepEqual(resumedIds, [])
    })

    await t.test("backend atomic capacity refusal is translated even after a fresh available check", async () => {
      startRefusal = true
      await page.goto(origin)
      await page.getByRole("button", { name: "啟動 Instance", exact: true }).first().click()
      const panel = page.getByRole("dialog", { name: "啟動 Instance" })
      await panel.getByRole("button", { name: /Worker shortcut/ }).click()
      await panel.getByRole("button", { name: "啟動全新 Instance", exact: true }).click()
      await panel.getByRole("alert").getByText(/無法確認 Worker 目前執行環境容量/).waitFor()
      assert.doesNotMatch(await panel.getByRole("alert").innerText(), /internal execution detail/)
      assert.equal(apiEvents.includes("POST /api/v1/instances"), true)
    })

    await t.test("fresh capacity blocks mutations when availability changed after the UI enabled them", async () => {
      for (const state of ["occupied", "unknown"]) {
        await freshPage()
        capacity = { state: "available", maxInstances: 1 }
        instances = [{ ...instanceFixture("lost", "unreachable", true), recovery: { recheckAllowed: true, resumeAllowed: true, hideAllowed: true, removeAllowed: false } }]
        await page.goto(origin)
        await page.getByRole("button", { name: "啟動 Instance", exact: true }).first().click()
        const panel = page.getByRole("dialog", { name: "啟動 Instance" })
        await panel.getByRole("button", { name: /Worker shortcut/ }).click()
        await panel.getByRole("status").getByText("Worker 目前執行環境可用，可啟動或接續 Instance。", { exact: true }).waitFor()
        capacity = { state, maxInstances: 1 }
        const beforeStart = capacityRequests.length
        await panel.getByRole("button", { name: "啟動全新 Instance", exact: true }).click()
        await panel.getByRole("alert").waitFor()
        assert.ok(capacityRequests.length > beforeStart)
        assert.deepEqual(startedDirectories, [])
        assert.equal(await page.locator(".toast-error").count(), 0, "start errors belong only to the panel")
        const close = panel.getByRole("button", { name: "關閉啟動面板" })
        assert.equal(await close.evaluate(button => {
          const box = button.getBoundingClientRect()
          return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
        }), true)
        await panel.getByRole("alert").waitFor({ state: "visible" })
        await close.click()
        await panel.waitFor({ state: "hidden" })
        assert.equal(await page.locator(".toast-error").count(), 0)
        capacity = { state: "available", maxInstances: 1 }
        await page.goto(origin)
        await page.getByRole("button", { name: /Worker Project/ }).click()
        await page.getByText("Instance 操作", { exact: true }).click()
        await page.getByRole("button", { name: "接續對話", exact: true }).click()
        capacity = { state, maxInstances: 1 }
        const beforeResume = capacityRequests.length
        await page.getByRole("alertdialog").getByRole("button", { name: "接續對話", exact: true }).click()
        await page.locator(".lifecycle-error").waitFor()
        assert.ok(capacityRequests.length > beforeResume)
        assert.deepEqual(resumedIds, [])
      }
    })

    await t.test("Worker recheck, stop, history and resume retain their user workflow", async () => {
      instances = [{ ...instanceFixture("lost", "unreachable", true), recovery: { recheckAllowed: true, resumeAllowed: true, hideAllowed: true, removeAllowed: false } }]
      await page.goto(origin)
      await page.getByRole("button", { name: /Worker Project/ }).click()
      await page.getByText("Instance 操作", { exact: true }).click()
      await page.getByRole("button", { name: "重新檢查", exact: true }).click()
      const nativeLink = page.getByRole("link", { name: "開啟原生 OpenCode Web", exact: true })
      await nativeLink.waitFor()
      if (await page.getByRole("button", { name: "Instance 操作", exact: true }).getAttribute("aria-expanded") !== "true") await page.getByRole("button", { name: "Instance 操作", exact: true }).click()
      await page.getByRole("button", { name: "停止 Instance", exact: true }).click()
      await page.getByRole("alertdialog").getByRole("button", { name: "停止 Instance", exact: true }).click()
      await nativeLink.waitFor({ state: "hidden" })
      if (await page.getByRole("button", { name: "Instance 操作", exact: true }).getAttribute("aria-expanded") !== "true") await page.getByRole("button", { name: "Instance 操作", exact: true }).click()
      await page.getByRole("button", { name: "接續對話", exact: true }).click()
      await page.getByRole("alertdialog").getByRole("button", { name: "接續對話", exact: true }).click()
      await nativeLink.waitFor()
      await page.getByRole("button", { name: "返回列表", exact: true }).click()
      await page.getByRole("button", { name: /已停止紀錄/ }).click()
      await page.locator(".stopped-history").getByText("Saved work", { exact: true }).waitFor()
    })

    await t.test("Worker primary Session selection exposes its todo and preserves session-specific native navigation", async () => {
      instances = [instanceFixture("session-live")]
      await page.goto(origin)
      await page.getByRole("button", { name: /Worker Project/ }).click()
      const primary = page.getByRole("button", { name: "建立入口 Session", exact: true })
      await primary.waitFor()
      assert.equal(await page.locator(".primary-actions > :first-child").textContent(), "建立入口 Session")
      assert.equal(await page.locator(".advanced-sessions").getAttribute("open"), null)
      const beforeChooser = apiEvents.length
      await page.getByRole("button", { name: "選擇既有 Session", exact: true }).click()
      await page.getByRole("button", { name: "切換為入口 Session：Saved work", exact: true }).waitFor()
      assert.equal(await page.locator(".advanced-sessions").getAttribute("open"), "")
      assert.equal(await page.locator(".advanced-sessions > summary").evaluate(node => node === document.activeElement && node.getBoundingClientRect().top >= 0 && node.getBoundingClientRect().bottom <= innerHeight), true)
      assert.equal(apiEvents.slice(beforeChooser).some(event => /^(POST|PATCH|DELETE) /.test(event)), false)
      assert.equal(await page.getByRole("alertdialog").count(), 0)
      await page.getByRole("button", { name: "切換為入口 Session：Saved work", exact: true }).click()
      assert.equal(apiEvents.some(event => event === "POST /api/v1/instances/session-live/primary-session"), false)
      await page.getByRole("alertdialog").getByRole("button", { name: "切換", exact: true }).click()
      await page.getByRole("heading", { name: "Saved work", exact: true }).waitFor()
      await page.getByText("Verify Worker task", { exact: true }).waitFor()
      const popupPromise = page.context().waitForEvent("page")
      await page.getByRole("button", { name: "進入入口 Session", exact: true }).click()
      const popup = await popupPromise
      await popup.waitForURL("https://native.example.test/project/session/ses-root")
      await popup.close()
    })

    await t.test("Worker entry Session creation retains explicit confirmation and native provider access", async () => {
      instances = [instanceFixture("session-live")]
      await page.goto(origin)
      await page.getByRole("button", { name: /Worker Project/ }).click()
      const create = page.getByRole("button", { name: "建立入口 Session", exact: true })
      await create.click()
      assert.equal(apiEvents.some(event => event === "POST /api/v1/instances/session-live/sessions"), false)
      await page.getByRole("alertdialog").getByRole("button", { name: "取消", exact: true }).click()
      await page.getByRole("alertdialog").waitFor({ state: "hidden" })
      assert.equal(await create.evaluate(node => node === document.activeElement), true)
      await page.getByRole("link", { name: "開啟原生 OpenCode Web", exact: true }).waitFor()
      await page.getByText("Provider 登入與重新登入請在原生 OpenCode Web 中操作。", { exact: true }).waitFor()
      await create.click()
      const popupPromise = page.context().waitForEvent("page")
      await page.getByRole("alertdialog").getByRole("button", { name: "建立並開啟", exact: true }).click()
      const popup = await popupPromise
      await popup.waitForURL("https://native.example.test/project/session/ses-root")
      await page.getByRole("heading", { name: "Saved work", exact: true }).waitFor()
      assert.equal(apiEvents.filter(event => event === "POST /api/v1/instances/session-live/sessions").length, 1)
      await page.getByRole("button", { name: "進入入口 Session", exact: true }).waitFor()
      assert.equal(await create.count(), 0)
      await popup.close()
    })

    await t.test("Worker tracking can hide and restore an Instance without stopping it", async () => {
      instances = [instanceFixture("tracked", "unreachable", true)]
      await page.goto(origin)
      await page.getByRole("button", { name: /Worker Project/ }).click()
      await page.getByText("Instance 操作", { exact: true }).click()
      await page.getByRole("button", { name: "停止追蹤", exact: true }).click()
      await page.getByRole("checkbox", { name: "顯示已停止追蹤" }).check()
      await page.getByRole("button", { name: /Worker Project/ }).click()
      const actions = page.getByRole("button", { name: "Instance 操作", exact: true })
      if (await actions.getAttribute("aria-expanded") !== "true") await actions.click()
      await page.getByRole("button", { name: "恢復追蹤", exact: true }).click()
      await page.getByText("已恢復追蹤此 Instance。", { exact: true }).waitFor()
    })

    await t.test("missing, unsafe or prefixed native origins never produce a root link", async () => {
      instances = [instanceFixture("live")]
      for (const value of [undefined, "http://user:secret@native.example.test", "javascript:alert(1)", "https://native.example.test/prefix", "https://native.example.test/?token=private"]) {
        await freshPage()
        connectivity = { ...workerConnectivity, nativeWebOrigin: value }
        await page.goto(origin)
        await page.locator("#connectivity-title").filter({ hasText: /^Worker · 單機$/ }).waitFor({ state: "attached" })
        await page.getByRole("button", { name: /Worker Project/ }).click()
        assert.equal(await page.getByRole("link", { name: "開啟原生 OpenCode Web", exact: true }).count(), 0)
      }
      connectivity = { ...workerConnectivity, capabilities: { ...workerConnectivity.capabilities, nativeWeb: false } }
      await freshPage()
      await page.goto(origin)
      await page.getByRole("button", { name: /Worker Project/ }).click()
      assert.equal(await page.getByRole("link", { name: "開啟原生 OpenCode Web", exact: true }).count(), 0)
      await freshPage()
      connectivity = { ...workerConnectivity }
      delete connectivity.capabilities
      await page.goto(origin)
      await page.getByRole("button", { name: /Worker Project/ }).click()
      assert.equal(await page.getByRole("link", { name: "開啟原生 OpenCode Web", exact: true }).count(), 0)
    })

    await t.test("legacy loopback DTO without new optional fields retains credential and manager controls", async () => {
      connectivity = { ...workerConnectivity, mode: "loopback" }
      delete connectivity.capabilities
      delete connectivity.nativeWebOrigin
      await page.goto(origin)
      await page.getByRole("button", { name: "OMW 設定", exact: true }).click()
      const settings = page.getByRole("dialog", { name: "OMW 設定" })
      assert.equal(await settings.locator("input[type=password]").count(), 3)
      await settings.getByRole("button", { name: "停止 OMW", exact: true }).waitFor()
      assert.equal(await settings.getByText("Worker 帳密由部署設定管理。原生 Web 會由瀏覽器另行要求登入。", { exact: true }).count(), 0)
      assert.deepEqual(unsupportedRequests, [])
      await settings.getByRole("button", { name: "關閉 OMW 設定" }).click()
      await page.getByRole("button", { name: "啟動 Instance", exact: true }).first().click()
      const panel = page.getByRole("dialog", { name: "啟動 Instance" })
      await panel.getByRole("textbox", { name: "目錄捷徑名稱", exact: true }).waitFor()
      assert.equal(await panel.getByRole("textbox", { name: "目錄捷徑名稱", exact: true }).evaluate(node => node === document.activeElement), true)
      assert.equal(await panel.getByRole("button", { name: "新增捷徑", exact: true }).count(), 0)
      assert.equal(await panel.getByRole("button", { name: "重新檢查", exact: true }).count(), 0)
      assert.equal(await panel.getByRole("button", { name: "返回 Instance 清單", exact: true }).count(), 0)
      await panel.getByRole("button", { name: /Worker shortcut/ }).click()
      await panel.getByRole("button", { name: "啟動全新 Instance", exact: true }).click()
      await page.getByRole("heading", { name: "demo", exact: true }).waitFor()
      assert.deepEqual(startedDirectories, ["/projects/demo"])
      assert.deepEqual(capacityRequests, [], "Desktop must not call Worker capacity API")
    })
  } finally {
    await browser?.close()
    if (httpServer?.listening) await new Promise((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve()))
    await server?.close()
    await rm(profile, { recursive: true, force: true })
  }
})
