import assert from "node:assert/strict"
import { createReadStream } from "node:fs"
import { mkdir, stat } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { chromium } from "playwright-core"

const worktree = path.resolve(import.meta.dirname, "../..")
const webRoot = path.join(worktree, "apps/web/dist")
const imageRoot = path.join(worktree, "docs/images")
const executablePath = process.env.OMW_BROWSER_EXECUTABLE
if (!executablePath) {
  throw new Error("OMW_BROWSER_EXECUTABLE must be set to an installed browser executable path")
}
const watchdogMs = 25_000

const instance = {
  id: "inst-issue11-acceptance",
  kind: "headless",
  projectName: "issue11-onboarding",
  projectDirectory: "C:\\acceptance\\issue11-onboarding",
  state: "ready",
  endpoint: "http://127.0.0.1:49999",
  port: 49_999,
  pid: 10_011,
  launchedAt: "2026-09-20T01:00:00.000Z",
  healthVersion: "acceptance-fixture",
  stopAllowed: true,
  remoteUrlUnavailableReason: null,
  error: null,
  summary: {
    activity: "reported-non-busy",
    busySessions: 0,
    pendingQuestions: 0,
    pendingPermissions: 0,
    error: null,
  },
  sessions: [{ id: "ses-issue11-root", title: "Fixture planning session" }],
  primarySession: {
    sessionId: "ses-issue11-root",
    title: "Fixture planning session",
    source: "activity",
    boundAt: "2026-09-20T01:00:00.000Z",
  },
  trackingHidden: false,
  recovery: { recheckAllowed: false, resumeAllowed: false, hideAllowed: false, removeAllowed: false },
}

const connectivity = {
  checkedAt: "2026-09-20T01:00:00.000Z",
  mode: "loopback",
  manager: { localUrl: "http://127.0.0.1:4174", publicUrl: null },
  tailscale: { state: "unavailable", dnsName: null, version: null },
  serve: {
    state: "not-configured",
    managerMapped: null,
    mappedInstancePorts: null,
    expectedInstancePorts: 1,
    funnel: "disabled",
  },
  nodeVersion: process.version,
}

function contentType(filePath) {
  return {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
  }[path.extname(filePath)] ?? "application/octet-stream"
}

async function startStaticServer() {
  await stat(path.join(webRoot, "index.html"))
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname)
      const requestedPath = pathname === "/" ? "index.html" : pathname.slice(1)
      const filePath = path.resolve(webRoot, requestedPath)
      if (!filePath.startsWith(`${webRoot}${path.sep}`) && filePath !== webRoot) {
        response.writeHead(403).end()
        return
      }
      const file = await stat(filePath)
      if (!file.isFile()) throw new Error("not a file")
      response.writeHead(200, { "content-type": contentType(filePath) })
      createReadStream(filePath).pipe(response)
    } catch {
      response.writeHead(404).end()
    }
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === "object")
  return { server, origin: `http://127.0.0.1:${address.port}` }
}

function browserEnvironment() {
  const allowed = [
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATH",
    "PATHEXT",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "LANG",
    "LC_ALL",
  ]
  return Object.fromEntries(allowed.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]))
}

function withDeadline(promise, timeoutMs, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs)
    }),
  ]).finally(() => clearTimeout(timer))
}

async function closeStaticServer(server) {
  server.closeAllConnections()
  await withDeadline(new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  }), 3_000, "static server close")
}

