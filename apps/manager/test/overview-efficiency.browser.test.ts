import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import http from "node:http"
import net from "node:net"
import path from "node:path"
import { performance } from "node:perf_hooks"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { gzipSync, gunzipSync } from "node:zlib"
import { chromium, type Browser } from "playwright-core"
import { buildApp } from "../src/app.js"
import { ManagerRepository, type InstanceRecord } from "../src/repository.js"
import { ManagerService } from "../src/service.js"
import type { RuntimePort } from "../src/runtime.js"
import { createProofArtifacts } from "./proof-artifacts.js"

const enabled = process.env.OMW_BROWSER_TEST === "1"

test("compact overview/history isolated browser proof and actual HTTP measurements", { skip: !enabled, timeout: 90_000 }, async (t) => {
  const executablePath = process.env.OMW_BROWSER_EXECUTABLE
  assert.ok(executablePath)
  // 同一 bounded test 擁有 app/browser，finally 只關閉本次 binding；screenshots 保留於外部 run root。
  const artifacts = await createProofArtifacts("overview-95-96-")
  const profile = path.join(artifacts, "profile")
  await Promise.all(["AppData/Roaming", "AppData/Local", "Temp"].map((folder) => mkdir(path.join(profile, folder), { recursive: true })))
  const repository = new ManagerRepository(":memory:")
  const sessions = Array.from({ length: 180 }, (_, index) => ({ id: `session-${index}`, title: `匿名測試 Session ${index} ${"Long title ".repeat(5)}` }))
  let questions = 0, inspectCalls = 0, summaryCalls = 0
  const unexpected = async (): Promise<never> => { throw new Error("fixture prohibits runtime mutation") }
  const runtime: RuntimePort = {
    launch: unexpected, cleanupLaunch: unexpected, readiness: unexpected, stop: unexpected,
    inspect: async () => { inspectCalls++; return { running: true, matched: true, portOwnerMatched: true, portOwnedByOther: false } },
    summary: async () => { summaryCalls++; return { activity: "reported-non-busy", busySessions: 0, pendingQuestions: questions, pendingPermissions: 0, error: null, sessions } },
    sessions: async () => sessions, children: async () => [], openUrl: () => { throw new Error("fixture prohibits upstream URL") },
  }
  const record: InstanceRecord = {
    id: "current-a", projectName: "匿名長專案名稱與完整定位資訊 ".repeat(6), projectDirectory: "C:\\fixture\\project-a",
    state: "ready", endpoint: "http://127.0.0.1:49998", port: 49998, pid: 12345,
    creationTimeUtc: null, creationTimeTicks: null, executable: null,
    launchedAt: "2026-09-18T00:00:00.000Z", healthVersion: "fixture", stoppedAt: null, error: null, stderrSummary: null,
  }
  repository.createInstance(record)
  repository.createInstance({ ...record, id: "current-b", projectName: "另一個 Instance 同 Project" })
  for (let index = 0; index < 45; index++) repository.createInstance({ ...record, id: `history-${String(index).padStart(2, "0")}`, state: "stopped",
    projectName: index === 44 ? "needle-outside-first-page" : `停止歷史 ${index} ${"長名稱 ".repeat(10)}`,
    launchedAt: "2026-09-17T00:00:00.000Z" })
  for (const instance of repository.listInstances()) repository.replacePrimarySession(instance.id, {
    sessionId: "session-0", title: `匿名很長的入口標題 ${"工作名稱 ".repeat(18)}`, source: "manual", boundAt: "2026-09-18T00:00:00.000Z",
  })
  const service = new ManagerService(repository, runtime)
  const probe = net.createServer()
  await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve) })
  const address = probe.address()
  assert.ok(address && typeof address !== "string")
  await new Promise<void>((resolve, reject) => probe.close((cause) => cause ? reject(cause) : resolve()))
  const origin = `http://127.0.0.1:${address.port}`
  const app = buildApp({ service, authority: { hostname: "127.0.0.1", port: address.port }, allowedOrigins: new Set([origin]),
    webRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../web/dist") })
  let browser: Browser | undefined
  let releaseHistory = () => {}
  try {
    await app.listen({ host: "127.0.0.1", port: address.port })
    const rawRead = (target: string, encoding: string, etag?: string) => new Promise<{ status: number; body: Buffer; headers: http.IncomingHttpHeaders; headerBytes: number; latencyMs: number }>((resolve, reject) => {
      const started = performance.now()
      const request = http.get(`${origin}${target}`, { headers: { "accept-encoding": encoding, ...(etag ? { "if-none-match": etag } : {}) } }, (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.on("end", () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks), headers: response.headers,
          headerBytes: Buffer.byteLength(`HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}\r\n${response.rawHeaders.reduce((text, value, index) => text + value + (index % 2 ? "\r\n" : ": "), "")}\r\n`), latencyMs: performance.now() - started }))
      })
      request.on("error", reject)
      request.setTimeout(5_000, () => request.destroy(new Error("fixture HTTP deadline")))
    })
    const compactUrl = "/api/v1/overview?view=compact&scope=current"
    const legacy = await rawRead("/api/v1/overview", "identity")
    const plain = await rawRead(compactUrl, "identity")
    const zipped = await rawRead(compactUrl, "gzip")
    assert.deepEqual(gunzipSync(zipped.body), plain.body)
    const hit = await rawRead(compactUrl, "gzip", String(zipped.headers.etag))
    assert.equal(hit.status, 304)
    const stable: number[] = []
    const changing: number[] = []
    for (let index = 0; index < 5; index++) stable.push((await rawRead(compactUrl, "gzip", String(zipped.headers.etag))).status)
    for (let index = 0; index < 5; index++) { questions++; changing.push((await rawRead(compactUrl, "gzip", String(zipped.headers.etag))).status) }
    const cost = (operation: () => unknown) => { const start = performance.now(); for (let index = 0; index < 100; index++) operation(); return (performance.now() - start) / 100 }
    const metrics = { fixture: { live: 2, stopped: 45, sessionsPerLive: 180 }, legacyJsonBytes: legacy.body.length, compactJsonBytes: plain.body.length,
      actualHttp: { identity: { bodyBytes: plain.body.length, headerBytes: plain.headerBytes, latencyMs: plain.latencyMs }, gzip: { bodyBytes: zipped.body.length, headerBytes: zipped.headerBytes, latencyMs: zipped.latencyMs },
        notModified: { bodyBytes: hit.body.length, headerBytes: hit.headerBytes, latencyMs: hit.latencyMs } },
      offlineCostMeanMs: { gzipSync: cost(() => gzipSync(plain.body)), validatorSha256: cost(() => createHash("sha256").update(`${compactUrl}\ntrue\n${plain.body}`).digest("hex")) },
      validator: { stableHits: stable.filter((status) => status === 304).length, stableReads: 5, changedHits: changing.filter((status) => status === 304).length, changedReads: 5 },
      probeBoundary: { inspectCalls, summaryCalls, note: "每次 HTTP 包括304仍 fresh probes；歷史不探測，沒有真人 OpenCode" } }
    await writeFile(path.join(artifacts, "metrics.json"), JSON.stringify(metrics, null, 2))
    t.diagnostic(JSON.stringify({ artifacts, metrics }))
    const env = Object.fromEntries(["SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "LANG", "LC_ALL"]
      .flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]))
    browser = await chromium.launch({ executablePath, headless: true, env: { ...env, HOME: profile, USERPROFILE: profile,
      APPDATA: path.join(profile, "AppData/Roaming"), LOCALAPPDATA: path.join(profile, "AppData/Local"), TEMP: path.join(profile, "Temp"), TMP: path.join(profile, "Temp") } })
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" })
    const pageErrors: string[] = []
    const consoleErrors: string[] = []
    page.on("pageerror", (error) => pageErrors.push(error.message))
    page.on("console", (message) => { if (message.type() === "error" || message.type() === "warning") consoleErrors.push(message.text()) })
    let historyReads = 0, historyFail = false, historyGate: Promise<void> | null = null, overviewReads = 0
    await page.route("**/api/v1/instances/history?**", async (route) => {
      historyReads++
      if (historyGate) await historyGate
      if (historyFail) await route.fulfill({ status: 503, json: { error: { code: "FIXTURE_HISTORY_FAILURE", message: "匿名測試失敗" } } })
      else await route.continue()
    })
    page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/v1/overview") overviewReads++ })
    await page.addInitScript(() => {
      const host = window as typeof window & { __shown: unknown[] }
      host.__shown = []
      Object.defineProperty(window, "Notification", { value: class { static permission = "granted"; static requestPermission = async () => "granted"; constructor(title: string) { host.__shown.push(title) } } })
      Object.defineProperty(navigator, "serviceWorker", { value: undefined, configurable: true })
    })
    // serviceWorker property must be absent for the existing Notification fallback.
    await page.addInitScript(() => { delete (Navigator.prototype as unknown as { serviceWorker?: unknown }).serviceWorker; delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker })
    questions = 0
    await page.goto(origin)
    try { await page.locator('.instance-row[data-instance-id="current-a"]').waitFor({ timeout: 5_000 }) }
    catch (cause) {
      await page.screenshot({ path: path.join(artifacts, "initial-failure.png"), fullPage: true })
      t.diagnostic(JSON.stringify({ pageErrors, consoleErrors, visibility: await page.evaluate(() => document.visibilityState), text: await page.locator("body").innerText(), overviewReads }))
      throw cause
    }
    assert.equal(historyReads, 0, "collapsed history has no body download")
    await page.getByRole("button", { name: "OMW 設定" }).click()
    await page.getByRole("checkbox", { name: /頁面開啟期間通知/ }).check()
    await page.getByRole("button", { name: "關閉 OMW 設定" }).click()
    await page.waitForTimeout(300)
    const baselineReads = overviewReads, baselineProbes = inspectCalls
    questions = 1
    await page.waitForTimeout(5_400)
    assert.equal(overviewReads - baselineReads, 1, "UI + notifications only download one overview per regular cycle")
    assert.equal(inspectCalls - baselineProbes, 2, "one probe per current Instance, not twice")
    assert.equal(await page.evaluate(() => (window as unknown as { __shown: unknown[] }).__shown.length), 2)
    await page.getByRole("textbox", { name: "搜尋", exact: true }).fill("no-current-match")
    await page.getByRole("button", { name: "執行搜尋", exact: true }).click()
    await page.getByText("此處只搜尋目前 Instance；請展開停止歷史搜尋完整歷史。", { exact: true }).waitFor()
    questions = 0
    await page.waitForTimeout(5_400)
    questions = 1
    await page.waitForTimeout(5_400)
    assert.equal(await page.evaluate(() => (window as unknown as { __shown: unknown[] }).__shown.length), 4, "filtered empty UI still observes both Instance notification edges")
    await page.getByRole("textbox", { name: "搜尋", exact: true }).fill("")
    await page.getByRole("button", { name: "執行搜尋", exact: true }).click()
    await page.locator('.instance-row[data-instance-id="current-a"]').waitFor()
    historyGate = new Promise((resolve) => { releaseHistory = resolve })
    await page.locator(".history-toggle").click()
    await page.getByText("載入中…", { exact: true }).waitFor()
    await page.screenshot({ path: path.join(artifacts, "390-history-loading.png"), fullPage: true })
    releaseHistory(); historyGate = null
    await page.getByText("已載入 20 / 45 筆", { exact: true }).waitFor()
    await page.getByRole("button", { name: "載入更多", exact: true }).click()
    await page.getByText("已載入 40 / 45 筆", { exact: true }).waitFor()
    const loadedReads = historyReads
    await page.locator(".history-toggle").click(); await page.locator(".history-toggle").click()
    assert.equal(historyReads, loadedReads)
    await page.locator('.stopped-row[data-instance-id="history-00"]').click()
    await page.locator('.detail-pane .state-chip[data-category="stopped"]').waitFor()
    await page.getByRole("button", { name: "返回列表", exact: true }).click()
    await page.getByText("已載入 40 / 45 筆", { exact: true }).waitFor()
    const historySearch = page.getByRole("textbox", { name: "停止歷史關鍵字", exact: true })
    await historySearch.fill("needle-outside-first-page")
    await page.getByRole("button", { name: "搜尋停止歷史", exact: true }).click()
    await page.getByText("已載入 1 / 1 筆", { exact: true }).waitFor()
    assert.equal(await page.locator(".stopped-row").count(), 1)
    await historySearch.fill(""); await page.getByRole("button", { name: "搜尋停止歷史", exact: true }).click()
    await page.getByText("已載入 20 / 45 筆", { exact: true }).waitFor()
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 844 })
      await page.screenshot({ path: path.join(artifacts, `${width}-history-loaded.png`), fullPage: true })
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `no horizontal overflow at ${width}`)
    }
    await page.setViewportSize({ width: 320, height: 844 })
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%" })
    await page.screenshot({ path: path.join(artifacts, "320-history-text-200.png"), fullPage: true })
    const zoomOverflow = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1 && element.getBoundingClientRect().width > 0)
      .map((element) => ({ className: element.className, right: element.getBoundingClientRect().right, text: element.innerText?.slice(0, 60) })))
    if (zoomOverflow.length) t.diagnostic(JSON.stringify({ zoomOverflow }))
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
    await page.evaluate(() => { document.documentElement.style.fontSize = "" })
    historyFail = true
    await page.getByRole("button", { name: "刷新停止歷史", exact: true }).click()
    await page.locator("#instance-history [role=alert]").waitFor()
    assert.equal(await page.locator(".stopped-row").count(), 20)
    await page.screenshot({ path: path.join(artifacts, "320-history-error.png"), fullPage: true })
    historyFail = false
    await page.locator("#instance-history").getByRole("button", { name: "重試", exact: true }).click()
    await page.locator("#instance-history [role=alert]").waitFor({ state: "hidden" })
    await page.locator('.instance-row[data-instance-id="current-a"]').click()
    repository.saveInstance({ ...record, state: "stopped" })
    await page.locator('.detail-pane .state-chip[data-category="stopped"]').waitFor({ timeout: 8_000 })
    assert.equal(await page.locator(".detail-head").count(), 1, "selected stopping Instance retains detail")
    assert.deepEqual(pageErrors, [])
    await writeFile(path.join(artifacts, "browser-result.json"), JSON.stringify({ pageErrors, historyReads, overviewReads, normalCycleOverviewRequests: 1, normalCycleProbeCalls: 2, screenshots: [320, 390, 1280], result: "passed" }, null, 2))
  } finally {
    releaseHistory()
    try { await browser?.close() } finally {
      try { await app.close() } finally {
        try { await service.shutdown() } finally { repository.close() }
      }
    }
    assert.equal(browser?.isConnected() ?? false, false)
    assert.equal(app.server.listening, false)
    await writeFile(path.join(artifacts, "lifecycle.json"), JSON.stringify({
      browserConnected: false, appListening: false, serviceShutdown: true, repositoryClosed: true,
      finalDisposition: "Stop", cleanup: "completed",
    }, null, 2))
  }
})
