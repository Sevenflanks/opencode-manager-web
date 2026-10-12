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
const observed = "2026-10-02T00:00:00Z"
function connectivity(mode = "worker") {
  return {
    checkedAt: observed, mode,
    capabilities: { launcher: false, tailscale: false, credentialUpdate: false, managerShutdown: false, maxInstances: 2, nativeWeb: true },
    nativeWebOrigin: "https://native.example.test",
    manager: { localUrl: "http://127.0.0.1:4174", publicUrl: null },
    tailscale: { state: "unavailable", dnsName: null, version: null },
    serve: { state: "not-configured", managerMapped: null, mappedInstancePorts: null, expectedInstancePorts: 0, funnel: "unknown" },
    registration: { state: "not-configured", trigger: null, diagnostic: null }, nodeVersion: "24",
  }
}
function worker(id, health = "online", kind = "resident") {
  return { id, generation: `gen/${id}`, name: `Worker ${id}`, kind, health, registeredAt: observed,
    lastCheckedAt: observed, lastHealthyAt: health === "connecting" ? null : observed,
    consecutiveFailures: health === "online" ? 0 : 3, endedAt: kind === "task" && health === "offline" ? observed : null,
    dataUpdatedAt: health === "connecting" ? null : observed, freshness: health === "online" ? "fresh" : health === "connecting" ? "unknown" : "stale",
    instanceCount: health === "connecting" ? null : 1, capacity: health === "online" ? { state: "available", maxInstances: 2 } : null,
    diagnosticCode: health === "online" ? null : "WORKER_HEALTH_UNAVAILABLE", address: "10.0.0.2", nativeOrigin: `https://${id.toLowerCase()}.native.example.test` }
}
function instance(workerId, id = "same-id") {
  return { id, kind: "headless", projectName: `Project ${workerId}`, projectDirectory: `/projects/${workerId}`, state: "ready",
    endpoint: "http://execution:4096", port: 4096, pid: 123, launchedAt: observed, healthVersion: "1.2.27", stopAllowed: true,
    error: null, remoteUrlUnavailableReason: null, trackingHidden: false,
    recovery: { recheckAllowed: true, resumeAllowed: false, hideAllowed: true, removeAllowed: false },
    summary: { activity: "busy", busySessions: 1, pendingQuestions: 1, pendingPermissions: 2, error: null },
    primarySummary: { scope: "known", activity: "busy", busySessions: 1, retrySessions: 0, pendingQuestions: 1, pendingPermissions: 2, error: null },
    sessions: [], primarySession: { sessionId: "ses-root", title: `Saved ${workerId}`, source: "manual", boundAt: observed } }
}
function overview() {
  const workers = [worker("A"), worker("B"), worker("unstable", "unstable"), worker("resident", "offline"), worker("task", "offline", "task"), worker("initial", "connecting")]
  return { checkedAt: observed, workers, instances: workers.filter(item => item.health !== "connecting").map(item => ({
    workerId: item.id, generation: item.generation, workerName: item.name, freshness: item.freshness, observedAt: observed, instance: instance(item.id),
  })) }
}

