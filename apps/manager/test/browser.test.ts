import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright-core"
import type { ConnectivityInfo, ManagedInstance, SessionMetadata } from "@omw/contracts"
import { buildApp } from "../src/app.js"
import { ManagerError } from "../src/errors.js"
import { prepareIsolatedEnvironment } from "../src/isolation.js"
import { ManagerRepository, type InstanceRecord } from "../src/repository.js"
import { ManagerService } from "../src/service.js"
import {
  OpenCodeRuntime,
  type LaunchResult,
  type RuntimeActivityEvent,
  type RuntimeActivityObserver,
  type RuntimePort,
} from "../src/runtime.js"

const enabled = process.env.OMW_BROWSER_TEST === "1"
const realEnabled = enabled && process.env.OMW_REAL_OPENCODE_TEST === "1"

test("browser process environment excludes host credential variables", () => {
  const sentinelName = "OMW_BROWSER_SENTINEL_PASSWORD"
  const previous = process.env[sentinelName]
  process.env[sentinelName] = "fixture-browser-secret"
  try {
    const environment = createBrowserEnvironment("C:\\isolated-browser-fixture")
    assert.equal(environment[sentinelName], undefined)
    assert.equal(Object.values(environment).includes("fixture-browser-secret"), false)
    assert.equal(environment.USERPROFILE, "C:\\isolated-browser-fixture\\browser-profile")
  } finally {
    if (previous === undefined) delete process.env[sentinelName]
    else process.env[sentinelName] = previous
  }
})

test("detail header keeps long project title and state badge on one line", { skip: !enabled, timeout: 45_000 }, async () => {
  const executablePath = process.env.OMW_BROWSER_EXECUTABLE
  assert.ok(executablePath, "OMW_BROWSER_EXECUTABLE is required")
  const sandbox = await mkdtemp(path.join(tmpdir(), "omw-browser-detail-header-"))
  const projectDirectory = path.join(sandbox, "omw-tty-acceptance")
  await Promise.all([
    mkdir(projectDirectory, { recursive: true }),
    mkdir(path.join(sandbox, "browser-profile", "AppData", "Roaming"), { recursive: true }),
    mkdir(path.join(sandbox, "browser-profile", "AppData", "Local"), { recursive: true }),
    mkdir(path.join(sandbox, "browser-profile", "Temp"), { recursive: true }),
  ])
  const repository = new ManagerRepository(":memory:")
  const runtime = new BrowserRuntime()
  const service = new ManagerService(repository, runtime)
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../web/dist")
  const app = buildApp({
    service,
    authority: { hostname: "127.0.0.1", port },
    allowedOrigins: new Set([origin]),
    webRoot,
  })
  const projectName = "omw-tty-acceptance"
  const states: Array<{ label: string; state: InstanceRecord["state"] }> = [
    { label: "可連線", state: "ready" },
    { label: "已停止", state: "stopped" },
    { label: "已失聯", state: "unreachable" },
  ]
  states.forEach(({ state }, index) => repository.createInstance({
    id: randomUUID(),
    projectName,
    projectDirectory: path.join(projectDirectory, String(index)),
    state,
    endpoint: `http://127.0.0.1:${45_100 + index}`,
    port: 45_100 + index,
    pid: null,
    creationTimeUtc: null,
    creationTimeTicks: null,
    executable: null,
    launchedAt: new Date(Date.now() + index).toISOString(),
    healthVersion: null,
    stoppedAt: state === "stopped" ? new Date().toISOString() : null,
    error: null,
    stderrSummary: null,
  }))
  let browser: Browser | undefined

  try {
    await app.listen({ host: "127.0.0.1", port })
    browser = await chromium.launch({ executablePath, headless: true, env: createBrowserEnvironment(sandbox) })
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    await page.goto(origin, { waitUntil: "networkidle" })
    await page.locator(".instance-row").nth(0).waitFor()

    for (const width of [1440, 390, 360]) {
      await page.setViewportSize({ width, height: 844 })
      for (const { label } of states) {
        await returnToInstanceList(page)
        const row = page.locator(".instance-row").filter({ hasText: label })
        assert.equal(await row.count(), 1, `${width}px fixture row for ${label} is missing`)
        if (!await row.isVisible()) {
          const historyToggle = page.locator(".history-toggle").filter({ hasText: "已停止紀錄" })
          assert.equal(await historyToggle.count(), 1, `${width}px stopped history disclosure is missing`)
          await historyToggle.click()
        }
        await row.click()
        await page.getByText(label, { exact: true }).last().waitFor()
        const geometry = await page.evaluate(() => {
          const title = document.querySelector<HTMLElement>(".detail-head h2")
          const titleContainer = document.querySelector<HTMLElement>(".detail-head > div")
          const header = document.querySelector<HTMLElement>(".detail-head")
          const controls = document.querySelector<HTMLElement>(".detail-head-controls")
          const badge = document.querySelector<HTMLElement>(".detail-head .state-chip")
          if (!title || !titleContainer || !header || !controls || !badge) throw new Error("detail header geometry target is missing")
          const badgeBounds = badge.getBoundingClientRect()
          const titleBounds = title.getBoundingClientRect()
          const containerBounds = titleContainer.getBoundingClientRect()
          const headerBounds = header.getBoundingClientRect()
          const controlsBounds = controls.getBoundingClientRect()
          return {
            documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
            titleBounds: { left: titleBounds.left, right: titleBounds.right },
            containerBounds: { left: containerBounds.left, right: containerBounds.right, bottom: containerBounds.bottom },
            headerBounds: { left: headerBounds.left, right: headerBounds.right },
            controlsBounds: { left: controlsBounds.left, right: controlsBounds.right, top: controlsBounds.top },
            badgeBounds: { left: badgeBounds.left, right: badgeBounds.right, top: badgeBounds.top, height: badgeBounds.height },
            badgeClientWidth: badge.clientWidth,
            badgeScrollWidth: badge.scrollWidth,
            badgeWhiteSpace: getComputedStyle(badge).whiteSpace,
          }
        })
        assert.equal(geometry.documentWidth <= width, true, `${width}px detail header has horizontal overflow`)
        assert.equal(geometry.titleBounds.left >= geometry.containerBounds.left - 1, true, `${width}px title escapes its container`)
        if (width > 860) {
          assert.equal(geometry.titleBounds.right <= geometry.badgeBounds.left - 8, true, `${width}px title overlaps the state badge`)
        } else {
          assert.equal(geometry.containerBounds.right >= geometry.headerBounds.right - 1, true, `${width}px title and path do not receive the full detail width`)
          assert.equal(geometry.controlsBounds.top >= geometry.containerBounds.bottom + 8, true, `${width}px controls do not occupy an independent row`)
          assert.equal(geometry.controlsBounds.left <= geometry.headerBounds.left + 1 && geometry.controlsBounds.right >= geometry.headerBounds.right - 1, true, `${width}px control row does not span the detail width`)
        }
        assert.equal(geometry.badgeWhiteSpace, "nowrap", `${width}px ${label} badge text may wrap`)
        assert.equal(geometry.badgeScrollWidth <= geometry.badgeClientWidth, true, `${width}px ${label} badge content overflows`)
        assert.equal(geometry.badgeBounds.height >= 20, true, `${width}px ${label} badge clips its text`)
      }
    }
  } finally {
    await browser?.close()
    await app.close()
    repository.close()
    await rm(sandbox, { recursive: true, force: true })
  }
})

test("primary Session attention reasons stay consistent in the list, detail, and filter", { skip: !enabled, timeout: 45_000 }, async () => {
  const executablePath = process.env.OMW_BROWSER_EXECUTABLE
  assert.ok(executablePath, "OMW_BROWSER_EXECUTABLE is required")
  const sandbox = await mkdtemp(path.join(tmpdir(), "omw-browser-primary-attention-"))
  await Promise.all([
    mkdir(path.join(sandbox, "browser-profile", "AppData", "Roaming"), { recursive: true }),
    mkdir(path.join(sandbox, "browser-profile", "AppData", "Local"), { recursive: true }),
    mkdir(path.join(sandbox, "browser-profile", "Temp"), { recursive: true }),
  ])
  const repository = new ManagerRepository(":memory:")
  const service = new ManagerService(repository, new BrowserRuntime())
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../web/dist")
  const app = buildApp({ service, authority: { hostname: "127.0.0.1", port }, allowedOrigins: new Set([origin]), webRoot })
  const directory = "C:\\fixture\\primary-attention"
  const instances = [
    fakeManagedInstance({
      id: "inst-zero-busy",
      projectDirectory: directory,
      primarySession: { sessionId: "root-zero", title: "Ready for next step", source: "manual", boundAt: "2026-09-22T00:00:00.000Z" },
      summary: { activity: "busy", busySessions: 1, pendingQuestions: 0, pendingPermissions: 0, error: null },
      primarySummary: { scope: "known", activity: "none-reported", busySessions: 0, retrySessions: 0, pendingQuestions: 0, pendingPermissions: 0, error: null },
    }),
    fakeManagedInstance({
      id: "inst-unbound",
      projectDirectory: directory,
      primarySession: null,
      primarySummary: { scope: "unbound", activity: "none-reported", busySessions: null, retrySessions: null, pendingQuestions: null, pendingPermissions: null, error: null },
    }),
    fakeManagedInstance({
      id: "inst-retry",
      projectDirectory: directory,
      primarySession: { sessionId: "root-retry", title: "Retrying work", source: "manual", boundAt: "2026-09-22T00:00:00.000Z" },
      primarySummary: { scope: "known", activity: "reported-non-busy", busySessions: 0, retrySessions: 1, pendingQuestions: 0, pendingPermissions: 0, error: null },
    }),
    fakeManagedInstance({
      id: "inst-unknown-scope",
      projectDirectory: directory,
      primarySession: { sessionId: "missing-root", title: "Missing hierarchy", source: "manual", boundAt: "2026-09-22T00:00:00.000Z" },
      primarySummary: { scope: "unknown", activity: "unknown", busySessions: null, retrySessions: null, pendingQuestions: null, pendingPermissions: null, error: "PRIMARY_SESSION_SCOPE_UNKNOWN" },
    }),
  ]
  let browser: Browser | undefined

  try {
    await app.listen({ host: "127.0.0.1", port })
    browser = await chromium.launch({ executablePath, headless: true, env: createBrowserEnvironment(sandbox) })
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" })
    await page.route("**/api/v1/**", async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      if (request.method() === "GET" && url.pathname === "/api/v1/overview") {
        const visible = url.searchParams.get("filter") === "attention"
          ? instances.filter((instance) => instance.id === "inst-zero-busy" || instance.id === "inst-unbound")
          : instances
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ shortcuts: [], instances: visible }) })
        return
      }
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "FIXTURE_ROUTE_MISSING", message: url.pathname } }) })
    })

    await page.goto(origin, { waitUntil: "networkidle" })
    const zeroBusy = page.locator('.instance-row[data-instance-id="inst-zero-busy"]')
    const unbound = page.locator('.instance-row[data-instance-id="inst-unbound"]')
    const retry = page.locator('.instance-row[data-instance-id="inst-retry"]')
    const unknown = page.locator('.instance-row[data-instance-id="inst-unknown-scope"]')
    assert.match(await zeroBusy.textContent() ?? "", /需處理 · 無執行中 Session.*主 Session 工作範圍.*可連線/s)
    assert.match(await unbound.textContent() ?? "", /需處理 · 未綁定主 Session.*可連線/s)
    assert.match(await retry.textContent() ?? "", /重試中.*主 Session 工作範圍.*可連線/s)
    assert.match(await unknown.textContent() ?? "", /無法確認.*主 Session 工作範圍.*可連線/s)

    await zeroBusy.click()
    await page.locator(".detail-pane").waitFor()
    assert.match(await page.locator(".primary-session-attention").textContent() ?? "", /需處理 · 無執行中 Session/)
    assert.match(await page.locator(".summary-grid").textContent() ?? "", /主 Session 範圍.*0.*執行中 Session/s)
    assert.match(await page.locator(".status-note").textContent() ?? "", /請查看對話並決定下一步/)

    await page.getByRole("button", { name: "返回列表" }).click()
    await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/overview"),
      page.getByRole("button", { name: "需處理", exact: true }).click(),
    ])
    assert.deepEqual((await page.locator(".instance-row").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-instance-id")))).sort(), ["inst-unbound", "inst-zero-busy"])
  } finally {
    await browser?.close()
    await app.close()
    repository.close()
    await rm(sandbox, { recursive: true, force: true })
  }
})

