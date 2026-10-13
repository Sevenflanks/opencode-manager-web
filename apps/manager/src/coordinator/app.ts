import Fastify from "fastify"
import { existsSync } from "node:fs"
import type { ConnectivityInfo } from "@omw/contracts"
import type { RequestAuthenticator } from "../auth.js"
import { ManagerError } from "../errors.js"
import { registerWeb } from "../app.js"
import { CoordinatorRegistry } from "./registry.js"
import { CoordinatorProxy, managerProxyAllowed } from "./proxy.js"

export function buildCoordinatorApp(options: {
  registry: CoordinatorRegistry; publicOrigin: string; port: number; authenticator: RequestAuthenticator
  managerVersion?: string; webRoot?: string; mutationTimeoutMs?: number; proxyTimeoutMs?: number
}) {
  const { registry, publicOrigin } = options
  const proxy = new CoordinatorProxy()
  let draining = false
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024, trustProxy: false, ajv: { customOptions: { removeAdditional: false } } })
  const authorities = new Set([new URL(publicOrigin).host, `127.0.0.1:${options.port}`])
  const origins = new Set([publicOrigin, `http://127.0.0.1:${options.port}`])
  app.addHook("onRequest", async (request, reply) => {
    if (draining) throw new ManagerError("COORDINATOR_DRAINING", "Coordinator 正在關閉。", 503)
    const host = request.headers.host
    if (typeof host !== "string") throw new ManagerError("UNTRUSTED_AUTHORITY", "Request authority 不符合設定。", 403)
    const native = !authorities.has(host)
    // Unknown native host 不可落入 manager SPA；任何 malformed／foreign Host 都必須精確查 registry。
    const target = native ? registry.nativeTarget(host) : undefined
    const route = request.routeOptions.url
    if (!native && route === "/api/v1/coordinator/register") {
      if (request.headers.origin !== undefined || request.headers["sec-fetch-site"] !== undefined) throw new ManagerError("BROWSER_NOT_ALLOWED", "註冊 API 不接受 browser Origin。", 403)
      return
    }
    if (request.headers["sec-fetch-site"] === "cross-site" || (request.headers.origin !== undefined
      && (native ? request.headers.origin !== target!.nativeOrigin : !origins.has(request.headers.origin)))) {
      throw new ManagerError("UNTRUSTED_ORIGIN", "Request Origin 不符合設定。", 403)
    }
    if (!options.authenticator.authorize(request.headers, "browser")) {
      return reply.header("www-authenticate", 'Basic realm="OMW", charset="UTF-8"').code(401).send({ error: { code: "AUTH_REQUIRED", message: "需要有效的 OMW Basic auth。" } })
    }
    const mutation = !["GET", "HEAD", "OPTIONS"].includes(request.method)
    if (mutation && (native ? request.headers.origin !== target!.nativeOrigin
      : typeof request.headers.origin !== "string" || !origins.has(request.headers.origin) || request.headers["x-omw-csrf"] !== "1")) {
      throw new ManagerError("MUTATION_ORIGIN_REJECTED", "操作需要受信任的 Origin 與 CSRF header。", 403)
    }
    if (native) {
      reply.hijack()
      proxy.http(request.raw, reply.raw, { target: target!, publicOrigin, pathname: request.raw.url ?? "/", native: true,
        timeoutMs: options.proxyTimeoutMs ?? 10_000, retired: registry.retirementSignal(target!.id, target!.generation) })
      return reply
    }
    if (route === "/*" && request.url.startsWith("/api/")) throw new ManagerError("ROUTE_NOT_FOUND", "找不到此 API。", 404)
    if (route === "/api/v1/coordinator/workers/:workerId/:generation/proxy/*") {
      const { workerId, generation } = request.params as { workerId: string; generation: string }
      const prefix = `/api/v1/coordinator/workers/${workerId}/${generation}/proxy`
      const raw = request.raw.url ?? ""
      if (!raw.startsWith(`${prefix}/`)) throw new ManagerError("WORKER_PROXY_FORBIDDEN", "Worker proxy 路徑不符合設定。", 403)
      const pathname = raw.slice(prefix.length)
      if (!managerProxyAllowed(request.method, pathname.split("?")[0]!)) throw new ManagerError("WORKER_PROXY_FORBIDDEN", "此 route 不允許 Worker proxy。", 403)
      const scoped = registry.lookup(workerId, generation)
      const start = request.method === "POST" && (/^\/api\/v1\/instances(?:\?|$)/.test(pathname) || /^\/api\/v1\/instances\/[^/]+\/resume(?:\?|$)/.test(pathname))
      reply.hijack()
      proxy.http(request.raw, reply.raw, { target: scoped, publicOrigin, pathname, native: false,
        timeoutMs: options.mutationTimeoutMs ?? (start ? 45_000 : 10_000), retired: registry.retirementSignal(workerId, generation) })
      return reply
    }
  })
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ManagerError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } })
    if ((error as { statusCode?: number }).statusCode === 413) return reply.code(413).send({ error: { code: "REQUEST_TOO_LARGE", message: "註冊資料超出大小限制。" } })
    return reply.code(400).send({ error: { code: "REQUEST_INVALID", message: "請求格式不正確。" } })
  })
  app.get("/api/v1/connectivity", async (): Promise<ConnectivityInfo> => ({
    checkedAt: new Date().toISOString(), mode: "coordinator", remoteAccess: "disabled",
    capabilities: { launcher: false, tailscale: false, credentialUpdate: false, managerShutdown: false, maxInstances: 0, nativeWeb: true },
    manager: { localUrl: `http://127.0.0.1:${options.port}`, publicUrl: publicOrigin, ...(options.managerVersion ? { version: options.managerVersion } : {}) },
    tailscale: { state: "unavailable", dnsName: null, version: null },
    serve: { state: "not-configured", managerMapped: null, mappedInstancePorts: null, expectedInstancePorts: 0, funnel: "unknown" },
    registration: { state: "not-configured", trigger: null, diagnostic: null }, nodeVersion: process.version,
  }))
  app.get("/api/v1/coordinator/overview", async (_request, reply) => { reply.header("cache-control", "no-store"); return registry.overview() })
  app.post<{ Body: unknown }>("/api/v1/coordinator/register", async (request) => {
    const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? "")
    await registry.register(request.body, bearer?.[1] ?? "")
    // Machine acknowledgement 不洩漏其他 Workers，也不回傳 credentials。
    return { registered: true }
  })
  app.post<{ Params: { workerId: string; generation: string } }>("/api/v1/coordinator/workers/:workerId/:generation/check", async (request) => {
    await registry.check(request.params.workerId, request.params.generation)
    return registry.overview()
  })
  app.all("/api/v1/coordinator/workers/:workerId/:generation/proxy/*", async () => undefined)
  // native host 的所有 HTTP methods 都會由 onRequest 接手，manager host 的未知 API 不進 SPA。
  app.setNotFoundHandler(async (request, reply) => reply.code(404).send({ error: { code: "ROUTE_NOT_FOUND", message: "找不到此 API。" } }))
  if (options.webRoot && existsSync(options.webRoot)) registerWeb(app, options.webRoot)
  app.server.on("upgrade", (request, socket, head) => {
    try {
      if (draining) throw new ManagerError("COORDINATOR_DRAINING", "", 503)
      const target = registry.nativeTarget(request.headers.host ?? "")
      if (request.headers.origin !== target.nativeOrigin || request.headers["sec-fetch-site"] === "cross-site"
        || !options.authenticator.authorize(request.headers, "browser")) throw new ManagerError("AUTH_REQUIRED", "", 403)
      proxy.upgrade(request, socket, head, { target, publicOrigin, retired: registry.retirementSignal(target.id, target.generation) })
    } catch (error) {
      const status = error instanceof ManagerError ? error.statusCode : 404
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    }
  })
  app.addHook("preClose", async () => { draining = true; proxy.close(); await registry.close() })
  return app
}
