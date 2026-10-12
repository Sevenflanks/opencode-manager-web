import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { isBuiltin } from "node:module"
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const root = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(root, "dist")
const json = async file => JSON.parse(await readFile(path.join(root, file), "utf8"))
const lock = await json("package-lock.json")
const pins = {
  "@prevalentware/opencode-goal-plugin": {
    version: "0.1.60", commit: "cf22feaaa7ab3367053a9a99913cbc40e5c3224e",
    integrity: "sha512-mDEwq3DdZtUPtty26FFf7SptSnTATeJYZGXOYEMVt/utjB7YwTzxiZwur6D65hxYEzhC6Qw7uSMi2wrP3OK0og==",
    repository: "https://github.com/prevalentWare/opencode-goal-plugin", entry: "dist/server.js",
  },
  "opencode-command-inject": {
    version: "1.3.1", commit: "14787ebc26c950c3410330837be2314971218ea4",
    integrity: "sha512-s8E89q2kDoi7lDFbPZJwUzMTeq8sVphnuiLDAtW39w+O+xkqslyWvZ6TRVmLoyj5wwQWL9fEy0YyCFcTHG1hvQ==",
    repository: "https://github.com/shihyuho/opencode-command-inject", entry: "index.ts",
  },
}
for (const [name, pin] of Object.entries(pins)) {
  assert.equal(lock.packages[""].dependencies[name], pin.version)
  assert.equal(lock.packages[`node_modules/${name}`].version, pin.version)
  assert.equal(lock.packages[`node_modules/${name}`].integrity, pin.integrity)
  const pkg = await json(`node_modules/${name}/package.json`)
  assert.equal(pkg.version, pin.version)
  assert.equal(pkg.license, "MIT")
}
assert.equal(lock.packages["node_modules/@opencode-ai/plugin"].version, "1.18.34")
assert.equal(lock.packages["node_modules/@opencode-ai/sdk"].version, "1.18.34")
assert.equal((await json("node_modules/@prevalentware/opencode-goal-plugin/package.json")).exports["./server"].import, "./dist/server.js")
assert.equal((await json("node_modules/opencode-command-inject/package.json")).module, "index.ts")

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })
const sourcePackages = new Set(Object.keys(pins).map(name => `node_modules/${name}`))
const graphs = {}
for (const entry of ["goal", "command-inject"]) {
  const result = await build({
    absWorkingDir: root, entryPoints: [`${entry}.mjs`], outfile: `dist/${entry}.mjs`,
    bundle: true, platform: "node", target: "node24", format: "esm", metafile: true,
    legalComments: "linked",
  })
  const output = result.metafile.outputs[`dist/${entry}.mjs`]
  assert.deepEqual(output.exports, ["default"], `${entry}: default factory only`)
  // esbuild 真正解析 import graph；外部只接受 runtime builtins，不能遺漏 npm deps。
  for (const item of output.imports) assert.ok(item.external && isBuiltin(item.path), `unbundled dependency: ${item.path}`)
  for (const input of Object.keys(result.metafile.inputs)) {
    const normalized = input.replaceAll("\\", "/")
    if (!normalized.includes("node_modules/")) continue
    const packageRoot = normalized.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)/)?.[1]
    assert.ok(packageRoot, `package source missing: ${input}`)
    assert.ok(!/\/(?:@opentui|solid-js|@opencode\/)/.test(packageRoot), `unexpected TUI/V2 dependency: ${input}`)
    sourcePackages.add(packageRoot)
  }
  graphs[entry] = result.metafile
  await writeFile(path.join(out, `${entry}.metafile.json`), JSON.stringify(result.metafile, null, 2) + "\n")
}

const packages = []
for (const packageRoot of [...sourcePackages].sort()) {
  const pkg = await json(`${packageRoot}/package.json`)
  const pinned = lock.packages[packageRoot]
  assert.ok(pinned?.integrity, `lock integrity missing: ${packageRoot}`)
  assert.equal(pkg.version, pinned.version)
  // 完整 npm package 另存 source；nested dependencies 各自按實際 graph 複製。
  const destination = `sources/${packageRoot}`
  await cp(path.join(root, packageRoot), path.join(out, destination), {
    recursive: true, filter: source => path.basename(source) !== "node_modules",
  })
  packages.push({ location: packageRoot, name: pkg.name, version: pkg.version, license: pkg.license,
    integrity: pinned.integrity, source: destination })
}
await mkdir(path.join(out, "source"))
for (const file of ["package.json", "package-lock.json", ".npmrc", "build.mjs", "goal.mjs", "command-inject.mjs"])
  await cp(path.join(root, file), path.join(out, "source", file))
await cp(path.join(root, "THIRD_PARTY_NOTICES.md"), path.join(out, "THIRD_PARTY_NOTICES.md"))

const files = {}
async function inventory(directory, prefix = "") {
  for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix + item.name
    if (item.isDirectory()) await inventory(path.join(directory, item.name), `${relative}/`)
    else {
      assert.ok(item.isFile(), `nonregular artifact: ${relative}`)
      files[relative] = createHash("sha256").update(await readFile(path.join(directory, item.name))).digest("hex")
    }
  }
}
await inventory(out)
const artifact = { plugins: pins, entries: ["goal.mjs", "command-inject.mjs"], packages,
  runtimeExternals: Object.fromEntries(Object.entries(graphs).map(([name, graph]) =>
    [name, graph.outputs[`dist/${name}.mjs`].imports.map(item => item.path)])),
  omittedPeers: { "@opentui/solid": ">=0.5.8", "solid-js": ">=1.9.0", reason: "Goal TUI only; server import graph bundled without peers" }, files }
await writeFile(path.join(out, "artifact.json"), JSON.stringify(artifact, null, 2) + "\n")
console.log(JSON.stringify({ entries: artifact.entries, packages: packages.map(({ name, version }) => ({ name, version })), files: Object.keys(files).length }))
