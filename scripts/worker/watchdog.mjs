// 獨立有限 lifetime：host tool 中斷／parent 被終止時仍會清 current-run Docker resources。
import { readFile, rm, writeFile } from "node:fs/promises"
import { dockerOwner } from "./docker-owner.mjs"

const filename = process.argv[2]
const configuration = JSON.parse(await readFile(filename, "utf8"))
setTimeout(async () => {
  const result = await dockerOwner(configuration).cleanup()
  await writeFile(configuration.watchdogEvidence, JSON.stringify({ at: new Date().toISOString(), cleanup: result }, null, 2))
  if (result.status === "stopped") await rm(configuration.secretDirectory, { recursive: true, force: true })
}, configuration.watchdogMilliseconds)
