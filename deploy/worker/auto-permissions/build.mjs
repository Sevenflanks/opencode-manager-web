import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { cp, readFile, readdir, mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = fileURLToPath(new URL("./", import.meta.url))
const source = path.join(root, "node_modules/opencode-auto-permissions")
const output = path.join(root, "dist")
const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"))
const pkg = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"))
const integrity = "sha512-iaOI64a8DiC3b8rnYAxWH3QyvdIvJIltL2neMG6eBlUKwsKC5Vt7W6A3ft+7wDFX7+iGFth2ClduKWS0S+hSVA=="
assert.equal(pkg.name, "opencode-auto-permissions")
assert.equal(pkg.version, "0.2.15")
assert.equal(pkg.license, "MIT")
assert.deepEqual(pkg.dependencies ?? {}, {})
assert.equal(pkg.exports["./server"], "./dist/v1-server.js")
assert.deepEqual(Object.keys(lock.packages).sort(), ["", "node_modules/opencode-auto-permissions"])
assert.equal(lock.packages["node_modules/opencode-auto-permissions"].version, "0.2.15")
assert.equal(lock.packages["node_modules/opencode-auto-permissions"].integrity, integrity)
// npm ci 驗證 tarball integrity；這裡原封保留 package，沒有重寫上游 policy 或重新 bundle。
const files = {}
async function inventory(directory, relative = "") {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const name = path.posix.join(relative, item.name)
    if (item.isDirectory()) await inventory(path.join(directory, item.name), name)
    else {
      assert.ok(item.isFile(), `unexpected package entry: ${name}`)
      const bytes = await readFile(path.join(directory, item.name))
      assert.ok(bytes.length > 0, `empty package entry: ${name}`)
      files[name] = createHash("sha256").update(bytes).digest("hex")
    }
  }
}
await inventory(source)
assert.deepEqual(Object.keys(files).sort(), ["LICENSE", "README.md", "dist/server.js", "dist/tui.js", "dist/v1-server.js", "package.json"])
assert.equal(files["dist/v1-server.js"], "6263c4509ea0bb93e715e96e58174d14a615c95ee68cbd5a64c0ba98124adc76")
const plugin = await import(pathToFileURL(path.join(source, "dist/v1-server.js")))
assert.equal(typeof plugin.default.server, "function")
assert.equal(plugin.default.tui, undefined)
await rm(output, { recursive: true, force: true })
await cp(source, output, { recursive: true })
await mkdir(path.join(output, "source"))
for (const name of ["package.json", "package-lock.json", "build.mjs"]) await cp(path.join(root, name), path.join(output, "source", name))
const result = { name: pkg.name, version: pkg.version, license: pkg.license, integrity,
  source: "https://github.com/hueyexe/opencode-auto-permissions/tree/v0.2.15",
  sourceCommit: "bc238eff1bfa56c7d16e3571b7b2f7ead465db2a", runtimeDependencies: {},
  entry: "dist/v1-server.js", files, node: process.version, nativeImport: "default.server function; no TUI loaded" }
await writeFile(path.join(output, "artifact.json"), JSON.stringify(result, null, 2) + "\n")
console.log(JSON.stringify(result))
