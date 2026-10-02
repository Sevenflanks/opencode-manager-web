import { createHash } from "node:crypto"
import { promisify } from "node:util"
import { gzip } from "node:zlib"
import type { FastifyInstance } from "fastify"

const compress = promisify(gzip)

function encodingQualities(header: string | undefined): Map<string, number> {
  return new Map((header ?? "").split(",").map((entry) => {
    const [name, ...parameters] = entry.trim().toLowerCase().split(";")
    const q = parameters.find((value) => value.trim().startsWith("q="))?.trim().slice(2)
    const quality = q === undefined ? 1 : Number(q)
    return [name!, Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0]
  }))
}

export function acceptsGzip(header: string | undefined): boolean {
  const qualities = encodingQualities(header)
  return (qualities.get("gzip") ?? qualities.get("*") ?? 0) > 0
}

export function installHttpRepresentations(app: FastifyInstance): void {
  app.addHook("onSend", async (request, reply, payload) => {
    const route = request.routeOptions.url
    if (request.method !== "GET" || !["/api/v1/overview", "/api/v1/instances/history", "/api/v1/instances/:id"].includes(route ?? "")
      || typeof payload !== "string" || !String(reply.getHeader("content-type")).includes("application/json")) return payload
    reply.header("vary", "Accept-Encoding")
    reply.header("cache-control", "private, no-cache")
    const qualities = encodingQualities(request.headers["accept-encoding"])
    const identityQuality = qualities.get("identity")
    const acceptsIdentity = (identityQuality ?? (qualities.get("*") === 0 ? 0 : 1)) > 0
    const gzipQuality = qualities.get("gzip") ?? qualities.get("*") ?? 0
    // RFC 9110 §12.5.3：未列出的 identity 預設可接受，並非明示 q=1；不能因此壓過已接受的 gzip。
    const gzipPreferred = gzipQuality > 0 && (identityQuality === undefined || gzipQuality >= identityQuality)
    const gzipVariant = gzipPreferred && (Buffer.byteLength(payload) >= 1024 || !acceptsIdentity
      || (identityQuality !== undefined && gzipQuality > identityQuality))
    if (!gzipVariant && !acceptsIdentity) {
      reply.code(406)
      reply.removeHeader("content-length")
      return null
    }
    if (gzipVariant) reply.header("content-encoding", "gzip")
    if (reply.statusCode === 200) {
      // Validator 只省傳輸，仍先完成 fresh probes；URL 與 encoding 隔離，不另持有跨請求 snapshot。
      const etag = `"${createHash("sha256").update(`${request.url}\n${gzipVariant}\n${payload}`).digest("hex")}"`
      reply.header("etag", etag)
      const candidates = request.headers["if-none-match"]?.split(",").map((value) => value.trim().replace(/^W\//, "")) ?? []
      if (candidates.includes(etag) || candidates.includes("*")) {
        reply.code(304)
        reply.removeHeader("content-length")
        return null
      }
    }
    if (!gzipVariant) return payload
    const compressed = await compress(payload)
    reply.header("content-encoding", "gzip")
    reply.header("content-length", compressed.length)
    return compressed
  })
}