test("mobile list-detail navigation preserves context and separates stopped history", { skip: !enabled, timeout: 55_000 }, async () => {
  const executablePath = process.env.OMW_BROWSER_EXECUTABLE
  assert.ok(executablePath, "OMW_BROWSER_EXECUTABLE is required")
  const sandbox = await mkdtemp(path.join(tmpdir(), "omw-browser-mobile-navigation-"))
  await Promise.all([
    mkdir(path.join(sandbox, "browser-profile", "AppData", "Roaming"), { recursive: true }),
    mkdir(path.join(sandbox, "browser-profile", "AppData", "Local"), { recursive: true }),
    mkdir(path.join(sandbox, "browser-profile", "Temp"), { recursive: true }),
  ])
  const repository = new ManagerRepository(":memory:")
  const service = new ManagerService(repository, new BrowserRuntime())
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../web/dist")
  const app = buildApp({ service, authority: { hostname: "127.0.0.1", port }, allowedOrigins: new Set([origin]), webRoot })
  const directory = path.join(sandbox, "mobile-navigation-project")
  const attentionInstances = Array.from({ length: 12 }, (_, index) => fakeManagedInstance({
    id: `inst-attention-${String(index).padStart(2, "0")}`,
    projectDirectory: directory,
    projectName: "mobile-navigation-project",
    pid: 21_000 + index,
    launchedAt: `2026-09-18T${String(10 + index).padStart(2, "0")}:00:00.000Z`,
    primarySession: { sessionId: `ses-attention-${index}`, title: `Attention work ${index}`, source: "activity", boundAt: "2026-09-18T09:00:00.000Z" },
    sessions: [{ id: `ses-attention-${index}`, title: `Attention work ${index}` }],
    summary: { activity: "reported-non-busy", busySessions: 0, pendingQuestions: 1, pendingPermissions: 0, error: null },
  }))
  const unknownInstance = fakeManagedInstance({
    id: "inst-unknown-active",
    projectDirectory: directory,
    projectName: "mobile-navigation-project",
    state: "unreachable",
    pid: null,
    primarySession: { sessionId: "ses-unknown", title: "Unknown active work", source: "activity", boundAt: "2026-09-18T09:00:00.000Z" },
    sessions: [{ id: "ses-unknown", title: "Unknown active work" }],
    summary: { activity: "unknown", busySessions: null, pendingQuestions: null, pendingPermissions: null, error: "fixture status unavailable" },
    stopAllowed: false,
    recovery: { recheckAllowed: true, resumeAllowed: true, hideAllowed: true, removeAllowed: false },
  })
  const stoppedInstance = fakeManagedInstance({
    id: "inst-history-stopped",
    projectDirectory: directory,
    projectName: "mobile-navigation-project",
    state: "stopped",
    pid: null,
    primarySession: { sessionId: "ses-history", title: "Historic title", source: "activity", boundAt: "2026-09-18T09:00:00.000Z" },
    sessions: [{ id: "ses-history", title: "Historic title" }],
    stopAllowed: false,
    recovery: { recheckAllowed: false, resumeAllowed: true, hideAllowed: false, removeAllowed: true },
  })
  const instances = [...attentionInstances, unknownInstance, stoppedInstance]
  let markDelayedSearchStarted: (() => void) | undefined
  const delayedSearchStarted = new Promise<void>((resolve) => { markDelayedSearchStarted = resolve })
  let releaseDelayedSearch: (() => void) | undefined
  const delayedSearchRelease = new Promise<void>((resolve) => { releaseDelayedSearch = resolve })
  let markDelayedFallbackStarted: (() => void) | undefined
  const delayedFallbackStarted = new Promise<void>((resolve) => { markDelayedFallbackStarted = resolve })
  let releaseDelayedFallback: (() => void) | undefined
  const delayedFallbackRelease = new Promise<void>((resolve) => { releaseDelayedFallback = resolve })
  let delayUnfilteredFallback = false
  let failOverview = false
  let stopCalls = 0
  let browser: Browser | undefined

  try {
    await app.listen({ host: "127.0.0.1", port })
    browser = await chromium.launch({ executablePath, headless: true, env: createBrowserEnvironment(sandbox) })
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" })
    await page.route("**/api/v1/**", async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      const respond = async (status: number, body?: unknown) => await route.fulfill({
        status,
        ...(body === undefined ? {} : { contentType: "application/json", body: JSON.stringify(body) }),
      })
      if (request.method() === "GET" && url.pathname === "/api/v1/overview") {
        if (failOverview) {
          await respond(503, { error: { code: "OVERVIEW_UNAVAILABLE", message: "overview unavailable fixture" } })
          return
        }
        const queryText = (url.searchParams.get("q") ?? "").trim().toLocaleLowerCase("zh-TW")
        const requestedFilter = url.searchParams.get("filter") ?? "all"
        if (delayUnfilteredFallback && !queryText && requestedFilter === "all") {
          markDelayedFallbackStarted?.()
          await delayedFallbackRelease
        }
        if (queryText === "historic title") {
          markDelayedSearchStarted?.()
          await delayedSearchRelease
        }
        let visible = instances.filter((instance) => !instance.trackingHidden)
        if (queryText) {
          visible = queryText === "no-match"
            ? []
            : visible.filter((instance) => [instance.projectName, instance.projectDirectory, instance.id,
                ...instance.sessions.flatMap((session) => [session.id, session.title])]
              .some((value) => value.toLocaleLowerCase("zh-TW").includes(queryText)))
        }
        if (requestedFilter === "attention") {
          visible = visible.filter((instance) => (instance.summary.pendingQuestions ?? 0) > 0 || (instance.summary.pendingPermissions ?? 0) > 0)
        }
        if (requestedFilter === "unreachable") visible = visible.filter((instance) => instance.state === "unreachable")
        await respond(200, { shortcuts: [], instances: visible })
        return
      }
      const match = /^\/api\/v1\/instances\/([^/]+)(?:\/(sessions|stop))?$/.exec(url.pathname)
      const instance = instances.find((item) => item.id === decodeURIComponent(match?.[1] ?? ""))
      const action = match?.[2]
      if (request.method() === "GET" && action === "sessions" && instance) {
        await respond(200, { roots: instance.sessions, unknownParent: [] })
        return
      }
      if (request.method() === "POST" && action === "stop" && instance) {
        stopCalls++
        Object.assign(instance, {
          state: "stopped",
          pid: null,
          stopAllowed: false,
          summary: { activity: "reported-non-busy", busySessions: 0, pendingQuestions: 0, pendingPermissions: 0, error: null },
          recovery: { recheckAllowed: false, resumeAllowed: true, hideAllowed: false, removeAllowed: true },
        } satisfies Partial<ManagedInstance>)
        await respond(200, instance)
        return
      }
      if (request.method() === "DELETE" && match && !action && instance) {
        instances.splice(instances.indexOf(instance), 1)
        await respond(204)
        return
      }
      await respond(404, { error: { code: "FIXTURE_ROUTE_MISSING", message: `${request.method()} ${url.pathname}` } })
    })

    await page.goto(origin, { waitUntil: "networkidle" })
    await page.locator(".instance-pane").waitFor()
    assert.match(await page.locator(".overview-freshness").textContent() ?? "", /最後更新/, "successful overview exposes its last-fetched timestamp")
    assert.deepEqual(await page.evaluate(() => ({ view: history.state.omwMobileView, instanceId: history.state.omwInstanceId })), { view: "list", instanceId: "" }, "mobile navigation initializes a replaceable list history entry")
    assert.equal(await page.locator(".detail-pane").isVisible(), false, "mobile opens on the list without overview auto-selection")
    assert.equal(await page.locator(".connectivity").isVisible(), true, "connectivity remains in the mobile list view")
    const historyToggle = page.locator(".history-toggle")
    assert.equal(await historyToggle.getAttribute("aria-expanded"), "false", "stopped history is collapsed by default")
    const stoppedRow = page.locator('.instance-row[data-instance-id="inst-history-stopped"]')
    assert.equal(await stoppedRow.isVisible(), false)
    const unknownRow = page.locator('.instance-row[data-instance-id="inst-unknown-active"]')
    assert.equal(await unknownRow.isVisible(), true, "unreachable remains in the active list")
    assert.match(await unknownRow.textContent() ?? "", /無法確認.*已失聯/s)

    await historyToggle.click()
    await page.getByRole("textbox", { name: "搜尋" }).fill("Attention work")
    await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/overview"),
      page.getByRole("button", { name: "執行搜尋" }).click(),
    ])
    await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/overview"),
      page.getByRole("button", { name: "需處理", exact: true }).click(),
    ])
    const includeHiddenToggle = page.getByRole("checkbox", { name: "顯示已停止追蹤" })
    await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/overview"),
      includeHiddenToggle.check(),
    ])
    await page.locator(".instance-row").last().scrollIntoViewIfNeeded()
    await page.evaluate(() => window.scrollBy(0, 80))
    const pureListScroll = await page.evaluate(() => window.scrollY)
    assert.equal(pureListScroll > 0, true, "pure-list fixture creates a saved scroll position")
    await page.reload({ waitUntil: "networkidle" })
    await page.locator(".instance-pane").waitFor()
    assert.equal(await page.getByRole("textbox", { name: "搜尋" }).inputValue(), "Attention work", "pure-list reload restores the current query")
    assert.equal(await page.locator(".filters button.active").textContent(), "需處理", "pure-list reload restores the current filter")
    assert.equal(await includeHiddenToggle.isChecked(), true, "pure-list reload restores include-hidden")
    assert.equal(await page.evaluate(() => Array.isArray(history.state.omwHistoryOpen) && history.state.omwHistoryOpen.length === 1), true, "pure-list reload restores history disclosure")
    assert.equal(await page.evaluate(() => Number(history.state.omwListScroll) > 0), true, "pure-list reload keeps a pagehide scroll snapshot")
    await page.waitForFunction(() => window.scrollY > 0)

    await page.getByRole("textbox", { name: "搜尋" }).fill("")
    await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/overview"),
      page.getByRole("button", { name: "執行搜尋" }).click(),
    ])
    await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/overview"),
      page.getByRole("button", { name: "全部", exact: true }).click(),
    ])
    await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/overview"),
      includeHiddenToggle.uncheck(),
    ])
    await page.waitForFunction(() => document.querySelectorAll(".instance-row").length === 14)
    assert.equal(await historyToggle.getAttribute("aria-expanded"), "true", "restored disclosure remains applied when stopped history is visible again")
    await historyToggle.click()
    assert.equal(await historyToggle.getAttribute("aria-expanded"), "false")

    await page.getByRole("textbox", { name: "搜尋" }).fill("Historic title")
    assert.equal(await historyToggle.getAttribute("aria-expanded"), "false", "unsubmitted input does not expand history for the old overview")
    await page.getByRole("button", { name: "執行搜尋" }).click()
    await delayedSearchStarted
    assert.equal(await historyToggle.getAttribute("aria-expanded"), "false", "pending search does not apply its query before the response")
    assert.equal(await stoppedRow.isVisible(), false)
    releaseDelayedSearch?.()
    await stoppedRow.waitFor()
    assert.equal(await historyToggle.getAttribute("aria-expanded"), "true", "search reveals matching stopped history")
    assert.match(await page.locator(".project-group-head").textContent() ?? "", /mobile-navigation-project.*1/s, "stopped-only results keep their folder and count")
    await page.getByRole("textbox", { name: "搜尋" }).fill("")
    assert.equal(await historyToggle.getAttribute("aria-expanded"), "true", "clearing input without submitting keeps the applied search visible")
    await page.getByRole("button", { name: "執行搜尋" }).click()
    await page.waitForFunction(() => document.querySelectorAll(".instance-row").length === 14)
    assert.equal(await historyToggle.getAttribute("aria-expanded"), "false", "clearing search restores the prior collapsed preference")
    await historyToggle.click()
    assert.equal(await historyToggle.getAttribute("aria-expanded"), "true", "history can be expanded before selecting a stopped Instance")
    await stoppedRow.click()
    await page.locator(".detail-pane").waitFor()
    await page.getByRole("button", { name: "返回列表" }).click()
    await page.locator(".instance-pane").waitFor()
    assert.equal(await historyToggle.getAttribute("aria-expanded"), "true", "returning from a stopped Instance keeps the user's expanded preference")
    await historyToggle.click()
    assert.equal(await historyToggle.getAttribute("aria-expanded"), "false", "history can be collapsed after returning from a stopped Instance")
    await historyToggle.click()
    assert.equal(await historyToggle.getAttribute("aria-expanded"), "true", "history can be expanded again after returning from a stopped Instance")
    await page.getByRole("button", { name: "需處理", exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll(".instance-row").length === 12)
    const selectedRow = page.locator('.instance-row[data-instance-id="inst-attention-02"]')
    await selectedRow.scrollIntoViewIfNeeded()
    await page.evaluate(() => window.scrollBy(0, 120))
    const listScroll = await page.evaluate(() => window.scrollY)
    assert.equal(listScroll > 0, true, "fixture creates a non-zero list scroll position")
    await selectedRow.click()
    await page.locator(".detail-pane").waitFor()
    assert.deepEqual(await page.evaluate(() => ({ view: history.state.omwMobileView, instanceId: history.state.omwInstanceId })), { view: "detail", instanceId: "inst-attention-02" })
    assert.equal(await page.locator(".instance-pane").isVisible(), false, "mobile detail hides the instance list")
    assert.equal(await page.locator(".connectivity").isVisible(), false, "mobile detail hides the connectivity section")
    assert.equal(await page.getByRole("button", { name: "返回列表" }).evaluate((button) => button.getBoundingClientRect().height >= 44), true)
    assert.equal(await page.getByRole("button", { name: "進入主 Session" }).evaluate((button) => button.getBoundingClientRect().bottom <= window.innerHeight), true, "primary action is available above the 390px mobile fold")
    const technicalInfo = page.getByText("Technical info", { exact: true })
    assert.equal(await technicalInfo.evaluate((summary) => !(summary.parentElement as HTMLDetailsElement).open), true, "technical identity is collapsed by default")
    const primaryAttention = page.locator(".primary-session-attention")
    assert.match(await primaryAttention.textContent() ?? "", /1 項待回答/, "pending requests are explicit beside the primary Session")
    assert.equal(await primaryAttention.evaluate((alert) => alert.previousElementSibling?.classList.contains("primary-session-card")), true, "pending requests stay adjacent to the primary Session")
    const bindingDetails = page.locator(".main-session-details")
    assert.equal(await bindingDetails.evaluate((details) => !(details as HTMLDetailsElement).open), true, "long binding guidance is opt-in")

    await page.goBack()
    await page.locator(".instance-pane").waitFor()
    assert.equal(await page.locator(".detail-pane").isVisible(), false, "browser Back returns to the mobile list")
    await page.goForward()
    await page.locator(".detail-pane").waitFor()
    assert.equal(await page.locator('.detail-pane h2').textContent(), "Attention work 2", "browser Forward restores the selected Instance")
    await page.evaluate(() => {
      window.addEventListener("popstate", () => window.history.forward(), { once: true })
      window.history.back()
    })
    await page.waitForFunction(() => history.state.omwMobileView === "detail" && document.querySelector<HTMLElement>(".detail-pane")?.offsetParent !== null)
    assert.equal(await page.locator('.detail-pane h2').textContent(), "Attention work 2", "rapid Back/Forward cannot leave a stale list restore over the detail target")

    await page.evaluate(() => window.history.replaceState({ ...window.history.state, omwFilter: "unreachable" }, ""))
    delayUnfilteredFallback = true
    await page.reload({ waitUntil: "domcontentloaded" })
    await delayedFallbackStarted
    await page.goBack()
    await page.waitForFunction(() => history.state.omwMobileView === "list")
    delayUnfilteredFallback = false
    releaseDelayedFallback?.()
    await page.locator(".loading-copy").waitFor({ state: "hidden" })
    assert.equal(await page.evaluate(() => history.state.omwMobileView), "list", "a delayed detail fallback cannot rewrite a newer Back target")
    assert.equal(await page.locator(".detail-pane").isVisible(), false, "a delayed detail fallback cannot reopen detail after Back")
    await page.goForward()
    await page.locator(".detail-pane").waitFor()
    assert.equal(await page.locator('.detail-pane h2').textContent(), "Attention work 2", "Forward remains valid after a delayed fallback loses the route race")
    await page.evaluate(() => window.history.replaceState({ ...window.history.state, omwFilter: "attention" }, ""))

    await page.reload({ waitUntil: "networkidle" })
    await page.locator(".detail-pane").waitFor()
    assert.equal(await page.locator('.detail-pane h2').textContent(), "Attention work 2", "refresh restores the mobile detail from history state")
    assert.equal(await page.locator(".instance-pane").isVisible(), false)

    await page.setViewportSize({ width: 360, height: 844 })
    const compactSummary = await page.locator(".summary-grid").evaluate((grid) => {
      const cards = [...grid.querySelectorAll("article")].map((card) => card.getBoundingClientRect())
      return {
        sameRow: cards.every((card) => Math.abs(card.top - cards[0]!.top) < 1),
        readable: cards.every((card) => card.width > 0 && card.height > 0),
        noOverflow: document.documentElement.scrollWidth <= window.innerWidth,
      }
    })
    assert.deepEqual(compactSummary, { sameRow: true, readable: true, noOverflow: true }, "360px summary remains a readable, non-overflowing three-column row")
    await page.setViewportSize({ width: 390, height: 844 })

    const screenshotDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../.scratch")
    await mkdir(screenshotDirectory, { recursive: true })
    await page.screenshot({ path: path.join(screenshotDirectory, "detail-390.png"), fullPage: true, animations: "disabled" })
    await page.getByRole("button", { name: "返回列表" }).click()
    assert.equal(await page.getByRole("textbox", { name: "搜尋" }).inputValue(), "")
    assert.equal(await page.locator(".filters button.active").textContent(), "需處理")
    assert.equal(await page.evaluate(() => window.scrollY > 0), true, "return restores list scroll")
    assert.equal(await selectedRow.evaluate((row) => row === document.activeElement), true, "return restores focus to the selected row")
    await page.getByRole("button", { name: "全部", exact: true }).click()
    assert.equal(await historyToggle.getAttribute("aria-expanded"), "true", "filtering does not erase the user's history disclosure preference")
    await page.screenshot({ path: path.join(screenshotDirectory, "mobile-navigation-list-390.png"), fullPage: true, animations: "disabled" })

    await selectedRow.click()
    await page.evaluate(() => window.history.replaceState({ ...window.history.state, omwFilter: "unreachable" }, ""))
    failOverview = true
    await page.reload({ waitUntil: "networkidle" })
    assert.equal(await page.evaluate(() => history.state.omwMobileView), "detail", "an initial overview failure preserves the requested detail history entry")
    assert.match(await page.locator(".overview-freshness").textContent() ?? "", /尚未取得執行個體資料/, "first-fetch failure is unavailable, not stale")
    failOverview = false
    await page.getByRole("button", { name: "重試更新" }).click()
    await page.locator(".detail-pane").waitFor()
    assert.equal(await page.locator('.detail-pane h2').textContent(), "Attention work 2", "retry uses an unfiltered overview fallback to restore a filtered-out detail")
    assert.equal(await page.locator(".filters button.active").textContent(), "全部", "fallback visibly clears the excluding filter")

    await page.evaluate(() => window.history.replaceState({ ...window.history.state, omwMobileView: "detail", omwInstanceId: "inst-removed" }, ""))
    await page.reload({ waitUntil: "networkidle" })
    await page.locator(".instance-pane").waitFor()
    await page.getByText("原執行個體已不存在，已返回列表。", { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => history.state.omwMobileView), "list", "a confirmed missing record replaces the invalid detail history entry")

    await selectedRow.click()
    await page.getByRole("button", { name: "執行個體操作" }).click()
    await page.getByRole("button", { name: "停止執行個體" }).click()
    const staleStopDialog = page.getByRole("alertdialog", { name: "停止整個執行個體？" })
    await page.setViewportSize({ width: 390, height: 360 })
    assert.equal(await staleStopDialog.getByRole("button", { name: "停止執行個體" }).evaluate((button) => button.getBoundingClientRect().bottom <= window.innerHeight), true, "short mobile viewport keeps the destructive dialog action visible")
    await page.setViewportSize({ width: 390, height: 844 })
    failOverview = true
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))
    await page.getByText(/資料已過期，最後更新/).waitFor()
    await staleStopDialog.waitFor({ state: "hidden" })
    assert.equal(stopCalls, 0, "a confirmation opened before staleness cannot mutate after the foreground check starts")
    assert.equal(await page.getByRole("button", { name: "停止執行個體" }).isDisabled(), true, "stale overview disables capability-dependent mutations")
    failOverview = false
    await page.getByRole("button", { name: "重試更新" }).click()
    await page.waitForFunction(() => !document.body.textContent?.includes("資料已過期，最後更新"))
    assert.equal(await page.getByRole("button", { name: "停止執行個體" }).isEnabled(), true, "successful refresh silently clears the stale mutation gate")
    await page.getByRole("button", { name: "停止執行個體" }).click()
    await page.getByRole("alertdialog", { name: "停止整個執行個體？" }).getByRole("button", { name: "停止執行個體" }).click()
    await page.getByText("背景執行個體已停止。", { exact: true }).waitFor()
    assert.equal(stopCalls, 1)
    assert.equal(await page.locator(".detail-pane").isVisible(), true, "a stopped selection remains in detail for resume or removal")
    assert.match(await page.locator(".detail-head .state-chip").textContent() ?? "", /已停止/)
    await page.getByRole("button", { name: "移除紀錄" }).click()
    await page.getByRole("alertdialog", { name: "移除 OMW 紀錄與綁定？" }).getByRole("button", { name: "移除紀錄" }).click()
    await page.getByText("OMW 追蹤紀錄與綁定已移除；OpenCode Sessions 與檔案未受影響。", { exact: true }).waitFor()
    assert.equal(await page.locator(".instance-pane").isVisible(), true, "removing the selected record returns mobile to the list")
    assert.equal(await page.locator(".detail-pane").isVisible(), false)

    await page.getByRole("textbox", { name: "搜尋" }).fill("no-match")
    await page.getByRole("button", { name: "執行搜尋" }).click()
    await page.getByText("沒有符合目前搜尋或篩選條件的執行個體。", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "啟動執行個體", exact: true }).count() <= 2, true, "filtered empty never multiplies start CTAs")
    await page.getByRole("button", { name: "清除篩選" }).click()
    await page.locator(".instance-row").first().waitFor()

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.waitForFunction(() => document.querySelector(".instance-pane")?.getBoundingClientRect().width !== 0
      && document.querySelector(".detail-pane")?.getBoundingClientRect().width !== 0)
    assert.equal(await page.locator(".instance-pane").isVisible(), true)
    assert.equal(await page.locator(".detail-pane").isVisible(), true, "desktop keeps the two-pane overview")
    await page.screenshot({ path: path.join(screenshotDirectory, "desktop-1440.png"), fullPage: true, animations: "disabled" })
  } finally {
    await browser?.close()
    releaseDelayedFallback?.()
    await app.close().catch(() => undefined)
    repository.close()
    await rm(sandbox, { recursive: true, force: true })
  }
})

