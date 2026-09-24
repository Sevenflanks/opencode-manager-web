import type { InstanceRecord } from "./repository.js"
import type { RuntimeCapabilities, RuntimePort, RuntimeSummary } from "./runtime.js"

export function capabilitiesFor(adapter: RuntimePort, instance: InstanceRecord): RuntimeCapabilities {
  const declared = adapter.capabilities?.(instance) ?? {}
  if ((adapter.agentFamily ?? "opencode") === "opencode") return declared
  const unsupported = { state: "unsupported" } as const
  return {
    sessions: declared.sessions ?? unsupported,
    sessionCreation: declared.sessionCreation ?? unsupported,
    activity: declared.activity ?? unsupported,
    pendingQuestions: declared.pendingQuestions ?? unsupported,
    pendingPermissions: declared.pendingPermissions ?? unsupported,
    nativeWeb: declared.nativeWeb ?? unsupported,
  }
}

export function supports(capabilities: RuntimeCapabilities, name: keyof RuntimeCapabilities): boolean {
  return !capabilities[name] || capabilities[name].state === "supported"
}

export function availableSummary(summary: RuntimeSummary, capabilities: RuntimeCapabilities): RuntimeSummary {
  // 逐項遮蔽不可讀訊號，避免某個 optional capability 不可用時抹掉其餘可靠的 busy / Session。
  const result = { ...summary }
  if (!supports(capabilities, "sessions")) {
    result.sessions = []
    result.sessionsKnown = false
  }
  if (!supports(capabilities, "activity")) {
    result.activity = "unknown"
    result.busySessions = result.retrySessions = null
    result.sessionStatuses = result.invalidStatusSessionIds = null
  }
  if (!supports(capabilities, "pendingQuestions")) {
    result.pendingQuestions = null
    result.questionRequests = result.invalidQuestionSessionIds = null
  }
  if (!supports(capabilities, "pendingPermissions")) {
    result.pendingPermissions = null
    result.permissionRequests = result.invalidPermissionSessionIds = null
  }
  return result
}
