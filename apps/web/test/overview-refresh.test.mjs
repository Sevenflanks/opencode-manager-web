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
      assert.equal(reads, 2)
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
