import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"
import { buildApp } from "../../manager/dist/src/app.js"
import { ManagerRepository } from "../../manager/dist/src/repository.js"
import { ManagerService } from "../../manager/dist/src/service.js"

const executablePath = process.env.OMW_BROWSER_EXECUTABLE
const enabled = process.env.OMW_BROWSER_TEST === "1"
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist")

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function withOverviewPage(run, setupPage = async () => {}, awaitInitial = true) {
  assert.ok(executablePath, "OMW_BROWSER_EXECUTABLE is required when OMW_BROWSER_TEST=1")
  const sandbox = await mkdtemp(path.join(tmpdir(), "omw-overview-refresh-"))
  const repository = new ManagerRepository(":memory:")
  const id = randomUUID()
  repository.createInstance({
    id, projectName: "refresh-fixture", projectDirectory: "C:\\refresh-fixture", state: "unreachable",
    endpoint: "http://127.0.0.1:49999", port: 49999, pid: 12345,
    creationTimeUtc: null, creationTimeTicks: null, executable: null,
    launchedAt: "2026-09-18T00:00:00.000Z", healthVersion: null,
    stoppedAt: null, error: null, stderrSummary: null,
  })
  let inspectCalls = 0
  let onInspect = async () => {}
  const runtime = {
    inspect: async () => {
      inspectCalls++
      await onInspect(inspectCalls)
      return { running: false, matched: false, portOwnerMatched: false, portOwnedByOther: false }
    },
    sessions: async () => [],
  }
  const service = new ManagerService(repository, runtime)
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const app = buildApp({ service, authority: { hostname: "127.0.0.1", port }, allowedOrigins: new Set([origin]), webRoot })
  let browser
  try {
    await app.listen({ host: "127.0.0.1", port })
    const profile = path.join(sandbox, "browser-profile")
    await Promise.all(["AppData/Roaming", "AppData/Local", "Temp"].map((folder) => mkdir(path.join(profile, folder), { recursive: true })))
    const env = Object.fromEntries(["SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "LANG", "LC_ALL"]
      .flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]))
    browser = await chromium.launch({ executablePath, headless: true, env: {
      ...env, HOME: profile, USERPROFILE: profile, APPDATA: path.join(profile, "AppData/Roaming"),
      LOCALAPPDATA: path.join(profile, "AppData/Local"), TEMP: path.join(profile, "Temp"), TMP: path.join(profile, "Temp"),
    } })
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    page.on("pageerror", (error) => console.error("web page error", error))
    await setupPage(page)
    await page.goto(origin)
    if (awaitInitial) await page.locator(`.instance-row[data-instance-id="${id}"]`).waitFor({ timeout: 5_000 })
    await run({ page, origin, id, service, setInspect: (callback) => { onInspect = callback }, inspectCount: () => inspectCalls })
  } finally {
    await browser?.close()
    await app.close()
    repository.close()
    await rm(sandbox, { recursive: true, force: true })
  }
}

test("global notification uses unfiltered instance-wide polling, persists preference and opens instance on click", { skip: !enabled, timeout: 20_000 }, async () => {
  let questions = 0
  let permissions = 0
  let reads = 0
  await withOverviewPage(async ({ page, id, origin }) => {
    await page.getByRole("button", { name: "OMW 設定" }).click()
    const toggle = page.getByRole("checkbox", { name: /頁面開啟期間通知/ })
    assert.equal(await toggle.isChecked(), false)
    assert.equal(await page.evaluate(() => window.__permissionRequests), 0)
    await toggle.check()
    await page.getByText("已在此瀏覽器啟用", { exact: false }).waitFor()
    assert.equal(await page.evaluate(() => window.__permissionRequests), 1)
    assert.equal(await page.evaluate(() => localStorage.getItem("omw-browser-notifications")), "true")
    assert.deepEqual(await page.evaluate(() => window.__shown), [], "enable baselines known zero")
    questions = 1
    permissions = 1
    await page.waitForFunction(() => window.__shown.length === 1, null, { timeout: 8_000 })
    assert.deepEqual((await page.evaluate(() => window.__shown)).map((item) => item.title), ["有待回答或待授權事項"])
    assert.ok(reads >= 2)
    await page.getByRole("button", { name: "關閉 OMW 設定" }).click()
    await page.goto(`${origin}/#instance=${encodeURIComponent(id)}`)
    await page.locator(`.detail-pane .detail-head`).waitFor()
    assert.equal(await page.evaluate(() => window.history.state.omwInstanceId), id)
    await page.reload()
    await page.getByRole("button", { name: "OMW 設定" }).click()
    await page.getByText("已在此瀏覽器啟用", { exact: false }).waitFor()
    assert.equal(await toggle.isChecked(), true)
    assert.equal(await page.evaluate(() => window.__permissionRequests), 0, "reload never re-prompts")
    await toggle.uncheck()
    assert.equal(await page.evaluate(() => localStorage.getItem("omw-browser-notifications")), null)
  }, async (page) => {
    await page.addInitScript(() => {
      window.__permissionRequests = 0
      window.__shown = []
      window.__grant = false
      Object.defineProperty(window, "Notification", { configurable: true, value: {
        get permission() { return window.__grant || localStorage.getItem("omw-browser-notifications") === "true" ? "granted" : "default" },
        requestPermission: () => { window.__permissionRequests++; window.__grant = true; return Promise.resolve("granted") },
      } })
      const registration = { showNotification: async (title, options) => { window.__shown.push({ title, ...options }) } }
      Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: {
        register: async () => registration, ready: Promise.resolve(registration),
      } })
    })
    await page.route("**/api/v1/overview?**", async (route) => {
      const response = await route.fetch()
      const overview = await response.json()
      overview.instances[0].state = "ready"
      overview.instances[0].summary.pendingQuestions = questions
      overview.instances[0].summary.pendingPermissions = permissions
      overview.instances[0].primarySummary.pendingQuestions = 0
      overview.instances[0].primarySummary.pendingPermissions = 0
      if (new URL(route.request().url()).searchParams.get("q") === "" && !new URL(route.request().url()).searchParams.has("includeHidden")) reads++
      await route.fulfill({ response, json: overview })
    })
  })
})