async function runUiAcceptance(page, origin, calls) {
  const missingRoutes = []
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const call = {
      method: request.method(),
      path: url.pathname,
      body: request.postData() === null ? undefined : request.postDataJSON(),
      csrf: request.headers()["x-omw-csrf"],
    }
    calls.push(call)

    if (call.method === "GET" && call.path === "/api/v1/overview") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ shortcuts: [], instances: [instance] }) })
      return
    }
    if (call.method === "GET" && call.path === "/api/v1/connectivity") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(connectivity) })
      return
    }
    if (call.method === "GET" && call.path === `/api/v1/instances/${instance.id}/sessions`) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ roots: instance.sessions, unknownParent: [] }) })
      return
    }
    if (call.method === "GET" && call.path === "/api/v1/directories" && url.searchParams.get("path") === instance.projectDirectory) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ current: instance.projectDirectory, parent: "C:\\acceptance", children: [], errors: [] }),
      })
      return
    }
    if (call.method === "PATCH" && call.path === "/api/v1/settings/credentials") {
      await route.fulfill({ status: 204 })
      return
    }
    if (call.method === "POST" && call.path === "/api/v1/manager/shutdown") {
      await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ stopping: true }) })
      return
    }

    missingRoutes.push(`${call.method} ${call.path}`)
    await route.fulfill({
      status: 501,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "FIXTURE_ROUTE_MISSING", message: `${call.method} ${call.path}` } }),
    })
  })

  await page.goto(origin, { waitUntil: "networkidle" })
  await page.locator(".instance-row").waitFor()

  await page.locator(".topbar").getByRole("button", { name: "啟動執行個體" }).click()
  const startPanel = page.getByRole("dialog", { name: "啟動執行個體" })
  await startPanel.waitFor()
  await startPanel.getByLabel("瀏覽目錄").fill(instance.projectDirectory)
  const directoryResponse = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return response.request().method() === "GET"
      && url.pathname === "/api/v1/directories"
      && url.searchParams.get("path") === instance.projectDirectory
  })
  await startPanel.getByRole("button", { name: "瀏覽" }).click()
  assert.equal((await directoryResponse).status(), 200)
  await startPanel.getByRole("button", { name: "啟動全新 Instance" }).waitFor()
  assert.equal(calls.filter((call) => call.method === "POST" && call.path === "/api/v1/instances").length, 0)
  await page.screenshot({ path: path.join(imageRoot, "issue11-start-instance-panel-desktop.png") })
  await startPanel.getByRole("button", { name: "關閉啟動面板" }).click()
  await startPanel.waitFor({ state: "hidden" })

  await page.getByRole("button", { name: "OMW 設定" }).click()
  const settings = page.getByRole("dialog", { name: "OMW 設定" })
  await settings.waitFor()
  await settings.getByLabel("帳號").fill("omw-rotated")
  await settings.getByLabel("目前密碼").fill("acceptance-current-password")
  await settings.getByLabel("新密碼（至少 16 字元）").fill("acceptance-new-password-2026")
  await settings.getByLabel("再次輸入新密碼").fill("acceptance-new-password-2026")
  const credentialResponse = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return response.request().method() === "PATCH" && url.pathname === "/api/v1/settings/credentials"
  })
  await settings.getByRole("button", { name: "更新帳密" }).click()
  assert.equal((await credentialResponse).status(), 204)
  await page.getByRole("status").filter({ hasText: "OMW 帳密已更新" }).waitFor()
  assert.equal(await settings.getByLabel("目前密碼").inputValue(), "")
  assert.equal(await settings.getByLabel("新密碼（至少 16 字元）").inputValue(), "")
  assert.equal(await settings.getByLabel("再次輸入新密碼").inputValue(), "")
  await page.screenshot({ path: path.join(imageRoot, "issue11-credential-rotation-success-desktop.png") })
  await page.getByRole("button", { name: "關閉成功通知" }).click()
  await page.locator(".toast-success").waitFor({ state: "hidden" })

  await settings.getByRole("button", { name: "關閉 OMW 設定" }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator(".instance-pane").waitFor()
  assert.equal(await page.locator(".detail-pane").isVisible(), false)
  const mobileGeometry = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    mobileView: document.querySelector(".app-root")?.getAttribute("data-mobile-view"),
  }))
  assert.equal(mobileGeometry.mobileView, "list")
  assert.equal(mobileGeometry.scrollWidth <= mobileGeometry.clientWidth, true, "mobile viewport has horizontal overflow")
  await page.locator(".instance-row").first().click()
  await page.locator('.app-root[data-mobile-view="detail"] .detail-pane').waitFor()
  assert.equal(await page.getByRole("button", { name: "返回列表" }).isVisible(), true)
  await page.screenshot({ path: path.join(imageRoot, "issue11-mobile-detail.png") })
  await page.getByRole("button", { name: "返回列表" }).click()
  await page.locator('.app-root[data-mobile-view="list"] .instance-pane').waitFor()
  assert.equal(await page.locator(".detail-pane").isVisible(), false)
  await page.screenshot({ path: path.join(imageRoot, "issue11-mobile-overview.png") })

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole("button", { name: "OMW 設定" }).click()
  await page.getByRole("dialog", { name: "OMW 設定" }).getByRole("button", { name: "停止 OMW" }).click()
  const confirmation = page.getByRole("alertdialog", { name: "停止 OMW Manager？" })
  await confirmation.waitFor()
  assert.match(await confirmation.textContent() ?? "", /OpenCode TUI.*Sessions.*Project/s)
  await page.screenshot({ path: path.join(imageRoot, "issue11-stop-manager-confirmation-desktop.png") })
  const shutdownResponse = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return response.request().method() === "POST" && url.pathname === "/api/v1/manager/shutdown"
  })
  await confirmation.getByRole("button", { name: "只停止 OMW" }).click()
  assert.equal((await shutdownResponse).status(), 202)
  await page.locator(".manager-stopped").waitFor()
  assert.match(await page.locator(".manager-stopped").textContent() ?? "", /OpenCode TUI.*背景執行個體.*Sessions.*Project/s)
  await page.screenshot({ path: path.join(imageRoot, "issue11-stop-manager-result-desktop.png") })

  const credentialCalls = calls.filter((call) => call.method === "PATCH" && call.path === "/api/v1/settings/credentials")
  const shutdownCalls = calls.filter((call) => call.method === "POST" && call.path === "/api/v1/manager/shutdown")
  assert.equal(credentialCalls.length, 1)
  assert.deepEqual(credentialCalls[0].body, {
    currentPassword: "acceptance-current-password",
    username: "omw-rotated",
    password: "acceptance-new-password-2026",
  })
  assert.equal(credentialCalls[0].csrf, "1")
  assert.equal(shutdownCalls.length, 1)
  assert.deepEqual(shutdownCalls[0].body, {})
  assert.equal(shutdownCalls[0].csrf, "1")
  assert.deepEqual(missingRoutes, [], `mock API route missing: ${missingRoutes.join(", ")}`)
  return {
    credentialCalls: credentialCalls.length,
    shutdownCalls: shutdownCalls.length,
    startInstancePostsBeforeScreenshot: 0,
    mobileNavigation: ["list", "detail", "list"],
    mobileGeometry,
  }
}

