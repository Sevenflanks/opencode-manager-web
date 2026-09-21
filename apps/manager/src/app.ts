import { createReadStream, existsSync } from "node:fs"
import path from "node:path"
import process from "node:process"
import Fastify, { type FastifyInstance } from "fastify"
import type { ConnectivityInfo, LauncherRegistrationRequest, LauncherReservationRequest, OverviewFilter } from "@omw/contracts"
import type { RequestAuthenticator } from "./auth.js"
import { CredentialUpdateError, type CredentialController } from "./credential-controller.js"
import { ManagerError } from "./errors.js"
import type { ManagerService } from "./service.js"
import type { RemoteAccessController } from "./remote-access.js"

const objectBody = {
  type: "object",
  additionalProperties: false,
  required: ["name", "directory"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 80 },
    directory: { type: "string", minLength: 1, maxLength: 32_767 },
  },
} as const

export function buildApp(options: {
  service: ManagerService
  authority: { hostname: string; port: number }
  allowedOrigins: Set<string>
  publicOrigin?: string
  authenticator?: RequestAuthenticator
  remoteAccess?: RemoteAccessController
  remoteAuthenticator?: RequestAuthenticator
  launcherAuthenticator?: RequestAuthenticator
  credentialController?: CredentialController
  shutdownManager?: () => void
  connectivity?: { get(): Promise<ConnectivityInfo>; register(trigger: "manual"): Promise<ConnectivityInfo> }
  webRoot?: string
}): FastifyInstance {
  const app = Fastify({
    logger: false,
    bodyLimit: 64 * 1024,
    trustProxy: false,
    ajv: { customOptions: { removeAdditional: false } },
  })
  const expectedAuthority = trustedAuthority(options.authority)
  trustedOriginSet(expectedAuthority, options.allowedOrigins, options.remoteAccess?.config?.publicManagerOrigin ?? options.publicOrigin)

  // onClose 會等待 HTTP 請求完成；必須先阻止仍在等待 discovery/save 的 enable 繼續寫 Serve。
  app.addHook("preClose", async () => { await options.remoteAccess?.close() })

  app.addHook("onRequest", async (request, reply) => {
    const publicOrigin = options.remoteAccess?.config?.publicManagerOrigin ?? options.publicOrigin
    const trustedAuthorities = new Set([expectedAuthority])
    if (publicOrigin) trustedAuthorities.add(new URL(publicOrigin).host)
    const trustedOrigins = trustedOriginSet(expectedAuthority, options.allowedOrigins, publicOrigin)
    // 使用 router 已解析的路徑，避免 %65nable 這類編碼繞過啟用或 launcher 的專用授權。
    const route = request.routeOptions.url ?? request.url.split("?")[0]!
    const enableRoute = route === "/api/v1/connectivity/enable"
    const launcherRoute = route.startsWith("/api/v1/launcher/")
    if (typeof request.headers.host !== "string" || !trustedAuthorities.has(request.headers.host)) {
      throw new ManagerError("UNTRUSTED_AUTHORITY", "Request authority 不在設定的 Manager endpoints。", 403)
    }
    const origin = request.headers.origin
    if (origin !== undefined && (typeof origin !== "string" || !trustedOrigins.has(origin))) {
      throw new ManagerError("UNTRUSTED_ORIGIN", "Request Origin 不在受信任的 loopback origins。", 403)
    }
    if (launcherRoute) {
      if (request.headers.host !== expectedAuthority || origin !== undefined) {
        throw new ManagerError("LAUNCHER_LOCAL_ONLY", "Launcher API 只接受無 browser Origin 的 configured loopback authority。", 403)
      }
      if (!options.launcherAuthenticator?.authorize(request.headers, "launcher")) {
        return reply.code(401).send({ error: { code: "LAUNCHER_AUTH_REQUIRED", message: "需要有效的 launcher token。" } })
      }
      return
    }
    if (enableRoute && request.headers.host !== expectedAuthority) {
      throw new ManagerError("REMOTE_ENABLE_LOCAL_ONLY", "啟用遠端存取只接受 configured loopback authority。", 403)
    }
    // 首次啟用也必須驗證 browser Basic；launcher token 永遠不能授權這個安全切換。
    const authenticator = enableRoute || options.remoteAccess?.config
      ? options.remoteAuthenticator ?? options.authenticator
      : options.authenticator
    if ((enableRoute && !authenticator) || (authenticator && !authenticator.authorize(request.headers, "browser"))) {
      const challenge = authenticator?.challenge("browser")
      if (challenge) reply.header("www-authenticate", challenge)
      return reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: "需要有效的 OMW Basic auth。" } })
    }
    if (!["POST", "PATCH", "DELETE"].includes(request.method)) return
    if (typeof origin !== "string" || !trustedOrigins.has(origin) || request.headers["x-omw-csrf"] !== "1") {
      throw new ManagerError("MUTATION_ORIGIN_REJECTED", "Mutation 需要受信任的 Origin 與 CSRF header。", 403)
    }
  })

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof CredentialUpdateError) {
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } })
    }
    if (error instanceof ManagerError) {
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details } })
    }
    if (typeof error === "object" && error !== null && "validation" in error && error.validation) {
      return reply.code(400).send({ error: { code: "REQUEST_INVALID", message: "Request 格式不正確。", details: error.validation } })
    }
    return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "Manager 發生未預期錯誤。" } })
  })

  app.get<{ Querystring: { q?: string; filter?: OverviewFilter; includeHidden?: string } }>("/api/v1/overview", async (request) => {
    const filter = request.query.filter ?? "all"
    if (!["all", "active", "attention", "unreachable"].includes(filter)) {
      throw new ManagerError("FILTER_INVALID", "filter 必須是 all、active、attention 或 unreachable。", 400)
    }
    if (request.query.includeHidden !== undefined && !["true", "false"].includes(request.query.includeHidden)) {
      throw new ManagerError("INCLUDE_HIDDEN_INVALID", "includeHidden 必須是 true 或 false。", 400)
    }
    return await options.service.overview(request.query.q, filter, request.query.includeHidden === "true")
  })

  app.get("/api/v1/connectivity", async () => {
    return options.connectivity
      ? await options.connectivity.get()
      : fallbackConnectivity(options.authority.port, options.publicOrigin)
  })

  app.post("/api/v1/connectivity/register", async () => {
    if (!options.connectivity) throw new ManagerError("REMOTE_REGISTRATION_UNAVAILABLE", "目前無法自動註冊 Tailscale。", 503)
    return await options.connectivity.register("manual")
  })

  app.post("/api/v1/connectivity/enable", {
    schema: { body: {
      type: "object", additionalProperties: false, required: ["confirmed"],
      properties: { confirmed: { const: true } },
    } },
  }, async () => {
    if (!options.remoteAccess) throw new ManagerError("REMOTE_ENABLE_UNAVAILABLE", "目前無法啟用遠端存取。", 503)
    return options.remoteAccess.enable()
  })

  app.patch<{ Body: { currentPassword: string; username: string; password: string } }>("/api/v1/settings/credentials", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["currentPassword", "username", "password"],
        properties: {
          currentPassword: { type: "string", minLength: 1, maxLength: 1024 },
          username: { type: "string", minLength: 1, maxLength: 256 },
          password: { type: "string", minLength: 16, maxLength: 4096 },
        },
      },
    },
  }, async (request, reply) => {
    if (!options.credentialController) {
      throw new ManagerError("CREDENTIAL_UPDATE_UNAVAILABLE", "目前無法更新 OMW 帳密。", 503)
    }
    await options.credentialController.update(request.body)
    return reply.code(204).send()
  })

  app.post("/api/v1/manager/shutdown", async (_request, reply) => {
    if (!options.shutdownManager) throw new ManagerError("SHUTDOWN_UNAVAILABLE", "目前無法從 Web 停止 OMW。", 503)
    setImmediate(options.shutdownManager)
    return reply.code(202).send({ stopping: true })
  })

  app.get<{ Querystring: { path?: string } }>("/api/v1/directories", async (request) => {
    if (!request.query.path) throw new ManagerError("DIRECTORY_REQUIRED", "path query parameter 必填。", 400)
    return await options.service.browse(request.query.path)
  })

  app.post<{ Body: { name: string; directory: string } }>("/api/v1/shortcuts", { schema: { body: objectBody } }, async (request, reply) => {
    return reply.code(201).send(await options.service.createShortcut(request.body))
  })

  app.patch<{ Params: { id: string }; Body: { name: string; directory: string } }>("/api/v1/shortcuts/:id", { schema: { body: objectBody } }, async (request) => {
    return await options.service.updateShortcut(request.params.id, request.body)
  })

  app.delete<{ Params: { id: string } }>("/api/v1/shortcuts/:id", async (request, reply) => {
    options.service.deleteShortcut(request.params.id)
    return reply.code(204).send()
  })

  app.post<{ Body: { directory: string } }>("/api/v1/instances", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["directory"],
        properties: { directory: { type: "string", minLength: 1, maxLength: 32_767 } },
      },
    },
  }, async (request, reply) => reply.code(201).send(await options.service.start(request.body.directory)))

  app.post<{ Params: { id: string } }>("/api/v1/instances/:id/stop", async (request) => {
    return await options.service.stop(request.params.id)
  })

  app.post<{ Params: { id: string } }>("/api/v1/instances/:id/recheck", async (request) => {
    return await options.service.recheck(request.params.id)
  })

  app.post<{ Params: { id: string } }>("/api/v1/instances/:id/resume", async (request) => {
    return await options.service.resume(request.params.id)
  })

  app.post<{ Params: { id: string }; Body: { hidden: boolean } }>("/api/v1/instances/:id/tracking", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["hidden"],
        properties: { hidden: { type: "boolean" } },
      },
    },
  }, async (request) => await options.service.setTrackingHidden(request.params.id, request.body.hidden))

  app.delete<{ Params: { id: string } }>("/api/v1/instances/:id", async (request, reply) => {
    await options.service.deleteInstance(request.params.id)
    return reply.code(204).send()
  })

  app.get<{ Params: { id: string } }>("/api/v1/instances/:id/sessions", async (request) => {
    return await options.service.sessionRoots(request.params.id)
  })

  app.post<{ Params: { id: string } }>("/api/v1/instances/:id/sessions", async (request, reply) => {
    return reply.code(201).send(await options.service.createSession(request.params.id))
  })

  app.get<{ Params: { id: string; sessionId: string } }>("/api/v1/instances/:id/sessions/:sessionId/children", async (request) => {
    return await options.service.sessionChildren(request.params.id, request.params.sessionId)
  })

  app.post<{ Params: { id: string }; Body: { sessionId?: string } }>("/api/v1/instances/:id/open-url", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: { sessionId: { type: "string", minLength: 1, maxLength: 512 } },
      },
    },
  }, async (request) => await options.service.openUrl(request.params.id, request.body.sessionId))

  app.post<{ Params: { id: string }; Body: { sessionId: string } }>("/api/v1/instances/:id/primary-session", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["sessionId"],
        properties: { sessionId: { type: "string", minLength: 1, maxLength: 512 } },
      },
    },
  }, async (request) => await options.service.selectPrimarySession(request.params.id, request.body.sessionId))

  if (options.launcherAuthenticator) {
    app.get("/api/v1/launcher/identity", async () => ({ product: "omw-manager", protocolVersion: 1 }))
    app.post<{ Body: LauncherReservationRequest }>("/api/v1/launcher/reservations", {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["clientInvocationId", "directory"],
          properties: {
            clientInvocationId: { type: "string", format: "uuid" },
            directory: { type: "string", minLength: 1, maxLength: 32_767 },
            requestedPort: { type: "integer", minimum: 1, maximum: 65_535 },
          },
        },
      },
    }, async (request, reply) => reply.code(201).send(await options.service.reserveLocal(request.body)))

    const registrationBody = {
      type: "object",
      additionalProperties: false,
      required: ["clientInvocationId", "pid"],
      properties: {
        clientInvocationId: { type: "string", format: "uuid" },
        pid: { type: "integer", minimum: 1 },
      },
    } as const
    app.post<{ Params: { id: string }; Body: LauncherRegistrationRequest }>("/api/v1/launcher/reservations/:id/register", {
      schema: { body: registrationBody },
    }, async (request, reply) => reply.code(202).send(await options.service.registerLocal(request.params.id, request.body)))
    app.post<{ Params: { id: string }; Body: LauncherRegistrationRequest }>("/api/v1/launcher/reservations/:id/finalize", {
      schema: { body: registrationBody },
    }, async (request) => await options.service.finalizeLocal(request.params.id, request.body))
  }

  if (options.webRoot && existsSync(options.webRoot)) registerWeb(app, options.webRoot)

  app.addHook("onClose", async () => {
    await options.service.shutdown()
  })

  return app
}