test("Coordinator real Vue UI fences Worker executions and retains truthful collected data", { skip: !enabled, timeout: 120_000 }, async t => {
  assert.ok(process.env.OMW_BROWSER_EXECUTABLE, "Set OMW_BROWSER_EXECUTABLE to installed Chrome/Chromium")
  const profile = await mkdtemp(path.join(tmpdir(), "omw-coordinator-browser-"))
  let server, httpServer, browser, page
  const holds = []
  try {
    // 當次 owner handles：隨機 HTTP port / 隔離 Chrome profile；finally 停止全部 owned resources。
    server = await createServer({ root: webRoot, server: { middlewareMode: true, hmr: false } })
    httpServer = createHttpServer(server.middlewares)
    await new Promise((resolve, reject) => { httpServer.once("error", reject); httpServer.listen(0, "127.0.0.1", resolve) })
    const origin = `http://127.0.0.1:${httpServer.address().port}`
    await Promise.all(["AppData/Roaming", "AppData/Local", "Temp"].map(folder => mkdir(path.join(profile, folder), { recursive: true })))
    const env = Object.fromEntries(["SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "LANG", "LC_ALL"]
      .flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]]))
    browser = await chromium.launch({ executablePath: process.env.OMW_BROWSER_EXECUTABLE, headless: true, env: { ...env,
      HOME: profile, USERPROFILE: profile, APPDATA: path.join(profile, "AppData/Roaming"), LOCALAPPDATA: path.join(profile, "AppData/Local"), TEMP: path.join(profile, "Temp"), TMP: path.join(profile, "Temp") } })
    let snapshot, rootMode, modeFailure, overviewFailure, sessionHold, overviewHold, wrongNative
    const mutations = [], reads = [], checks = [], errors = []
    function hold() { let release; const promise = new Promise(resolve => { release = resolve }); holds.push(release); return { promise, release } }
    async function routeApi(route) {
      const request = route.request(), url = new URL(request.url())
      if (url.pathname === "/api/v1/connectivity") {
        if (modeFailure) return route.fulfill({ status: 503, json: { error: { code: "HTTP_ERROR", message: "secret must not render" } } })
        return route.fulfill({ json: connectivity(rootMode) })
      }
      if (url.pathname === "/api/v1/coordinator/overview") {
        const response = structuredClone(snapshot)
        if (overviewHold) { const pending = overviewHold; overviewHold = null; await pending.promise }
        if (overviewFailure) return route.fulfill({ status: 503, json: { error: { code: "HTTP_ERROR", message: "secret must not render" } } })
        return route.fulfill({ json: response }).catch(() => {})
      }
      const scoped = url.pathname.match(/^\/api\/v1\/coordinator\/workers\/([^/]+)\/([^/]+)\/(check|proxy)(.*)$/)
      if (scoped?.[3] === "check") {
        checks.push([decodeURIComponent(scoped[1]), decodeURIComponent(scoped[2])])
        assert.equal(request.headers()["x-omw-csrf"], "1")
        return route.fulfill({ json: snapshot })
      }
      const id = scoped ? decodeURIComponent(scoped[1]) : "local"
      const generation = scoped ? decodeURIComponent(scoped[2]) : "local"
      const apiPath = scoped ? scoped[4] : url.pathname
      if (request.method() !== "GET") mutations.push({ id, generation, path: apiPath, body: request.postData(), authorization: request.headers().authorization })
      else reads.push({ id, generation, path: apiPath })
      let payload
      if (apiPath === "/api/v1/connectivity") payload = { ...connectivity(), nativeWebOrigin: `https://${id.toLowerCase()}.native.example.test` }
      else if (apiPath === "/api/v1/worker/capacity") payload = { state: "available", maxInstances: 2 }
      else if (apiPath === "/api/v1/overview") payload = { shortcuts: [], instances: [instance(id, "other-id"), instance(id)], history: { total: 0, revision: "0" } }
      else if (apiPath === "/api/v1/instances/history") payload = { instances: [], total: 0, nextOffset: null, revision: "0" }
      else if (apiPath.endsWith("/primary-todos")) payload = { instanceId: apiPath.split("/").at(-2), sessionId: "ses-root", todos: [{ content: `Verify ${id}`, status: "pending", priority: "high" }] }
      else if (apiPath.endsWith("/sessions")) {
        if (sessionHold && id === "A") { const pending = sessionHold; sessionHold = null; await pending.promise }
        payload = { roots: [{ id: "ses-root", title: `Session ${id}` }], unknownParent: [] }
      } else if (apiPath.endsWith("/open-url")) payload = { instanceId: "same-id", sessionId: "ses-root", url: `https://${wrongNative ? "a" : id.toLowerCase()}.native.example.test/project/session/ses-root` }
      else if (apiPath.endsWith("/stop")) payload = { ...instance(id), state: "stopped", stopAllowed: false }
      else if (apiPath.endsWith("/directories")) payload = { current: url.searchParams.get("path"), parent: null, children: [], errors: [] }
      else if (apiPath === "/api/v1/instances" && request.method() === "POST") payload = instance(id, "started")
      else if (/^\/api\/v1\/instances\/[^/]+$/.test(apiPath)) payload = instance(id, apiPath.split("/").at(-1))
      else return route.fulfill({ status: 404 })
      return route.fulfill({ json: payload }).catch(() => {})
    }
    const aggregateRow = id => page.locator(`.coordinator-instance[data-worker-id="${id}"]`)
    const workerCard = id => page.locator(`.coordinator-worker[data-worker-id="${id}"]`)
    const open = async id => { await aggregateRow(id).getByRole("button", { name: "查看詳情" }).click(); await page.locator(".coordinator-workspace .primary-session-card strong").getByText(`Saved ${id}`, { exact: true }).waitFor() }
    const check = async id => {
      await page.getByRole("tab", { name: "Worker 管理", exact: true }).click()
      await workerCard(id).getByRole("button", { name: "重新檢查連線", exact: true }).click()
      await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/coordinator/overview"), page.getByRole("alertdialog").getByRole("button", { name: "重新檢查連線", exact: true }).click()])
    }
    t.beforeEach(async () => {
      for (const release of holds.splice(0)) release()
      await page?.context().close()
      snapshot = overview(); rootMode = "coordinator"; modeFailure = false; overviewFailure = false; sessionHold = null; overviewHold = null; wrongNative = false
      mutations.length = 0; reads.length = 0; checks.length = 0; errors.length = 0
      page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
      page.setDefaultTimeout(5_000)
      page.on("pageerror", error => errors.push(error.message))
      await page.route("**/api/v1/**", routeApi)
      await page.context().route("https://*.native.example.test/**", route => route.fulfill({ contentType: "text/html", body: "<h1>Controlled native entry fixture</h1>" }))
    })

    await t.test("default aggregate, keyboard tabs, bilingual counts and truthful offline/unknown survive one failed Worker", async () => {
      await page.goto(origin)
      await aggregateRow("A").waitFor()
      assert.equal(await page.getByRole("tab", { name: "Instance 總覽", exact: true }).getAttribute("aria-selected"), "true")
      assert.equal(await page.locator(".coordinator-instance").count(), 5)
      assert.deepEqual(await page.locator(".coordinator-counts dd").allTextContents(), ["2", "1", "2", "1"])
      assert.equal(await page.getByRole("button", { name: /啟動|建立 Task/ }).count(), 0)
      await aggregateRow("unstable").getByText(/最後已知資料/).waitFor()
      await page.getByText("Worker initial：Instance 數量尚未確認。", { exact: true }).waitFor()
      await page.getByRole("tab", { name: "Instance 總覽", exact: true }).focus()
      await page.keyboard.press("ArrowRight")
      await workerCard("task").getByText("已結束 · 結果未知", { exact: true }).waitFor()
      await workerCard("resident").getByText("離線", { exact: true }).waitFor()
      await workerCard("initial").getByText("Instance 數量：未知", { exact: true }).waitFor()
      assert.equal(await workerCard("task").locator("details").getAttribute("open"), null)
      await page.evaluate(async () => { const { i18n } = await import("/src/i18n.ts"); i18n.global.locale.value = "en-US" })
      await workerCard("task").getByText("Ended · Result unknown", { exact: true }).waitFor()
      await workerCard("initial").getByText("Instance count: Unknown", { exact: true }).waitFor()
      assert.deepEqual(await page.locator(".coordinator-counts dt").allTextContents(), ["Online", "Unstable", "Offline", "Checking connection"])
      assert.match(await workerCard("A").textContent(), /Last successful check: Oct 2, 2026/)
      assert.deepEqual(mutations, [])
      assert.deepEqual(errors, [])
    })

    await t.test("same Instance id routes confirmed Stop to exact Worker generation, initial selection is not first row", async () => {
      await page.goto(origin); await open("B")
      // 模擬此前 desktop 啟用留下的 transient Basic；Worker scoped client 不得沿用。
      await page.evaluate(async () => {
        const { managerApi } = await import("/src/api.ts")
        await managerApi.enableRemoteAccess("fixture-human", "fixture-only").catch(() => {})
      })
      mutations.length = 0
      await page.getByText("Verify B", { exact: true }).waitFor()
      const workspace = page.locator(".coordinator-workspace")
      assert.equal(await workspace.locator(".topbar").count(), 0)
      assert.equal(await workspace.locator(".connectivity").count(), 0)
      await workspace.locator(".lifecycle-trigger").click()
      await workspace.getByRole("button", { name: "停止 Instance", exact: true }).click()
      const confirmation = page.getByRole("alertdialog")
      assert.match(await confirmation.textContent(), /Worker B.*gen\/B/)
      assert.equal(mutations.length, 0)
      await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/stop")), confirmation.getByRole("button", { name: "停止 Instance", exact: true }).click()])
      assert.deepEqual(mutations.map(({ id, generation, path }) => ({ id, generation, path })), [{ id: "B", generation: "gen/B", path: "/api/v1/instances/same-id/stop" }])
      assert.equal(mutations[0].authorization, undefined)
      assert.equal(reads.some(read => read.id === "B" && read.path === "/api/v1/instances/same-id/sessions"), true)
    })

    await t.test("selected Worker Start requires fresh capacity and explicit target confirmation", async () => {
      await page.goto(origin); await aggregateRow("B").waitFor()
      await page.locator("#coordinator-worker-filter").selectOption(JSON.stringify(["B", "gen/B"]))
      await page.getByRole("button", { name: "管理此 Worker", exact: true }).click()
      const workspace = page.locator(".coordinator-workspace")
      await workspace.getByRole("button", { name: "啟動 Instance", exact: true }).click()
      const panel = page.getByRole("dialog", { name: "啟動 Instance" })
      await panel.locator(".current-directory code").getByText("/workspace", { exact: true }).waitFor()
      await panel.getByRole("button", { name: "啟動全新 Instance", exact: true }).click()
      const confirmation = page.getByRole("alertdialog")
      assert.match(await confirmation.textContent(), /Worker B.*gen\/B/)
      assert.match(await confirmation.textContent(), /\/workspace/)
      assert.deepEqual(mutations, [])
      await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/proxy/api/v1/instances")), confirmation.getByRole("button", { name: "啟動", exact: true }).click()])
      assert.deepEqual(mutations.map(({ id, generation, path, body }) => ({ id, generation, path, body })), [{ id: "B", generation: "gen/B", path: "/api/v1/instances", body: '{"directory":"/workspace"}' }])
    })

    await t.test("native Session entry validates backend URL against selected Worker origin, not private Pod IP or another Worker", async () => {
      await page.goto(origin); await open("B")
      const workspace = page.locator(".coordinator-workspace")
      assert.equal(await workspace.locator(".native-web-link").getAttribute("href"), "https://b.native.example.test/")
      wrongNative = true
      await workspace.getByRole("button", { name: "進入入口 Session", exact: true }).click()
      await workspace.getByText("Manager 回傳了不安全的 Open URL。", { exact: true }).waitFor()
      assert.deepEqual(mutations.map(({ id, generation, path }) => ({ id, generation, path })), [{ id: "B", generation: "gen/B", path: "/api/v1/instances/same-id/open-url" }])
      wrongNative = false
      const popupPromise = page.waitForEvent("popup")
      await workspace.getByRole("button", { name: "進入入口 Session", exact: true }).click()
      const popup = await popupPromise
      await popup.waitForURL("https://b.native.example.test/project/session/ses-root")
      await popup.getByRole("heading", { name: "Controlled native entry fixture", exact: true }).waitFor()
      assert.deepEqual(errors, [])
    })

    await t.test("Worker offline or retired while confirmation is open aborts workspace without Stop or automatic rerun", async () => {
      await page.clock.install()
      await page.goto(origin); await open("A")
      await page.locator(".coordinator-workspace .lifecycle-trigger").click()
      await page.locator(".coordinator-workspace").getByRole("button", { name: "停止 Instance", exact: true }).click()
      await page.getByRole("alertdialog").waitFor()
      snapshot.workers[0] = worker("A", "offline")
      snapshot.instances[0].freshness = "stale"
      await page.clock.fastForward(10_000)
      await page.locator(".coordinator-workspace").waitFor({ state: "detached" })
      assert.equal(await page.getByRole("alertdialog").count(), 0)
      await aggregateRow("A").getByText(/最後已知資料/).waitFor()
      assert.equal(await aggregateRow("A").getByRole("button").count(), 0)
      assert.deepEqual(mutations, [])
    })

    await t.test("filter and late A response cannot contaminate B context or reuse old confirmation", async () => {
      sessionHold = hold()
      await page.goto(origin); await open("A")
      await page.locator(".coordinator-workspace .lifecycle-trigger").click()
      await page.locator(".coordinator-workspace").getByRole("button", { name: "停止 Instance", exact: true }).click()
      await page.getByRole("alertdialog").getByRole("button", { name: "取消", exact: true }).click()
      await page.locator("#coordinator-worker-filter").selectOption(JSON.stringify(["B", "gen/B"]))
      await open("B")
      for (const release of holds.splice(0)) release()
      await page.getByText("Verify B", { exact: true }).waitFor()
      assert.equal(await page.getByText("Verify A", { exact: true }).count(), 0)
      assert.equal(await page.getByRole("alertdialog").count(), 0)
      assert.deepEqual(mutations, [])
      assert.deepEqual(errors, [])
    })

    await t.test("unstable allows history reads but denies all new operations; check is confirmed and not restart", async () => {
      await page.goto(origin); await open("unstable")
      await page.getByText(/目前不可安全執行新操作/).waitFor()
      assert.equal(await page.locator(".coordinator-workspace").getByRole("button", { name: "啟動 Instance", exact: true }).count(), 0)
      assert.equal(await page.locator(".coordinator-workspace").getByRole("button", { name: "New Session", exact: true }).isDisabled(), true)
      await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname.includes("/instances/history")), page.locator(".coordinator-workspace .history-toggle").click()])
      await check("task")
      assert.deepEqual(checks, [["task", "gen/task"]])
      assert.deepEqual(mutations, [])
      snapshot.workers.find(item => item.id === "task").health = "online"
      snapshot.workers.find(item => item.id === "task").freshness = "fresh"
      snapshot.workers.find(item => item.id === "task").endedAt = null
      await check("task")
      await workerCard("task").getByText("在線", { exact: true }).waitFor()
      assert.deepEqual(mutations, [], "recovery must not auto-start or rerun tasks")
    })

    await t.test("latest overview fences late snapshot and retired execution, while read failure preserves other rows", async () => {
      await page.clock.install()
      await page.goto(origin); await aggregateRow("A").waitFor()
      const pending = hold(); overviewHold = pending
      await Promise.all([page.waitForRequest(request => new URL(request.url()).pathname === "/api/v1/coordinator/overview"), page.clock.fastForward(10_000)])
      snapshot.workers[0] = { ...worker("A"), generation: "new-A" }
      snapshot.instances[0].generation = "new-A"
      await check("A")
      pending.release()
      await workerCard("A").waitFor()
      assert.equal(await workerCard("A").getAttribute("data-generation"), "new-A")
      overviewFailure = true
      await check("A")
      await page.getByText(/總覽更新失敗/).waitFor()
      await page.getByRole("tab", { name: "Instance 總覽", exact: true }).click()
      assert.equal(await page.locator(".coordinator-instance").count(), 5)
      await aggregateRow("B").getByText(/最後已知資料/).waitFor()
      assert.deepEqual(mutations, [])
    })

    await t.test("initial failure/unknown mode never assumes desktop; empty Coordinator points to external startup; legacy mode stays local", async () => {
      modeFailure = true; await page.goto(origin)
      await page.getByText("無法確認運作模式。請重試連線。", { exact: true }).waitFor()
      assert.equal(await page.locator(".topbar,.connectivity,.coordinator").count(), 0)
      assert.deepEqual(reads, [])
      modeFailure = false; rootMode = "unexpected"
      await page.getByRole("button", { name: "重試", exact: true }).click()
      await page.getByText("無法確認運作模式。請重試連線。", { exact: true }).waitFor()
      rootMode = "coordinator"; overviewFailure = true
      await page.getByRole("button", { name: "重試", exact: true }).click()
      await page.getByText(/無法取得總覽/).waitFor()
      assert.deepEqual(await page.locator(".coordinator-counts dd").allTextContents(), ["未知", "未知", "未知"])
      overviewFailure = false; snapshot = { checkedAt: observed, workers: [], instances: [] }
      await page.getByRole("button", { name: "重試", exact: true }).click()
      await page.getByText(/請由外部啟動 Worker/).waitFor()
      assert.equal(await page.getByRole("button", { name: /啟動|建立 Task/ }).count(), 0)
      rootMode = "loopback"; await page.reload()
      await page.locator(".topbar").waitFor()
      assert.equal(await page.locator(".coordinator").count(), 0)
      await page.getByRole("button", { name: "啟動 Instance", exact: true }).first().waitFor()
    })

    await t.test("mobile and desktop retain readable source identity, local diagnostics and keyboard navigation", async () => {
      await page.goto(origin); await aggregateRow("A").waitFor()
      const captures = process.env.OMW_COORDINATOR_CAPTURE
      if (captures) await mkdir(captures, { recursive: true })
      for (const [name, width, height] of [["desktop", 1440, 900], ["mobile", 390, 844]]) {
        await page.setViewportSize({ width, height })
        await page.getByRole("tab", { name: "Instance 總覽", exact: true }).click()
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true)
        if (captures) await page.screenshot({ path: path.join(captures, `${name}-instances.png`), fullPage: true })
        await page.getByRole("tab", { name: "Instance 總覽", exact: true }).focus(); await page.keyboard.press("End")
        await workerCard("task").waitFor()
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true)
        if (captures) await page.screenshot({ path: path.join(captures, `${name}-workers.png`), fullPage: true })
      }
      await workerCard("A").locator("summary").click()
      await workerCard("A").getByText("gen/A", { exact: true }).waitFor()
      await workerCard("A").getByText("10.0.0.2", { exact: true }).waitFor()
      await page.evaluate(() => {
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async value => { window.fixtureClipboard = value } } })
      })
      await workerCard("A").getByRole("button", { name: "複製診斷資訊", exact: true }).click()
      await workerCard("A").getByText("診斷資訊已複製。", { exact: true }).waitFor()
      assert.deepEqual(await page.evaluate(() => JSON.parse(window.fixtureClipboard)), { id: "A", generation: "gen/A", address: "10.0.0.2", diagnosticCode: null })
      await workerCard("A").getByRole("button", { name: "查看 Instances", exact: true }).click()
      assert.equal(await page.locator(".coordinator-instance").count(), 1)
      assert.equal(await page.locator("#coordinator-worker-filter").inputValue(), JSON.stringify(["A", "gen/A"]))
      await open("A")
      await page.getByText("Verify A", { exact: true }).waitFor()
      assert.equal(await page.locator(".coordinator-workspace .app-root").getAttribute("data-mobile-view"), "detail")
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true)
      await page.getByRole("button", { name: "關閉 Worker 操作區", exact: true }).click()
      assert.equal(await page.locator(".coordinator-workspace").count(), 0)
      assert.deepEqual(errors, [])
    })
  } finally {
    for (const release of holds) release()
    await browser?.close()
    await server?.close()
    if (httpServer) await new Promise(resolve => { httpServer.close(resolve); httpServer.closeAllConnections() })
    await rm(profile, { recursive: true, force: true })
  }
})