test("notification registration interrupted by a hidden page restarts on return without prompting", { skip: !enabled, timeout: 15_000 }, async () => {
  await withOverviewPage(async ({ page }) => {
    await page.waitForFunction(() => typeof window.__releaseRegister === "function")
    await page.waitForFunction(() => window.__pollInstalled === true)
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" })
      document.dispatchEvent(new Event("visibilitychange"))
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" })
      document.dispatchEvent(new Event("visibilitychange"))
      window.__releaseRegister()
    })
    await page.waitForFunction(() => window.__registrations === 2, null, { timeout: 8_000 })
    await page.getByRole("button", { name: "OMW 設定" }).click()
    await page.getByText("已在此瀏覽器啟用", { exact: false }).waitFor()
    assert.equal(await page.getByRole("checkbox", { name: /頁面開啟期間通知/ }).isChecked(), true)
    assert.equal(await page.evaluate(() => window.__permissionRequests), 0)
  }, async (page) => {
    await page.addInitScript(() => {
      localStorage.setItem("omw-browser-notifications", "true")
      window.__registrations = 0
      window.__permissionRequests = 0
      window.__pollInstalled = false
      const originalInterval = window.setInterval.bind(window)
      window.setInterval = (callback, milliseconds, ...args) => {
        if (milliseconds === 5_000) window.__pollInstalled = true
        return originalInterval(callback, milliseconds, ...args)
      }
      Object.defineProperty(window, "Notification", { configurable: true, value: {
        permission: "granted", requestPermission: () => { window.__permissionRequests++; return Promise.resolve("granted") },
      } })
      const registration = { showNotification: async () => {} }
      Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: {
        register: () => ++window.__registrations === 1
          ? new Promise((resolve) => { window.__releaseRegister = () => resolve(registration) })
          : Promise.resolve(registration),
        ready: Promise.resolve(registration),
      } })
    })
  })
})

test("overlapping notification poll requests queue one follow-up read", { skip: !enabled, timeout: 15_000 }, async () => {
  let reads = 0
  let active = 0
  let maxActive = 0
  let release
  let baselineDone
  let blocked
  const baseline = new Promise((resolve) => { baselineDone = resolve })
  const blockedRead = new Promise((resolve) => { blocked = resolve })
  await withOverviewPage(async ({ page }) => {
    await page.getByRole("button", { name: "已失聯", exact: true }).click()
    await page.route("**/api/v1/overview?**", async (route) => {
      if (new URL(route.request().url()).searchParams.get("filter") !== "all") return route.continue()
      const read = ++reads
      active++
      maxActive = Math.max(maxActive, active)
      try {
        if (read === 2) await new Promise((resolve) => { release = resolve; blocked() })
        const response = await route.fetch()
        const overview = await response.json()
        overview.instances[0].state = "ready"
        overview.instances[0].summary.pendingQuestions = 0
        overview.instances[0].summary.pendingPermissions = 0
        await route.fulfill({ response, json: overview })
      } finally {
        active--
        if (read === 1) baselineDone()
      }
    })
    await page.getByRole("button", { name: "OMW 設定" }).click()
    await page.getByRole("checkbox", { name: /頁面開啟期間通知/ }).check()
    await baseline
    try {
      await page.evaluate(() => window.__notificationPoll())
      await blockedRead
      await page.evaluate(() => { window.__notificationPoll(); window.__notificationPoll() })
    } finally {
      release?.()
    }
    await page.waitForFunction(() => window.__notificationReads === 3, null, { timeout: 5_000 })
    assert.equal(reads, 3, "multiple waiters schedule just one fresh snapshot")
    assert.equal(maxActive, 1, "notification reads never overlap")
  }, async (page) => {
    await page.addInitScript(() => {
      window.__notificationReads = 0
      const interval = window.setInterval.bind(window)
      window.setInterval = (callback, delay, ...args) => {
        if (delay === 5_000) window.__notificationPoll = callback
        return interval(callback, delay, ...args)
      }
      Object.defineProperty(window, "Notification", { configurable: true, value: {
        permission: "granted", requestPermission: async () => "granted",
      } })
      const registration = { showNotification: async () => {} }
      Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: {
        register: async () => registration, ready: Promise.resolve(registration),
      } })
      const fetch = window.fetch.bind(window)
      window.fetch = async (...args) => {
        if (args[0] === "/api/v1/overview?q=&filter=all" && localStorage.getItem("omw-browser-notifications") === "true") window.__notificationReads++
        return fetch(...args)
      }
    })
  })
})