test("mobile UI covers Shortcut, browsing, filters, scoped Session trees, and Stop errors", { skip: !enabled, timeout: 55_000 }, async () => {
  const executablePath = process.env.OMW_BROWSER_EXECUTABLE
  assert.ok(executablePath, "OMW_BROWSER_EXECUTABLE is required")
  const sandbox = await mkdtemp(path.join(tmpdir(), "omw-browser-"))
  const projectA = path.join(sandbox, "project-a")
  const projectB = path.join(sandbox, "project-b")
  const childDirectory = path.join(projectA, "child-folder")
  await Promise.all([
    mkdir(childDirectory, { recursive: true }),
    mkdir(projectB),
    mkdir(path.join(sandbox, "browser-profile", "AppData", "Roaming"), { recursive: true }),
    mkdir(path.join(sandbox, "browser-profile", "AppData", "Local"), { recursive: true }),
    mkdir(path.join(sandbox, "browser-profile", "Temp"), { recursive: true }),
  ])
  const repository = new ManagerRepository(path.join(sandbox, "omw.sqlite"))
  const runtime = new BrowserRuntime()
  const service = new ManagerService(repository, runtime)
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../web/dist")
  const app = buildApp({
    service,
    authority: { hostname: "127.0.0.1", port },
    allowedOrigins: new Set([origin]),
    webRoot,
  })
  const serverErrors: string[] = []
  app.addHook("onError", async (_request, _reply, error) => { serverErrors.push(error.stack ?? error.message) })
  let browser: Browser | undefined

  try {
    await app.listen({ host: "127.0.0.1", port })
    browser = await chromium.launch({ executablePath, headless: true, env: createBrowserEnvironment(sandbox) })
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    const pageErrors: string[] = []
    let popupCount = 0
    page.on("pageerror", (error) => pageErrors.push(error.message))
    page.on("popup", () => { popupCount++ })
    await page.goto(origin, { waitUntil: "networkidle" })
    await page.context().route("**/opened/**", async (route) => {
      await route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Fixture destination</title>" })
    })

    const startTrigger = page.locator(".topbar").getByRole("button", { name: "啟動執行個體" })
    await startTrigger.click()
    const startDialog = page.getByRole("dialog", { name: "啟動執行個體" })
    await startDialog.waitFor()
    const pointerEnterMotion = await page.locator(".start-panel-overlay").evaluate((overlay) => ({
      motion: (overlay as HTMLElement).dataset.motion,
      duration: Number.parseFloat(getComputedStyle(overlay).transitionDuration),
      panelTransition: getComputedStyle(overlay.querySelector<HTMLElement>(".start-panel")!).transitionProperty,
    }))
    assert.equal(pointerEnterMotion.motion, "pointer", "pointer-opened start panel uses pointer motion")
    assert.equal(pointerEnterMotion.duration > 0 && pointerEnterMotion.duration <= 0.18, true, "pointer enter is a short opacity transition")
    assert.match(pointerEnterMotion.panelTransition, /transform/, "pointer enter transitions only the panel transform")
    assert.equal(await page.getByLabel("Shortcut 名稱").evaluate((input) => input === document.activeElement), true, "opening the panel focuses its first field")
    const closeStartPanel = page.getByRole("button", { name: "關閉啟動面板" })
    await closeStartPanel.focus()
    await page.keyboard.press("Shift+Tab")
    assert.equal(await page.getByRole("button", { name: "瀏覽", exact: true }).evaluate((button) => button === document.activeElement), true, "backward Tab wraps within the start panel")
    await page.keyboard.press("Tab")
    assert.equal(await closeStartPanel.evaluate((button) => button === document.activeElement), true, "forward Tab wraps within the start panel")
    await page.getByLabel("Shortcut 名稱").fill("未送出的捷徑")
    await closeStartPanel.click()
    const pointerLeaveState = await page.locator(".start-panel-overlay").evaluate((overlay) => ({
      inert: (overlay as HTMLElement).inert,
      pointerEvents: getComputedStyle(overlay).pointerEvents,
      duration: Number.parseFloat(getComputedStyle(overlay).transitionDuration),
    }))
    assert.equal(pointerLeaveState.inert, true, "leaving panel is inert before its DOM is removed")
    assert.equal(pointerLeaveState.pointerEvents, "none", "leaving panel cannot submit or receive pointer input")
    assert.equal(pointerLeaveState.duration > 0 && pointerLeaveState.duration <= 0.12, true, "pointer leave is shorter than enter")
    await startDialog.waitFor({ state: "hidden" })
    await page.waitForFunction(() => document.activeElement?.closest(".topbar") !== null)
    assert.equal(await startTrigger.evaluate((button) => button === document.activeElement), true, "closing the panel returns focus to its trigger")
    await startTrigger.focus()
    await page.keyboard.press("Enter")
    assert.equal(await page.locator(".start-panel-overlay").getAttribute("data-motion"), "none", "keyboard-opened start panel skips motion")
    assert.equal(await page.locator(".start-panel-overlay").evaluate((overlay) => Number.parseFloat(getComputedStyle(overlay).transitionDuration)), 0, "keyboard-opened start panel has no transition")
    assert.equal(await page.getByLabel("Shortcut 名稱").inputValue(), "未送出的捷徑", "closing the panel preserves input state")
    await page.keyboard.press("Escape")
    await startDialog.waitFor({ state: "hidden" })
    await page.waitForFunction(() => document.activeElement?.closest(".topbar") !== null)
    assert.equal(await startTrigger.evaluate((button) => button === document.activeElement), true, "Escape returns focus to the panel trigger")

    await startTrigger.click()
    await startDialog.waitFor()
    await page.getByRole("button", { name: "關閉啟動面板" }).click()
    assert.equal(await page.locator(".start-panel-overlay").evaluate((overlay) => (overlay as HTMLElement).inert), true, "rapid pointer close keeps the leaving form inert")
    await startDialog.waitFor({ state: "hidden" })
    await page.waitForFunction(() => document.activeElement?.closest(".topbar") !== null)
    assert.equal(await startTrigger.evaluate((button) => button === document.activeElement), true, "rapid open-close still restores focus")

    await startTrigger.click()
    await page.getByLabel("Shortcut 名稱").fill("")
    for (const width of [1440, 390, 360]) {
      await page.setViewportSize({ width, height: 844 })
      await assertShortcutFormLayout(page, width)
    }
    await page.setViewportSize({ width: 390, height: 844 })

    await page.getByLabel("Shortcut 名稱").fill("瀏覽器測試")
    await page.getByLabel("Shortcut 目錄").fill(projectA)
    await page.getByRole("button", { name: "新增目錄" }).click()
    await page.getByText("瀏覽器測試", { exact: true }).waitFor()
    assert.equal(repository.listShortcuts().length, 1)

    await page.getByRole("button", { name: "編輯 Shortcut" }).click()
    await page.getByLabel("Shortcut 名稱").fill("已更新捷徑")
    await page.getByLabel("Shortcut 目錄").fill(projectB)
    await page.getByRole("button", { name: "更新捷徑" }).click()
    await page.getByText("已更新捷徑", { exact: true }).waitFor()
    assert.equal(repository.listShortcuts()[0]?.directory.toLowerCase(), projectB.toLowerCase())

    await page.getByLabel("瀏覽目錄").fill(projectA)
    await page.getByRole("button", { name: "瀏覽", exact: true }).click()
    await page.getByRole("button", { name: /child-folder/ }).click()
    await page.getByText(childDirectory, { exact: true }).waitFor()
    await page.getByRole("button", { name: "上層目錄" }).click()
    await page.getByText(projectA, { exact: true }).waitFor()

    const removeShortcutTrigger = page.getByRole("button", { name: "移除 Shortcut" })
    await removeShortcutTrigger.focus()
    await removeShortcutTrigger.click()
    const nestedConfirmation = page.getByRole("alertdialog", { name: "移除目錄捷徑？" })
    await nestedConfirmation.waitFor()
    const confirmationScreenshotDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../.scratch")
    await mkdir(confirmationScreenshotDirectory, { recursive: true })
    await page.screenshot({ path: path.join(confirmationScreenshotDirectory, "confirmation-dialog-390.png"), fullPage: true })
    assert.equal(await page.locator(".start-panel").isVisible(), true, "the parent start dialog remains mounted under confirmation")
    assert.equal(await page.locator(".start-panel").evaluate((panel) => panel.closest('[aria-hidden="true"]') !== null), true, "the parent start dialog is hidden from assistive technology while nested confirmation owns focus")
    const cancelConfirmation = nestedConfirmation.getByRole("button", { name: "取消" })
    const confirmShortcutRemoval = nestedConfirmation.getByRole("button", { name: "移除捷徑" })
    assert.equal(await cancelConfirmation.evaluate((button) => button === document.activeElement), true, "safe cancel receives initial focus")
    await page.keyboard.press("Shift+Tab")
    assert.equal(await confirmShortcutRemoval.evaluate((button) => button === document.activeElement), true, "confirmation traps backward focus")
    await page.keyboard.press("Tab")
    assert.equal(await cancelConfirmation.evaluate((button) => button === document.activeElement), true, "confirmation traps forward focus")
    await page.keyboard.press("Escape")
    await nestedConfirmation.waitFor({ state: "hidden" })
    assert.equal(repository.listShortcuts().length, 1, "Escape cancels without deleting the shortcut")
    assert.equal(await startDialog.isVisible(), true, "Escape closes only the nested confirmation")
    assert.equal(await removeShortcutTrigger.evaluate((button) => button === document.activeElement), true, "cancel restores focus to its trigger")
    await removeShortcutTrigger.click()
    const pointerCancelConfirmation = page.getByRole("alertdialog", { name: "移除目錄捷徑？" })
    await pointerCancelConfirmation.getByRole("button", { name: "取消" }).click()
    const pointerCancelLeave = page.locator(".confirmation-content")
    assert.equal(await pointerCancelLeave.getAttribute("data-state"), "closed", "pointer cancel starts the confirmation leave")
    assert.match(await pointerCancelLeave.textContent() ?? "", /移除目錄捷徑？|將移除/, "cancel leave retains the original confirmation snapshot")
    await pointerCancelConfirmation.waitFor({ state: "hidden" })
    assert.equal(await removeShortcutTrigger.evaluate((button) => button === document.activeElement), true, "pointer cancel restores focus to its trigger")
    assert.equal(repository.listShortcuts().length, 1, "pointer cancel does not invoke the old accept callback")

    let releaseDelayedShortcutFailure: (() => void) | undefined
    const delayedShortcutFailure = new Promise<void>((resolve) => { releaseDelayedShortcutFailure = resolve })
    await page.route("**/api/v1/shortcuts/*", async (route) => {
      if (route.request().method() !== "DELETE") {
        await route.continue()
        return
      }
      await delayedShortcutFailure
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "SHORTCUT_DELETE_FAILED", message: "delayed shortcut failure" } }),
      })
    })
    await removeShortcutTrigger.click()
    const delayedFailureDialog = page.getByRole("alertdialog", { name: "移除目錄捷徑？" })
    await delayedFailureDialog.getByRole("button", { name: "移除捷徑" }).click()
    await delayedFailureDialog.waitFor({ state: "hidden" })
    const browseControl = page.getByRole("button", { name: "瀏覽", exact: true })
    await browseControl.focus()
    assert.equal(await browseControl.evaluate((button) => button === document.activeElement), true, "user focus moves to another safe control while delete is pending")
    assert.ok(releaseDelayedShortcutFailure, "delayed shortcut failure gate is ready")
    releaseDelayedShortcutFailure()
    await page.getByText("delayed shortcut failure", { exact: true }).waitFor()
    assert.equal(await browseControl.evaluate((button) => button === document.activeElement), true, "completed failed delete does not steal the user's newer focus")
    await page.unroute("**/api/v1/shortcuts/*")

    await removeShortcutTrigger.click()
    const firstRemoveDialog = page.getByRole("alertdialog", { name: "移除目錄捷徑？" })
    await firstRemoveDialog.getByRole("button", { name: "移除捷徑" }).click()
    const firstRemoveLeave = page.locator(".confirmation-content")
    assert.equal(await firstRemoveLeave.getAttribute("data-state"), "closed", "pointer confirm starts the confirmation leave")
    assert.match(await firstRemoveLeave.textContent() ?? "", /移除目錄捷徑？|將移除/, "confirm leave retains the original confirmation snapshot")
    await page.getByText("目錄捷徑已移除；執行個體未受影響。", { exact: true }).waitFor()
    assert.equal(repository.listShortcuts().length, 0, `${await page.locator("body").innerText()}\n${serverErrors.join("\n")}`)
    assert.equal(repository.listShortcuts().length, 0)
    assert.equal(await page.evaluate(() => document.activeElement?.closest(".start-panel") !== null), true, "successful shortcut deletion keeps focus in the parent start panel")
    assert.equal(await page.evaluate(() => document.activeElement?.closest("[inert]") === null), true, "successful shortcut deletion does not focus an inert ancestor")
    assert.equal(await page.evaluate(() => document.activeElement !== document.body), true, "deleted shortcut trigger falls back without focusing body")

    await page.route("**/api/v1/instances", async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "START_FAILED", message: "start failure fixture" } }),
      })
    })
    await page.getByRole("button", { name: /啟動全新 Instance/ }).click()
    await page.getByText("start failure fixture", { exact: true }).waitFor()
    assert.equal(await startDialog.isVisible(), true, "a failed start keeps the panel open")
    const nextPoll = page.waitForResponse((response) => response.url().includes("/api/v1/overview?") && response.ok(), { timeout: 7_000 })
    await nextPoll
    assert.equal(await page.getByText("start failure fixture", { exact: true }).isVisible(), true, "successful background polling must not clear an action error")
    await page.unroute("**/api/v1/instances")

    await page.getByRole("button", { name: /啟動全新 Instance/ }).click()
    await page.locator(".detail-pane .state-chip small").getByText("可連線", { exact: true }).waitFor()
    await startDialog.waitFor({ state: "hidden" })
    await page.waitForFunction(() => !document.querySelector(".shell")?.hasAttribute("inert"))
    await page.getByText(/執行個體已啟動（[a-f0-9-]{8}）。/).waitFor()
    await page.waitForTimeout(250)
    const startResultLayout = await page.evaluate(() => {
      const detail = document.querySelector<HTMLElement>(".detail-pane")
      const toast = document.querySelector<HTMLElement>(".toast-success")
      const toastRegion = document.querySelector<HTMLElement>(".toast-region")
      if (!detail || !toast || !toastRegion) throw new Error("successful start detail or toast is missing")
      const detailBounds = detail.getBoundingClientRect()
      const toastBounds = toast.getBoundingClientRect()
      return {
        detailVisible: detailBounds.top < window.innerHeight && detailBounds.bottom > 0,
        detailFocused: detail === document.activeElement,
        scrolled: window.scrollY > 0,
        toastInViewport: toastBounds.top >= 0 && toastBounds.bottom <= window.innerHeight,
        toastPosition: getComputedStyle(toastRegion).position,
      }
    })
    assert.equal(startResultLayout.detailVisible, true, "successful start reveals the selected detail on mobile")
    assert.equal(startResultLayout.detailFocused, true, "successful start moves focus to the selected detail")
    assert.equal(startResultLayout.scrolled, false, "successful start does not retain the hidden list scroll position")
    assert.equal(startResultLayout.toastInViewport, true, "success toast stays in the viewport after scrolling")
    assert.equal(startResultLayout.toastPosition, "fixed", "the toast region is fixed to the viewport")

    await startTrigger.click()
    await page.getByLabel("瀏覽目錄").fill(projectB)
    await page.getByRole("button", { name: "瀏覽", exact: true }).click()
    await page.route("**/api/v1/instances", async (route) => {
      const response = await route.fetch()
      const body = await response.json() as Record<string, unknown>
      await route.fulfill({
        status: response.status(),
        contentType: "application/json",
        body: JSON.stringify({ ...body, state: "unreachable" }),
      })
    })
    await page.getByRole("button", { name: /啟動全新 Instance/ }).click()
    await page.getByText("摘要未知：INSTANCE_SUMMARY_PARTIAL", { exact: true }).waitFor()
    await startDialog.waitFor({ state: "hidden" })
    await page.waitForFunction(() => !document.querySelector(".shell")?.hasAttribute("inert"))
    await page.getByText(/執行個體已啟動，目前無法連線，請查看狀態（[a-f0-9-]{8}）。/).waitFor()
    await page.unroute("**/api/v1/instances")
    assert.equal(repository.listInstances().length, 2)

    await returnToInstanceList(page)
    const searchInput = page.getByRole("textbox", { name: "搜尋" })
    await searchInput.fill("project-a")
    assert.equal(await searchInput.inputValue(), "project-a")
    const searchRequest = page.waitForRequest((request) => {
      const requestUrl = new URL(request.url())
      return requestUrl.pathname === "/api/v1/overview" && requestUrl.searchParams.get("q") === "project-a"
    }, { timeout: 5_000 })
    await page.getByRole("button", { name: "執行搜尋" }).click()
    await searchRequest
    await page.waitForFunction(() => document.querySelectorAll(".instance-row").length === 1)
    assert.equal(await page.locator(".instance-row").count(), 1)
    await page.getByRole("textbox", { name: "搜尋" }).fill("")
    await page.getByRole("button", { name: "執行搜尋" }).click()
    await page.waitForFunction(() => document.querySelectorAll(".instance-row").length === 2)

    await page.getByRole("button", { name: "有執行中", exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll(".instance-row").length === 1)
    assert.equal(await page.locator(".instance-row").count(), 1)
    await page.getByRole("button", { name: "需處理", exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll(".instance-row").length === 1)
    assert.equal(await page.locator(".instance-row").count(), 1)
    await page.getByRole("button", { name: "已失聯", exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll(".instance-row").length === 1)
    assert.equal(await page.locator(".instance-row").count(), 1)
    await page.getByRole("button", { name: "全部", exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll(".instance-row").length === 2)

    const instanceA = page.getByTitle(projectA).locator("..").locator(".instance-row")
    const instanceB = page.getByTitle(projectB).locator("..").locator(".instance-row")
    await instanceA.click()
    await page.locator(".primary-session-card").getByText("尚未綁定主 Session", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "進入主 Session" }).isDisabled(), true)
    const advancedSessions = page.locator("details.advanced-sessions")
    assert.equal(await advancedSessions.evaluate((details) => (details as HTMLDetailsElement).open), false)
    await advancedSessions.locator("summary").click()
    await page.getByRole("option", { name: "Root A (ses_shared)" }).waitFor({ state: "attached" })
    await page.getByRole("button", { name: "載入 Child Session" }).click()
    await page.getByText("Child A", { exact: true }).waitFor()
    const childA = page.locator(".session-node").filter({ hasText: "Child A" }).first()
    await childA.getByRole("button", { name: "載入 Child Session" }).click()
    await page.getByText("Nested A", { exact: true }).waitFor()

    await returnToInstanceList(page)
    await instanceB.click()
    await page.locator(".primary-session-card").getByText("尚未綁定主 Session", { exact: true }).waitFor()
    assert.equal(await advancedSessions.evaluate((details) => (details as HTMLDetailsElement).open), false, "advanced details reset when Instance scope changes")
    assert.equal(await page.getByText("Child A", { exact: true }).count(), 0)
    assert.equal(await page.locator(".primary-session-card").getByText("Shared history", { exact: true }).count(), 0, "shared history must not be presented as the primary binding")
    assert.equal(await page.getByText("Shared history", { exact: true }).isVisible(), false, "advanced history stays collapsed by default")

    const instanceBRecord = repository.listInstances().find((item) => item.projectName === "project-b")
    assert.ok(instanceBRecord)
    const instanceBId = instanceBRecord.id
    runtime.setProjectBReady()
    await runtime.emitActivity(instanceBId, { type: "activity", source: "event", sessionIds: ["ses_second"] })
    await page.locator(".topbar").getByRole("button", { name: "重新整理" }).click()
    await page.locator(".primary-session-card").getByText("Second instance work", { exact: true }).waitFor()
    assert.equal(await page.locator(".primary-session-id").textContent(), "ses_seco")

    await runtime.emitActivity(instanceBId, { type: "activity", source: "snapshot", sessionIds: [] })
    await runtime.emitActivity(instanceBId, { type: "activity", source: "event", sessionIds: ["ses_later"] })
    await page.locator(".topbar").getByRole("button", { name: "重新整理" }).click()
    await page.locator(".primary-session-card").getByText("Second instance work", { exact: true }).waitFor()
    assert.equal(await page.locator(".primary-session-card").getByText("Later unrelated work", { exact: true }).count(), 0, "later activity must not replace the fixed binding")

    let openRequestBody: unknown
    let releaseOpenUrl = () => {}
    const openUrlGate = new Promise<void>((resolve) => { releaseOpenUrl = resolve })
    let observeOpenUrl = () => {}
    const openUrlObserved = new Promise<void>((resolve) => { observeOpenUrl = resolve })
    await page.route("**/api/v1/instances/*/open-url", async (route) => {
      openRequestBody = route.request().postDataJSON()
      observeOpenUrl()
      await openUrlGate
      await route.fulfill({ json: { url: `${origin}/opened/primary-s2`, instanceId: instanceBId, sessionId: "ses_second" } })
    })
    const primaryPopupPromise = page.waitForEvent("popup")
    await page.getByRole("button", { name: "進入主 Session" }).click()
    const primaryPopup = await primaryPopupPromise
    await openUrlObserved
    await primaryPopup.getByText("正在連線到 OpenCode Web…", { exact: true }).waitFor()
    assert.equal(await primaryPopup.evaluate(() => window.opener), null)
    assert.equal(await primaryPopup.locator('meta[name="referrer"]').getAttribute("content"), "no-referrer")
    assert.deepEqual(openRequestBody, { sessionId: "ses_second" })
    releaseOpenUrl()
    await primaryPopup.waitForURL(`${origin}/opened/primary-s2`)
    await primaryPopup.close()
    await page.unroute("**/api/v1/instances/*/open-url")

    await page.route("**/api/v1/instances/*/open-url", async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "OPEN_FAILED", message: "open failure fixture" } }),
      })
    })
    const failedPopupPromise = page.waitForEvent("popup")
    await page.getByRole("button", { name: "進入主 Session" }).click()
    const failedPopup = await failedPopupPromise
    await page.getByText("open failure fixture", { exact: true }).waitFor()
    assert.equal(failedPopup.isClosed(), true, "failed open-url closes only the owned blank popup")
    await page.unroute("**/api/v1/instances/*/open-url")

    let blockedPopupRequests = 0
    await page.route("**/api/v1/instances/*/open-url", async (route) => {
      blockedPopupRequests++
      await route.fulfill({ json: { url: `${origin}/opened/unexpected`, instanceId: instanceBId, sessionId: "ses_second" } })
    })
    await page.evaluate(() => {
      Reflect.set(window, "__omwOriginalOpen", window.open)
      window.open = () => null
    })
    await page.getByRole("button", { name: "進入主 Session" }).click()
    await page.getByText("瀏覽器封鎖了彈出視窗，請允許此網站開啟新分頁後再試。", { exact: true }).waitFor()
    await page.waitForTimeout(50)
    assert.equal(blockedPopupRequests, 0, "a blocked popup must not fire an unusable open-url request")
    await page.evaluate(() => {
      const originalOpen = Reflect.get(window, "__omwOriginalOpen")
      if (typeof originalOpen === "function") window.open = originalOpen as typeof window.open
      Reflect.deleteProperty(window, "__omwOriginalOpen")
    })
    await page.unroute("**/api/v1/instances/*/open-url")

    const createCallsBeforeCancel = runtime.createSessionCalls
    await page.getByRole("button", { name: "New Session" }).click()
    const cancelledNewSession = page.getByRole("alertdialog", { name: "建立 New Session？" })
    await cancelledNewSession.getByRole("button", { name: "取消" }).click()
    await cancelledNewSession.waitFor({ state: "hidden" })
    await page.waitForTimeout(50)
    assert.equal(runtime.createSessionCalls, createCallsBeforeCancel, "cancelled New Session must not create a Session")
    assert.equal(await page.locator(".primary-session-id").textContent(), "ses_seco", "cancelled New Session keeps the previous binding")

    let releaseStaleOverview = () => {}
    const staleOverviewGate = new Promise<void>((resolve) => { releaseStaleOverview = resolve })
    let markStaleOverviewCaptured = () => {}
    const staleOverviewCaptured = new Promise<void>((resolve) => { markStaleOverviewCaptured = resolve })
    let markStaleOverviewSettled = () => {}
    const staleOverviewSettled = new Promise<void>((resolve) => { markStaleOverviewSettled = resolve })
    let releasePostRefreshOverviews = () => {}
    const postRefreshOverviewGate = new Promise<void>((resolve) => { releasePostRefreshOverviews = resolve })
    let delayNextOverview = true
    let refreshedNewBinding = false
    await page.route("**/api/v1/overview?*", async (route) => {
      if (!delayNextOverview) {
        if (!refreshedNewBinding && repository.getPrimarySession(instanceBId)?.sessionId === "created-1") {
          refreshedNewBinding = true
          await route.continue()
          return
        }
        if (refreshedNewBinding) await postRefreshOverviewGate
        await route.continue()
        return
      }
      delayNextOverview = false
      const staleResponse = await route.fetch()
      const staleBody = await staleResponse.json() as { instances: Array<{ id: string; primarySession: { sessionId: string } | null }> }
      assert.equal(staleBody.instances.find((instance) => instance.id === instanceBId)?.primarySession?.sessionId, "ses_second")
      markStaleOverviewCaptured()
      await staleOverviewGate
      await route.fulfill({ status: staleResponse.status(), contentType: "application/json", body: JSON.stringify(staleBody) })
      markStaleOverviewSettled()
    })
    await page.locator(".topbar").getByRole("button", { name: "重新整理" }).click()
    await staleOverviewCaptured

    runtime.createSessionDelayMs = 180
    await page.getByRole("button", { name: "New Session" }).click()
    const newSessionPopupPromise = page.waitForEvent("popup")
    await page.getByRole("alertdialog", { name: "建立 New Session？" }).getByRole("button", { name: "建立並開啟" }).click()
    const newSessionPopup = await newSessionPopupPromise
    await newSessionPopup.getByText("正在連線到 OpenCode Web…", { exact: true }).waitFor()
    assert.equal(await newSessionPopup.evaluate(() => window.opener), null)
    assert.equal(await newSessionPopup.locator('meta[name="referrer"]').getAttribute("content"), "no-referrer")
    await newSessionPopup.waitForURL(`${instanceBRecord.endpoint}/opened/created-1?session=created-1`)
    await page.locator(".primary-session-card").getByText("New root created-1", { exact: true }).waitFor()
    assert.equal(await page.locator(".primary-session-id").textContent(), "created-")
    releaseStaleOverview()
    await staleOverviewSettled
    await page.waitForTimeout(500)
    assert.equal(await page.locator(".primary-session-card").getByText("New root created-1", { exact: true }).count(), 1, "a late older overview must not replace the refreshed binding")
    assert.equal(await page.locator(".primary-session-id").textContent(), "created-", "a late older overview must not replace the refreshed binding")
    releasePostRefreshOverviews()
    await page.unrouteAll({ behavior: "wait" })
    await newSessionPopup.close()
    runtime.createSessionDelayMs = 0

    runtime.createSessionError = new Error("create failure fixture")
    await page.getByRole("button", { name: "New Session" }).click()
    const createFailedPopupPromise = page.waitForEvent("popup")
    await page.getByRole("alertdialog", { name: "建立 New Session？" }).getByRole("button", { name: "建立並開啟" }).click()
    const createFailedPopup = await createFailedPopupPromise
    await page.getByText("OpenCode Session 建立失敗或回應無效；原綁定保持不變。", { exact: true }).waitFor()
    assert.equal(createFailedPopup.isClosed(), true)
    assert.equal(await page.locator(".primary-session-id").textContent(), "created-")
    runtime.createSessionError = null

    runtime.failCreatedSessionUrl = true
    await page.getByRole("button", { name: "New Session" }).click()
    const createdWithoutUrlPopupPromise = page.waitForEvent("popup")
    await page.getByRole("alertdialog", { name: "建立 New Session？" }).getByRole("button", { name: "建立並開啟" }).click()
    const createdWithoutUrlPopup = await createdWithoutUrlPopupPromise
    await page.getByText(/created-2.*已建立並綁定.*不要再次建立 New Session/).waitFor()
    assert.equal(createdWithoutUrlPopup.isClosed(), true)
    await page.locator(".primary-session-card").getByText("New root created-2", { exact: true }).waitFor()
    assert.equal(await page.locator(".primary-session-id").textContent(), "created-")

    assert.equal(await advancedSessions.evaluate((details) => (details as HTMLDetailsElement).open), false)
    await advancedSessions.locator("summary").click()
    const rootSelector = page.getByLabel("選擇其他 root Session")
    await rootSelector.selectOption("ses_shared")
    assert.equal(await page.locator(".primary-session-id").textContent(), "created-", "choosing a candidate must not change the binding before confirmation")
    const popupsBeforeManualCancel = popupCount
    const manualSwitchButton = page.getByRole("button", { name: "切換並開啟" })
    const manualSwitchState = await page.evaluate(() => ({
      freshness: document.querySelector(".overview-freshness")?.getAttribute("data-state"),
      sessionLoading: Boolean(document.querySelector(".sessions-panel .spin")),
    }))
    assert.equal(await manualSwitchButton.isEnabled(), true, `manual switch should be ready after fresh sessions load: ${JSON.stringify(manualSwitchState)}`)
    await manualSwitchButton.click()
    const cancelledManualBinding = page.getByRole("alertdialog", { name: "切換主要 Session？" })
    await cancelledManualBinding.getByRole("button", { name: "取消" }).click()
    await cancelledManualBinding.waitFor({ state: "hidden" })
    await page.waitForTimeout(50)
    assert.equal(popupCount, popupsBeforeManualCancel, "cancelled primary binding must not open a popup")
    assert.equal(await page.locator(".primary-session-id").textContent(), "created-", "cancelled primary binding keeps the previous binding")
    const manualSwitchStateAfterCancel = await page.evaluate(() => ({
      freshness: document.querySelector(".overview-freshness")?.getAttribute("data-state"),
      sessionLoading: Boolean(document.querySelector(".sessions-panel .spin")),
      selectedCandidate: (document.querySelector('select[aria-label="選擇其他 root Session"]') as HTMLSelectElement | null)?.value,
      lifecycle: document.querySelector(".detail-state")?.textContent,
    }))
    assert.equal(await manualSwitchButton.isEnabled(), true, `manual switch should remain ready after cancel: ${JSON.stringify(manualSwitchStateAfterCancel)}`)
    await manualSwitchButton.click()
    const manualPopupPromise = page.waitForEvent("popup")
    await page.getByRole("alertdialog", { name: "切換主要 Session？" }).getByRole("button", { name: "切換並開啟" }).click()
    const manualPopup = await manualPopupPromise
    await manualPopup.waitForURL(`${instanceBRecord.endpoint}/opened/ses_shared?session=ses_shared`)
    await page.locator(".primary-session-card").getByText("Shared history", { exact: true }).waitFor()
    assert.equal(await page.locator(".primary-session-id").textContent(), "ses_shar")
    await manualPopup.close()

    const laterNode = page.locator(".session-node").filter({ hasText: "Later unrelated work" }).first()
    const treePopupPromise = page.waitForEvent("popup")
    await laterNode.getByRole("button", { name: "在 OpenCode Web 開啟 Session" }).click()
    const treePopup = await treePopupPromise
    await treePopup.waitForURL(`${instanceBRecord.endpoint}/opened/ses_later?session=ses_later`)
    await treePopup.close()
    await page.locator(".topbar").getByRole("button", { name: "重新整理" }).click()
    assert.equal(await page.locator(".primary-session-id").textContent(), "ses_shar", "opening history must not change the primary binding")

    runtime.queueSessions("project-a", { delayMs: 220, title: "Stale Root A" })
    runtime.queueSessions("project-b", { delayMs: 30, title: "Current Root B" })
    await returnToInstanceList(page)
    await instanceA.click()
    await page.waitForTimeout(10)
    await returnToInstanceList(page)
    assert.equal(await page.getByText("Root B", { exact: true }).count(), 0, "switching Instance clears the old root tree immediately")
    await instanceB.click()
    await page.getByRole("option", { name: "Current Root B (ses_shared)" }).waitFor({ state: "attached" })
    await advancedSessions.locator("summary").click()
    await page.waitForTimeout(240)
    assert.equal(await page.getByText("Stale Root A", { exact: true }).count(), 0)

    runtime.queueSessions("project-b",
      { delayMs: 180, title: "Stale B Refresh" },
      { delayMs: 20, title: "Current B Refresh" },
    )
    const reloadSessions = page.getByRole("button", { name: "重新載入" })
    await reloadSessions.click()
    await page.waitForTimeout(10)
    await reloadSessions.click()
    await page.getByRole("option", { name: "Current B Refresh (ses_shared)" }).waitFor({ state: "attached" })
    await page.waitForTimeout(190)
    assert.equal(await page.getByText("Stale B Refresh", { exact: true }).count(), 0)

    runtime.queueSessions("project-a", { delayMs: 80, error: "stale root failure fixture" })
    runtime.queueSessions("project-b", { delayMs: 220, title: "Current B After Error" })
    await returnToInstanceList(page)
    await instanceA.click()
    await page.waitForTimeout(10)
    await returnToInstanceList(page)
    await instanceB.click()
    await page.waitForTimeout(100)
    assert.equal(await page.getByText("stale root failure fixture", { exact: true }).count(), 0)
    assert.equal(await page.locator(".sessions-panel .spin").count(), 1, "stale error must not clear the current loading state")
    await page.getByRole("option", { name: "Current B After Error (ses_shared)" }).waitFor({ state: "attached" })
    assert.equal(await page.locator(".sessions-panel .spin").count(), 0)

    await assertPrimaryActionLayout(page, 1440)
    const screenshotDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../.scratch")
    await mkdir(screenshotDirectory, { recursive: true })
    await page.screenshot({ path: path.join(screenshotDirectory, "main-session-1440.png"), fullPage: true })
    await assertPrimaryActionLayout(page, 390)
    await page.screenshot({ path: path.join(screenshotDirectory, "main-session-390.png"), fullPage: true })

    await page.getByRole("button", { name: "執行個體操作" }).click()
    const stopCallsBeforeCancel = runtime.stopCalls
    await page.getByRole("button", { name: "停止執行個體" }).click()
    const cancelledStop = page.getByRole("alertdialog", { name: "停止整個執行個體？" })
    await cancelledStop.getByRole("button", { name: "取消" }).click()
    await cancelledStop.waitFor({ state: "hidden" })
    await page.waitForTimeout(50)
    assert.equal(runtime.stopCalls, stopCallsBeforeCancel, "cancelled Stop must not call the runtime")
    await page.getByRole("button", { name: "停止執行個體" }).click()
    await page.getByRole("alertdialog", { name: "停止整個執行個體？" }).getByRole("button", { name: "停止執行個體" }).click()
    await page.getByText(/拒絕停止：process identity 無法安全核對/).waitFor()
    runtime.allowStop = true
    await page.getByRole("button", { name: "停止執行個體" }).click()
    await page.getByRole("alertdialog", { name: "停止整個執行個體？" }).getByRole("button", { name: "停止執行個體" }).click()
    await page.getByText("背景執行個體已停止。", { exact: true }).waitFor()
    await page.locator(".primary-session-card").getByText("Shared history", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "進入主 Session" }).isDisabled(), true)
    assert.equal(await page.getByRole("button", { name: "New Session" }).isDisabled(), true)
    assert.equal(await page.getByRole("button", { name: "切換並開啟" }).isDisabled(), true)
    assert.equal(await page.getByRole("button", { name: "在 OpenCode Web 開啟 Session" }).first().isDisabled(), true)
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"))
  } finally {
    await browser?.close()
    await app.close()
    repository.close()
    await rm(sandbox, { recursive: true, force: true })
  }
})

