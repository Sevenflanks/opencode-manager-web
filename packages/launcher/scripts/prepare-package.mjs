import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

await import("./generate-third-party-notices.mjs")

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const repositoryRoot = path.resolve(packageRoot, "../..")
const destination = path.join(packageRoot, "dist")
const contractsDestination = path.join(destination, "contracts")

await Promise.all([
  rm(path.join(destination, "test"), { recursive: true, force: true }),
  rm(path.join(destination, "manager"), { recursive: true, force: true }),
  rm(path.join(destination, "web"), { recursive: true, force: true }),
  rm(path.join(destination, "scripts"), { recursive: true, force: true }),
  rm(contractsDestination, { recursive: true, force: true }),
])
await mkdir(destination, { recursive: true })
await Promise.all([
  cp(path.join(repositoryRoot, "apps/manager/dist/src"), path.join(destination, "manager/src"), { recursive: true }),
  cp(path.join(repositoryRoot, "apps/web/dist"), path.join(destination, "web"), { recursive: true }),
  cp(path.join(repositoryRoot, "apps/manager/scripts"), path.join(destination, "scripts"), { recursive: true }),
  cp(path.join(repositoryRoot, "packages/contracts/dist"), contractsDestination, { recursive: true }),
])

let rewrittenImports = 0
// contracts 維持 private/dev-only；發佈產物改連到 tarball 內的 runtime copy，不可依賴 workspace resolution。
await rewriteContractImports(path.join(destination, "manager"))
if (rewrittenImports === 0) throw new Error("Packaged Manager has no @omw/contracts runtime import to rewrite.")

async function rewriteContractImports(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      await rewriteContractImports(filename)
      continue
    }
    if (!entry.isFile() || path.extname(entry.name) !== ".js") continue
    const source = await readFile(filename, "utf8")
    const specifier = relativeImport(path.dirname(filename), path.join(contractsDestination, "index.js"))
    const rewritten = source.replace(/(["'])@omw\/contracts\1/g, (_match, quote) => {
      rewrittenImports++
      return `${quote}${specifier}${quote}`
    })
    if (rewritten !== source) await writeFile(filename, rewritten)
  }
}

function relativeImport(from, to) {
  const relative = path.relative(from, to).split(path.sep).join("/")
  return relative.startsWith(".") ? relative : `./${relative}`
}
