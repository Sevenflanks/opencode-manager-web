import { readFile } from "node:fs/promises"

try {
  const password = (await readFile(process.env.OMW_BROWSER_PASSWORD_FILE, "utf8")).trimEnd()
  const response = await fetch("http://127.0.0.1:4174/api/v1/connectivity", {
    headers: { authorization: `Basic ${Buffer.from(`${process.env.OMW_BROWSER_USERNAME}:${password}`).toString("base64")}` },
    signal: AbortSignal.timeout(2500), redirect: "error",
  })
  if (!response.ok || (await response.json()).mode !== "worker") process.exitCode = 1
} catch { process.exitCode = 1 }
