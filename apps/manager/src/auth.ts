import { timingSafeEqual } from "node:crypto"
import type { IncomingHttpHeaders } from "node:http"

export interface BasicCredential {
  username: string
  password: string
}

export interface StoredCredentials {
  manager: BasicCredential
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
