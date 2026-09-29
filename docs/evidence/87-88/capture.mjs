// 可重現的唯讀視覺證據；配合 apps/web/test/i18n.browser.test.mjs 的 mock 狀態使用。
// 從 repository root 執行：OMW_BROWSER_EXECUTABLE=<Chrome path> node docs/evidence/87-88/capture.mjs
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"
import { createServer } from "vite"

const executablePath = process.env.OMW_BROWSER_EXECUTABLE
assert.ok(executablePath, "Set OMW_BROWSER_EXECUTABLE to an installed Chrome/Chromium executable")
const webRoot = fileURLToPath(new URL("../../../apps/web/", import.meta.url))
const image = name => fileURLToPath(new URL(`./${name}.png`, import.meta.url))
const profile = await mkdtemp(path.join(tmpdir(), "omw-i18n-evidence-"))
let server
let browser
try {
  server = await createServer({ root: webRoot, server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false } })
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  await Promise.all(["AppData/Roaming", "AppData/Local", "Temp"].map(folder => mkdir(path.join(profile, folder), { recursive: true })))
  const env = Object.fromEntries(["SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "LANG", "LC_ALL"]
    .flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]]))
  browser = await chromium.launch({ executablePath, headless: true, env: {
    ...env, HOME: profile, USERPROFILE: profile, APPDATA: path.join(profile, "AppData/Roaming"),
    LOCALAPPDATA: path.join(profile, "AppData/Local"), TEMP: path.join(profile, "Temp"), TMP: path.join(profile, "Temp"),
  } })
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  const instanceId = "instance-a"
  const userTitle = "使用者的原始標題 Keep This"
  const userChild = "User Child Title 不翻譯"
  const userTodo = "Do not translate my todo text"
  const directory = "C:\\my Project\\原始路徑"
  const hiddenDiagnostic = "do-not-display-runtime-diagnostic"
  let failTodos = false
  let failSessions = false
  const instance = {
    id: instanceId, kind: "headless", projectName: "User Project Name", projectDirectory: directory,
    state: "ready", endpoint: "http://127.0.0.1:40001", port: 40001, pid: 12345,
    launchedAt: "2025-01-02T00:00:00Z", healthVersion: "1.0", stopAllowed: true,
    remoteUrlUnavailableReason: null, error: null, trackingHidden: false,
    recovery: { recheckAllowed: true, resumeAllowed: false, hideAllowed: true, removeAllowed: false },
    summary: { activity: "busy", busySessions: 1, pendingQuestions: 0, pendingPermissions: 0, error: null },
    primarySummary: { scope: "known", activity: "busy", busySessions: 1, retrySessions: 0, pendingQuestions: 0, pendingPermissions: 0, error: null },
    sessions: [], primarySession: { sessionId: "ses-root", title: userTitle, source: "manual", boundAt: "2025-01-02T00:00:00Z" },
  }
  await page.route("**/api/v1/**", route => {
    const request = new URL(route.request().url())
    let body
    if (request.pathname === "/api/v1/overview") {
      body = { shortcuts: [], instances: [instance] }
    } else if (request.pathname === "/api/v1/connectivity") {
      body = { checkedAt: "2025-01-02T00:00:00Z", mode: "loopback",
        manager: { localUrl: "http://127.0.0.1:40000", publicUrl: null },
        tailscale: { state: "unknown", dnsName: null, version: null },
        serve: { state: "not-configured", managerMapped: null, mappedInstancePorts: null, expectedInstancePorts: 1, funnel: "disabled" },
        registration: { state: "not-configured", trigger: null, diagnostic: null }, nodeVersion: "24" }
    } else if (request.pathname === `/api/v1/instances/${instanceId}/sessions`) {
      if (failSessions) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "INSTANCE_START_TIMEOUT", message: hiddenDiagnostic } }) })
      body = { roots: [{ id: "ses-root", title: userTitle }], unknownParent: [] }
    } else if (request.pathname === `/api/v1/instances/${instanceId}/sessions/ses-root/children`) {
      body = { parentID: "ses-root", children: [{ id: "ses-child", title: userChild, parentID: "ses-root" }], loadedDirectChildren: 1 }
    } else if (request.pathname === `/api/v1/instances/${instanceId}/primary-todos`) {
      if (failTodos) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "INSTANCE_START_TIMEOUT", message: hiddenDiagnostic } }) })
      body = { instanceId, sessionId: "ses-root", todos: [{ content: userTodo, status: "pending", priority: "medium" }] }
    } else return route.fulfill({ status: 404 })
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) })
  })

  await page.goto(origin)
  await page.locator(`.instance-row[data-instance-id="${instanceId}"]`).waitFor()
  const normalButton = await page.locator(".topbar-actions .ui-button:first-child").boundingBox()
  assert.ok(normalButton && normalButton.width >= 320 && normalButton.height >= 44 && normalButton.height <= 80,
    `390px zh-TW launch action: ${JSON.stringify(normalButton)}`)
  await page.getByRole("button", { name: /User Project Name/ }).first().click()
  await page.locator(".primary-session-card strong").getByText(userTitle).waitFor()
  assert.equal(await page.locator(".primary-session-label").innerText(), "入口 Session")
  assert.equal(await page.locator(".detail-path").innerText(), directory)
  await page.getByText(userTodo, { exact: true }).waitFor()
  if (await page.locator(".advanced-sessions").getAttribute("open") === null) await page.locator(".advanced-sessions summary").click()
  await page.getByRole("heading", { name: "Main Session" }).waitFor()
  await page.locator(".main-session-list .tree-toggle").first().click()
  await page.getByText(userChild, { exact: true }).waitFor()
  await page.screenshot({ path: image("main-child-user-data-390"), fullPage: true })

  const longLocale = JSON.parse(await readFile(new URL("../../../apps/web/test/long-test.locale.json", import.meta.url), "utf8"))
  const reordered = await page.evaluate(async messages => {
    const { i18n } = await import("/src/i18n.ts")
    i18n.global.setLocaleMessage("en-US", messages)
    i18n.global.locale.value = "en-US"
    return i18n.global.t("notification.body", { id: "xyz", count: 2 })
  }, longLocale)
  assert.equal(reordered, "共有 2 項待處理，請查看 Instance xyz")
  await page.getByRole("button", { name: "返回列表" }).click()
  await page.getByRole("button", { name: /為這個 Project 啟動一個全新的 Instance/ }).first().waitFor()
  await page.getByRole("group", { name: /請選擇需要顯示的 Instance 狀態/ }).waitFor()
  const dimensions = await page.getByRole("button", { name: /為這個 Project 啟動一個全新的 Instance/ }).first().evaluate(button => {
    const box = button.getBoundingClientRect()
    const lines = []
    const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      if (!walker.currentNode.textContent.trim()) continue
      const range = document.createRange()
      range.selectNodeContents(walker.currentNode)
      lines.push(...range.getClientRects())
    }
    return { height: box.height, width: box.width, lines: lines.length,
      listTop: document.querySelector(".instance-row")?.getBoundingClientRect().top,
      clipped: lines.length === 0 || lines.some(line => line.top < box.top || line.bottom > box.bottom),
      documentWidth: document.documentElement.scrollWidth }
  })
  assert.ok(dimensions.width >= 320 && dimensions.height >= 44 && dimensions.height <= 144 && dimensions.listTop < 844
    && dimensions.lines > 0 && !dimensions.clipped && dimensions.documentWidth <= 390,
    `390px button: ${JSON.stringify(dimensions)}`)
  await page.screenshot({ path: image("long-button-390"), fullPage: true })
  console.log(`390px_zhTW_button=${JSON.stringify(normalButton)} 390px_long_button=${JSON.stringify(dimensions)} parameter_reordering=pass`)

  await page.evaluate(async () => { const { i18n } = await import("/src/i18n.ts"); i18n.global.locale.value = "zh-TW" })
  failTodos = true
  await page.getByRole("button", { name: "啟動 Instance" }).first().waitFor()
  await page.getByRole("button", { name: "重新整理" }).click()
  await page.getByRole("button", { name: /User Project Name/ }).first().click()
  const knownFailure = "Instance 啟動逾時，請先重新整理確認狀態再操作。"
  await page.locator(".primary-todos-error").getByText(knownFailure).waitFor()
  await page.locator(".primary-todos-error details summary").click()
  await page.locator(".primary-todos-error").getByText("錯誤代碼：INSTANCE_START_TIMEOUT").waitFor()
  failSessions = true
  if (await page.locator(".advanced-sessions").getAttribute("open") === null) await page.locator(".advanced-sessions summary").click()
  await page.locator(".advanced-sessions").getByRole("button", { name: "重新整理" }).click()
  await page.locator(".advanced-sessions .inline-error").getByText(knownFailure).waitFor()
  const sessionDetails = page.locator(".advanced-sessions .inline-error details")
  await sessionDetails.locator("summary").click()
  await sessionDetails.getByText("錯誤代碼：INSTANCE_START_TIMEOUT").waitFor()
  assert.equal(await page.getByText(hiddenDiagnostic).count(), 0, "untrusted freeform diagnostic must not render")
  await page.screenshot({ path: image("safe-error-details-390"), fullPage: true })
  console.log("entry_main_child_user_content=pass known_error_code_visible=pass freeform_diagnostic_hidden=pass")
} finally {
  const cleanup = await Promise.allSettled([browser?.close(), server?.close()])
  await rm(profile, { recursive: true, force: true })
  assert.ok(cleanup.every(result => result.status === "fulfilled"), "browser and Vite cleanup must both succeed")
  console.log("owned_browser_server_profile_cleanup=completed")
}