async function main() {
  await mkdir(imageRoot, { recursive: true })
  const { server, origin } = await startStaticServer()
  let browserServer
  let browserContext
  let watchdogTimer
  let watchdogFired = false
  let closeFallbackUsed = false
  const calls = []
  let downstreamResult = null
  let lifecycleStatus = "planned"
  let primaryError
  let cleanupError

  try {
    browserServer = await chromium.launchServer({ executablePath, headless: true, env: browserEnvironment() })
    const browser = await chromium.connect(browserServer.wsEndpoint())
    browserContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", baseURL: origin })
    const page = await browserContext.newPage()
    const acceptance = runUiAcceptance(page, origin, calls)
    acceptance.catch(() => {})
    const watchdog = new Promise((_, reject) => {
      watchdogTimer = setTimeout(() => {
        watchdogFired = true
        reject(new Error(`acceptance watchdog exceeded ${watchdogMs}ms`))
      }, watchdogMs)
    })
    downstreamResult = await Promise.race([acceptance, watchdog])
  } catch (error) {
    primaryError = error
    downstreamResult = { status: "failed", message: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(watchdogTimer)
    await withDeadline(browserContext?.close() ?? Promise.resolve(), 3_000, "browser context close").catch(() => {})
    if (browserServer) {
      try {
        await withDeadline(browserServer.close(), 5_000, "BrowserServer close")
      } catch {
        closeFallbackUsed = true
        try {
          await withDeadline(browserServer.kill(), 5_000, "BrowserServer kill")
        } catch (error) {
          cleanupError = error
        }
      }
      lifecycleStatus = cleanupError ? "unresolved" : "stopped"
    }
    try {
      await closeStaticServer(server)
    } catch (error) {
      cleanupError ??= error
    }
    console.log(JSON.stringify({
      applicable: true,
      platform: "Windows",
      selected_tier: "external-launcher",
      owner_binding: { kind: "official-interface-current-run" },
      action: "Finalize",
      final_disposition: { requested: "Stop", status: lifecycleStatus },
      watchdog_fired: watchdogFired,
      close_fallback_used: closeFallbackUsed,
      os_inspection_performed: false,
      lifecycle_shell_calls: [],
      lifecycle_result: { status: lifecycleStatus },
      downstream_result: downstreamResult,
      minimum_outcomes: {
        ownership_binding: "owner handled",
        stdio: "owner handled",
        readiness: "owner handled",
        observation: "owner handled",
        disposition: "owner handled",
        cleanup_or_handoff: "owner handled",
        lifecycle_callback: "owner handled",
      },
    }, null, 2))
  }
  if (cleanupError) throw cleanupError
  if (primaryError) throw primaryError
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
