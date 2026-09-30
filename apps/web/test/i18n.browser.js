async page => {
  // Run on a separately owned Vite dev server: playwright-cli run-code --filename=apps/web/test/i18n.browser.js
  await page.route("**/api/v1/**", route => route.fulfill({
    status: 500, contentType: "application/json",
    body: JSON.stringify({ error: { code: "INSTANCE_START_TIMEOUT", message: "Basic dXNlcjpwYXNz credential=secret" } }),
  }))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("http://127.0.0.1:5173/")
  await page.getByRole("button", { name: "啟動 Instance" }).first().waitFor()
  const translated = await page.evaluate(async () => {
    const { i18n } = await import("/src/i18n.ts")
    const testLocale = {
      ui: { startInstance: "為這個 Project 啟動一個全新的 Instance，並確認之後可以安心回到列表繼續檢視狀態" },
      aria: { filter: "請選擇需要顯示的 Instance 狀態，必要時向左右捲動這些篩選條件" },
      notification: { body: "共有 {count} 項待處理，請查看 Instance {id}" },
    }
    i18n.global.setLocaleMessage("en-US", testLocale)
    i18n.global.locale.value = "en-US"
    return i18n.global.t("notification.body", { id: "xyz", count: 2 })
  })
  if (translated !== "共有 2 項待處理，請查看 Instance xyz") throw new Error(`parameter order: ${translated}`)
  await page.getByRole("button", { name: /為這個 Project 啟動一個全新的 Instance/ }).first().waitFor()
  const rail = page.getByRole("group", { name: /請選擇需要顯示的 Instance 狀態/ })
  await rail.waitFor()
  const width = await page.evaluate(() => document.documentElement.scrollWidth)
  if (width > 390) throw new Error(`horizontal overflow at 390px: ${width}`)
  const buttonTextFits = await page.getByRole("button", { name: /為這個 Project 啟動一個全新的 Instance/ }).first().evaluate(button => {
    const bounds = button.getBoundingClientRect()
    const range = document.createRange()
    for (const text of [...button.childNodes].filter(node => node.nodeType === Node.TEXT_NODE)) range.selectNodeContents(text)
    return bounds.height >= 44 && [...range.getClientRects()].every(line => line.top >= bounds.top && line.bottom <= bounds.bottom)
  })
  if (!buttonTextFits) throw new Error("390px start button clips long locale text")
  if (!(await page.getByText("入口 Session").count()) && !(await page.getByText("目錄捷徑").count())) {
    await page.getByRole("button", { name: /為這個 Project 啟動/ }).first().click()
    await page.getByRole("heading", { name: "目錄捷徑" }).waitFor()
    await page.getByRole("button", { name: "關閉啟動面板" }).click()
    await page.getByRole("dialog", { name: "啟動 Instance" }).waitFor({ state: "hidden" })
  }
  const diagnostic = page.getByText("診斷詳細資訊").first()
  await diagnostic.waitFor()
   if (await page.getByText("Basic dXNlcjpwYXNz credential=secret").count()) throw new Error("diagnostic leaked before expansion")
  await diagnostic.click()
   await page.getByText("錯誤代碼：INSTANCE_START_TIMEOUT").first().waitFor()
   if (await page.getByText("Basic dXNlcjpwYXNz credential=secret").count()) throw new Error("diagnostic leaked after expansion")
  await page.evaluate(async () => { const { i18n } = await import("/src/i18n.ts"); i18n.global.locale.value = "zh-TW" })
  await page.getByRole("button", { name: "啟動 Instance" }).first().waitFor()
  return "390px, reactive locale, reordered parameters, zh-TW fallback, a11y, safe error details: passed"
}