test("foreground refresh retains the old list, neutral status and stable narrow layout while Manager shares a >5s snapshot", { skip: !enabled, timeout: 25_000 }, async () => {
  await withOverviewPage(async ({ page, origin, id, setInspect, inspectCount }) => {
    const before = await page.locator(".overview-freshness time").getAttribute("datetime")
    await page.waitForTimeout(150)
    await page.setViewportSize({ width: 360, height: 844 })
    let overviewReads = 0
    page.on("request", (request) => { if (request.url().includes("/api/v1/overview?")) overviewReads++ })
    setInspect(async () => { await new Promise((resolve) => setTimeout(resolve, 6300)) })
    await page.addStyleTag({ content: ".app-root { min-height: 1600px }" })
    await page.evaluate(() => window.scrollTo(0, 180))
    const scroll = await page.evaluate(() => scrollY)
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))
    await page.getByText("正在更新，先顯示上次資料", { exact: false }).waitFor({ timeout: 3_000 })
    assert.equal(await page.locator(`.instance-row[data-instance-id="${id}"]`).count(), 1)
    assert.equal(await page.locator(".loading-copy").count(), 0)
    assert.equal(await page.evaluate(() => scrollY), scroll, "refreshing preserves the list scroll position")
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    const geometry = await page.locator(".overview-freshness").evaluate((element) => element.getBoundingClientRect().height)
    const joined = fetch(`${origin}/api/v1/overview?q=&filter=all`).then((response) => response.json())
    await page.waitForTimeout(5200)
    await page.waitForFunction((previous) => {
      const status = document.querySelector(".overview-freshness")
      return status?.getAttribute("data-state") === "fresh" && status.querySelector("time")?.dateTime !== previous
    }, before, { timeout: 9_000 })
    assert.equal(await page.locator(".overview-freshness").evaluate((element) => element.getBoundingClientRect().height), geometry)
    assert.equal(await page.evaluate(() => scrollY), scroll, "the completed refresh keeps the scroll position")
    assert.equal(await page.locator(".overview-freshness [role=status]").count(), 0, "polling and last-success timestamps are not live announcements")
    assert.equal((await joined).instances.length, 1, "a concurrent Manager overview joined the same slow snapshot")
    assert.equal(overviewReads, 1, `polling should not launch another request (reads=${overviewReads}, inspect=${inspectCount()})`)
    assert.equal(inspectCount(), 2, "a concurrent Manager request joins the actual in-flight snapshot")
  })
})

test("returning from a hidden tab waits for the old Manager flight, then verifies a new snapshot once", { skip: !enabled, timeout: 20_000 }, async () => {
  await withOverviewPage(async ({ page, setInspect, inspectCount }) => {
    let releaseOld
    const oldHeld = new Promise((resolve) => { releaseOld = resolve })
    let oldStarted
    const oldSent = new Promise((resolve) => { oldStarted = resolve })
    let releaseNew
    const newHeld = new Promise((resolve) => { releaseNew = resolve })
    let newStarted
    const newSent = new Promise((resolve) => { newStarted = resolve })
    setInspect(async (call) => {
      if (call === 2) { oldStarted(); await oldHeld }
      if (call === 3) { newStarted(); await newHeld }
    })
    try {
      await oldSent // the five-second background poll has reached the actual Manager service
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" })
        document.dispatchEvent(new Event("visibilitychange"))
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" })
        document.dispatchEvent(new Event("visibilitychange"))
        window.dispatchEvent(new Event("pageshow"))
      })
      await page.locator('.overview-freshness[data-state="refreshing"]').waitFor()
      releaseOld()
      await newSent
      assert.equal(inspectCount(), 3, "only one new snapshot follows the old Manager flight despite duplicate foreground events")
      assert.equal(await page.locator(".overview-freshness").getAttribute("data-state"), "refreshing", "the old response cannot unlock mutations")
      releaseNew()
      await page.locator('.overview-freshness[data-state="fresh"]').waitFor()
    } finally {
      releaseOld()
      releaseNew()
    }
  })
})

test("a second hide while awaiting the old snapshot sends no new request until visible", { skip: !enabled, timeout: 20_000 }, async () => {
  await withOverviewPage(async ({ page, setInspect, inspectCount }) => {
    let releaseOld
    const oldHeld = new Promise((resolve) => { releaseOld = resolve })
    let oldStarted
    const oldSent = new Promise((resolve) => { oldStarted = resolve })
    setInspect(async (call) => { if (call === 2) { oldStarted(); await oldHeld } })
    try {
      await oldSent
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" })
        document.dispatchEvent(new Event("visibilitychange"))
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" })
        document.dispatchEvent(new Event("visibilitychange"))
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" })
        document.dispatchEvent(new Event("visibilitychange"))
      })
      const oldResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/overview")
      releaseOld()
      await oldResponse
      await page.waitForTimeout(100)
      assert.equal(inspectCount(), 2, "no replacement request is sent while hidden")
      assert.notEqual(await page.locator(".overview-freshness").getAttribute("data-state"), "fresh", "an old snapshot cannot re-enable mutations while hidden")
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" })
        document.dispatchEvent(new Event("visibilitychange"))
      })
      await page.waitForFunction(() => document.querySelector('.overview-freshness')?.getAttribute('data-state') === 'fresh')
      assert.equal(inspectCount(), 3)
    } finally {
      releaseOld()
    }
  })
})

