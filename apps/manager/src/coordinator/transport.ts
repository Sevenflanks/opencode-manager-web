import http, { type IncomingHttpHeaders } from "node:http"

export interface WorkerTarget {
  id: string
  generation: string
  address: string
  nativeOrigin: string
  browser: { username: string; password: string }
}

export function managerHeaders(target: WorkerTarget, publicOrigin: string): IncomingHttpHeaders {
  return { host: new URL(publicOrigin).host, origin: publicOrigin, "x-omw-csrf": "1",
    authorization: `Basic ${Buffer.from(`${target.browser.username}:${target.browser.password}`).toString("base64")}` }
}

/** 只接受 registry 驗證後的 literal IPv4，沒有 DNS、redirect 或 client 可指定的 ports。 */
export async function workerJson(target: WorkerTarget, publicOrigin: string, pathname: string, signal: AbortSignal): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const request = http.request({ hostname: target.address, port: 4174, path: pathname, method: "GET",
      headers: managerHeaders(target, publicOrigin), signal, agent: false }, (response) => {
      if (response.statusCode !== 200) { response.destroy(); request.destroy(); reject(new Error("WORKER_RESPONSE_INVALID")); return }
      const chunks: Buffer[] = []
      let size = 0
      response.on("data", (chunk: Buffer) => {
        size += chunk.length
        if (size > 1024 * 1024) { request.destroy(new Error("WORKER_BODY_LIMIT")); return }
        chunks.push(chunk)
      })
      response.once("error", reject)
      response.once("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))) } catch { reject(new Error("WORKER_RESPONSE_INVALID")) } })
    })
    request.once("error", reject)
    request.end()
  })
}
