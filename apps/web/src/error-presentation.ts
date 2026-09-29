import { ApiError } from "./api"
import type { MessageKey } from "./i18n"

// 只列出已確認語意的 API code；不從未知 code 猜測原因，也不在摘要回傳 server message。
const knownCodes: Record<string, MessageKey> = {
  INSTANCE_NOT_FOUND: "error.instanceNotFound", INSTANCE_STOPPED: "error.instanceStopped",
  SESSION_NOT_FOUND: "error.sessionNotFound", SESSION_BINDING_CHANGED: "error.bindingChanged",
  DIRECTORY_REQUIRED: "error.directoryRequired", DIRECTORY_NOT_ACCESSIBLE: "error.directoryNotAccessible",
  PORT_UNAVAILABLE: "error.portUnavailable", PORT_POOL_EXHAUSTED: "error.portExhausted",
  REMOTE_URL_UNAVAILABLE: "error.remoteUnavailable", TAILSCALE_OFFLINE: "error.tailscaleOffline",
  TAILSCALE_NEEDS_LOGIN: "error.tailscaleLogin", SESSION_CREATED_URL_FAILED: "error.sessionCreatedUrlFailed",
  AUTH_REQUIRED: "error.unauthorized", CURRENT_PASSWORD_INVALID: "error.invalidCredentials",
  PASSWORD_INVALID: "error.invalidRequest", USERNAME_INVALID: "error.invalidRequest", REQUEST_INVALID: "error.invalidRequest",
  INSTANCE_PRIMARY_SESSION_REQUIRED: "error.primaryRequired", SESSION_NOT_ROOT: "error.notRoot",
  INSTANCE_REMOVAL_UNSAFE: "error.removalUnsafe", INSTANCE_START_FAILED: "error.startFailed",
  INSTANCE_START_TIMEOUT: "error.startTimeout", REMOTE_ENABLE_LOCAL_ONLY: "error.notLocal",
  LAUNCHER_LOCAL_ONLY: "error.notLocal", SESSION_CREATE_FAILED: "error.sessionCreateFailed",
  CREDENTIAL_UPDATE_UNAVAILABLE: "error.credentialUnavailable",
  INSTANCE_IDENTITY_CHECK_FAILED: "error.identityUnverified", INSTANCE_IDENTITY_UNVERIFIED: "error.identityUnverified",
  PROCESS_IDENTITY_INCOMPLETE: "error.identityUnverified", PROCESS_IDENTITY_MISMATCH: "error.identityUnverified",
  SESSION_CREATE_UNAVAILABLE: "error.sessionUnavailable", SESSION_TODOS_UNAVAILABLE: "error.sessionUnavailable",
  SESSION_CREATE_RESPONSE_INVALID: "error.sessionUnavailable", INSTANCE_SUMMARY_FAILED: "error.sessionUnavailable",
  REMOTE_ENABLE_DISABLED: "error.remoteDisabled", REMOTE_ENABLE_UNAVAILABLE: "error.remoteRegistration",
  REMOTE_REGISTRATION_UNAVAILABLE: "error.remoteRegistration", TAILSCALE_UNAVAILABLE: "error.remoteRegistration",
  REGISTRATION_TIMEOUT: "error.remoteRegistration", DNS_MISMATCH: "error.remoteRegistration",
  INSTANCE_RESUME_UNAVAILABLE: "error.requestConflict", INSTANCE_TRACKING_HIDE_UNAVAILABLE: "error.requestConflict",
  LOCAL_TUI_OBSERVE_ONLY: "error.requestConflict", TARGET_CONFLICT: "error.requestConflict",
  SHORTCUT_NOT_FOUND: "error.requestConflict", RESERVATION_NOT_FOUND: "error.requestConflict",
  SHUTDOWN_UNAVAILABLE: "error.shutdownUnavailable", MUTATION_ORIGIN_REJECTED: "error.originRejected",
}

export interface PresentedError { summary: string; summaryKey: MessageKey; params?: Record<string, string | number>; diagnostic: string | null; code: string | null }

export function safeDiagnostic(value: unknown): string | null {
  // Free-form diagnostics 可能夾帶 Basic、URL 或新型憑證；只顯示我們已知的純 code。
  return typeof value === "string" && Object.hasOwn(knownCodes, value) ? value : null
}

export function presentError(cause: unknown, t: (key: MessageKey) => string): PresentedError {
  if (cause instanceof ApiError) {
    const known = Object.hasOwn(knownCodes, cause.code) ? knownCodes[cause.code] : null
    const summaryKey = known ?? (cause.status === 401 ? "error.unauthorized" : cause.code === "HTTP_ERROR" ? "error.http" : "error.unknown")
    return { summary: t(summaryKey), summaryKey, code: known ? cause.code : null, diagnostic: safeDiagnostic(cause.message) }
  }
  return { summary: t("error.unknown"), summaryKey: "error.unknown", code: null, diagnostic: cause instanceof Error ? safeDiagnostic(cause.message) : null }
}

export function presentStatusError(value: string | null, t: (key: MessageKey) => string, fallback: MessageKey): PresentedError {
  const known = value !== null && Object.hasOwn(knownCodes, value) ? knownCodes[value] : null
  const summaryKey = known ?? fallback
  return { summary: t(summaryKey), summaryKey, code: known ? value : null, diagnostic: safeDiagnostic(value) }
}