test("a timed-out Manager flight is drained before any retry can mark the overview fresh", { skip: !enabled, timeout: 32_000 }, async () => {
  await withOverviewPage(async ({ page, setInspect, inspectCount }) => {
    let releaseOld
    const oldHeld = new Promise((resolve) => { releaseOld = resolve })
    let oldStarted
    const oldSent = new Promise((resolve) => { oldStarted = resolve })
    let releaseNew
    const newHeld = new Promise((resolve) => { releaseNew = resolve })
    let newStarted
    const newSent = new Promise((resolve) => { newStarted = resolve })
    setInspect(async (call) => {
      if (call === 2) { oldStarted(); await oldHeld }
      if (call === 3) { newStarted(); await newHeld }
    })
    try {
      await oldSent
      await page.locator('.overview-freshness[data-state="failed"]').waitFor({ timeout: 19_000 })
      assert.match(await page.locator(".overview-freshness").textContent(), /更新逾時/)
      await page.getByRole("button", { name: "重試更新" }).click()
      releaseOld()
      await newSent
      assert.equal(inspectCount(), 3, "a completed retry must be a distinct Manager inspection after draining the old one")
      assert.notEqual(await page.locator(".overview-freshness").getAttribute("data-state"), "fresh")
      releaseNew()
      await page.locator('.overview-freshness[data-state="fresh"]').waitFor()
    } finally {
      releaseOld()
      releaseNew()
    }
  })
})

test("initial loading and initial failure have distinct states and a retry recovers", { skip: !enabled, timeout: 15_000 }, async () => {
  let rejectInitial
  const held = new Promise((resolve) => { rejectInitial = resolve })
  let initialAttempt = true
  await withOverviewPage(async ({ page, id }) => {
    try {
      await page.locator('.overview-freshness[data-state="initial"]').waitFor()
      assert.equal(await page.locator(".overview-freshness time").count(), 0)
      rejectInitial()
      await page.locator('.overview-freshness[data-state="unavailable"]').waitFor()
      assert.equal(await page.locator(".overview-freshness").getByRole("button", { name: "重試更新" }).count(), 1)
      await page.getByRole("button", { name: "重試更新" }).click()
      await page.locator('.overview-freshness[data-state="fresh"]').waitFor()
      assert.equal(await page.locator(`.instance-row[data-instance-id="${id}"]`).count(), 1)
    } finally {
      rejectInitial()
    }
  }, async (page) => {
    await page.route("**/api/v1/overview?**", async (route) => {
      if (initialAttempt) {
        initialAttempt = false
        await held
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "UNAVAILABLE", message: "暫時無法更新" } }) })
      } else await route.continue()
    })
  }, false)
})

test("routine five-second polling updates the last-success time without a loading indicator or live status", { skip: !enabled, timeout: 12_000 }, async () => {
  await withOverviewPage(async ({ page, id }) => {
    const before = await page.locator(".overview-freshness time").getAttribute("datetime")
    await page.waitForFunction((previous) => document.querySelector(".overview-freshness time")?.dateTime !== previous, before, { timeout: 7_000 })
    assert.equal(await page.locator('.overview-freshness[data-state="fresh"]').count(), 1)
    assert.equal(await page.locator(".loading-copy, .overview-freshness [role=status]").count(), 0)
    assert.equal(await page.locator(`.instance-row[data-instance-id="${id}"]`).count(), 1)
  })
})

test("manual refresh immediately shows a neutral status and the previous successful time", { skip: !enabled, timeout: 12_000 }, async () => {
  await withOverviewPage(async ({ page, id }) => {
    const before = await page.locator(".overview-freshness time").getAttribute("datetime")
    let release
    const pending = new Promise((resolve) => { release = resolve })
    await page.route("**/api/v1/overview?**", async (route) => {
      await pending
      await route.continue()
    })
    try {
      await page.getByRole("button", { name: "重新整理" }).click()
      await page.locator('.overview-freshness[data-state="refreshing"]').waitFor()
      assert.match(await page.locator(".overview-freshness").textContent(), /正在更新，先顯示上次資料.*最後成功更新/)
      assert.equal(await page.locator(".overview-freshness time").getAttribute("datetime"), before)
      assert.equal(await page.locator(`.instance-row[data-instance-id="${id}"]`).count(), 1)
      assert.equal(await page.locator(".loading-copy").count(), 0)
      release()
      await page.locator('.overview-freshness[data-state="fresh"]').waitFor()
    } finally {
      release()
    }
  })
})

test("a failed foreground refresh keeps the old list guarded until retry succeeds", { skip: !enabled, timeout: 15_000 }, async () => {
  await withOverviewPage(async ({ page, id }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.getByRole("button", { name: "執行個體操作" }).click()
    let failed = true
    let recheckCalls = 0
    page.on("request", (request) => { if (request.url().includes(`/instances/${id}/recheck`)) recheckCalls++ })
    await page.route("**/api/v1/overview?**", async (route) => {
      if (failed) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "UNAVAILABLE", message: "暫時無法更新" } }) })
      else await route.continue()
    })
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))
    await page.locator('.overview-freshness[data-state="failed"]').waitFor()
    assert.match(await page.locator(".overview-freshness").textContent(), /最後成功更新.*暫時無法更新/)
    const action = page.getByRole("button", { name: "重新檢查", exact: true })
    assert.equal(await action.isDisabled(), true)
    assert.equal(recheckCalls, 0)
    failed = false
    await page.getByRole("button", { name: "重試更新" }).click()
    await page.locator('.overview-freshness[data-state="fresh"]').waitFor()
    assert.equal(await action.isEnabled(), true)
    assert.equal(recheckCalls, 0)
  })
})