test("grouped Instance UI and recovery actions honor the browser contract", { skip: !enabled, timeout: 65_000 }, async () => {
  const executablePath = process.env.OMW_BROWSER_EXECUTABLE
  assert.ok(executablePath, "OMW_BROWSER_EXECUTABLE is required")
  const sandbox = await mkdtemp(path.join(tmpdir(), "omw-browser-recovery-"))
  await Promise.all([
    mkdir(path.join(sandbox, "browser-profile", "AppData", "Roaming"), { recursive: true }),
    mkdir(path.join(sandbox, "browser-profile", "AppData", "Local"), { recursive: true }),
    mkdir(path.join(sandbox, "browser-profile", "Temp"), { recursive: true }),
  ])
  const repository = new ManagerRepository(":memory:")
  const runtime = new BrowserRuntime()
  const service = new ManagerService(repository, runtime)
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../web/dist")
  const app = buildApp({ service, authority: { hostname: "127.0.0.1", port }, allowedOrigins: new Set([origin]), webRoot })
  const directoryA = "C:\\fake-data\\team-a\\a-very-long-workspace-name-for-mobile-layout\\shared-project"
  const directoryB = "D:\\fake-data\\team-b\\another-very-long-workspace-name-for-mobile-layout\\shared-project"
  const longTitle = "修正跨裝置同步與背景執行狀態，這是一段刻意很長且只用於版面測試的主要 Session 標題"
  const instances: ManagedInstance[] = [
    fakeManagedInstance({
      id: "inst-a1-11111111",
      projectDirectory: directoryA,
      pid: 11_001,
      launchedAt: "2026-09-18T03:00:00.000Z",
      primarySession: { sessionId: "ses-a1", title: longTitle, source: "activity", boundAt: "2026-09-18T03:00:00.000Z" },
      sessions: [{ id: "ses-a1", title: longTitle }, { id: "ses-search", title: "search-only-session-metadata" }],
    }),
    fakeManagedInstance({
      id: "inst-a2-22222222",
      projectDirectory: directoryA,
      state: "stopped",
      pid: null,
      launchedAt: "2026-09-18T02:00:00.000Z",
       healthVersion: null,
       stopAllowed: false,
       primarySession: { sessionId: "ses-a2", title: "Stopped primary work", source: "manual", boundAt: "2026-09-18T02:00:00.000Z" },
       sessions: [],
       recovery: { recheckAllowed: false, resumeAllowed: true, hideAllowed: false, removeAllowed: true },
    }),
    fakeManagedInstance({
      id: "inst-b1-33333333",
      projectDirectory: directoryB,
      kind: "local-tui",
      state: "unreachable",
      pid: null,
      launchedAt: "2026-09-18T04:00:00.000Z",
      healthVersion: null,
      stopAllowed: false,
      primarySession: { sessionId: "ses-b1", title: "Local TUI recovery work", source: "manual", boundAt: "2026-09-18T04:00:00.000Z" },
      sessions: [{ id: "ses-b1", title: "Local TUI recovery work" }],
      recovery: { recheckAllowed: true, resumeAllowed: true, hideAllowed: true, removeAllowed: false },
    }),
    fakeManagedInstance({
      id: "inst-b2-44444444",
      projectDirectory: directoryB,
      state: "unreachable",
      pid: null,
      launchedAt: "2026-09-18T01:00:00.000Z",
      healthVersion: null,
      stopAllowed: false,
      primarySession: { sessionId: "ses-b2", title: "Partial resume fixture", source: "activity", boundAt: "2026-09-18T01:00:00.000Z" },
      sessions: [{ id: "ses-b2", title: "Partial resume fixture" }],
      recovery: { recheckAllowed: true, resumeAllowed: true, hideAllowed: true, removeAllowed: false },
    }),
    fakeManagedInstance({
      id: "inst-check-55555555",
      projectName: "recheck-project",
      projectDirectory: "C:\\fake-data\\recheck-project",
       state: "unreachable",
      pid: null,
      healthVersion: null,
      stopAllowed: false,
      primarySession: null,
      sessions: [],
      recovery: { recheckAllowed: true, resumeAllowed: false, hideAllowed: true, removeAllowed: false },
    }),
    fakeManagedInstance({
      id: "inst-new-55555556",
      projectName: "fresh-start-project",
      projectDirectory: "C:\\fake-data\\fresh-start-project",
      state: "stopped",
      pid: null,
      healthVersion: null,
      stopAllowed: false,
      primarySession: null,
      sessions: [],
      recovery: { recheckAllowed: false, resumeAllowed: false, hideAllowed: false, removeAllowed: true },
    }),
    fakeManagedInstance({
      id: "inst-hidden-66666666",
      projectName: "archived-project",
      projectDirectory: "C:\\fake-data\\archived-project",
      state: "stopped",
      pid: null,
      healthVersion: null,
      stopAllowed: false,
      trackingHidden: true,
      primarySession: null,
      sessions: [],
      recovery: { recheckAllowed: false, resumeAllowed: false, hideAllowed: true, removeAllowed: true },
    }),
  ]
  let overviewCalls = 0
  let recheckCalls = 0
  let startCalls = 0
  let resumeCalls = 0
  let removeCalls = 0
  let popupCount = 0
  let browser: Browser | undefined

  try {
    await app.listen({ host: "127.0.0.1", port })
    browser = await chromium.launch({ executablePath, headless: true, env: createBrowserEnvironment(sandbox) })
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" })
    page.on("popup", () => { popupCount++ })
    await page.route("**/api/v1/**", async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      const respond = async (status: number, body?: unknown) => await route.fulfill({
        status,
        ...(body === undefined ? {} : { contentType: "application/json", body: JSON.stringify(body) }),
      })

      if (request.method() === "GET" && url.pathname === "/api/v1/overview") {
        overviewCalls++
        const includeHidden = url.searchParams.get("includeHidden") === "true"
        const queryText = (url.searchParams.get("q") ?? "").trim().toLocaleLowerCase("zh-TW")
        const requestedFilter = url.searchParams.get("filter") ?? "all"
        if (queryText === "legacy-recovery") {
          const fixture = instances.find((instance) => instance.id === "inst-check-55555555")
          assert.ok(fixture)
          const { recovery: _recovery, ...legacyFixture } = fixture
          await respond(200, { shortcuts: [], instances: [legacyFixture] })
          return
        }
        let visible = instances.filter((instance) => includeHidden || !instance.trackingHidden)
        if (queryText) {
          visible = visible.filter((instance) => [
            instance.projectName,
            instance.projectDirectory,
            instance.id,
            ...instance.sessions.flatMap((session) => [session.title, session.id]),
          ].some((value) => value.toLocaleLowerCase("zh-TW").includes(queryText)))
        }
        if (requestedFilter === "active") visible = visible.filter((instance) => instance.state === "starting" || (instance.summary.busySessions ?? 0) > 0)
        if (requestedFilter === "attention") visible = visible.filter((instance) => (instance.summary.pendingQuestions ?? 0) > 0 || (instance.summary.pendingPermissions ?? 0) > 0)
        if (requestedFilter === "unreachable") visible = visible.filter((instance) => instance.state === "unreachable" || instance.state === "failed" || instance.summary.activity === "unknown")
        if (overviewCalls % 2 === 0) visible = [...visible].reverse()
        await respond(200, { shortcuts: [], instances: visible })
        return
      }

      if (request.method() === "POST" && url.pathname === "/api/v1/instances") {
        startCalls++
        const payload = request.postDataJSON() as { directory: string }
        const started = fakeManagedInstance({
          id: "inst-fresh-99999999",
          projectName: "fresh-start-project",
          projectDirectory: payload.directory,
          kind: "headless",
          pid: 44_004,
          launchedAt: "2026-09-18T06:00:00.000Z",
          primarySession: null,
          sessions: [],
        })
        instances.push(started)
        await respond(201, started)
        return
      }

      const match = /^\/api\/v1\/instances\/([^/]+)(?:\/(sessions|recheck|resume|tracking))?$/.exec(url.pathname)
      const instanceId = match ? decodeURIComponent(match[1] ?? "") : ""
      const action = match?.[2]
      const instance = instances.find((item) => item.id === instanceId)
      if (!instance) {
        await respond(404, { error: { code: "INSTANCE_NOT_FOUND", message: "fixture Instance not found" } })
        return
      }
      if (request.method() === "GET" && action === "sessions") {
        await respond(200, { roots: instance.sessions, unknownParent: [] })
        return
      }
      if (request.method() === "POST" && action === "recheck") {
        recheckCalls++
        await new Promise((resolve) => setTimeout(resolve, 100))
        Object.assign(instance, {
          state: "ready",
          pid: 22_002,
          healthVersion: "fixture-rechecked",
          summary: { activity: "reported-non-busy", busySessions: 0, pendingQuestions: 0, pendingPermissions: 0, error: null },
          recovery: { recheckAllowed: false, resumeAllowed: false, hideAllowed: false, removeAllowed: false },
        } satisfies Partial<ManagedInstance>)
        await respond(200, instance)
        return
      }
      if (request.method() === "POST" && action === "resume") {
        resumeCalls++
        const resumed = fakeManagedInstance({
          id: instanceId === "inst-b2-44444444" ? "inst-partial-88888888" : "inst-resumed-77777777",
          projectDirectory: instance.projectDirectory,
          kind: "headless",
          pid: 33_003,
          launchedAt: "2026-09-18T05:00:00.000Z",
          primarySession: instanceId === "inst-b2-44444444" ? null : instance.primarySession,
          sessions: instanceId === "inst-b2-44444444" ? [] : instance.sessions,
        })
        instances.push(resumed)
        if (instanceId === "inst-b2-44444444") {
          await respond(409, { error: { code: "RESUME_BIND_FAILED", message: "resume bind failure fixture", details: { newInstanceId: resumed.id } } })
        } else {
          await respond(200, resumed)
        }
        return
      }
      if (request.method() === "POST" && action === "tracking") {
        const payload = request.postDataJSON() as { hidden: boolean }
        instance.trackingHidden = payload.hidden
        instance.recovery.hideAllowed = payload.hidden || instance.state === "unreachable" || instance.state === "failed"
        await respond(200, instance)
        return
      }
      if (request.method() === "DELETE" && action === undefined) {
        removeCalls++
        if (removeCalls === 1) {
          await respond(409, { error: { code: "REMOVE_FAILED", message: "remove failure fixture" } })
          return
        }
        instances.splice(instances.indexOf(instance), 1)
        await respond(204)
        return
      }
      await respond(404, { error: { code: "FIXTURE_ROUTE_MISSING", message: `${request.method()} ${url.pathname}` } })
    })

    await page.goto(origin, { waitUntil: "networkidle" })
    await page.locator(".project-group").first().waitFor()
    const reducedStartTrigger = page.locator(".topbar").getByRole("button", { name: "啟動執行個體" })
    await reducedStartTrigger.click()
    const reducedOverlay = page.locator(".start-panel-overlay")
    assert.equal(await reducedOverlay.getAttribute("data-motion"), "reduced", "reduced motion uses a fade-only start panel transition")
    const reducedMotion = await reducedOverlay.evaluate((overlay) => {
      const panel = overlay.querySelector<HTMLElement>(".start-panel")!
      return {
        duration: Number.parseFloat(getComputedStyle(overlay).transitionDuration),
        panelTransform: getComputedStyle(panel).transform,
        panelDuration: Number.parseFloat(getComputedStyle(panel).transitionDuration),
      }
    })
    assert.equal(reducedMotion.duration <= 0.12, true, "reduced motion fade stays short")
    assert.equal(reducedMotion.panelTransform, "none", "reduced motion removes panel movement")
    assert.equal(reducedMotion.panelDuration <= 0.001, true, "reduced motion does not animate the panel transform")
    await page.getByRole("button", { name: "關閉啟動面板" }).click()
    await page.getByRole("dialog", { name: "啟動執行個體" }).waitFor({ state: "hidden" })

    const sameNameGroups = page.locator(".project-group-head").filter({ hasText: "shared-project" })
    assert.equal(await sameNameGroups.count(), 2, "same basename directories must remain separate Project groups")
      assert.equal(await page.getByTitle(directoryA).locator("b").textContent(), "2")
      assert.equal(await page.getByTitle(directoryB).locator("b").textContent(), "2")
      const longTitleRow = page.getByRole("button", { name: `#11001 ${longTitle}` })
      const stoppedPrimaryRow = page.locator('.instance-row[data-instance-id="inst-a2-22222222"]')
      await longTitleRow.waitFor()
      assert.equal(await stoppedPrimaryRow.isVisible(), false, "stopped history is collapsed by default")
      await page.getByTitle(directoryA).locator("..").getByRole("button", { name: /已停止紀錄/ }).click()
      await stoppedPrimaryRow.waitFor()
      await longTitleRow.click()

      for (const width of [390, 360]) await assertDetailIdentityLayout(page, width, longTitle, "shared-project", directoryA)

      await returnToInstanceList(page)
      for (const width of [1440, 390, 360]) await assertGroupedInstanceLayout(page, width)
    await page.setViewportSize({ width: 390, height: 844 })
    const orderBeforeRefresh = await page.locator(".instance-row").evaluateAll((rows) => rows.map((row) => row.getAttribute("aria-label")))
    await page.evaluate(() => Reflect.set(window, "__omwStableRow", document.querySelector(".instance-row")))
    const nextPoll = page.waitForResponse((response) => response.url().includes("/api/v1/overview?") && response.ok(), { timeout: 7_000 })
    await nextPoll
    const orderAfterRefresh = await page.locator(".instance-row").evaluateAll((rows) => rows.map((row) => row.getAttribute("aria-label")))
    assert.deepEqual(orderAfterRefresh, orderBeforeRefresh, "polling must not reorder grouped Instances")
    assert.equal(await page.evaluate(() => Reflect.get(window, "__omwStableRow") === document.querySelector(".instance-row")), true, "polling must reuse keyed rows")
    assert.equal(await page.locator(".instance-row").first().evaluate((row) => getComputedStyle(row).animationName), "none", "polling rows must not re-animate")

    await page.getByRole("textbox", { name: "搜尋" }).fill("search-only-session-metadata")
    await page.getByRole("button", { name: "執行搜尋" }).click()
    await page.waitForFunction(() => document.querySelectorAll(".instance-row").length === 1)
    assert.equal(await page.getByRole("button", { name: `#11001 ${longTitle}` }).count(), 1, "search must include Session metadata")
    await page.getByRole("textbox", { name: "搜尋" }).fill("")
      await page.getByRole("button", { name: "執行搜尋" }).click()
      await page.waitForFunction(() => document.querySelectorAll(".instance-row").length === 6)

      await page.getByRole("button", { name: /inst-che/ }).click()
      assert.equal(await page.getByRole("heading", { level: 2, name: "recheck-project" }).count(), 1, "unbound detail falls back to the folder name")
      assert.equal(await page.locator(".detail-unbound").textContent(), "尚未綁定主 Session")
      assert.equal(await page.locator(".detail-folder").count(), 0, "unbound detail does not repeat the folder name")
      await page.getByRole("button", { name: "執行個體操作" }).click()
      assert.equal(await page.getByRole("button", { name: "重新檢查" }).isEnabled(), true, "unreachable Instance exposes backend-approved recheck")
      assert.equal(await page.getByRole("button", { name: "接續對話" }).isDisabled(), true, "unbound Instance cannot resume")
      assert.equal(await page.getByRole("button", { name: "停止追蹤" }).isEnabled(), true, "unreachable Instance exposes backend-approved tracking action")
      assert.match(await page.locator(".lifecycle-reason").textContent() ?? "", /接續：尚未綁定主要 Session，無對話可接續/)

      await returnToInstanceList(page)
      await page.getByRole("textbox", { name: "搜尋" }).fill("legacy-recovery")
      await page.getByRole("button", { name: "執行搜尋" }).click()
      await page.getByRole("button", { name: /inst-che/ }).click()
      const legacyDiagnostic = page.locator(".lifecycle-diagnostic[role=alert]")
      await legacyDiagnostic.waitFor()
      assert.match(await legacyDiagnostic.textContent() ?? "", /操作資訊尚未取得。可能是前後端版本不一致/, "legacy recovery diagnostic is visible")
      for (const name of ["重新檢查", "接續對話", "停止追蹤", "移除紀錄"]) {
        assert.equal(await page.getByRole("button", { name }).isDisabled(), true, `legacy recovery disables ${name}`)
      }
      await returnToInstanceList(page)
      await page.getByRole("textbox", { name: "搜尋" }).fill("")
      await page.getByRole("button", { name: "執行搜尋" }).click()
      await page.waitForFunction(() => document.querySelectorAll(".instance-row").length === 6)

      await page.getByRole("button", { name: /inst-a2-.*Stopped primary work/ }).click()
      assert.equal(await page.getByRole("button", { name: "接續對話" }).isEnabled(), true, "stopped Instance with primary Session allows resume")
      assert.equal(await page.getByRole("button", { name: "移除紀錄" }).isEnabled(), true, "stopped Instance with released port allows remove")
      assert.match(await page.locator(".lifecycle-reason").textContent() ?? "", /重新檢查：已停止不需檢查.*停止追蹤：可用移除紀錄/)

      await returnToInstanceList(page)
      await page.getByRole("button", { name: /inst-che/ }).click()
      const lifecycleTrigger = page.getByRole("button", { name: "執行個體操作" })
    assert.equal(await lifecycleTrigger.getAttribute("aria-expanded"), "true", "expanded lifecycle actions persist across Instance switches")
    await page.locator(".topbar").getByRole("button", { name: "重新整理" }).click()
    assert.equal(await lifecycleTrigger.getAttribute("aria-expanded"), "true", "expanded lifecycle actions persist across refresh")
    await lifecycleTrigger.click()
    assert.equal(await lifecycleTrigger.getAttribute("aria-expanded"), "false")
    await returnToInstanceList(page)
    await page.getByRole("button", { name: /inst-a2-.*Stopped primary work/ }).click()
    assert.equal(await lifecycleTrigger.getAttribute("aria-expanded"), "false", "explicitly collapsed lifecycle actions stay collapsed across switches")
    await returnToInstanceList(page)
    await page.getByRole("button", { name: /inst-che/ }).click()
    await lifecycleTrigger.focus()
    await page.keyboard.press("Enter")
    assert.equal(await lifecycleTrigger.getAttribute("aria-expanded"), "true")
    assert.equal(await page.getByRole("button", { name: "停止執行個體" }).count(), 1, "lifecycle actions belong only in the detail panel")
    assert.deepEqual(await page.locator(".primary-actions button").allTextContents(), ["進入主 Session", "New Session"])
    await page.keyboard.press("Tab")
    assert.equal(await page.getByRole("button", { name: "重新檢查" }).evaluate((button) => button === document.activeElement), true, "keyboard focus enters the first enabled lifecycle action")
    const recheckButton = page.getByRole("button", { name: "重新檢查" })
    const recheckRequest = page.waitForRequest((request) => request.url().endsWith("/recheck") && request.method() === "POST")
    const recheckClick = recheckButton.click()
    await recheckRequest
    const recheckDisabledWhilePending = await recheckButton.isDisabled()
    await recheckClick
    assert.equal(recheckDisabledWhilePending, true, "pending recheck disables duplicate submissions")
    await page.getByText("可連線", { exact: true }).last().waitFor()
    await page.waitForFunction(() => document.querySelector("#instance-lifecycle-panel")?.getAttribute("aria-busy") === "false")
    assert.equal(recheckCalls, 1)
    const reducedTransition = await lifecycleTrigger.evaluate((button) => Number.parseFloat(getComputedStyle(button).transitionDuration))
    assert.equal(reducedTransition <= 0.001, true, "reduced motion removes movement transitions")

    await returnToInstanceList(page)
    await page.getByRole("textbox", { name: "搜尋" }).fill("fresh-start-project")
    await page.getByRole("button", { name: "執行搜尋" }).click()
    await page.getByRole("button", { name: /inst-new.*尚未綁定主 Session/ }).click()
    const freshStartButton = page.getByRole("button", { name: "啟動", exact: true })
    assert.equal(await freshStartButton.isEnabled(), true, "stopped unbound Instance offers a fresh start")
    const successContrast = await freshStartButton.evaluate((button) => {
      const luminance = (value: string): number => {
        const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [0, 0, 0]
        const linear = channels.map((channel) => {
          const normalized = channel / 255
          return normalized <= .04045 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4
        })
        return .2126 * (linear[0] ?? 0) + .7152 * (linear[1] ?? 0) + .0722 * (linear[2] ?? 0)
      }
      const styles = getComputedStyle(button)
      const foreground = luminance(styles.color)
      const background = luminance(styles.backgroundColor)
      return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05)
    })
    assert.equal(successContrast >= 4.5, true, `fresh start contrast ${successContrast} must meet WCAG AA`)
    const sessionsBeforeFreshStart = runtime.createSessionCalls
    await freshStartButton.focus()
    await page.keyboard.press("Enter")
    const keyboardConfirmation = page.getByRole("alertdialog", { name: "啟動新的執行個體？" })
    assert.equal(await keyboardConfirmation.getAttribute("data-motion"), "none", "keyboard-opened confirmation is immediate")
    assert.equal(await keyboardConfirmation.evaluate((dialog) => getComputedStyle(dialog).animationName), "none")
    await page.keyboard.press("Escape")
    await keyboardConfirmation.waitFor({ state: "hidden" })
    assert.equal(startCalls, 0, "cancelled fresh start makes no API call")
    await freshStartButton.click()
    const reducedConfirmation = page.getByRole("alertdialog", { name: "啟動新的執行個體？" })
    assert.equal(await reducedConfirmation.getAttribute("data-motion"), "reduced")
    assert.equal(await reducedConfirmation.evaluate((dialog) => getComputedStyle(dialog).animationName), "confirmation-fade-in", "reduced motion removes dialog displacement")
    await reducedConfirmation.getByRole("button", { name: "啟動", exact: true }).click()
    await page.locator(".technical-info", { hasText: "inst-fresh-99999999" }).waitFor()
    assert.equal(startCalls, 1, "one confirmation starts exactly one Instance")
    assert.equal(runtime.createSessionCalls, sessionsBeforeFreshStart, "fresh start does not create a Session")
    assert.equal(await page.locator(".search-row input").inputValue(), "", "fresh start clears a query that excludes the new Instance")
    assert.equal(await page.locator(".filters button.active").textContent(), "全部", "fresh start resets the state filter")
    assert.equal(await page.locator('.instance-row[data-instance-id="inst-new-55555556"]').count(), 1, "fresh start preserves the old stopped record")
    assert.equal(await lifecycleTrigger.getAttribute("aria-expanded"), "true", "fresh start selection does not collapse lifecycle actions")

    await returnToInstanceList(page)
    await page.getByRole("textbox", { name: "搜尋" }).fill("Local TUI recovery work")
    await page.getByRole("button", { name: "執行搜尋" }).click()
    await page.getByRole("button", { name: "已失聯", exact: true }).click()
    await page.getByRole("button", { name: /inst-b1-.*Local TUI recovery work/ }).click()
    const resumeButton = page.getByRole("button", { name: "接續對話" })
    await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).some((button) => button.textContent?.includes("接續對話") && !button.disabled))
    await resumeButton.click()
    const resumeConfirmation = page.getByRole("alertdialog", { name: "接續主要對話？" })
    assert.match(await resumeConfirmation.textContent() ?? "", /新的背景程序與 PID.*不會停止舊程序.*不會傳送模型訊息/)
    await resumeConfirmation.getByRole("button", { name: "取消" }).click()
    await resumeConfirmation.waitFor({ state: "hidden" })
    await page.waitForTimeout(50)
    assert.equal(resumeCalls, 0, "cancelled resume makes no API call")
    assert.equal(popupCount, 0, "cancelled resume opens no popup")
    await resumeButton.click()
    await page.getByRole("alertdialog", { name: "接續主要對話？" }).getByRole("button", { name: "接續對話" }).click()
    await page.getByText(/已啟動新的背景執行個體（inst-res）；請確認後再進入主 Session/).waitFor()
    await page.locator(".technical-info", { hasText: "inst-resumed-77777777" }).waitFor()
    await page.locator(".primary-session-card").getByText("Local TUI recovery work", { exact: true }).waitFor()
    assert.equal(await page.locator(".search-row input").inputValue(), "", "resume clears a query that excludes the new Instance")
    assert.equal(await page.locator(".filters button.active").textContent(), "全部", "resume resets the state filter to all")
    assert.match(await page.locator(".instance-row.selected").getAttribute("aria-label") ?? "", /^#33003 Local TUI recovery work$/, "resume keeps the new ready Instance visible and selected")
    assert.equal(popupCount, 0, "resume must not immediately open OpenCode Web")

    await returnToInstanceList(page)
    await page.getByRole("textbox", { name: "搜尋" }).fill("Partial resume fixture")
    await page.getByRole("button", { name: "執行搜尋" }).click()
    await page.getByRole("button", { name: "已失聯", exact: true }).click()
    await page.getByRole("button", { name: /inst-b2-.*Partial resume fixture/ }).click()
    await page.getByRole("button", { name: "接續對話" }).click()
    await page.getByRole("alertdialog", { name: "接續主要對話？" }).getByRole("button", { name: "接續對話" }).click()
    await page.getByText(/新的背景執行個體 inst-par 已啟動，但尚未完成主要 Session 綁定.*列表已顯示並選取.*不要重複接續/).waitFor()
    await page.locator(".technical-info", { hasText: "inst-partial-88888888" }).waitFor()
    await page.locator(".primary-session-card").getByText("尚未綁定主 Session", { exact: true }).waitFor()
    assert.equal(await page.locator(".search-row input").inputValue(), "", "partial resume clears a query that excludes the new Instance")
    assert.equal(await page.locator(".filters button.active").textContent(), "全部", "partial resume resets the state filter to all")
    assert.equal(await page.locator(".instance-row.selected").getAttribute("aria-label"), "#33003 尚未綁定主 Session", "partial resume keeps the new ready unbound Instance visible and selected")

    await returnToInstanceList(page)
    await page.getByRole("button", { name: /inst-b2-.*Partial resume fixture/ }).click()
    await page.getByRole("button", { name: "停止追蹤" }).click()
    await page.getByText("已從主列表隱藏；程序與保留的連線埠不受影響。", { exact: true }).waitFor()
    await page.waitForFunction(() => !document.body.textContent?.includes("Partial resume fixture"))
    await page.getByLabel("顯示已停止追蹤").check()
    await page.getByRole("button", { name: /inst-b2-.*Partial resume fixture/ }).waitFor()
    await page.getByRole("button", { name: /inst-b2-.*Partial resume fixture/ }).click()
    await page.getByRole("button", { name: "恢復追蹤" }).click()
    await page.getByText("已恢復追蹤此執行個體。", { exact: true }).waitFor()

    await returnToInstanceList(page)
    assert.equal(await page.getByLabel("顯示已停止追蹤").isChecked(), true, "returning from detail preserves the include-hidden list context")
    await page.getByRole("textbox", { name: "搜尋" }).fill("archived-project")
    await page.getByRole("button", { name: "執行搜尋" }).click()
    await page.getByRole("button", { name: /inst-hid/ }).click()
    await page.getByRole("button", { name: "移除紀錄" }).click()
    const cancelledRemove = page.getByRole("alertdialog", { name: "移除 OMW 紀錄與綁定？" })
    await cancelledRemove.getByRole("button", { name: "取消" }).click()
    await cancelledRemove.waitFor({ state: "hidden" })
    await page.waitForTimeout(50)
    assert.equal(removeCalls, 0, "cancelled removal makes no API call")
    assert.equal(await page.locator('.instance-row[data-instance-id="inst-hidden-66666666"]').count(), 1, "cancelled removal preserves the record")
    await page.getByRole("button", { name: "移除紀錄" }).click()
    const firstRemoveDialog = page.getByRole("alertdialog", { name: "移除 OMW 紀錄與綁定？" })
    assert.match(await firstRemoveDialog.textContent() ?? "", /OMW 追蹤紀錄與綁定.*不會刪除 OpenCode Sessions、專案檔案或其他資料/)
    await firstRemoveDialog.getByRole("button", { name: "移除紀錄" }).click()
    await page.getByText("remove failure fixture", { exact: true }).waitFor()
    await page.getByRole("button", { name: "移除紀錄" }).click()
    await page.getByRole("alertdialog", { name: "移除 OMW 紀錄與綁定？" }).getByRole("button", { name: "移除紀錄" }).click()
    await page.waitForFunction(() => !document.body.textContent?.includes("archived-project"))
    assert.equal(removeCalls, 2)

    const screenshotDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../.scratch")
    await mkdir(screenshotDirectory, { recursive: true })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.screenshot({ path: path.join(screenshotDirectory, "grouped-recovery-fake-1440.png"), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: path.join(screenshotDirectory, "grouped-recovery-fake-390.png"), fullPage: true })

    const touchPage = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true })
    await touchPage.goto(origin, { waitUntil: "networkidle" })
    assert.equal(await touchPage.evaluate(() => matchMedia("(pointer: coarse)").matches), true, "touch fixture exposes a coarse pointer")
    const touchStart = touchPage.locator(".topbar").getByRole("button", { name: "啟動執行個體" })
    const touchBounds = await touchStart.boundingBox()
    assert.ok(touchBounds)
    await touchPage.mouse.move(touchBounds.x + touchBounds.width / 2, touchBounds.y + touchBounds.height / 2)
    await touchPage.mouse.down()
    const touchPressedTransform = await touchStart.evaluate((button) => getComputedStyle(button).transform)
    await touchPage.mouse.up()
    assert.notEqual(touchPressedTransform, "none", "coarse-pointer press gives primary buttons scale feedback")
    await touchPage.close()
  } finally {
    await browser?.close()
    await app.close().catch(() => undefined)
    repository.close()
    await rm(sandbox, { recursive: true, force: true })
  }
})

