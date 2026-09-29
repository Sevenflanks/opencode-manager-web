import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import { createSSRApp, defineComponent, h } from "vue"
import { renderToString } from "vue/server-renderer"
import { createServer } from "vite"

const server = await createServer({ server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true }, appType: "custom" })
try {
  const { i18n, useMessages } = await server.ssrLoadModule("/src/i18n.ts")
  const { LocalError, presentError, presentStatusError, safeDiagnostic } = await server.ssrLoadModule("/src/error-presentation.ts")
  const { ApiError } = await server.ssrLoadModule("/src/api.ts")
  const longLocale = JSON.parse(await readFile(new URL("./long-test.locale.json", import.meta.url), "utf8"))
  const base = i18n.global.getLocaleMessage("zh-TW")
  const render = (key, named) => {
    const app = createSSRApp(defineComponent({
      setup() {
        const { t, date, number } = useMessages()
        return () => h("main", [t(key, named), date(new Date("2025-01-02T00:00:00Z")), number(12345)])
      },
    }))
    app.use(i18n)
    return renderToString(app)
  }

  await test("named parameters reorder and missing test-locale messages fall back to zh-TW", async () => {
    i18n.global.setLocaleMessage("en-US", longLocale)
    i18n.global.locale.value = "en-US"
    assert.match(await render("notification.body", { id: "xyz", count: 2 }), /共有 2 項待處理，請查看 Instance xyz/)
    assert.match(await render("terms.primarySession"), /入口 Session/)
    assert.match(await render("ui.startInstance"), /為這個 Project 啟動一個全新的 Instance/)
    i18n.global.locale.value = "zh-TW"
    assert.match(await render("ui.startInstance"), /啟動 Instance/)
  })

  await test("baseline key loss ends at safe text instead of leaking a key", async () => {
    const missing = structuredClone(base)
    delete missing.terms.primarySession
    i18n.global.setLocaleMessage("zh-TW", missing)
    try {
      const html = await render("terms.primarySession")
      assert.match(html, /操作未完成/)
      assert.doesNotMatch(html, /terms\.primarySession/)
    } finally { i18n.global.setLocaleMessage("zh-TW", base) }
  })

  await test("known and unknown API errors have safe summaries and expandable data", () => {
    const t = (key) => key
    const known = presentError(new ApiError("INSTANCE_NOT_FOUND", "not found", 404), t)
    assert.equal(known.summary, "error.instanceNotFound")
    assert.equal(known.code, "INSTANCE_NOT_FOUND")
    const unknown = presentError(new ApiError("NEW_CODE", "Bearer very-private-token", 500), t)
    assert.equal(unknown.summary, "error.unknown")
    assert.equal(unknown.code, null)
    assert.equal(unknown.diagnostic, null)
    assert.equal(safeDiagnostic("https://host.example/?code=hidden"), null)
    for (const value of ["Permission denied", "Basic dXNlcjpwYXNz", "credential=private", "http://user:pass@host", "SESSION_NOT_FOUND Basic c2VjcmV0"]) {
      assert.equal(safeDiagnostic(value), null, value)
    }
    assert.equal(safeDiagnostic("INSTANCE_START_TIMEOUT"), "INSTANCE_START_TIMEOUT")
    const status = presentStatusError("INSTANCE_START_TIMEOUT", t, "session.summaryUnknown")
    assert.equal(status.summary, "error.startTimeout")
    assert.equal(status.code, "INSTANCE_START_TIMEOUT")
    assert.equal(presentStatusError("Basic dXNlcjpwYXNz", t, "error.unknown").summary, "error.unknown")
  })

  await test("only typed local popup failures have actionable summaries; ordinary Error messages remain private", () => {
    const t = (key) => key
    const blocked = presentError(new LocalError("popup.blocked"), t)
    assert.deepEqual(blocked, { summary: "popup.blocked", summaryKey: "popup.blocked", code: null, diagnostic: null })
    assert.equal(presentError(new Error("popup.blocked"), t).summaryKey, "error.unknown")
    assert.equal(presentError(Object.assign(new Error("private"), { key: "popup.blocked" }), t).summaryKey, "error.unknown")
    assert.equal(presentError(new ApiError("popup.blocked", "private", 500), t).summaryKey, "error.unknown")
  })

  await test("locale formats counts but never formats PID or port; timestamps retain the same instant", async () => {
    i18n.global.locale.value = "en-US"
    const enHtml = await render("terms.instance")
    assert.match(enHtml, /12,345/)
    assert.equal(new Date("2025-01-02T00:00:00Z").getTime(), 1735776000000)
    i18n.global.locale.value = "de-DE"
    assert.match(await render("terms.instance"), /12\.345/)
    i18n.global.locale.value = "zh-TW"
    const zhHtml = await render("terms.instance")
    assert.match(zhHtml, /12,345/)
    assert.match(zhHtml, /2025/)
    assert.notEqual(enHtml, zhHtml)
  })
} finally {
  await server.close()
}