test("query, filter and includeHidden changes reject out-of-order responses", { skip: !enabled, timeout: 15_000 }, async () => {
  await withOverviewPage(async ({ page, origin, id }) => {
    const initial = await (await fetch(`${origin}/api/v1/overview?q=&filter=all`)).json()
    let releaseOld
    const oldReleased = new Promise((resolve) => { releaseOld = resolve })
    let oldStarted
    const oldSent = new Promise((resolve) => { oldStarted = resolve })
    const requested = []
    await page.route("**/api/v1/overview?**", async (route) => {
      const url = new URL(route.request().url())
      requested.push(url)
      if (url.searchParams.get("q") === "old") {
        oldStarted()
        await oldReleased
        await route.fulfill({ json: initial }).catch(() => undefined)
      } else if (url.searchParams.get("q") === "new" && url.searchParams.get("filter") === "attention" && url.searchParams.get("includeHidden") === "true") {
        await route.fulfill({ json: { ...initial, instances: [{ ...initial.instances[0], id: `${id}-new`, projectDirectory: "C:\\new-result" }] } })
      } else {
        await route.fulfill({ json: { ...initial, instances: [] } })
      }
    })
    try {
      await page.getByRole("textbox", { name: "搜尋" }).fill("old")
      await page.getByRole("button", { name: "執行搜尋" }).click()
      await oldSent
      await page.getByRole("textbox", { name: "搜尋" }).fill("new")
      await page.getByRole("button", { name: "需處理" }).click()
      await page.getByLabel("顯示已停止追蹤").check()
      await page.locator(`[data-instance-id="${id}-new"]`).waitFor()
      releaseOld()
      await page.waitForTimeout(150)
      assert.equal(await page.locator(`[data-instance-id="${id}"]`).count(), 0)
      assert.equal(await page.locator(`[data-instance-id="${id}-new"]`).count(), 1)
      assert.ok(requested.some((url) => url.searchParams.get("includeHidden") === "true" && url.searchParams.get("filter") === "attention"))
    } finally {
      releaseOld()
    }
  })
})

test("switching mobile detail reads only the newly selected primary todos and clears the previous todos immediately", { skip: !enabled, timeout: 15_000 }, async () => {
  const secondId = randomUUID()
  let releaseSecond
  const secondHeld = new Promise((resolve) => { releaseSecond = resolve })
  let secondStarted
  const secondSent = new Promise((resolve) => { secondStarted = resolve })
  await withOverviewPage(async ({ page, id }) => {
    const todoRequests = []
    await page.route("**/api/v1/instances/*/primary-todos", async (route) => {
      const instanceId = new URL(route.request().url()).pathname.split("/").at(-2)
      todoRequests.push(instanceId)
      if (instanceId === secondId) {
        secondStarted()
        await secondHeld
      }
      await route.fulfill({ json: {
        instanceId,
        sessionId: instanceId === id ? "session-a" : "session-b",
        todos: [{ content: instanceId === id ? "A 的待辦" : "B 的待辦", status: "pending", priority: "high" }],
      } })
    })
    try {
      await page.locator(`.instance-row[data-instance-id="${id}"]`).click()
      await page.getByText("A 的待辦", { exact: true }).waitFor()
      assert.deepEqual(todoRequests, [id])

      await page.getByRole("button", { name: "返回列表" }).click()
      await page.locator(".mobile-back").waitFor({ state: "hidden" })
      await page.locator(`.instance-row[data-instance-id="${secondId}"]`).click()
      await secondSent

      assert.deepEqual(todoRequests, [id, secondId], "opening B must not briefly read A again")
      assert.equal(await page.getByText("A 的待辦", { exact: true }).count(), 0, "switching targets clears A before B responds")
      assert.equal(await page.getByRole("status").filter({ hasText: "正在載入主 Session 待辦事項" }).count(), 1)
      assert.ok((await page.getByRole("region", { name: "主 Session 待辦事項" }).boundingBox()).height >= 90, "the new target retains layout space without showing the old Todo")
      releaseSecond()
      await page.getByText("B 的待辦", { exact: true }).waitFor()
    } finally {
      releaseSecond()
    }
  }, async (page) => {
    await page.route("**/api/v1/overview?**", async (route) => {
      const response = await route.fetch()
      const overview = await response.json()
      overview.instances = [
        { ...overview.instances[0], primarySession: { sessionId: "session-a", title: "A", source: "manual", boundAt: "2026-09-24T00:00:00.000Z" } },
        { ...overview.instances[0], id: secondId, projectName: "second-fixture", projectDirectory: "C:\\second-fixture", primarySession: { sessionId: "session-b", title: "B", source: "manual", boundAt: "2026-09-24T00:00:00.000Z" } },
      ]
      await route.fulfill({ response, json: overview })
    })
  })
})