test("local remote enable UI confirms, cancels, reports errors and retries with memory-only auth", { skip: !enabled, timeout: 45_000 }, async () => {
  const executablePath = process.env.OMW_BROWSER_EXECUTABLE
  assert.ok(executablePath)
  const sandbox = await mkdtemp(path.join(tmpdir(), "omw-browser-enable-"))
  await Promise.all(["AppData/Roaming", "AppData/Local", "Temp"].map((name) => mkdir(path.join(sandbox, "browser-profile", name), { recursive: true })))
  const repository = new ManagerRepository(":memory:")
  const service = new ManagerService(repository, new BrowserRuntime())
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../web/dist")
  const app = buildApp({ service, authority: { hostname: "127.0.0.1", port }, allowedOrigins: new Set([origin]), webRoot })
  let response: ConnectivityInfo = {
    checkedAt: new Date().toISOString(), mode: "loopback", remoteAccess: "available",
    manager: { localUrl: origin, publicUrl: null }, tailscale: { state: "connected", dnsName: "fixture.example.ts.net", version: "fixture" },
    serve: { state: "not-configured", managerMapped: false, mappedInstancePorts: 0, expectedInstancePorts: 0, funnel: "disabled" },
    registration: { state: "idle", trigger: null, diagnostic: null }, nodeVersion: process.version,
  }
  const password = "fixture-browser-enable-password"
  const authorization = `Basic ${Buffer.from(`fixture:${password}`).toString("base64")}`
  let enableCalls = 0
  let registerCalls = 0
  let browser: Browser | undefined
  try {
    await app.listen({ host: "127.0.0.1", port })
    browser = await chromium.launch({ executablePath, headless: true, env: createBrowserEnvironment(sandbox) })
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    await page.route("**/api/v1/connectivity", (route) => route.fulfill({ json: response }))
    await page.route("**/api/v1/connectivity/enable", async (route) => {
      enableCalls++
      assert.equal(route.request().headers().authorization, authorization)
      assert.equal(route.request().headers()["x-omw-csrf"], "1")
      assert.deepEqual(route.request().postDataJSON(), { confirmed: true })
      if (enableCalls === 1) {
        await route.fulfill({ status: 503, json: { error: { code: "TAILSCALE_UNAVAILABLE", message: "fixture CLI 尚未安裝" } } })
        return
      }
      response = { ...response, mode: "tailnet", remoteAccess: "enabled", registration: { state: "failed", trigger: "manual", diagnostic: { code: "SERVE_WRITE_FAILED", message: "fixture Serve 失敗", nextStep: "請重試" } } }
      await route.fulfill({ json: response })
    })
    await page.route("**/api/v1/connectivity/register", async (route) => {
      registerCalls++
      assert.equal(route.request().headers().authorization, authorization, "auth remains available after form cleared")
      response = { ...response, manager: { ...response.manager, publicUrl: "https://fixture.example.ts.net:4174" }, serve: { ...response.serve, state: "verified", managerMapped: true }, registration: { state: "verified", trigger: "manual", diagnostic: null } }
      await route.fulfill({ json: response })
    })
    await page.goto(origin, { waitUntil: "networkidle" })
    await page.getByRole("button", { name: "啟用遠端存取", exact: true }).click()
    const form = page.getByRole("form", { name: "確認啟用遠端存取" })
    assert.match(await form.textContent() ?? "", /Tailnet.*OpenCode ports/s)
    await form.getByLabel("目前 OMW 密碼").fill(password)
    await form.getByRole("button", { name: "取消", exact: true }).click()
    assert.equal(enableCalls, 0)
    await page.getByRole("button", { name: "啟用遠端存取", exact: true }).click()
    assert.equal(await form.getByLabel("目前 OMW 密碼").inputValue(), "")
    await form.getByLabel("目前 OMW 帳號").fill("fixture")
    await form.getByLabel("目前 OMW 密碼").fill(password)
    await form.getByRole("button", { name: "同意並啟用" }).click()
    await form.getByRole("alert").waitFor()
    assert.match(await form.getByRole("alert").textContent() ?? "", /CLI 尚未安裝/)
    assert.equal(await form.getByLabel("目前 OMW 密碼").inputValue(), "")
    await form.getByLabel("目前 OMW 密碼").fill(password)
    await form.getByRole("button", { name: "同意並啟用" }).click()
    await form.waitFor({ state: "hidden" })
    await page.getByRole("button", { name: "自動註冊", exact: true }).click()
    await page.getByRole("heading", { name: "遠端入口已連線" }).waitFor()
    assert.equal(enableCalls, 2)
    assert.equal(registerCalls, 1)
    assert.equal(await page.evaluate((secret) => JSON.stringify({ ...localStorage, ...sessionStorage }).includes(secret), password), false)
    assert.equal(page.url(), `${origin}/`)
  } finally {
    await browser?.close()
    await app.close().catch(() => undefined)
    repository.close()
    await rm(sandbox, { recursive: true, force: true })
  }
})

