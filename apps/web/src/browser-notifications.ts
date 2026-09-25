import type { ManagedInstance } from "@omw/contracts"

export type PendingNotice = { instanceId: string; count: number }

function knownCount(value: number | null): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
}

export function createPendingTracker() {
  const previous = new Map<string, number | null>()
  return {
    reset() { previous.clear() },
    observe(instances: ManagedInstance[]): PendingNotice[] {
      const events: PendingNotice[] = []
      const present = new Set<string>()
      for (const instance of instances) {
        present.add(instance.id)
        // #79: primarySummary 只代表主 Session；兩種 Instance-wide 待處理合計為同一輪。
        // 任一數量未知或 Instance 不可信時不建立 0 基準，避免恢復時誤報。
        const questions = knownCount(instance.summary.pendingQuestions)
        const permissions = knownCount(instance.summary.pendingPermissions)
        const next = instance.state === "ready" && !instance.trackingHidden && questions !== null && permissions !== null
          ? questions + permissions : null
        if (previous.get(instance.id) === 0 && next !== null && next > 0) {
          events.push({ instanceId: instance.id, count: next })
        }
        previous.set(instance.id, next)
      }
      for (const id of previous.keys()) if (!present.has(id)) previous.delete(id)
      return events
    },
  }
}

const STORAGE_KEY = "omw-browser-notifications"
type Permission = NotificationPermission
interface PreferenceOptions {
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">
  supported: () => boolean
  permission: () => Permission
  requestPermission: () => Promise<Permission>
}

export function createNotificationPreference(options: PreferenceOptions) {
  let saved = false
  let storageAvailable = true
  let unavailable = false
  let generation = 0
  try { saved = options.storage.getItem(STORAGE_KEY) === "true" } catch { storageAvailable = false }

  function status(): "on" | "off" | "unsupported" | "blocked" | "unavailable" {
    if (!options.supported()) return "unsupported"
    if (options.permission() === "denied") return "blocked"
    if (!storageAvailable || unavailable) return "unavailable"
    return saved && options.permission() === "granted" ? "on" : "off"
  }

  function disable(): void {
    generation++
    saved = false
    try { options.storage.removeItem(STORAGE_KEY) } catch { storageAvailable = false }
  }

  function fail(): void {
    disable()
    unavailable = true
  }

  function enable(): Promise<boolean> {
    if (!storageAvailable || !options.supported() || options.permission() === "denied") {
      disable()
      return Promise.resolve(false)
    }
    const current = ++generation
    // 必須在使用者 click 的同一呼叫堆疊內要求權限，不能先 await SW 註冊或網路讀取。
    let request: Promise<Permission>
    try { request = options.permission() === "granted" ? Promise.resolve("granted") : options.requestPermission() }
    catch { fail(); return Promise.resolve(false) }
    return request.then((permission) => {
      if (current !== generation) return false
      if (permission !== "granted" || options.permission() !== "granted") { disable(); return false }
      try { options.storage.setItem(STORAGE_KEY, "true") } catch { fail(); return false }
      saved = true
      unavailable = false
      return true
    }, () => { if (current === generation) fail(); return false })
  }

  return { enabled: () => status() === "on", status, enable, disable, fail }
}
