import { cp, mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

await import("./generate-third-party-notices.mjs")

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const repositoryRoot = path.resolve(packageRoot, "../..")
const destination = path.join(packageRoot, "dist")

await Promise.all([
  rm(path.join(destination, "test"), { recursive: true, force: true }),
  rm(path.join(destination, "manager"), { recursive: true, force: true }),
  rm(path.join(destination, "web"), { recursive: true, force: true }),
  rm(path.join(destination, "scripts"), { recursive: true, force: true }),
])
await mkdir(destination, { recursive: true })
await Promise.all([
  cp(path.join(repositoryRoot, "apps/manager/dist/src"), path.join(destination, "manager/src"), { recursive: true }),
  cp(path.join(repositoryRoot, "apps/web/dist"), path.join(destination, "web"), { recursive: true }),
  cp(path.join(repositoryRoot, "apps/manager/scripts"), path.join(destination, "scripts"), { recursive: true }),
])