test("primary Session Todo reserves readable space while loading and when empty on phone and desktop", { skip: !enabled, timeout: 15_000 }, async () => {
  for (const width of [390, 1440]) {
    let releaseTodo
    const held = new Promise((resolve) => { releaseTodo = resolve })
    await withOverviewPage(async ({ page, id }) => {
      try {
        if (width === 390) await page.locator(`.instance-row[data-instance-id="${id}"]`).click()
        const loading = page.getByRole("status").filter({ hasText: "正在載入主 Session 待辦事項" })
        await loading.waitFor()
        const panel = page.getByRole("region", { name: "主 Session 待辦事項" })
        const loadingHeight = await panel.evaluate((element) => element.getBoundingClientRect().height)
        assert.ok(loadingHeight >= (width === 390 ? 90 : 100), `${width}px loading reserves space: ${loadingHeight}px`)
        releaseTodo()
        await page.getByText("此主 Session 目前沒有待辦事項。", { exact: true }).waitFor()
        const emptyHeight = await panel.evaluate((element) => element.getBoundingClientRect().height)
        assert.ok(emptyHeight >= (width === 390 ? 90 : 100), `${width}px empty reserves space: ${emptyHeight}px`)
      } finally {
        releaseTodo()
      }
    }, async (page) => {
      await page.setViewportSize({ width, height: 844 })
      await page.route("**/api/v1/overview?**", async (route) => {
        const response = await route.fetch()
        const overview = await response.json()
        overview.instances[0].primarySession = { sessionId: "session-a", title: "A", source: "manual", boundAt: "2026-09-24T00:00:00.000Z" }
        await route.fulfill({ response, json: overview })
      })
      await page.route("**/api/v1/instances/*/primary-todos", async (route) => {
        await held
        const instanceId = new URL(route.request().url()).pathname.split("/").at(-2)
        await route.fulfill({ json: { instanceId, sessionId: "session-a", todos: [] } }).catch(() => undefined)
      })
    })
  }
})

test("primary Session Todo follows wrapped rows, refresh changes and errors without hiding actions", { skip: !enabled, timeout: 45_000 }, async () => {
  const longTodos = Array.from({ length: 6 }, (_, index) => ({
    content: `待辦 ${index + 1}：${"這段內容要換行才能完整閱讀。".repeat(8)}`,
    status: "pending", priority: "high",
  }))
  for (const width of [390, 1440]) {
    let reads = 0
    await withOverviewPage(async ({ page, id }) => {
      if (width === 390) await page.locator(`.instance-row[data-instance-id="${id}"]`).click()
      const panel = page.getByRole("region", { name: "主 Session 待辦事項" })
      const content = panel.locator(".primary-todos-content")
      const action = page.getByRole("button", { name: "New Session" })
      const measured = async () => content.evaluate((element) => ({
        height: element.getBoundingClientRect().height,
        needed: element.firstElementChild.getBoundingClientRect().height,
        transition: getComputedStyle(element).transitionDuration,
        overflow: getComputedStyle(element).overflowY,
      }))
      const readable = async (expectedWidth) => {
        await page.waitForFunction((expectedWidth) => {
          if (window.innerWidth !== expectedWidth) return false
          const element = document.querySelector(".primary-todos-content")
          if (!element) return false
          const needed = element.firstElementChild.getBoundingClientRect().height
          return Math.abs(parseFloat(element.style.height) - Math.ceil(needed)) <= 1 && element.getBoundingClientRect().height + 1 >= needed
        }, expectedWidth)
        const { height, needed, overflow } = await measured()
        assert.ok(height + 1 >= needed, `${width}px content fits: ${height}px >= ${needed}px`)
        assert.equal(overflow, "clip", "the measured container clips only while its height catches up; settled content remains fully readable")
        const last = await panel.locator(".primary-todos-timeline li").last().boundingBox()
        if (last) assert.ok((await action.boundingBox()).y >= last.y + last.height - 1, "actions follow the last row")
      }

      if (width === 1440) {
        await panel.getByRole("alert").filter({ hasText: "讀取失敗" }).waitFor()
        assert.ok((await panel.boundingBox()).height >= 100, "initial error reserves space")
        const errorMargin = await content.locator(":scope > div").evaluate((inner) => {
          const first = inner.firstElementChild
          return { gap: first.getBoundingClientRect().top - inner.getBoundingClientRect().top, margin: parseFloat(getComputedStyle(first).marginTop) }
        })
        assert.ok(errorMargin.gap >= errorMargin.margin - 1, "error margin is included inside the measured box instead of shifting the panel")
      } else {
        await page.getByText("此主 Session 目前沒有待辦事項。", { exact: true }).waitFor()
      }
      assert.equal((await measured()).transition, "0.18s")
      await page.waitForFunction(() => document.querySelectorAll(".primary-todos-timeline li").length === 6, null, { timeout: 8_000 })
      const listMargin = await content.locator(":scope > div").evaluate((inner) => {
        const first = inner.firstElementChild
        return { gap: first.getBoundingClientRect().top - inner.getBoundingClientRect().top, margin: parseFloat(getComputedStyle(first).marginTop) }
      })
      assert.ok(listMargin.gap >= listMargin.margin - 1, "list margin participates in the observed content height")
      await readable(width)
      const wideHeight = (await measured()).needed
      const narrowWidth = width === 390 ? 320 : 900
      await page.setViewportSize({ width: narrowWidth, height: 844 })
      const transitionFrame = await page.waitForFunction((prior) => {
        const element = document.querySelector(".primary-todos-content")
        const target = parseFloat(element.style.height)
        if (element.firstElementChild.getBoundingClientRect().height <= prior || target - element.getBoundingClientRect().height <= 24) return false
        const action = document.querySelector(".primary-actions")
        return { overflow: getComputedStyle(element).overflowY, excess: element.firstElementChild.getBoundingClientRect().bottom - action.getBoundingClientRect().top }
      }, wideHeight)
      const { overflow: animatedOverflow, excess } = await transitionFrame.jsonValue()
      assert.ok(excess > 10, "during the resize animation, long rows would otherwise cover the actions")
      assert.equal(animatedOverflow, "clip", "only the transitioning content box clips rows before its target height catches up")
      await readable(narrowWidth)
      const narrowHeight = (await measured()).needed
      await page.setViewportSize({ width, height: 844 })
      await page.waitForFunction((prior) => parseFloat(document.querySelector(".primary-todos-content").style.height) < prior, narrowHeight)
      await page.setViewportSize({ width: narrowWidth, height: 844 })
      await readable(narrowWidth) // a new width retargets any height transition still in progress

      await page.emulateMedia({ reducedMotion: "reduce" })
      assert.equal((await measured()).transition, "0s", "reduced motion turns off size transitions")
      await panel.getByRole("alert").filter({ hasText: "讀取失敗" }).waitFor({ timeout: 8_000 })
      assert.equal(await panel.getByText("（下列為上次讀取結果，已過期）").count(), 1)
      assert.equal(await panel.locator(".primary-todos-timeline li").count(), 6, "failed refresh retains the old rows")
      await readable(narrowWidth)
      await page.getByText("此主 Session 目前沒有待辦事項。", { exact: true }).waitFor({ timeout: 8_000 })
      assert.ok((await panel.boundingBox()).height >= (width === 390 ? 90 : 100), "empty refresh keeps base height")
      await action.click()
      await page.getByText("建立 New Session？").waitFor()
      await page.getByRole("button", { name: "取消" }).click()
    }, async (page) => {
      await page.setViewportSize({ width, height: 844 })
      await page.route("**/api/v1/overview?**", async (route) => {
        const response = await route.fetch()
        const overview = await response.json()
        overview.instances[0].state = "ready"
        overview.instances[0].primarySession = { sessionId: "session-a", title: "A", source: "manual", boundAt: "2026-09-24T00:00:00.000Z" }
        await route.fulfill({ response, json: overview })
      })
      await page.route("**/api/v1/instances/*/primary-todos", async (route) => {
        reads++
        if ((width === 1440 && reads === 1) || reads === 3) {
          await route.fulfill({ status: 503, json: { error: "暫時無法讀取" } })
          return
        }
        const instanceId = new URL(route.request().url()).pathname.split("/").at(-2)
        await route.fulfill({ json: { instanceId, sessionId: "session-a", todos: reads === 2 ? longTodos : [] } })
      })
    })
  }
})