test("connectivity UI reports, copies, shares, and degrades safely", { skip: !enabled, timeout: 65_000 }, async () => {
  const executablePath = process.env.OMW_BROWSER_EXECUTABLE
  assert.ok(executablePath, "OMW_BROWSER_EXECUTABLE is required")
  const sandbox = await mkdtemp(path.join(tmpdir(), "omw-browser-connectivity-"))
  await Promise.all([
    mkdir(path.join(sandbox, "browser-profile", "AppData", "Roaming"), { recursive: true }),
    mkdir(path.join(sandbox, "browser-profile", "AppData", "Local"), { recursive: true }),
    mkdir(path.join(sandbox, "browser-profile", "Temp"), { recursive: true }),
  ])
  const repository = new ManagerRepository(":memory:")
  const runtime = new BrowserRuntime()
  const service = new ManagerService(repository, runtime)
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../web/dist")
  const app = buildApp({ service, authority: { hostname: "127.0.0.1", port }, allowedOrigins: new Set([origin]), webRoot })
  const publicUrl = "https://omw-node.example.ts.net:40443"
  const online: ConnectivityInfo = {
    checkedAt: "2026-09-18T08:30:00.000Z",
    mode: "tailnet",
    manager: { localUrl: `http://127.0.0.1:${port}`, publicUrl },
    tailscale: { state: "connected", dnsName: "omw-node.example.ts.net", version: "1.88.2" },
    serve: { state: "verified", managerMapped: true, mappedInstancePorts: 2, expectedInstancePorts: 2, funnel: "disabled" },
    registration: { state: "verified", trigger: "startup", diagnostic: null },
    nodeVersion: "v24.8.0",
  }
  let response = online
  let failConnectivity = false
  let delayConnectivity = false
  let releaseConnectivity: (() => void) | undefined
  let notifyConnectivityBlocked: (() => void) | undefined
  let connectivityCalls = 0
  let registrationCalls = 0
  let delayRegistration = false
  let releaseRegistration: (() => void) | undefined
  let notifyRegistrationBlocked: (() => void) | undefined
  let browser: Browser | undefined

  try {
    await app.listen({ host: "127.0.0.1", port })
    browser = await chromium.launch({ executablePath, headless: true, env: createBrowserEnvironment(sandbox) })
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" })
    const pageErrors: string[] = []
    page.on("pageerror", (error) => pageErrors.push(error.message))
    await page.addInitScript(() => {
      Reflect.set(window, "__omwClipboardMode", "allow")
      Reflect.set(window, "__omwCopiedUrls", [])
      Reflect.set(window, "__omwShareCalls", 0)
      Reflect.set(window, "__omwVisibilityState", "visible")
      Reflect.set(window, "__omwPollIntervals", [])
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => Reflect.get(window, "__omwVisibilityState"),
      })
      const originalSetInterval = window.setInterval.bind(window)
      window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        ;(Reflect.get(window, "__omwPollIntervals") as number[]).push(timeout ?? 0)
        if (timeout === 30_000 && typeof handler === "function") Reflect.set(window, "__omwConnectivityPoll", handler)
        return originalSetInterval(handler, timeout, ...args)
      }) as typeof window.setInterval
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            if (Reflect.get(window, "__omwClipboardMode") === "deny") throw new DOMException("denied", "NotAllowedError")
            ;(Reflect.get(window, "__omwCopiedUrls") as string[]).push(value)
          },
        },
      })
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: async () => {
          Reflect.set(window, "__omwShareCalls", Number(Reflect.get(window, "__omwShareCalls")) + 1)
          throw new DOMException("cancelled", "AbortError")
        },
      })
    })
    await page.route("**/api/v1/connectivity", async (route) => {
      connectivityCalls++
      if (delayConnectivity) {
        await new Promise<void>((resolve) => {
          releaseConnectivity = resolve
          notifyConnectivityBlocked?.()
        })
      }
      if (failConnectivity) {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "CONNECTIVITY_UNAVAILABLE", message: "fixture unavailable" } }) }).catch(() => undefined)
        return
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(response) }).catch(() => undefined)
    })
    await page.route("**/api/v1/connectivity/register", async (route) => {
      registrationCalls++
      if (delayRegistration) {
        await new Promise<void>((resolve) => {
          releaseRegistration = resolve
          notifyRegistrationBlocked?.()
        })
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(response) }).catch(() => undefined)
    })

    await page.goto(origin, { waitUntil: "networkidle" })
    assert.deepEqual(
      await page.evaluate(() => (Reflect.get(window, "__omwPollIntervals") as number[]).sort((left, right) => left - right)),
      [5_000, 30_000],
      "overview polls every 5 seconds while Connectivity polls every 30 seconds",
    )
    await page.getByRole("heading", { level: 2, name: "遠端入口已連線" }).waitFor()
    assert.equal(await page.getByText("Serve 映射吻合", { exact: false }).count() > 0, true)
    assert.equal(await page.getByText(publicUrl, { exact: true }).count(), 1)
    assert.match(await page.locator(".connectivity-qualifier").textContent() ?? "", /遠端裝置仍須連上 Tailnet/)
    const registrationButton = page.getByRole("button", { name: "自動註冊" })
    assert.equal(await registrationButton.count(), 0, "registration retry is hidden after verified startup")

    const callsBeforeHiddenPoll = connectivityCalls
    await page.evaluate(() => {
      Reflect.set(window, "__omwVisibilityState", "hidden")
      document.dispatchEvent(new Event("visibilitychange"))
      const poll = Reflect.get(window, "__omwConnectivityPoll")
      if (typeof poll === "function") poll()
    })
    await page.waitForTimeout(100)
    assert.equal(connectivityCalls, callsBeforeHiddenPoll, "hidden background polling skips Connectivity requests")
    const foregroundConnectivity = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/connectivity")
    await page.evaluate(() => {
      Reflect.set(window, "__omwVisibilityState", "visible")
      document.dispatchEvent(new Event("visibilitychange"))
    })
    await foregroundConnectivity
    assert.equal(connectivityCalls, callsBeforeHiddenPoll + 1, "returning to the foreground immediately refreshes Connectivity")

    await page.getByRole("button", { name: "複製網址" }).click()
    assert.deepEqual(await page.evaluate(() => Reflect.get(window, "__omwCopiedUrls")), [publicUrl], "copy writes the exact configured HTTPS URL")
    await page.getByRole("button", { name: "分享" }).click()
    await page.waitForFunction(() => Reflect.get(window, "__omwShareCalls") === 1)
    assert.equal(await page.getByRole("textbox", { name: "手動複製遠端入口" }).count(), 0, "AbortError is a cancellation, not a share failure")

    await page.locator(".connectivity-details summary").click()
    assert.match(await page.locator(".connectivity-details").textContent() ?? "", /1\.88\.2.*v24\.8\.0.*吻合.*2 \/ 2/s)
    for (const width of [390, 360]) {
      await page.setViewportSize({ width, height: 844 })
      const layout = await page.locator(".connectivity").evaluate((section) => ({
        documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
        sectionScrollWidth: section.scrollWidth,
        sectionClientWidth: section.clientWidth,
        controlHeights: Array.from(section.querySelectorAll("button"), (button) => button.getBoundingClientRect().height),
      }))
      assert.equal(layout.documentWidth <= width, true, `${width}px connectivity UI has horizontal overflow`)
      assert.equal(layout.sectionScrollWidth <= layout.sectionClientWidth, true, `${width}px connectivity section overflows`)
      for (const height of layout.controlHeights) assert.equal(Math.round(height) >= 44, true, `${width}px connectivity control is smaller than 44px: ${height}`)
    }

    const screenshotDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../.scratch")
    await mkdir(screenshotDirectory, { recursive: true })
    await page.locator(".connectivity-details summary").click()
    await page.setViewportSize({ width: 390, height: 844 })
    const compactHeight = await page.locator(".connectivity").evaluate((section) => section.getBoundingClientRect().height)
    assert.equal(compactHeight >= 170 && compactHeight <= 210, true, `390px default connectivity section should stay compact, got ${compactHeight}px`)
    const closeNotice = page.getByRole("button", { name: "關閉成功通知" })
    if (await closeNotice.count()) await closeNotice.click()
    await page.screenshot({ path: path.join(screenshotDirectory, "connectivity-390.png"), fullPage: true, animations: "disabled" })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.screenshot({ path: path.join(screenshotDirectory, "connectivity-1440.png"), fullPage: true, animations: "disabled" })

    await page.evaluate(() => Reflect.set(window, "__omwClipboardMode", "deny"))
    await page.getByRole("button", { name: "複製網址" }).click()
    const manualCopy = page.getByRole("textbox", { name: "手動複製遠端入口" })
    await manualCopy.waitFor()
    assert.equal(await manualCopy.inputValue(), publicUrl)
    assert.deepEqual(await manualCopy.evaluate((input) => ({ start: (input as HTMLInputElement).selectionStart, end: (input as HTMLInputElement).selectionEnd })), { start: 0, end: publicUrl.length })
    assert.match(await page.locator(".connectivity-copy-fallback").textContent() ?? "", /請選取網址手動複製/)

    const idleOffline: ConnectivityInfo = {
      ...online,
      checkedAt: "2026-09-18T08:30:30.000Z",
      manager: { ...online.manager, publicUrl: null },
      tailscale: { ...online.tailscale, state: "offline" },
      serve: { ...online.serve, state: "mismatch", managerMapped: false, mappedInstancePorts: 0 },
      registration: { state: "idle", trigger: null, diagnostic: null },
    }
    response = idleOffline
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))
    await page.getByRole("heading", { level: 2, name: "本機 Tailscale 離線" }).waitFor()
    assert.equal(await registrationButton.count(), 1, "remote-mode idle state offers auto-registration after verified connectivity is lost")
    response = {
      ...idleOffline,
      registration: {
        state: "failed",
        trigger: "manual",
        diagnostic: { code: "TAILSCALE_OFFLINE", message: "Tailscale 目前離線。", nextStep: "請恢復連線後重試。" },
      },
    }
    await registrationButton.click()
    await page.getByRole("heading", { level: 2, name: "連線 Tailscale 失敗" }).waitFor()
    assert.equal(registrationCalls, 1, "idle retry uses the registration POST mutation")

    response = {
      ...online,
      checkedAt: "2026-09-18T08:31:00.000Z",
      tailscale: { ...online.tailscale, state: "future-state" as ConnectivityInfo["tailscale"]["state"] },
      serve: { ...online.serve, state: "mismatch", managerMapped: false, funnel: "enabled" },
      registration: {
        state: "failed",
        trigger: "startup",
        diagnostic: { code: "FUNNEL_ENABLED", message: "目標 port 已啟用 Funnel。", nextStep: "請由管理者核對並關閉。" },
      },
    }
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))
    await page.getByRole("heading", { level: 2, name: "尚未連線 Tailscale" }).waitFor()
    await registrationButton.waitFor()
    response = { ...response, registration: { ...response.registration, trigger: "manual" } }
    delayRegistration = true
    const registrationBlocked = new Promise<void>((resolve) => { notifyRegistrationBlocked = resolve })
    await registrationButton.click()
    await registrationBlocked
    await page.evaluate(() => {
      const poll = Reflect.get(window, "__omwConnectivityPoll")
      if (typeof poll === "function") poll()
      document.dispatchEvent(new Event("visibilitychange"))
    })
    releaseRegistration?.()
    delayRegistration = false
    await page.getByRole("heading", { level: 2, name: "連線 Tailscale 失敗" }).waitFor()
    assert.equal(registrationCalls, 2, "registration retry uses the POST mutation")
    assert.equal(await page.locator(".connectivity").getAttribute("data-tone"), "warning")
    assert.match(await page.locator(".connectivity-warnings").textContent() ?? "", /Serve 映射與目前 OMW 設定不符.*偵測到 Funnel.*目標 port 已啟用 Funnel.*FUNNEL_ENABLED/s)
    assert.equal(await page.getByRole("button", { name: "複製網址" }).isDisabled(), true, "unverified URLs are never offered as available")

    response = {
      ...online,
      manager: {
        localUrl: "http://admin:local-password@127.0.0.1:4173/?token=local-secret",
        publicUrl: "https://admin:public-password@omw-node.example.ts.net:40443?token=public-secret",
      },
    }
    await registrationButton.click()
    await page.getByText("尚未驗證遠端入口", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "複製網址" }).isDisabled(), true)
    assert.doesNotMatch(await page.locator(".connectivity").textContent() ?? "", /local-password|public-password|local-secret|public-secret/, "credentials and token-like query strings never enter the UI")

    response = {
      ...online,
      checkedAt: "2026-09-18T08:32:00.000Z",
      mode: "loopback",
      manager: { ...online.manager, publicUrl: null },
      tailscale: { ...online.tailscale, state: "offline" },
      serve: { ...online.serve, state: "not-configured", managerMapped: null, mappedInstancePorts: null },
    }
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))
    await page.getByText("尚未驗證遠端入口", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "複製網址" }).isDisabled(), true, "loopback URL is never offered as a phone URL")
    assert.equal(await page.getByRole("button", { name: "分享" }).isDisabled(), true)

    response = online
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))
    await page.getByRole("heading", { level: 2, name: "遠端入口已連線" }).waitFor()
    failConnectivity = true
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))
    await page.getByRole("heading", { level: 2, name: "連線資料已過期" }).waitFor()
    assert.equal(await page.locator(".connectivity").getAttribute("data-tone"), "unknown", "stale success must not remain green")
    assert.equal(await page.getByText(publicUrl, { exact: true }).count(), 0, "stale remote URL is not presented as an available entry")
    assert.equal(await page.getByText("遠端入口（已驗證）", { exact: true }).count(), 0, "stale snapshot is not labelled verified")
    assert.equal(await page.getByRole("button", { name: "複製網址" }).isDisabled(), true, "stale remote URL cannot be copied")
    assert.equal(await page.getByRole("button", { name: "分享" }).isDisabled(), true, "stale remote URL cannot be shared")
    assert.equal(await page.getByRole("textbox", { name: "手動複製遠端入口" }).count(), 0, "stale manual-copy fallback is hidden")

    failConnectivity = false
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))
    await page.getByRole("heading", { level: 2, name: "遠端入口已連線" }).waitFor()
    assert.equal(await page.locator(".connectivity").getAttribute("data-tone"), "ready", "returning to the foreground refreshes a stale connectivity snapshot")

    delayConnectivity = true
    const connectivityBlocked = new Promise<void>((resolve) => { notifyConnectivityBlocked = resolve })
    const pendingRequest = page.waitForRequest((request) => request.url().endsWith("/api/v1/connectivity"))
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))
    await pendingRequest
    await connectivityBlocked
    const release = releaseConnectivity
    const navigation = page.goto("about:blank")
    release?.()
    await navigation
    assert.deepEqual(pageErrors, [], "late connectivity completion after unmount causes no page errors")
  } finally {
    releaseConnectivity?.()
    await browser?.close()
    await app.close().catch(() => undefined)
    repository.close()
    await rm(sandbox, { recursive: true, force: true })
  }
})

