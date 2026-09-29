import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"
import { createServer } from "vite"

const enabled = process.env.OMW_BROWSER_TEST === "1" || process.env.npm_lifecycle_event === "test:browser:i18n"
const executablePath = process.env.OMW_BROWSER_EXECUTABLE
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("mobile i18n keeps primary/main/child semantics, user content and safe diagnostics", { skip: !enabled, timeout: 60_000 }, async () => {
  assert.ok(executablePath, "Set OMW_BROWSER_EXECUTABLE to an installed Chrome/Chromium executable")
  const profile = await mkdtemp(path.join(tmpdir(), "omw-i18n-browser-"))
  let server
  let browser
  try {
    // 監聽隨機本機 port，不佔用既有 dev server；本測試擁有並在 finally 關閉伺服器和 browser。
    server = await createServer({ root: webRoot, server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false } })
    await server.listen()
    const port = server.httpServer.address().port
    const origin = `http://127.0.0.1:${port}`
    await Promise.all(["AppData/Roaming", "AppData/Local", "Temp"].map(folder => mkdir(path.join(profile, folder), { recursive: true })))
    const env = Object.fromEntries(["SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "LANG", "LC_ALL"]
      .flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]]))
    browser = await chromium.launch({ executablePath, headless: true, env: {
      ...env, HOME: profile, USERPROFILE: profile, APPDATA: path.join(profile, "AppData/Roaming"),
      LOCALAPPDATA: path.join(profile, "AppData/Local"), TEMP: path.join(profile, "Temp"), TMP: path.join(profile, "Temp"),
    } })
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    const userTitle = "使用者的原始標題 Keep This"
    const userChild = "User Child Title 不翻譯"
    const userTodo = "Do not translate my todo text"
    const directory = "C:\\my Project\\原始路徑"
    const instanceId = "instance-a"
    let failOverview = false
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
        if (failOverview) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "INSTANCE_START_TIMEOUT", message: "Basic dXNlcjpwYXNz credential=secret" } }) })
        body = { shortcuts: [], instances: [instance] }
      } else if (request.pathname === "/api/v1/connectivity") {
        body = { checkedAt: "2025-01-02T00:00:00Z", mode: "loopback",
          manager: { localUrl: "http://127.0.0.1:40000", publicUrl: null },
          tailscale: { state: "unknown", dnsName: null, version: null },
          serve: { state: "not-configured", managerMapped: null, mappedInstancePorts: null, expectedInstancePorts: 1, funnel: "disabled" },
          registration: { state: "not-configured", trigger: null, diagnostic: null }, nodeVersion: "24" }
      } else if (request.pathname === `/api/v1/instances/${instanceId}/sessions`) {
        if (failSessions) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "INSTANCE_START_TIMEOUT", message: "Basic c2VjcmV0" } }) })
        body = { roots: [{ id: "ses-root", title: userTitle }], unknownParent: [] }
      } else if (request.pathname === `/api/v1/instances/${instanceId}/sessions/ses-root/children`) {
        body = { parentID: "ses-root", children: [{ id: "ses-child", title: userChild, parentID: "ses-root" }], loadedDirectChildren: 1 }
      } else if (request.pathname === `/api/v1/instances/${instanceId}/primary-todos`) {
        if (failTodos) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "INSTANCE_START_TIMEOUT", message: "Basic dXNlcjpwYXNz credential=secret" } }) })
        body = { instanceId, sessionId: "ses-root", todos: [{ content: userTodo, status: "pending", priority: "medium" }] }
      } else return route.fulfill({ status: 404 })
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) })
    })
    await page.goto(origin)
    await page.locator(`.instance-row[data-instance-id="${instanceId}"]`).waitFor()
    const normalButton = await page.locator(".topbar-actions .ui-button:first-child").boundingBox()
    assert.ok(normalButton && normalButton.width >= 320 && normalButton.height >= 44 && normalButton.height <= 80,
      `390px zh-TW launch action needs a readable row: ${JSON.stringify(normalButton)}`)
    await page.getByRole("button", { name: /User Project Name/ }).first().click()
    await page.locator(".primary-session-card strong").getByText(userTitle).waitFor()
    assert.equal(await page.locator(".primary-session-label").innerText(), "入口 Session")
    assert.equal(await page.locator(".detail-path").innerText(), directory)
    await page.getByText(userTodo, { exact: true }).waitFor()
    if (await page.locator(".advanced-sessions").getAttribute("open") === null) await page.locator(".advanced-sessions summary").click()
    await page.getByRole("heading", { name: "Main Session" }).waitFor()
    await page.locator(".main-session-list .tree-toggle").first().click()
    await page.getByText(userChild, { exact: true }).waitFor()
    assert.equal(await page.getByText("主 Session", { exact: false }).count(), 0)

    const longLocale = JSON.parse(await readFile(new URL("./long-test.locale.json", import.meta.url), "utf8"))
    const reordered = await page.evaluate(async messages => {
      const { i18n } = await import("/src/i18n.ts")
      i18n.global.setLocaleMessage("en-US", messages)
      i18n.global.locale.value = "en-US"
      return i18n.global.t("notification.body", { id: "xyz", count: 2 })
    }, longLocale)
    assert.equal(reordered, "共有 2 項待處理，請查看 Instance xyz")
    await page.getByRole("heading", { name: "Main Session" }).waitFor() // 測試 locale 缺少的 key 回退 zh-TW
    await page.getByRole("button", { name: "返回列表" }).click()
    await page.getByRole("button", { name: /為這個 Project 啟動一個全新的 Instance/ }).first().waitFor()
    await page.getByRole("group", { name: /請選擇需要顯示的 Instance 狀態/ }).waitFor()
    const dimensions = await page.locator(".topbar-actions .ui-button:first-child").evaluate(button => {
      const box = button.getBoundingClientRect()
      const range = document.createRange()
      const textNode = [...button.childNodes].find(node => node.nodeType === Node.TEXT_NODE)
      if (!textNode) return { height: box.height, clipped: true, documentWidth: document.documentElement.scrollWidth }
      range.selectNodeContents(textNode)
      return { width: box.width, height: box.height,
        listTop: document.querySelector(".instance-row")?.getBoundingClientRect().top,
        clipped: [...range.getClientRects()].some(line => line.top < box.top || line.bottom > box.bottom),
        documentWidth: document.documentElement.scrollWidth }
    })
    assert.ok(dimensions.height >= 44, `touch target: ${JSON.stringify(dimensions)}`)
    assert.ok(dimensions.width >= 320 && dimensions.height <= 144, `long locale launch action needs a readable row: ${JSON.stringify(dimensions)}`)
    assert.ok(dimensions.listTop < 844, `first Instance must remain in the first viewport: ${JSON.stringify(dimensions)}`)
    assert.equal(dimensions.clipped, false, `long locale clipped: ${JSON.stringify(dimensions)}`)
    assert.ok(dimensions.documentWidth <= 390, `horizontal overflow: ${JSON.stringify(dimensions)}`)

    await page.evaluate(async () => { const { i18n } = await import("/src/i18n.ts"); i18n.global.locale.value = "zh-TW" })
    instance.error = "INSTANCE_START_TIMEOUT"
    instance.primarySummary = { ...instance.primarySummary, activity: "unknown", error: "INSTANCE_START_TIMEOUT" }
    failTodos = true
    await page.getByRole("button", { name: "啟動 Instance" }).first().waitFor()
    await page.getByRole("button", { name: "重新整理" }).click()
    await page.getByRole("button", { name: /User Project Name/ }).first().click()
    const knownFailure = "Instance 啟動逾時，請先重新整理確認狀態再操作。"
    await page.locator(".primary-todos-error").getByText(knownFailure).waitFor()
    assert.equal(await page.locator(".inline-error").getByText(knownFailure).count(), 2)
    await page.locator(".primary-todos-error details summary").click()
    await page.locator(".primary-todos-error").getByText("錯誤代碼：INSTANCE_START_TIMEOUT").waitFor()
    assert.equal(await page.getByText("Basic dXNlcjpwYXNz credential=secret").count(), 0)
    failSessions = true
    if (await page.locator(".advanced-sessions").getAttribute("open") === null) await page.locator(".advanced-sessions summary").click()
    await page.locator(".advanced-sessions").getByRole("button", { name: "重新整理" }).click()
    await page.locator(".advanced-sessions .inline-error").getByText(knownFailure).waitFor()

    await page.locator(".lifecycle-trigger").click()
    await page.getByRole("button", { name: "停止 Instance" }).click()
    const confirmation = page.getByRole("alertdialog")
    await confirmation.getByText("停止整個 Instance？").waitFor()
    const updatedLocale = { ...longLocale, error: { ...longLocale.error, startTimeout: "Please refresh Instance state before retrying" }, confirm: { stopTitle: "Stop this Instance?", stopDescription: "Stop Instance {id} now?", stopAction: "Stop Instance now" } }
    await page.evaluate(async messages => { const { i18n } = await import("/src/i18n.ts"); i18n.global.setLocaleMessage("en-US", messages); i18n.global.locale.value = "en-US" }, updatedLocale)
    await confirmation.getByText("Stop this Instance?").waitFor()
    assert.equal(await confirmation.locator(".confirmation-description").innerText(), "Stop Instance instance now?")
    await page.locator(".primary-todos-error").getByText("Please refresh Instance state before retrying").waitFor()
    await page.locator(".advanced-sessions .inline-error").getByText("Please refresh Instance state before retrying").waitFor()
    assert.equal(await page.getByText("Basic c2VjcmV0").count(), 0)
    await page.evaluate(async () => { const { i18n } = await import("/src/i18n.ts"); i18n.global.locale.value = "zh-TW" })
    await confirmation.getByText("停止整個 Instance？").waitFor()
    await confirmation.getByRole("button", { name: "取消" }).click()
    await confirmation.waitFor({ state: "hidden" })
    await page.getByRole("button", { name: "返回列表" }).click()

    failOverview = true
    await page.getByRole("button", { name: "啟動 Instance" }).first().waitFor()
    await page.getByRole("button", { name: "重新整理" }).click()
    const details = page.locator(".overview-freshness details")
    await details.waitFor()
    assert.equal(await page.getByText("Basic dXNlcjpwYXNz credential=secret").count(), 0)
    await details.locator("summary").click()
    await details.getByText("錯誤代碼：INSTANCE_START_TIMEOUT").waitFor()
    assert.equal(await page.getByText("Basic dXNlcjpwYXNz credential=secret").count(), 0)
  } finally {
    await browser?.close()
    await server?.close()
    await rm(profile, { recursive: true, force: true })
  }
})