test("a hung refresh times out, retains the last successful time, and a retry recovers", { skip: !enabled, timeout: 35_000 }, async () => {
  await withOverviewPage(async ({ page, origin, id }) => {
    const initial = await (await fetch(`${origin}/api/v1/overview?q=&filter=all`)).json()
    const previous = await page.locator(".overview-freshness time").getAttribute("datetime")
    let reads = 0
    let releaseHung
    const hung = new Promise((resolve) => { releaseHung = resolve })
    await page.route("**/api/v1/overview?**", async (route) => {
      reads++
      if (reads === 1) {
        await hung
        await route.fulfill({ json: { ...initial, instances: [] } }).catch(() => undefined)
      } else if (reads === 2) {
        await route.fulfill({ json: { ...initial, instances: [] } })
      } else {
        await route.fulfill({ json: initial })
      }
    })
    try {
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))
      await page.locator('.overview-freshness[data-state="refreshing"]').waitFor()
      await page.locator('.overview-freshness[data-state="failed"]').waitFor({ timeout: 19_000 })
      assert.match(await page.locator(".overview-freshness").textContent(), /更新逾時/)
      assert.equal(await page.locator(".overview-freshness time").getAttribute("datetime"), previous)
      await page.getByRole("button", { name: "重試更新" }).click()
      await page.locator('.overview-freshness[data-state="fresh"]').waitFor()
      releaseHung()
      await page.waitForTimeout(150)
      assert.equal(await page.locator(`[data-instance-id="${id}"]`).count(), 1)
      assert.equal(reads, 3, "the first response after a timeout is only a drain, then a new snapshot verifies freshness")
    } finally {
      releaseHung()
    }
  })
})

test("a mutation refresh cannot be overwritten by a pre-mutation overview response", { skip: !enabled, timeout: 15_000 }, async () => {
  await withOverviewPage(async ({ page, origin, id }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.getByRole("button", { name: "執行個體操作" }).click()
    const initial = await (await fetch(`${origin}/api/v1/overview?q=&filter=all`)).json()
    let releaseMutation
    const mutationHeld = new Promise((resolve) => { releaseMutation = resolve })
    let releaseOld
    const oldHeld = new Promise((resolve) => { releaseOld = resolve })
    let oldStarted
    const oldSent = new Promise((resolve) => { oldStarted = resolve })
    let reads = 0
    await page.route(`**/api/v1/instances/${id}/recheck`, async (route) => {
      await mutationHeld
      await route.continue()
    })
    await page.route("**/api/v1/overview?**", async (route) => {
      reads++
      if (reads === 1) {
        oldStarted()
        await oldHeld
        await route.fulfill({ json: { ...initial, instances: [] } }).catch(() => undefined)
      } else {
        await route.continue()
      }
    })
    try {
      await page.getByRole("button", { name: "重新檢查", exact: true }).click()
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))
      await oldSent
      releaseMutation()
      await page.locator('.overview-freshness[data-state="fresh"]').waitFor()
      releaseOld()
      await page.waitForTimeout(150)
      assert.equal(await page.locator(`[data-instance-id="${id}"]`).count(), 1)
      assert.ok(reads >= 2)
    } finally {
      releaseMutation()
      releaseOld()
    }
  })
})