function fallbackConnectivity(managerPort: number, publicOrigin?: string): ConnectivityInfo {
  return {
    checkedAt: new Date().toISOString(),
    mode: publicOrigin ? "tailnet" : "loopback",
    manager: { localUrl: `http://127.0.0.1:${managerPort}`, publicUrl: publicOrigin ?? null },
    tailscale: { state: "unknown", dnsName: null, version: null },
    serve: {
      state: publicOrigin ? "unknown" : "not-configured",
      managerMapped: null,
      mappedInstancePorts: null,
      expectedInstancePorts: 0,
      funnel: "unknown",
    },
    registration: {
      state: publicOrigin ? "idle" : "not-configured",
      trigger: null,
      diagnostic: null,
    },
    nodeVersion: process.version,
  }
}

function trustedAuthority(authority: { hostname: string; port: number }): string {
  if (authority.hostname !== "127.0.0.1" || !Number.isInteger(authority.port) || authority.port < 1 || authority.port > 65_535) {
    throw new Error("Manager authority 必須是明確的 127.0.0.1:<port>。")
  }
  return `${authority.hostname}:${authority.port}`
}

function trustedOriginSet(expectedAuthority: string, configured: Set<string>, publicOrigin?: string): Set<string> {
  const trusted = new Set([`http://${expectedAuthority}`])
  if (publicOrigin) trusted.add(publicOrigin)
  for (const value of configured) {
    const url = new URL(value)
    const loopback = url.protocol === "http:" && url.hostname === "127.0.0.1"
    const approvedRemote = publicOrigin !== undefined && value === publicOrigin && url.protocol === "https:"
    if (url.origin !== value || (!loopback && !approvedRemote)) {
      throw new Error("allowedOrigins 只接受完整 loopback origin 或設定的 public HTTPS origin。")
    }
    trusted.add(value)
  }
  return trusted
}

function registerWeb(app: FastifyInstance, webRoot: string): void {
  const canonicalRoot = path.resolve(webRoot)
  app.get("/*", async (request, reply) => {
    const requested = request.url.split("?", 1)[0] ?? "/"
    const relative = requested === "/" ? "index.html" : decodeURIComponent(requested.slice(1))
    const candidate = path.resolve(canonicalRoot, relative)
    const file = candidate.startsWith(`${canonicalRoot}${path.sep}`) && existsSync(candidate)
      ? candidate
      : path.join(canonicalRoot, "index.html")
    const extension = path.extname(file).toLowerCase()
    const contentType = extension === ".js" ? "text/javascript; charset=utf-8"
      : extension === ".css" ? "text/css; charset=utf-8"
        : extension === ".svg" ? "image/svg+xml"
          : "text/html; charset=utf-8"
    return reply.type(contentType).send(createReadStream(file))
  })
}
