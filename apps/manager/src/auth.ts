import { timingSafeEqual } from "node:crypto"
import type { IncomingHttpHeaders } from "node:http"

export interface BasicCredential {
  username: string
  password: string
}

export interface StoredCredentials {
  manager: BasicCredential
  openCode: BasicCredential
  launcherToken: string
}

export type AuthAudience = "browser" | "launcher"

export interface RequestAuthenticator {
  authorize(headers: IncomingHttpHeaders, audience: AuthAudience): boolean
  challenge(audience: AuthAudience): string | null
}

export class SeparateRequestAuthenticator implements RequestAuthenticator {
  constructor(private readonly credentials: StoredCredentials) {}

  authorize(headers: IncomingHttpHeaders, audience: AuthAudience): boolean {
    if (audience === "launcher") {
      const supplied = singleHeader(headers["x-omw-launcher-token"])
      return supplied !== undefined && secretEqual(supplied, this.credentials.launcherToken)
    }
    const supplied = parseBasic(singleHeader(headers.authorization))
    return supplied !== null
      && secretEqual(supplied.username, this.credentials.manager.username)
      && secretEqual(supplied.password, this.credentials.manager.password)
  }

  challenge(audience: AuthAudience): string | null {
    return audience === "browser" ? 'Basic realm="OMW", charset="UTF-8"' : null
  }
}

export class OpenCodeAuthAdapter {
  constructor(private readonly credential: BasicCredential) {}

  environment(): NodeJS.ProcessEnv {
    return {
      OPENCODE_SERVER_USERNAME: this.credential.username,
      OPENCODE_SERVER_PASSWORD: this.credential.password,
    }
  }

  headers(): Record<string, string> {
    return { authorization: `Basic ${Buffer.from(`${this.credential.username}:${this.credential.password}`, "utf8").toString("base64")}` }
  }

  redact(value: string): string {
    const authorization = this.headers()["authorization"] ?? ""
    const secrets: string[] = [this.credential.username, this.credential.password, authorization]
      .filter((secret) => secret.length > 0)
      .sort((left, right) => right.length - left.length)
    return secrets
      .reduce((result, secret) => result.replaceAll(secret, "[REDACTED]"), value)
  }
}

function parseBasic(value: string | undefined): BasicCredential | null {
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec(value ?? "")
  if (!match?.[1]) return null
  const decoded = Buffer.from(match[1], "base64").toString("utf8")
  const separator = decoded.indexOf(":")
  if (separator < 0) return null
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) }
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined
}

function secretEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8")
  const rightBytes = Buffer.from(right, "utf8")
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}
