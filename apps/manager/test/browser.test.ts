import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright-core"
import { buildApp } from "../src/app.js"
import { ManagerRepository, type InstanceRecord } from "../src/repository.js"
import { ManagerService } from "../src/service.js"
import { OpenCodeRuntime, type LaunchResult, type RuntimePort } from "../src/runtime.js"

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

test("mobile UI covers Shortcut, browsing, filters, scoped Session trees, and Stop errors", { skip: !enabled, timeout: 45_000 }, async () => {
  const executablePath = process.env.OMW_BROWSER_EXECUTABLE
  assert.ok(executablePath, "OMW_BROWSER_EXECUTABLE is required")
  const sandbox = await mkdtemp(path.join(tmpdir(), "omw-browser-"))
  const projectA = path.join(sandbox, "project-a")
  const projectB = path.join(sandbox, "project-b")
  const childDirectory = path.join(projectA, "child-folder")
  await Promise.all([mkdir(childDirectory, { recursive: true }), mkdir(projectB)])
  const repository = new ManagerRepository(path.join(sandbox, "omw.sqlite"))
  const service = new ManagerService(repository, new BrowserRuntime())
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
    browser = await chromium.launch({ executablePath, headless: true })
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    const pageErrors: string[] = []
    page.on("pageerror", (error) => pageErrors.push(error.message))
    await page.goto(origin, { waitUntil: "networkidle" })

    await page.getByLabel("Shortcut 名稱").fill("瀏覽器測試")
    await page.getByLabel("Shortcut 目錄").fill(projectA)
    await page.getByRole("button", { name: "新增捷徑" }).click()
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

    page.once("dialog", (dialog) => dialog.accept())
    await page.getByRole("button", { name: "移除 Shortcut" }).click()
    await page.waitForTimeout(300)
    assert.equal(repository.listShortcuts().length, 0, `${await page.locator("body").innerText()}\n${serverErrors.join("\n")}`)
    await page.getByText("Shortcut 已移除；Instance 未受影響。", { exact: true }).waitFor()
    assert.equal(repository.listShortcuts().length, 0)

    await page.getByRole("button", { name: /啟動全新 Instance/ }).click()
    await page.getByText("可連線", { exact: true }).first().waitFor()

    await page.getByLabel("瀏覽目錄").fill(projectB)
    await page.getByRole("button", { name: "瀏覽", exact: true }).click()
    await page.getByRole("button", { name: /啟動全新 Instance/ }).click()
    await page.getByText("摘要未知：INSTANCE_SUMMARY_PARTIAL", { exact: true }).waitFor()
    assert.equal(repository.listInstances().length, 2)

    await page.getByRole("textbox", { name: "搜尋" }).fill("project-a")
    await page.getByRole("button", { name: "執行搜尋" }).click()
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
    await page.getByRole("button", { name: "無法連線", exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll(".instance-row").length === 1)
    assert.equal(await page.locator(".instance-row").count(), 1)
    await page.getByRole("button", { name: "全部", exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll(".instance-row").length === 2)

    const instanceA = page.locator(".instance-row").filter({ hasText: "project-a" })
    const instanceB = page.locator(".instance-row").filter({ hasText: "project-b" })
    await instanceA.click()
    await page.getByText("共用根", { exact: true }).waitFor()
    await page.getByRole("button", { name: "載入 Child Session" }).click()
    await page.getByText("Child A", { exact: true }).waitFor()
    const childA = page.locator(".session-node").filter({ hasText: "Child A" }).first()
    await childA.getByRole("button", { name: "載入 Child Session" }).click()
    await page.getByText("Nested A", { exact: true }).waitFor()

    await instanceB.click()
    await page.getByText("摘要未知：INSTANCE_SUMMARY_PARTIAL", { exact: true }).waitFor()
    assert.equal(await page.getByText("Child A", { exact: true }).count(), 0)
    await page.getByRole("button", { name: "載入 Child Session" }).click()
    await page.getByText("Child B", { exact: true }).waitFor()
    assert.equal(await page.getByText("Nested A", { exact: true }).count(), 0)

    await instanceA.click()
    await page.getByText("共用根", { exact: true }).waitFor()
    assert.equal(await page.getByText("Child B", { exact: true }).count(), 0)
    await page.getByRole("button", { name: "載入 Child Session" }).click()
    await instanceB.click()
    await page.waitForTimeout(300)
    assert.equal(await page.getByText("Child A", { exact: true }).count(), 0)

    page.once("dialog", (dialog) => dialog.accept())
    await page.getByRole("button", { name: "安全停止" }).click()
    await page.getByText(/拒絕停止：process identity 無法安全核對/).waitFor()
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"))
  } finally {
    await browser?.close()
    await app.close()
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
  const openCodeEnvironment = createOpenCodeEnvironment(sandbox, config)
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
    await page.getByLabel("瀏覽目錄").fill(project)
    await page.getByRole("button", { name: "瀏覽", exact: true }).click()
    await page.getByRole("button", { name: /啟動全新 Instance/ }).click()
    await page.waitForFunction(
      () => document.body.textContent?.includes("已由真實 health 證明 ready") || document.querySelector(".banner-error") !== null,
      undefined,
      { timeout: 25_000 },
    ).catch(() => undefined)
    const body = await page.locator("body").innerText()
    assert.match(body, /已由真實 health 證明 ready/, `${body}\n${serverErrors.join("\n")}`)

    const record = repository.listInstances()[0]
    assert.ok(record)
    const popupPromise = page.waitForEvent("popup")
    await page.getByRole("button", { name: "Open Web" }).click()
    const popup = await popupPromise
    await popup.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined)
    assert.match(popup.url(), new RegExp(`^${escapeRegex(record.endpoint)}/[^/]+/session`))
    await popup.close()

    page.once("dialog", (dialog) => dialog.accept())
    await page.getByRole("button", { name: "安全停止" }).click()
    await page.getByText("已核對 process identity 並停止背景 Instance。", { exact: true }).waitFor({ timeout: 20_000 })
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
  async stop() { return { stopped: false, reason: "fixture identity mismatch" } }
  async sessions() { return [{ id: "ses_shared", title: "共用根" }] }
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
    if (instance.projectName === "project-b") {
      return {
        activity: "unknown" as const,
        busySessions: null,
        pendingQuestions: null,
        pendingPermissions: null,
        error: "status endpoint unavailable",
        sessions: [{ id: "ses_shared", title: "共用根" }],
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

  openUrl(instance: Pick<InstanceRecord, "endpoint">): string { return instance.endpoint }
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

function createOpenCodeEnvironment(sandbox: string, config: string): NodeJS.ProcessEnv {
  const home = path.join(sandbox, "home")
  const temporary = path.join(home, "Temp")
  return {
    ...baseProcessEnvironment(),
    HOME: home,
    USERPROFILE: home,
    TEMP: temporary,
    TMP: temporary,
    OPENCODE_TEST_HOME: home,
    XDG_CONFIG_HOME: path.join(sandbox, "xdg-config"),
    XDG_DATA_HOME: path.join(sandbox, "xdg-data"),
    XDG_CACHE_HOME: path.join(sandbox, "xdg-cache"),
    XDG_STATE_HOME: path.join(sandbox, "xdg-state"),
    OPENCODE_DB: path.join(sandbox, "opencode.sqlite"),
    OPENCODE_CONFIG: path.join(config, "opencode.json"),
    OPENCODE_CONFIG_DIR: config,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_PURE: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_PRUNE: "1",
    OPENCODE_AUTO_SHARE: "false",
  }
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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
