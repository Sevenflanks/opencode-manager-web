import { readFile, writeFile } from "node:fs/promises"

// 僅在 Docker build context 副本執行。Windows launcher workspace 是 build graph 一部分，
// Worker 不執行 desktop launcher；保留其版本與 dependency resolution，只移除 packaging os 限制。
for (const [filename, select] of [
  ["packages/launcher/package.json", (document) => document],
  ["package-lock.json", (document) => document.packages["packages/launcher"]],
]) {
  const document = JSON.parse(await readFile(filename, "utf8"))
  const metadata = select(document)
  if (!metadata || metadata.name && metadata.name !== "@sevenflanks/omw" || metadata.os?.join() !== "win32") throw new Error(`預期的 desktop launcher metadata 已改變：${filename}`)
  delete metadata.os
  await writeFile(filename, `${JSON.stringify(document, null, 2)}\n`)
}