test("mobile UI drives real Manager API Start, official Open URL, and safe Stop", { skip: !realEnabled, timeout: 75_000 }, async () => {
  const browserExecutable = process.env.OMW_BROWSER_EXECUTABLE
  const openCodeExecutable = process.env.OMW_OPENCODE_EXECUTABLE
  assert.ok(browserExecutable, "OMW_BROWSER_EXECUTABLE is required")
  assert.ok(openCodeExecutable, "OMW_OPENCODE_EXECUTABLE is required")
  const sandbox = path.join(tmpdir(), `omw-browser-real-${randomUUID()}`)
  const project = path.join(sandbox, "project")
  const config = path.join(sandbox, "config")
  const data = path.join(sandbox, "data")
  const browserProfile = path.join(sandbox, "browser-profile")
  await Promise.all([
    mkdir(project, { recursive: true }),
    mkdir(config, { recursive: true }),
    mkdir(data, { recursive: true }),
    mkdir(path.join(sandbox, "home", "Temp"), { recursive: true }),
    mkdir(path.join(browserProfile, "AppData", "Roaming"), { recursive: true }),
    mkdir(path.join(browserProfile, "AppData", "Local"), { recursive: true }),
    mkdir(path.join(browserProfile, "Temp"), { recursive: true }),
  ])
  await writeFile(path.join(config, "opencode.json"), "{\"plugin\":[]}\n", "utf8")
  const browserEnvironment = createBrowserEnvironment(sandbox)
  const isolation = await prepareIsolatedEnvironment({
    mode: "test",
    root: sandbox,
    configFile: path.join(config, "opencode.json"),
    sourceEnvironment: process.env,
  })
  const openCodeEnvironment = isolation.environment
  const repository = new ManagerRepository(path.join(sandbox, "manager.sqlite"))
  const runtime = new OpenCodeRuntime({ executable: openCodeExecutable, dataDirectory: data, environment: openCodeEnvironment })
  const service = new ManagerService(repository, runtime)
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../web/dist")
  const app = buildApp({
    service,
    authority: { hostname: "127.0.0.1", port },
    allowedOrigins: new Set([origin]),
    webRoot,
  })
  const serverErrors: string[] = []
  app.addHook("onError", async (_request, _reply, error) => { serverErrors.push(error.stack ?? error.message) })
  let browser: Browser | undefined

  try {
    await app.listen({ host: "127.0.0.1", port })
    browser = await chromium.launch({ executablePath: browserExecutable, headless: true, env: browserEnvironment })
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    const pageErrors: string[] = []
    page.on("pageerror", (error) => pageErrors.push(error.message))
    await page.goto(origin, { waitUntil: "networkidle" })
    await page.locator(".topbar").getByRole("button", { name: "啟動執行個體" }).click()
    await page.getByLabel("瀏覽目錄").fill(project)
    await page.getByRole("button", { name: "瀏覽", exact: true }).click()
    await page.getByRole("button", { name: /啟動全新 Instance/ }).click()
    await page.waitForFunction(
      () => document.body.textContent?.includes("執行個體已啟動（") || document.querySelector(".toast-error") !== null,
      undefined,
      { timeout: 25_000 },
    ).catch(() => undefined)
    const body = await page.locator("body").innerText()
    assert.match(body, /執行個體已啟動（[a-f0-9-]{8}）。/, `${body}\n${serverErrors.join("\n")}`)

    const record = repository.listInstances()[0]
    assert.ok(record)
    await page.locator(".primary-session-card").getByText("尚未綁定主 Session", { exact: true }).waitFor({ timeout: 10_000 })
    assert.equal(await page.locator(".primary-session-card").getByText("尚未綁定主 Session", { exact: true }).count(), 1)
    assert.equal(await page.getByRole("button", { name: "進入主 Session" }).isDisabled(), true)
    const createdNavigationPromise = page.context().waitForEvent("request", {
      predicate: (request) => request.isNavigationRequest()
        && request.url().startsWith(`${record.endpoint}/`)
        && request.url().includes("/session/"),
      timeout: 15_000,
    })
    await page.getByRole("button", { name: "New Session" }).click()
    const popupPromise = page.waitForEvent("popup")
    await page.getByRole("alertdialog", { name: "建立 New Session？" }).getByRole("button", { name: "建立並開啟" }).click()
    const popup = await popupPromise
    await page.locator(".primary-session-id").waitFor({ state: "visible", timeout: 15_000 })
    assert.equal(await page.getByRole("button", { name: "進入主 Session" }).isEnabled(), true)
    const createdPrimary = repository.getPrimarySession(record.id)
    assert.ok(createdPrimary?.sessionId)
    assert.equal(await page.locator(".primary-session-id").textContent(), createdPrimary.sessionId.slice(0, 8))
    const createdDestination = runtime.openUrl(record, createdPrimary.sessionId)
    const createdNavigation = await createdNavigationPromise
    assert.equal(createdNavigation.url(), createdDestination)
    await popup.close()

    const primaryPopupPromise = page.waitForEvent("popup")
    const primaryNavigationPromise = page.context().waitForEvent("request", {
      predicate: (request) => request.isNavigationRequest() && request.url() === createdDestination,
      timeout: 15_000,
    })
    await page.getByRole("button", { name: "進入主 Session" }).click()
    const primaryPopup = await primaryPopupPromise
    const primaryNavigation = await primaryNavigationPromise
    assert.equal(primaryNavigation.url(), createdDestination)
    await primaryPopup.close()

    await page.getByRole("button", { name: "執行個體操作" }).click()
    await page.getByRole("button", { name: "停止執行個體" }).click()
    await page.getByRole("alertdialog", { name: "停止整個執行個體？" }).getByRole("button", { name: "停止執行個體" }).click()
    await page.getByText("背景執行個體已停止。", { exact: true }).waitFor({ timeout: 20_000 })
    assert.equal(repository.getInstance(record.id)?.state, "stopped")
    assert.equal(await portReachable(record.port), false)
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"))
  } finally {
    for (const record of repository.listInstances()) {
      if (record.state !== "stopped" && await portReachable(record.port)) await runtime.stop(record).catch(() => undefined)
    }
    await browser?.close()
    await app.close().catch(() => undefined)
    repository.close()
    await rm(sandbox, { recursive: true, force: true })
  }
})