test("a foreground overview that finishes before recheck does not unlock stale mutations", { skip: !enabled, timeout: 15_000 }, async () => {
  await withOverviewPage(async ({ page, origin, id }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.getByRole("button", { name: "執行個體操作" }).click()
    const initial = await (await fetch(`${origin}/api/v1/overview?q=&filter=all`)).json()
    let releaseMutation
    const mutationHeld = new Promise((resolve) => { releaseMutation = resolve })
    let mutationStarted
    const mutationSent = new Promise((resolve) => { mutationStarted = resolve })
    let releasePostRefresh
    const postRefreshHeld = new Promise((resolve) => { releasePostRefresh = resolve })
    let postRefreshStarted
    const postRefreshSent = new Promise((resolve) => { postRefreshStarted = resolve })
    let reads = 0
    await page.route(`**/api/v1/instances/${id}/recheck`, async (route) => {
      mutationStarted()
      await mutationHeld
      await route.continue()
    })
    await page.route("**/api/v1/overview?**", async (route) => {
      reads++
      if (reads === 1) await route.fulfill({ json: initial })
      else {
        postRefreshStarted()
        await postRefreshHeld
        await route.continue()
      }
    })
    try {
      await page.getByRole("button", { name: "重新檢查", exact: true }).click()
      await mutationSent
      const foreground = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/overview")
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))
      await foreground
      await page.waitForTimeout(100)
      assert.equal(await page.locator(".overview-freshness").getAttribute("data-state"), "changed", "pre-mutation overview cannot clear the safety gate")
      releaseMutation()
      await postRefreshSent
      await page.locator('.overview-freshness[data-state="refreshing"]').waitFor()
      const validated = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/overview")
      releasePostRefresh()
      await validated
      await page.waitForTimeout(150)
      assert.equal(await page.locator(".overview-freshness").getAttribute("data-state"), "fresh", "post-operation verification clears stale before the next five-second poll")
      assert.equal(await page.locator(`[data-instance-id="${id}"]`).count(), 1)
      assert.ok(reads >= 2)
    } finally {
      releaseMutation()
      releasePostRefresh()
    }
  })
})

test("repeated failed background polls keep one alert without re-announcing refreshing", { skip: !enabled, timeout: 15_000 }, async () => {
  await withOverviewPage(async ({ page }) => {
    await page.route("**/api/v1/overview?**", async (route) => {
      await route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "暫時無法更新" } } })
    })
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))
    const failed = page.locator('.overview-freshness[data-state="failed"] [role="alert"]')
    await failed.waitFor()
    const firstAlert = await failed.elementHandle()
    assert.ok(firstAlert)
    await page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/overview" && response.status() === 503, { timeout: 8_000 })
    await page.waitForTimeout(100)
    assert.equal(await page.locator('.overview-freshness[data-state="failed"]').count(), 1)
    assert.equal(await page.locator(".overview-freshness [role=status]").count(), 0)
    assert.equal(await page.evaluate((alert) => document.querySelector(".overview-freshness [role=alert]") === alert, firstAlert), true,
      "polling must not remove and reinsert the live alert on identical failures")
  })
})

test("narrow status keeps full timestamp and errors readable without moving the list", { skip: !enabled, timeout: 15_000 }, async () => {
  await withOverviewPage(async ({ page }) => {
    const longError = "暫時無法更新，請確認 Manager 與網路連線。".repeat(8)
    for (const width of [320, 360]) {
      await page.setViewportSize({ width, height: 844 })
      const before = await page.locator(".instance-list").evaluate((element) => element.getBoundingClientRect().top)
      const statusHeight = await page.locator(".overview-freshness").evaluate((element) => element.getBoundingClientRect().height)
      await page.route("**/api/v1/overview?**", async (route) => {
        await route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: longError } } })
      })
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))
      await page.locator('.overview-freshness[data-state="failed"]').waitFor()
      const result = await page.locator(".overview-freshness").evaluate((element) => {
        const timestamp = element.querySelector("small")
        const error = element.querySelector("small:last-child")
        const content = element.querySelector(":scope > div")
        if (content) content.scrollTop = content.scrollHeight
        return {
          height: element.getBoundingClientRect().height,
          timestampWrap: timestamp && getComputedStyle(timestamp).whiteSpace === "normal" && timestamp.scrollWidth <= timestamp.clientWidth,
          errorWrap: error && getComputedStyle(error).whiteSpace === "normal" && error.scrollWidth <= error.clientWidth,
          longErrorScrollable: content && content.scrollHeight > content.clientHeight && content.scrollTop > 0,
          noOverflow: document.documentElement.scrollWidth <= innerWidth,
        }
      })
      assert.equal(result.height, statusHeight, `${width}px status stays fixed across refresh failure`)
      assert.equal(result.timestampWrap, true, `${width}px timestamp is fully wrapped rather than ellipsized`)
      assert.equal(result.errorWrap, true, `${width}px error is fully wrapped rather than ellipsized`)
      assert.equal(result.longErrorScrollable, true, `${width}px long errors remain readable by scrolling inside the fixed status`)
      assert.equal(result.noOverflow, true, `${width}px content fits the viewport`)
      assert.equal(await page.locator(".instance-list").evaluate((element) => element.getBoundingClientRect().top), before)
      await page.unrouteAll()
      await page.getByRole("button", { name: "重試更新" }).click()
      await page.locator('.overview-freshness[data-state="fresh"]').waitFor()
    }
  })
})
