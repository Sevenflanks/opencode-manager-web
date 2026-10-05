import { createServer } from "node:http"

// 與 authenticated app 分開；只有程序初始化狀態，絕不查 Instance、provider 或 secrets。
export async function startHealthServer(port: number | undefined) {
  if (port === undefined) return undefined
  let initialized = false
  let draining = false
  const server = createServer((request, response) => {
    if (request.method !== "GET" || !["/health/live", "/health/ready"].includes(request.url ?? "")) {
      response.writeHead(404).end()
      return
    }
    const ready = request.url === "/health/live" || (initialized && !draining)
    response.writeHead(ready ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" })
    response.end(JSON.stringify({ status: ready ? "ok" : "unavailable" }))
  })
  server.requestTimeout = 1_000
  server.headersTimeout = 1_000
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "0.0.0.0", () => { server.removeListener("error", reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Health listener address unavailable")
  let closing: Promise<void> | undefined
  return {
    port: address.port,
    ready() { if (!draining) initialized = true },
    drain() { draining = true },
    close() {
      draining = true
      closing ??= new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
        // Probe 不承載 streams；包含半份 headers 的 client 也不能延長 shutdown。
        server.closeAllConnections()
      })
      return closing
    },
  }
}