class BrowserRuntime implements RuntimePort {
  private readonly queuedSessions = new Map<string, SessionFixture[]>()
  private readonly activityObservers = new Map<string, (event: RuntimeActivityEvent) => Promise<void> | void>()
  private readonly createdSessions = new Map<string, SessionMetadata[]>()
  private createdSessionSequence = 0
  private projectBReady = false
  createSessionCalls = 0
  stopCalls = 0
  createSessionDelayMs = 0
  createSessionError: Error | null = null
  failCreatedSessionUrl = false
  allowStop = false

  queueSessions(projectName: string, ...responses: SessionFixture[]): void {
    this.queuedSessions.set(projectName, responses)
  }

  setProjectBReady(): void {
    this.projectBReady = true
  }

  async emitActivity(instanceId: string, event: RuntimeActivityEvent): Promise<void> {
    await this.activityObservers.get(instanceId)?.(event)
  }

  async launch(directory: string, port: number, instanceId: string): Promise<LaunchResult> {
    return {
      pid: 48001,
      creationTimeUtc: "2026-09-17T00:00:00.000Z",
      creationTimeTicks: "638936640000000001",
      executable: "C:\\tools\\opencode.exe",
      endpoint: `http://127.0.0.1:${port}`,
      directory,
      instanceId,
    }
  }

  async readiness(launch: LaunchResult) { return { version: "1.18.31", directory: launch.directory } }
  async cleanupLaunch() { return { stopped: true, reason: null } }
  async inspect() { return { running: true, matched: true, portOwnerMatched: true, portOwnedByOther: false } }
  async stop() {
    this.stopCalls++
    return this.allowStop ? { stopped: true, reason: null } : { stopped: false, reason: "fixture identity mismatch" }
  }
  async sessions(instance: InstanceRecord) {
    const queued = this.queuedSessions.get(instance.projectName)?.shift()
    if (queued) {
      await new Promise((resolve) => setTimeout(resolve, queued.delayMs))
      if (queued.error) throw new ManagerError("SESSION_FIXTURE_ERROR", queued.error, 503)
      return queued.roots ?? [{ id: "ses_shared", title: queued.title ?? "Fixture Root" }]
    }
    const roots = instance.projectName === "project-a"
      ? [{ id: "ses_shared", title: "Root A" }]
      : [
          { id: "ses_shared", title: "Shared history" },
          { id: "ses_second", title: "Second instance work" },
          { id: "ses_later", title: "Later unrelated work" },
        ]
    return [...roots, ...(this.createdSessions.get(instance.projectName) ?? [])]
  }
  async children(instance: InstanceRecord, sessionId: string) {
    await new Promise((resolve) => setTimeout(resolve, instance.projectName === "project-a" ? 200 : 20))
    if (instance.projectName === "project-a" && sessionId === "ses_shared") {
      return [{ id: "child-a", title: "Child A", parentID: "ses_shared" }]
    }
    if (instance.projectName === "project-a" && sessionId === "child-a") {
      return [{ id: "nested-a", title: "Nested A", parentID: "child-a" }]
    }
    if (instance.projectName === "project-b" && sessionId === "ses_shared") {
      return [{ id: "child-b", title: "Child B", parentID: "ses_shared" }]
    }
    return []
  }
  async summary(instance: InstanceRecord) {
    if (instance.projectName === "project-b" && !this.projectBReady) {
      return {
        activity: "unknown" as const,
        busySessions: null,
        pendingQuestions: null,
        pendingPermissions: null,
        error: "status endpoint unavailable",
        sessions: [{ id: "ses_shared", title: "共用根" }],
      }
    }
    if (instance.projectName === "project-b") {
      return {
        activity: "reported-non-busy" as const,
        busySessions: 0,
        pendingQuestions: 0,
        pendingPermissions: 0,
        error: null,
        sessions: [{ id: "ses_later", title: "Later unrelated work" }],
      }
    }
    return {
      activity: "busy" as const,
      busySessions: 1,
      pendingQuestions: 1,
      pendingPermissions: 0,
      error: null,
      sessions: [{ id: "ses_shared", title: "共用根" }],
    }
  }

  async activity() { return { busySessionIds: [] } }

  observeActivity(instance: InstanceRecord, onEvent: (event: RuntimeActivityEvent) => Promise<void> | void): RuntimeActivityObserver {
    this.activityObservers.set(instance.id, onEvent)
    let resolveDone = () => {}
    const done = new Promise<void>((resolve) => { resolveDone = resolve })
    return {
      close: () => {
        this.activityObservers.delete(instance.id)
        resolveDone()
      },
      done,
    }
  }

  async createSession(instance: InstanceRecord): Promise<SessionMetadata> {
    this.createSessionCalls++
    if (this.createSessionDelayMs) await new Promise((resolve) => setTimeout(resolve, this.createSessionDelayMs))
    if (this.createSessionError) throw this.createSessionError
    const id = `created-${++this.createdSessionSequence}`
    const session = { id, title: `New root ${id}` }
    const created = this.createdSessions.get(instance.projectName) ?? []
    created.push(session)
    this.createdSessions.set(instance.projectName, created)
    return session
  }

  openUrl(instance: Pick<InstanceRecord, "endpoint">, sessionId?: string): string {
    if (sessionId?.startsWith("created-") && this.failCreatedSessionUrl) {
      this.failCreatedSessionUrl = false
      throw new Error("created URL failure fixture")
    }
    return `${instance.endpoint}/opened/${sessionId ?? "new"}${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ""}`
  }
}

interface SessionFixture {
  delayMs: number
  title?: string
  error?: string
  roots?: Array<{ id: string; title: string }>
}

function fakeManagedInstance(overrides: Pick<ManagedInstance, "id" | "projectDirectory"> & Partial<ManagedInstance>): ManagedInstance {
  const { id, projectDirectory, ...rest } = overrides
  const summary = rest.summary ?? { activity: "reported-non-busy", busySessions: 0, pendingQuestions: 0, pendingPermissions: 0, error: null }
  const primarySummary = rest.primarySummary ?? (rest.primarySession
    ? { ...summary, scope: "known" as const, retrySessions: 0 }
    : {
        scope: "unbound" as const,
        activity: summary.activity,
        busySessions: null,
        retrySessions: null,
        pendingQuestions: null,
        pendingPermissions: null,
        error: summary.error,
      })
  return {
    id,
    kind: "headless",
    projectName: "shared-project",
    projectDirectory,
    state: "ready",
    endpoint: "http://127.0.0.1:49999",
    port: 49_999,
    pid: 10_001,
    launchedAt: "2026-09-18T00:00:00.000Z",
    healthVersion: "fixture-version",
    stopAllowed: true,
    remoteUrlUnavailableReason: null,
    error: null,
    summary,
    primarySummary,
    sessions: [],
    primarySession: null,
    trackingHidden: false,
    recovery: { recheckAllowed: false, resumeAllowed: false, hideAllowed: false, removeAllowed: false },
    ...rest,
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close((error) => error ? reject(error) : resolve(typeof address === "object" && address ? address.port : 0))
    })
  })
}

function createBrowserEnvironment(sandbox: string): NodeJS.ProcessEnv {
  const profile = path.join(sandbox, "browser-profile")
  return {
    ...baseProcessEnvironment(),
    HOME: profile,
    USERPROFILE: profile,
    APPDATA: path.join(profile, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(profile, "AppData", "Local"),
    TEMP: path.join(profile, "Temp"),
    TMP: path.join(profile, "Temp"),
  }
}

function baseProcessEnvironment(): NodeJS.ProcessEnv {
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

function portReachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port })
    const finish = (value: boolean) => { socket.destroy(); resolve(value) }
    socket.setTimeout(300)
    socket.once("connect", () => finish(true))
    socket.once("timeout", () => finish(false))
    socket.once("error", () => finish(false))
  })
}

async function assertShortcutFormLayout(page: Page, width: number): Promise<void> {
  const layout = await page.evaluate(() => {
    const buttons = [
      document.querySelector<HTMLButtonElement>(".shortcut-form > button[type=submit]"),
      document.querySelector<HTMLButtonElement>(".browse-form > button[type=submit]"),
    ]
    const panel = document.querySelector<HTMLElement>(".start-panel")
    if (!panel) throw new Error("start panel is missing")
    const panelBounds = panel.getBoundingClientRect()
    return {
      documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      panelBounds: { left: panelBounds.left, right: panelBounds.right },
      panelClientWidth: panel.clientWidth,
      panelScrollWidth: panel.scrollWidth,
      buttons: buttons.map((button) => {
        if (!button) throw new Error("form submit button is missing")
        const label = button.querySelector<HTMLElement>(".button-label")
        if (!label) throw new Error("form button label is missing")
        const buttonBounds = button.getBoundingClientRect()
        const labelBounds = label.getBoundingClientRect()
        return {
          whiteSpace: getComputedStyle(button).whiteSpace,
          labelWhiteSpace: getComputedStyle(label).whiteSpace,
          buttonClientWidth: button.clientWidth,
          buttonScrollWidth: button.scrollWidth,
          labelClientWidth: label.clientWidth,
          labelScrollWidth: label.scrollWidth,
          labelHeight: labelBounds.height,
          labelLineHeight: Number.parseFloat(getComputedStyle(label).lineHeight) || labelBounds.height,
          buttonBounds: { left: buttonBounds.left, right: buttonBounds.right, top: buttonBounds.top, bottom: buttonBounds.bottom },
          labelBounds: { left: labelBounds.left, right: labelBounds.right, top: labelBounds.top, bottom: labelBounds.bottom },
        }
      }),
      controlHeights: Array.from(document.querySelectorAll(".shortcut-form input, .shortcut-form button, .browse-form input, .browse-form button"),
        (control) => control.getBoundingClientRect().height),
    }
  })

  assert.equal(layout.documentWidth <= width, true, `${width}px viewport has horizontal overflow`)
  assert.equal(layout.panelBounds.left >= 0 && layout.panelBounds.right <= width, true, `${width}px start panel escapes the viewport`)
  assert.equal(layout.panelScrollWidth <= layout.panelClientWidth, true, `${width}px start panel has horizontal overflow`)
  for (const button of layout.buttons) {
    assert.equal(button.whiteSpace, "nowrap", `${width}px form button allows wrapping`)
    assert.equal(button.labelWhiteSpace, "nowrap", `${width}px form label allows wrapping`)
    assert.equal(button.buttonScrollWidth <= button.buttonClientWidth, true, `${width}px button content overflows`)
    assert.equal(button.labelScrollWidth <= button.labelClientWidth, true, `${width}px button label is clipped`)
    assert.equal(button.labelHeight <= button.labelLineHeight + 1, true, `${width}px button label wraps`)
    assert.equal(button.labelBounds.left >= button.buttonBounds.left - 1, true, `${width}px label escapes button left bound`)
    assert.equal(button.labelBounds.right <= button.buttonBounds.right + 1, true, `${width}px label escapes button right bound`)
    assert.equal(button.labelBounds.top >= button.buttonBounds.top - 1, true, `${width}px label escapes button top bound`)
    assert.equal(button.labelBounds.bottom <= button.buttonBounds.bottom + 1, true, `${width}px label escapes button bottom bound`)
  }
  if (width === 360) {
    for (const height of layout.controlHeights) assert.equal(Math.round(height) >= 44, true, `mobile form control is smaller than 44px: ${height}`)
  }
}

async function assertPrimaryActionLayout(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 844 })
  const advanced = page.locator("details.advanced-sessions")
  if (!await advanced.evaluate((details) => (details as HTMLDetailsElement).open)) await advanced.locator("summary").click()
  const layout = await page.evaluate(() => {
    const row = document.querySelector<HTMLElement>(".manual-session-controls")
    const field = document.querySelector<HTMLElement>(".manual-session-controls .main-session-picker")
    const select = document.querySelector<HTMLSelectElement>(".manual-session-controls select")
    const button = document.querySelector<HTMLButtonElement>(".manual-session-controls button")
    if (!row || !field || !select || !button) throw new Error("manual Session controls are missing")
    const rowBounds = row.getBoundingClientRect()
    const selectBounds = select.getBoundingClientRect()
    const buttonBounds = button.getBoundingClientRect()
    return {
      documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      rowBounds: { left: rowBounds.left, right: rowBounds.right },
      selectBounds: { left: selectBounds.left, right: selectBounds.right, bottom: selectBounds.bottom },
      buttonBounds: { left: buttonBounds.left, right: buttonBounds.right, bottom: buttonBounds.bottom },
    }
  })
  assert.equal(layout.documentWidth <= width, true, `${width}px primary controls cause horizontal overflow`)
  assert.equal(Math.abs(layout.selectBounds.bottom - layout.buttonBounds.bottom) <= 1, true, `${width}px selector and action are not baseline-aligned`)
  for (const bounds of [layout.selectBounds, layout.buttonBounds]) {
    assert.equal(bounds.left >= layout.rowBounds.left - 1, true, `${width}px primary control escapes left bound`)
    assert.equal(bounds.right <= layout.rowBounds.right + 1, true, `${width}px primary control escapes right bound`)
  }
}

async function assertGroupedInstanceLayout(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 844 })
  const layout = await page.evaluate(() => {
    const visible = <T extends HTMLElement>(elements: NodeListOf<T>): T[] => Array.from(elements).filter((element) => element.getClientRects().length > 0)
    return {
    documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    touchTargets: visible(document.querySelectorAll<HTMLElement>(".instance-row, .project-group-head, .filters button, .hidden-toggle")).map((element) => element.getBoundingClientRect().height),
    rowHeights: visible(document.querySelectorAll<HTMLElement>(".instance-row")).map((element) => element.getBoundingClientRect().height),
    groupPaths: Array.from(document.querySelectorAll<HTMLElement>(".project-group-head code"), (element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth })),
    titles: visible(document.querySelectorAll<HTMLElement>(".instance-copy strong")).map((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      textOverflow: getComputedStyle(element).textOverflow,
      whiteSpace: getComputedStyle(element).whiteSpace,
    })),
    identityLines: visible(document.querySelectorAll<HTMLElement>(".instance-title-line")).map((line) => {
      const pid = line.querySelector<HTMLElement>(".instance-pid")
      const title = line.querySelector<HTMLElement>("strong")
      if (!pid || !title) throw new Error("Instance identity line is incomplete")
      const pidBounds = pid.getBoundingClientRect()
      const titleBounds = title.getBoundingClientRect()
      return {
        pidClientWidth: pid.clientWidth,
        pidScrollWidth: pid.scrollWidth,
        pidWhiteSpace: getComputedStyle(pid).whiteSpace,
        pidRight: pidBounds.right,
        pidTop: pidBounds.top,
        pidBottom: pidBounds.bottom,
        titleLeft: titleBounds.left,
        titleTop: titleBounds.top,
        titleBottom: titleBounds.bottom,
      }
    }),
    highFrequencyTransitions: Array.from(document.querySelectorAll<HTMLElement>(".instance-row, .filters button, .no-press-transform"), (element) => getComputedStyle(element).transitionProperty),
    }
  })
  assert.equal(layout.documentWidth <= width, true, `${width}px grouped Instance UI has horizontal overflow`)
  for (const line of layout.identityLines) {
    assert.equal(line.pidScrollWidth <= line.pidClientWidth, true, `${width}px PID label is truncated`)
    assert.equal(line.pidWhiteSpace, "nowrap", `${width}px PID label wraps`)
    assert.equal(line.pidRight <= line.titleLeft, true, `${width}px PID label overlaps the Session title`)
    assert.equal(Math.min(line.pidBottom, line.titleBottom) > Math.max(line.pidTop, line.titleTop), true, `${width}px PID and Session title are not inline`)
  }
  for (const transition of layout.highFrequencyTransitions) assert.doesNotMatch(transition, /transform/, `${width}px high-frequency control has a movement transition`)
  if (width <= 390) {
    for (const height of layout.touchTargets) assert.equal(height >= 44, true, `${width}px grouped Instance target is smaller than 44px`)
    for (const height of layout.rowHeights) assert.equal(height <= 62, true, `${width}px Instance row grew beyond the dense mobile layout`)
  }
  if (width === 360) {
    assert.equal(layout.groupPaths.some((item) => item.scrollWidth > item.clientWidth), true, "long Project paths should truncate on narrow mobile")
    assert.equal(layout.titles.some((item) => item.textOverflow === "ellipsis" && item.whiteSpace === "nowrap"), true, "long primary Session titles should use single-line ellipsis on narrow mobile")
  }
}

async function assertDetailIdentityLayout(page: Page, width: number, title: string, folder: string, directory: string): Promise<void> {
  await page.setViewportSize({ width, height: 844 })
  const layout = await page.evaluate(() => {
    const heading = document.querySelector<HTMLElement>(".detail-head h2")
    const folderName = document.querySelector<HTMLElement>(".detail-folder")
    const path = document.querySelector<HTMLElement>(".detail-path")
    if (!heading || !folderName || !path) throw new Error("detail identity is missing")
    return {
      documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      headingText: heading.textContent,
      headingClientWidth: heading.clientWidth,
      headingScrollWidth: heading.scrollWidth,
      headingWhiteSpace: getComputedStyle(heading).whiteSpace,
      folderText: folderName.textContent,
      pathText: path.textContent,
      pathClientWidth: path.clientWidth,
      pathScrollWidth: path.scrollWidth,
    }
  })
  assert.equal(layout.headingText, title, `${width}px detail h2 prefers the primary Session title`)
  assert.equal(layout.folderText, folder, `${width}px detail shows the project folder after the primary title`)
  assert.equal(layout.pathText, directory, `${width}px detail keeps the complete project path`)
  assert.equal(layout.documentWidth <= width, true, `${width}px detail identity causes horizontal overflow`)
  assert.equal(layout.headingScrollWidth <= layout.headingClientWidth, true, `${width}px primary title overflows the detail heading`)
  assert.equal(layout.headingWhiteSpace, "normal", `${width}px primary title must be allowed to wrap`)
  assert.equal(layout.pathScrollWidth <= layout.pathClientWidth, true, `${width}px complete project path overflows the detail heading`)
}

async function returnToInstanceList(page: Page): Promise<void> {
  const button = page.getByRole("button", { name: "返回列表" })
  if (await button.isVisible()) await button.click()
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
