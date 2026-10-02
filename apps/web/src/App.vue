<script setup lang="ts">
import { primarySessionDisposition } from "@omw/contracts"
import type { ConnectivityInfo, DirectoryListing, DirectoryShortcut, ManagedInstance, OpenUrlResponse, OverviewFilter, SessionMetadata, SessionRootsResponse, SessionTodo } from "@omw/contracts"
import {
  ActivityIcon,
  AlertTriangleIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  CircleIcon,
  CircleSlash2Icon,
  CircleStopIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  ExternalLinkIcon,
  FolderPlusIcon,
  LoaderCircleIcon,
  PencilIcon,
  PlayIcon,
  PowerIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  ServerIcon,
  Share2Icon,
  Settings2Icon,
  Trash2Icon,
  WifiIcon,
  XIcon,
} from "lucide-vue-next"
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue"
import { ApiError, managerApi, type WorkerCapacity } from "@/api"
import { createNotificationPreference, createPendingTracker } from "@/browser-notifications"
import { createOverviewRefresh } from "@/overview-refresh"
import { createStoppedHistory } from "@/stopped-history"
import { createSessionTodoRefresh, TodoBindingChangedError } from "@/session-todo-refresh"
import { renderSessionWaiting } from "@/session-waiting"
import { createSwipeDismiss } from "@/swipe-dismiss"
import SessionTreeNode from "@/components/SessionTreeNode.vue"
import { Button } from "@/components/ui/button"
import ConfirmationDialog from "@/components/ui/dialog/ConfirmationDialog.vue"
import { Input } from "@/components/ui/input"
import ErrorDetails from "@/components/ErrorDetails.vue"
import { LocalError, presentError, presentRegistrationError, presentStatusError, safeDiagnostic, type PresentedError } from "@/error-presentation"
import { useMessages, type MessageKey } from "@/i18n"

const { t, date: formatDate, number } = useMessages()
const filters = computed<Array<{ value: OverviewFilter; label: string }>>(() => [
  { value: "all", label: t("filter.all") },
  { value: "active", label: t("filter.active") },
  { value: "attention", label: t("filter.attention") },
  { value: "unreachable", label: t("filter.unreachable") },
])
const SESSION_PAGE_SIZE = 10
const STOPPED_HISTORY_KEY = "stopped"
type LifecycleAction = "start" | "stop" | "recheck" | "resume" | "tracking" | "remove"
type RecoveryAction = "recheck" | "resume" | "tracking" | "remove"
type ConfirmationTone = "positive" | "caution" | "danger"
type InstanceStatusCategory = "operable" | "attention" | "unknown" | "stopped"
interface ConfirmationRequest {
  titleKey: MessageKey
  descriptionKey: MessageKey
  descriptionParams?: Record<string, string | number>
  confirmLabelKey: MessageKey
  tone: ConfirmationTone
  requiresFreshOverview?: boolean
  freshnessErrorTarget?: "lifecycle" | "action"
  accept: () => Promise<void>
}

const recoveryActionKeys = {
  recheck: "recheckAllowed",
  resume: "resumeAllowed",
  tracking: "hideAllowed",
  remove: "removeAllowed",
} as const
type ErrorArea = "action" | "connectivity" | "remote" | "sessions" | "browse" | "lifecycle" | "settings"
const errorDetails = reactive<Record<ErrorArea, PresentedError | null>>({
  action: null, connectivity: null, remote: null,
  sessions: null, browse: null, lifecycle: null, settings: null,
})

const connectivity = ref<ConnectivityInfo | null>(null)
const connectivityLoading = ref(false)
const connectivityRegistering = ref(false)
const connectivityError = ref("")
const connectivityStale = ref(false)
const workerCapacity = ref<WorkerCapacity["state"]>("unknown")
let capacityGeneration = 0
let capacityFlight: Promise<WorkerCapacity["state"]> | null = null
let capacityController: AbortController | null = null
const connectivityFallbackOpen = ref(false)
const connectivityFallback = ref<HTMLElement | null>(null)
const connectivityCopyMessage = ref<MessageKey | "">("")
const remoteEnableOpen = ref(false)
const remoteEnableUsername = ref("")
const remoteEnablePassword = ref("")
const remoteEnableError = ref("")
const shareSupported = ref(false)
const query = ref("")
const filter = ref<OverviewFilter>("all")
const appliedQuery = ref("")
const appliedFilter = ref<OverviewFilter>("all")
const includeHidden = ref(false)
const selectedId = ref("")
const mobileDetailOpen = ref(false)
const historyOpen = ref<Set<string>>(new Set())
const stoppedHistory = createStoppedHistory((q, hidden, offset, revision, signal) => managerApi.history(q, hidden, offset, revision, signal))
const { query: historyQuery, appliedQuery: historyAppliedQuery, instances: stoppedInstances, total: historyTotal,
  loading: historyLoading, loaded: historyLoaded, failure: historyFailure, nextOffset: historyNextOffset } = stoppedHistory
// reload 可能在 pagehide 前取用 History entry；先保存草稿，但不改變已提交的查詢意圖。
watch(historyQuery, persistMobileListHistory, { flush: "post" })
const historyError = computed(() => historyFailure.value ? presentError(historyFailure.value, t) : null)
const mutating = ref(false)
const actionError = ref("")
const notice = ref<{ key: MessageKey; params?: Record<string, string | number> } | null>(null)
const filtersRail = ref<HTMLElement | null>(null)
const filterCanLeft = ref(false)
const filterCanRight = ref(false)
const panelDrag = ref(0)
const settingsDrag = ref(0)
const noticeDrag = ref(0)
const errorDrag = ref(0)
const panelSwipe = createSwipeDismiss("down", 80)
const settingsSwipe = createSwipeDismiss("down", 80)
const noticeSwipe = createSwipeDismiss("horizontal", 80)
const errorSwipe = createSwipeDismiss("horizontal", 80)
type SwipeKind = "panel" | "settings" | "notice" | "error"
let activeSwipe: { kind: SwipeKind; id: number; x: number; y: number; target: HTMLElement } | null = null
let suppressMultitouchBackdropClick = false
let clearSwipeClickGuard: (() => void) | null = null
const swipes = { panel: panelSwipe, settings: settingsSwipe, notice: noticeSwipe, error: errorSwipe }
const startPanelOpen = ref(false)
const startPanelBlocking = ref(false)
const startPanelClosing = ref(false)
const startPanelMotion = ref<"pointer" | "reduced" | "none">("none")
const startPanel = ref<HTMLElement | null>(null)
const detailPane = ref<HTMLElement | null>(null)
const shortcutId = ref<string | null>(null)
const shortcutName = ref("")
const shortcutDirectory = ref("")
const browserPath = ref("")
const listing = ref<DirectoryListing | null>(null)
const browsingPath = ref("")
const browseError = ref("")
let browseGeneration = 0
const sessions = ref<SessionRootsResponse>({ roots: [], unknownParent: [] })
const sessionsLoading = ref(false)
const sessionsLoaded = ref(false)
const sessionsError = ref("")
const sessionPage = ref(1)
const switchingSessionId = ref("")
const opening = ref(false)
const sessionTabs = new Map<string, Window>()
const lifecycleOpen = ref(false)
const lifecyclePending = ref<LifecycleAction | null>(null)
const lifecycleError = ref("")
const confirmation = ref<ConfirmationRequest | null>(null)
const confirmationDisplay = ref<ConfirmationRequest | null>(null)
const confirmationAccepting = ref(false)
const confirmationReturnFocus = ref<HTMLElement | null>(null)
const managerSettingsOpen = ref(false)
const managerSettingsDialog = ref<HTMLElement | null>(null)
const managerSettingsBusy = ref(false)
const managerSettingsError = ref("")
const managerSettingsSuccess = ref<MessageKey | "">("")
const managerUsername = ref("omw")
const currentManagerPassword = ref("")
const nextManagerPassword = ref("")
const confirmManagerPassword = ref("")
const managerStopped = ref(false)
const notificationPreference = createNotificationPreference({
  storage: {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
    removeItem: (key) => window.localStorage.removeItem(key),
  },
  supported: () => window.isSecureContext && "Notification" in window,
  permission: () => Notification.permission,
  requestPermission: () => Notification.requestPermission(),
})
const notificationStatus = ref(notificationPreference.status())
const notificationError = ref<MessageKey | "">("")
const notificationBusy = ref(false)
const pendingTracker = createPendingTracker()
let notificationRegistration: ServiceWorkerRegistration | null = null
let notificationReady = false
let notificationPageActive = true
let notificationGeneration = 0
let notificationFlight: Promise<void> | null = null
let notificationQueued = false
let notificationNeedsDrain = false
let notificationController: AbortController | null = null
let confirmationClosing = false
let confirmationLeaveCompleted = false
let pollTimer: number | undefined
let connectivityPollTimer: number | undefined
let noticeTimer: number | undefined
let appDisposed = false
let returnFocusElement: HTMLElement | null = null
let managerSettingsReturnFocus: HTMLElement | null = null
let managerSettingsBodyOverflow = ""
let previousBodyOverflow = ""
let inputModality: "pointer" | "keyboard" = "keyboard"
let restoreFocusAfterStartPanelClose = true
let revealDetailAfterStartPanelClose = false
let restoringFilteredDetail = false
let connectivityReadGeneration = 0
let connectivityMutationGeneration = 0
let mobileHistoryGeneration = 0
let mobileBreakpoint: MediaQueryList | undefined
let listScrollPosition = 0
let returnToInstanceId = ""
// Root 請求可能亂序完成；只有最新選取的 Instance 可更新 data、error 與 loading state。
let sessionsGeneration = 0
let sessionsInstanceId = ""

const refresh = createOverviewRefresh({
  query: () => ({ query: query.value, filter: filter.value, includeHidden: includeHidden.value }),
  visible: () => document.visibilityState === "visible",
  mutationPending: () => Boolean(mutating.value || lifecyclePending.value || switchingSessionId.value),
  read: (requested, signal) => managerApi.overview(requested.query, requested.filter, requested.includeHidden, signal),
  captureRoute: () => ({
    historyGeneration: mobileHistoryGeneration,
    detailTarget: isMobileViewport() && mobileHistoryView() === "detail" ? mobileHistoryInstanceId() : "",
  }),
  prepare: async (next, requested, route, signal, current) => {
    const detailRouteIsCurrent = () => Boolean(route.detailTarget)
      && route.historyGeneration === mobileHistoryGeneration
      && mobileHistoryView() === "detail"
      && mobileHistoryInstanceId() === route.detailTarget
    const detailTarget = () => detailRouteIsCurrent() ? route.detailTarget : selectedId.value
    let target = detailTarget()
    while (target && !next.instances.some((item) => item.id === target) && current()) {
      let instance: ManagedInstance | null = null
      try {
        instance = await managerApi.instance(target, signal)
      } catch (cause) {
        if (!(cause instanceof ApiError && cause.status === 404)) throw cause
      }
      if (!current()) break
      // 等待 A 的 stopped fallback 時可改選 B；重解目前選取，避免只合併 A 後把 B 從詳情清掉。
      const latestTarget = detailTarget()
      if (target !== latestTarget) { target = latestTarget; continue }
      // current 投影刻意排除 stopped，但正在看的詳情必須持續呈現最新停止狀態。
      if (instance?.state === "stopped") next = { ...next, instances: [...next.instances, instance] }
      break
    }
    if (detailRouteIsCurrent() && !next.instances.some((item) => item.id === route.detailTarget)
      && (requested.query.trim() || requested.filter !== "all") && current()) {
      // 篩選結果不能當成 Instance 已移除；僅同一 includeHidden 範圍的未篩選結果可確認缺少。
      const fallback = await managerApi.overview("", "all", requested.includeHidden, signal)
      if (current() && detailRouteIsCurrent() && fallback.instances.some((item) => item.id === route.detailTarget)) {
        return { overview: fallback, query: "", filter: "all" as OverviewFilter }
      }
    }
    return { overview: next, query: requested.query, filter: requested.filter }
  },
  applied: async (result, requested, route, source, current) => {
    if (current() && workerMode.value) await loadWorkerCapacity()
    if (!current()) return
    if (result.query !== requested.query || result.filter !== requested.filter) {
      restoringFilteredDetail = true
      try {
        query.value = result.query
        filter.value = result.filter
      } finally {
        restoringFilteredDetail = false
      }
      replaceMobileHistory("detail", route.detailTarget)
    }
    appliedQuery.value = result.query
    appliedFilter.value = result.filter
    const next = result.overview
    const historyChanged = next.history ? stoppedHistory.observe(next.history) : false
    if (historyExpanded() && historyChanged) void stoppedHistory.load()
    if (current()) void revealNotificationTarget(next.instances)
    const detailRouteIsCurrent = Boolean(route.detailTarget)
      && route.historyGeneration === mobileHistoryGeneration
      && mobileHistoryView() === "detail"
      && mobileHistoryInstanceId() === route.detailTarget
    if (detailRouteIsCurrent && next.instances.some((item) => item.id === route.detailTarget)) {
      if (selectedId.value !== route.detailTarget || !mobileDetailOpen.value) await restoreMobileHistory()
    } else if (detailRouteIsCurrent) {
      selectedId.value = ""
      resetSelectedScope()
      mobileDetailOpen.value = false
      replaceMobileHistory("list")
      showNotice("notice.instanceMissing")
      void restoreListContext()
    } else if ((!isMobileViewport() || route.historyGeneration === mobileHistoryGeneration)
      && selectedId.value && !next.instances.some((item) => item.id === selectedId.value)) {
      selectedId.value = ""
      resetSelectedScope()
    }
    if (!selectedId.value && !isMobileViewport()) {
      selectedId.value = next.instances[0]?.id ?? ""
      lifecycleError.value = ""
      if (selectedId.value) await loadSessions()
    }
    if (current() && source === "user") persistMobileListHistory()
  },
  userAction: beginUserAction,
  errorMessage: (cause) => presentError(cause, t),
  timeoutMessage: () => ({ summary: t("error.overviewTimeout"), summaryKey: "error.overviewTimeout", code: null, diagnostic: null }),
})
const {
  overview, loading, error: overviewFailure, lastSucceededAt: overviewLastSucceededAt,
  stale: overviewStale, refreshing: overviewRefreshing,
  invalidate: invalidateOverview, refreshAfterMutation, load: loadOverview,
} = refresh
const overviewError = computed(() => overviewFailure.value ? t(overviewFailure.value.summaryKey) : "")
watch(() => Boolean(mutating.value || lifecyclePending.value || switchingSessionId.value), (pending) => {
  if (pending) suspendNotifications()
}, { flush: "sync" })

const selected = computed(() => overview.value.instances.find((instance) => instance.id === selectedId.value) ?? null)
const selectedSummaryFailure = computed(() => selected.value?.primarySummary.activity === "unknown"
  ? presentStatusError(selected.value.primarySummary.error, t, "session.summaryUnknown") : null)
const selectedFailure = computed(() => selected.value?.error ? presentStatusError(selected.value.error, t, "error.unknown") : null)
const todoRefresh = createSessionTodoRefresh({ read: (id) => managerApi.primaryTodos(id) })
const { todos: primaryTodos, loading: todosLoading, loaded: todosLoaded, stale: todosStale, error: todosError } = todoRefresh
const todoFailure = computed(() => {
  if (!todosError.value) return null
  if (todosError.value instanceof TodoBindingChangedError) return { summary: t("error.todoBindingChanged"), summaryKey: "error.todoBindingChanged" as const, code: null, diagnostic: null }
  return presentError(todosError.value, t)
})
const todoCompletedCount = computed(() => primaryTodos.value.filter((todo) => todo.status === "completed").length)
const todoActiveCount = computed(() => primaryTodos.value.filter((todo) => todo.status !== "cancelled").length)
const todoCancelledCount = computed(() => primaryTodos.value.filter((todo) => todo.status === "cancelled").length)
const todoMeasuredContent = ref<HTMLElement | null>(null)
watch(filtersRail, (rail, _, onCleanup) => {
  if (!rail) return
  const observer = new ResizeObserver(updateFilterHints)
  observer.observe(rail)
  rail.querySelectorAll("button").forEach((button) => observer.observe(button))
  updateFilterHints()
  onCleanup(() => observer.disconnect())
}, { flush: "post" })
function updateFilterHints(): void {
  const rail = filtersRail.value
  if (!rail) return
  filterCanLeft.value = rail.scrollLeft > 1
  filterCanRight.value = rail.scrollLeft + rail.clientWidth < rail.scrollWidth - 1
}
watch(todoMeasuredContent, (content, _, onCleanup) => {
  if (!content) return
  const container = content.parentElement
  if (!container) return
  // 量測實際內容而非猜測列數；長文字換行或 viewport 改變時仍可重新銜接高度。
  const observer = new ResizeObserver(() => {
    container.style.height = `${Math.ceil(content.getBoundingClientRect().height)}px`
  })
  observer.observe(content)
  onCleanup(() => observer.disconnect())
}, { flush: "post" })
const todoStatusLabels = computed<Record<SessionTodo["status"], string>>(() => ({
  pending: t("todo.pending"), in_progress: t("todo.inProgress"), completed: t("todo.completed"), cancelled: t("todo.cancelled"),
}))
function syncPrimaryTodos(): void {
  const instance = selected.value
  const sessionId = instance?.primarySession?.sessionId
  todoRefresh.focus(instance && sessionId && document.visibilityState === "visible"
    && (!isMobileViewport() || mobileDetailOpen.value) ? { instanceId: instance.id, sessionId } : null)
}
watch(() => [selected.value?.id, selected.value?.primarySession?.sessionId, mobileDetailOpen.value], syncPrimaryTodos, { immediate: true, flush: "sync" })
const sessionPageCount = computed(() => Math.max(1, Math.ceil(sessions.value.roots.length / SESSION_PAGE_SIZE)))
const sortedSessionRoots = computed(() => [...sessions.value.roots].sort(compareSessionMetadata))
const visibleSessionRoots = computed(() => sortedSessionRoots.value.slice(
  (sessionPage.value - 1) * SESSION_PAGE_SIZE,
  sessionPage.value * SESSION_PAGE_SIZE,
))
const connectivityMode = computed<"loopback" | "tailnet" | "worker" | "unknown">(() => {
  const value = connectivity.value?.mode as string | undefined
  return value === "loopback" || value === "tailnet" || value === "worker" ? value : "unknown"
})
const workerMode = computed(() => connectivityMode.value === "worker")
// 舊 Manager 沒有 capabilities；保留原模式行為，Worker 則不把缺欄位當成本機功能授權。
const tailscaleSupported = computed(() => Boolean(connectivity.value) && !workerMode.value && connectivity.value?.capabilities?.tailscale !== false)
const credentialUpdateSupported = computed(() => Boolean(connectivity.value) && !workerMode.value && connectivity.value?.capabilities?.credentialUpdate !== false)
const managerShutdownSupported = computed(() => Boolean(connectivity.value) && !workerMode.value && connectivity.value?.capabilities?.managerShutdown !== false)
const nativeWebRoot = computed(() => {
  if (!workerMode.value || connectivityStale.value || connectivity.value?.capabilities?.nativeWeb !== true) return null
  const value = safeManagerUrl(connectivity.value.nativeWebOrigin)
  if (!value) return null
  const parsed = new URL(value)
  return parsed.pathname === "/" ? `${parsed.origin}/` : null
})
const nativeWebAvailable = computed(() => nativeWebRoot.value && selected.value?.state === "ready" && !overviewStale.value)
const workerCapacityState = computed(() => connectivityStale.value || overviewStale.value ? "unknown" : workerCapacity.value)
const instanceCapacityBlocked = computed(() => workerMode.value && workerCapacityState.value !== "available")
const workerCapacityMessage = computed<MessageKey>(() => ({
  available: "worker.capacityAvailable", occupied: "worker.capacityFull", unknown: "worker.capacityUnknown",
} as const)[workerCapacityState.value])
const tailscaleState = computed<ConnectivityInfo["tailscale"]["state"]>(() => {
  const value = connectivity.value?.tailscale.state as string | undefined
  return ["connected", "offline", "needs-login", "unavailable", "unknown"].includes(value ?? "")
    ? value as ConnectivityInfo["tailscale"]["state"]
    : "unknown"
})
const serveState = computed<ConnectivityInfo["serve"]["state"]>(() => {
  const value = connectivity.value?.serve.state as string | undefined
  return ["verified", "mismatch", "unknown", "not-configured"].includes(value ?? "")
    ? value as ConnectivityInfo["serve"]["state"]
    : "unknown"
})
const remoteUrl = computed(() => {
  const value = connectivity.value?.manager.publicUrl
  if (connectivityStale.value
    || connectivityMode.value !== "tailnet"
    || tailscaleState.value !== "connected"
    || serveState.value !== "verified"
    || connectivity.value?.serve.funnel !== "disabled"
    || !value) return null
  return safeManagerUrl(value)
})
const canRegisterConnectivity = computed(() => {
  const state = connectivity.value?.registration.state
  return tailscaleSupported.value && connectivityMode.value === "tailnet"
    && !connectivityRegistering.value
    && (state === "failed" || (state === "idle" && !remoteUrl.value))
})
const localUrl = computed(() => safeManagerUrl(connectivity.value?.manager.localUrl) ?? t("common.unknown"))
const connectivityTone = computed(() => {
  if (connectivityStale.value || !connectivity.value) return "unknown"
  if (workerMode.value) return "ready"
  if (tailscaleState.value !== "connected" || serveState.value === "mismatch" || connectivity.value.serve.funnel === "enabled") return "warning"
  return serveState.value === "verified" ? "ready" : "unknown"
})
const connectivityHeadline = computed(() => {
  if (connectivityStale.value) return t("connectivity.stale")
  if (!connectivity.value) return connectivityLoading.value ? t("connectivity.pending") : t("connectivity.unknown")
  if (workerMode.value) return t("worker.modeTitle")
  if (connectivityRegistering.value || connectivity.value.registration.state === "registering") return t("connectivity.registering")
  if (connectivity.value.registration.state === "failed") {
    return connectivity.value.registration.trigger === "manual" ? t("connectivity.registrationFailed") : t("connectivity.notRegistered")
  }
  if (connectivity.value.registration.state === "verified") return t("connectivity.verified")
  return {
    connected: t("connectivity.online"),
    offline: t("connectivity.offline"),
    "needs-login": t("connectivity.needsLogin"),
    unavailable: t("connectivity.unavailable"),
    unknown: t("connectivity.unknownState"),
  }[tailscaleState.value]
})
const serveLabel = computed(() => ({
  verified: t("connectivity.serveVerified"),
  mismatch: t("connectivity.serveMismatch"),
  unknown: t("connectivity.serveUnknown"),
  "not-configured": t("connectivity.serveNotConfigured"),
})[serveState.value])
const registrationFailure = computed(() => {
  const registration = connectivity.value?.registration
  return registration?.state === "failed" && registration.trigger === "manual" && registration.diagnostic
    ? presentRegistrationError(registration.diagnostic.code, t)
    : null
})
const connectivityWarnings = computed(() => {
  const warnings: string[] = []
  if (connectivityStale.value) warnings.push(t("connectivity.warningStale"))
  if (!tailscaleSupported.value) return warnings
  if (tailscaleState.value === "offline") warnings.push(t("connectivity.warningOffline"))
  if (tailscaleState.value === "needs-login") warnings.push(t("connectivity.warningLogin"))
  if (tailscaleState.value === "unavailable") warnings.push(t("connectivity.warningUnavailable"))
  if (serveState.value === "mismatch") warnings.push(t("connectivity.warningMismatch"))
  if (connectivity.value?.serve.funnel === "enabled") warnings.push(t("connectivity.warningFunnel"))
  return warnings
})
const recoveryMetadataValid = computed(() => {
  const recovery = selected.value?.recovery
  return typeof recovery === "object" && recovery !== null
    && Object.values(recoveryActionKeys).every((key) => typeof recovery[key] === "boolean")
})
const recoveryDiagnostic = computed(() => selected.value && !recoveryMetadataValid.value ? t("error.unknown") : "")
const overviewMutationsBlocked = computed(() => overviewStale.value)
const overviewFreshnessState = computed<"initial" | "unavailable" | "refreshing" | "changed" | "failed" | "fresh">(() => {
  if (!overviewLastSucceededAt.value) return overviewError.value ? "unavailable" : "initial"
  if (overviewRefreshing.value) return "refreshing"
  if (overviewError.value) return "failed"
  return overviewStale.value ? "changed" : "fresh"
})
watch([query, filter, includeHidden], () => {
  if (!restoringFilteredDetail) invalidateOverview("changed")
}, { flush: "sync" })
const lifecycleUnavailableReasons = computed(() => {
  if (!selected.value || !recoveryMetadataValid.value || lifecyclePending.value) return []
  return (Object.keys(recoveryActionKeys) as RecoveryAction[])
    .filter((action) => !recoveryActionAllowed(action))
    .map((action) => ({ label: recoveryActionLabel(selected.value!, action), reason: lifecycleReason(selected.value!, action) }))
})
// 排序只依啟動時間與 Instance ID；polling 更新 activity 時不可讓同一列在清單中跳動。
const orderedInstances = computed(() => overview.value.instances.toSorted((left, right) =>
  Date.parse(right.launchedAt) - Date.parse(left.launchedAt) || left.id.localeCompare(right.id)))
const currentInstances = computed(() => orderedInstances.value.filter((instance) => instance.state !== "stopped"))

onMounted(async () => {
  mobileBreakpoint = window.matchMedia("(max-width: 860px)")
  if (isMobileViewport()) window.history.scrollRestoration = "manual"
  mobileBreakpoint.addEventListener("change", handleMobileBreakpointChange)
  document.addEventListener("pointerdown", handleDocumentPointerdown, true)
  document.addEventListener("pointerdown", cancelSwipeOnSecondPointer, true)
  document.addEventListener("keydown", handleDocumentKeydown, true)
  window.addEventListener("scroll", handleMobileListScroll, { passive: true })
  window.addEventListener("popstate", handleMobileHistoryChange)
  shareSupported.value = typeof navigator.share === "function"
  if (isMobileViewport() && !mobileHistoryView()) replaceMobileHistory("list")
  if (isMobileViewport()) applyMobileHistoryContext()
  window.addEventListener("hashchange", handleNotificationHash)
  if (notificationPreference.enabled()) void startNotifications()
  void loadConnectivity("background")
  const overviewLoaded = await loadOverview(true, "background")
  if (appDisposed) return
  if (overviewLoaded && isMobileViewport() && mobileHistoryView() === "list") await restoreMobileListScroll()
  if (appDisposed) return
  document.addEventListener("visibilitychange", handleForegroundRefresh)
  window.addEventListener("pageshow", handlePageShow)
  window.addEventListener("pagehide", handlePageHide)
  document.addEventListener("freeze", handlePageHide)
  document.addEventListener("resume", handlePageShow)
  connectivityPollTimer = window.setInterval(() => void loadConnectivity("background"), 30_000)
  pollTimer = window.setInterval(() => {
    if (!mutating.value && !lifecyclePending.value && !switchingSessionId.value) void loadOverview(false, "background")
    notificationStatus.value = notificationPreference.status()
    if (notificationPreference.enabled() && notificationPageActive) {
      if (notificationReady) void pollNotifications()
      else if (!notificationBusy.value) void startNotifications()
    }
  }, 5_000)
})
onBeforeUnmount(() => {
  appDisposed = true
  window.clearInterval(pollTimer)
  window.clearInterval(connectivityPollTimer)
  suspendNotifications()
  window.removeEventListener("hashchange", handleNotificationHash)
  window.clearTimeout(noticeTimer)
  document.removeEventListener("pointerdown", handleDocumentPointerdown, true)
  document.removeEventListener("pointerdown", cancelSwipeOnSecondPointer, true)
  cancelSwipe()
  clearSwipeClickGuard?.()
  document.removeEventListener("keydown", handleDocumentKeydown, true)
  window.removeEventListener("scroll", handleMobileListScroll)
  document.removeEventListener("visibilitychange", handleForegroundRefresh)
  window.removeEventListener("pageshow", handlePageShow)
  window.removeEventListener("pagehide", handlePageHide)
  document.removeEventListener("freeze", handlePageHide)
  document.removeEventListener("resume", handlePageShow)
  window.removeEventListener("popstate", handleMobileHistoryChange)
  mobileBreakpoint?.removeEventListener("change", handleMobileBreakpointChange)
  if (startPanelBlocking.value) document.body.style.overflow = previousBodyOverflow
  if (managerSettingsOpen.value) document.body.style.overflow = managerSettingsBodyOverflow
  refresh.dispose()
  capacityGeneration++
  capacityController?.abort()
  todoRefresh.dispose()
  stoppedHistory.dispose()
  connectivityReadGeneration++
  connectivityMutationGeneration++
  sessionsGeneration++
})

async function loadConnectivity(source: "user" | "background" = "user"): Promise<void> {
  if (source === "background" && document.visibilityState === "hidden") return
  if (connectivityRegistering.value) return
  const generation = ++connectivityReadGeneration
  if (source === "user") {
    connectivityError.value = ""
    connectivityFallbackOpen.value = false
  }
  connectivityLoading.value = true
  try {
    const next = await managerApi.connectivity()
    if (generation !== connectivityReadGeneration) return
    connectivity.value = next
    connectivityStale.value = false
    connectivityError.value = ""
    if (workerMode.value && (source === "user" || workerCapacity.value === "unknown")) await loadWorkerCapacity()
  } catch (cause) {
    if (generation !== connectivityReadGeneration) return
    // 保留最後一次成功結果供診斷，但一定降級為 stale，避免舊的綠色狀態被當成目前可用。
    connectivityStale.value = connectivity.value !== null
    connectivityError.value = message(cause, "connectivity")
  } finally {
    if (generation === connectivityReadGeneration) connectivityLoading.value = false
  }
}

function loadWorkerCapacity(fresh = false): Promise<WorkerCapacity["state"]> {
  if (!workerMode.value || connectivityStale.value || appDisposed) return Promise.resolve("unknown")
  if (!fresh && capacityFlight) return capacityFlight
  // 操作前不可共用已起始的背景讀取。capacity 僅指目前 execution；歷史失聯紀錄仍保留原狀。
  // 這是 UI 提示與 fail-closed seam，併發操作最後仍由 backend mutation 原子重驗。
  capacityController?.abort()
  const generation = ++capacityGeneration
  const controller = new AbortController()
  capacityController = controller
  workerCapacity.value = "unknown"
  const timeout = window.setTimeout(() => controller.abort(), 15_000)
  const flight = (async (): Promise<WorkerCapacity["state"]> => {
    try {
      const next = await managerApi.workerCapacity(controller.signal)
      if (generation !== capacityGeneration || appDisposed) return "unknown"
      workerCapacity.value = next.state
      return next.state
    } catch {
      if (generation === capacityGeneration) workerCapacity.value = "unknown"
      return "unknown"
    } finally {
      window.clearTimeout(timeout)
      if (generation === capacityGeneration) { capacityFlight = null; capacityController = null }
    }
  })()
  capacityFlight = flight
  return flight
}

async function registerConnectivity(): Promise<void> {
  const generation = ++connectivityMutationGeneration
  connectivityReadGeneration++
  connectivityRegistering.value = true
  connectivityLoading.value = false
  connectivityError.value = ""
  connectivityFallbackOpen.value = false
  try {
    const next = await managerApi.registerConnectivity()
    if (generation !== connectivityMutationGeneration) return
    connectivity.value = next
    connectivityStale.value = false
  } catch (cause) {
    if (generation !== connectivityMutationGeneration) return
    connectivityStale.value = connectivity.value !== null
    connectivityError.value = message(cause, "connectivity")
  } finally {
    if (generation === connectivityMutationGeneration) connectivityRegistering.value = false
  }
}

function cancelRemoteEnable(): void {
  if (connectivityRegistering.value) return
  remoteEnableOpen.value = false
  remoteEnablePassword.value = ""
  remoteEnableUsername.value = ""
  remoteEnableError.value = ""
}

async function enableRemoteAccess(): Promise<void> {
  if (connectivityRegistering.value) return
  const generation = ++connectivityMutationGeneration
  connectivityReadGeneration++
  connectivityRegistering.value = true
  connectivityLoading.value = false
  remoteEnableError.value = ""
  try {
    const next = await managerApi.enableRemoteAccess(remoteEnableUsername.value, remoteEnablePassword.value)
    if (generation !== connectivityMutationGeneration) return
    connectivity.value = next
    connectivityStale.value = false
    connectivityError.value = ""
    remoteEnableOpen.value = false
  } catch (cause) {
    if (generation === connectivityMutationGeneration) remoteEnableError.value = message(cause, "remote")
  } finally {
    remoteEnablePassword.value = ""
    if (generation === connectivityMutationGeneration) connectivityRegistering.value = false
  }
}

async function copyPhoneUrl(successMessage: MessageKey = "notice.remoteCopied"): Promise<boolean> {
  const url = remoteUrl.value
  if (!url) return false
  connectivityFallbackOpen.value = false
  connectivityCopyMessage.value = ""
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable")
    await navigator.clipboard.writeText(url)
    showNotice(successMessage)
    return true
  } catch {
    connectivityFallbackOpen.value = true
    connectivityCopyMessage.value = "connectivity.copyFailed"
    await nextTick()
    const input = connectivityFallback.value?.querySelector<HTMLInputElement>("input")
    input?.focus()
    input?.select()
    return false
  }
}

function sharePhoneUrl(): void {
  const url = remoteUrl.value
  if (!url || typeof navigator.share !== "function") return
  let result: Promise<void>
  try {
    // 必須在 click 的 user activation 內同步呼叫 share；不可先 await 其他工作。
    result = navigator.share({ title: "OpenCode Manager", url })
  } catch (cause) {
    void handleShareFailure(cause)
    return
  }
  void result.then(() => showNotice("notice.shareComplete"), handleShareFailure)
}

async function handleShareFailure(cause: unknown): Promise<void> {
  if (cause instanceof DOMException && cause.name === "AbortError") return
  const copied = await copyPhoneUrl("notice.shareCopied")
  if (!copied) connectivityCopyMessage.value = "connectivity.shareFailed"
}

async function choose(instance: ManagedInstance): Promise<void> {
  beginUserAction()
  replaceInstance(instance)
  if (isMobileViewport()) {
    listScrollPosition = window.scrollY
    returnToInstanceId = instance.id
  }
  selectedId.value = instance.id
  if (isMobileViewport()) {
    mobileDetailOpen.value = true
    pushMobileHistory(instance.id)
  }
  sessionPage.value = 1
  lifecycleError.value = ""
  if (isMobileViewport()) void revealSelectedDetail()
  await loadSessions()
}

async function returnToList(): Promise<void> {
  if (isMobileViewport() && mobileHistoryView() === "detail") {
    window.history.back()
    return
  }
  mobileDetailOpen.value = false
  if (isMobileViewport()) replaceMobileHistory("list")
  await restoreListContext()
}

function mobileHistoryView(): "list" | "detail" | null {
  const state = window.history.state
  if (typeof state !== "object" || state === null) return null
  const value = Reflect.get(state, "omwMobileView")
  return value === "list" || value === "detail" ? value : null
}

function mobileHistoryInstanceId(): string {
  const state = window.history.state
  if (typeof state !== "object" || state === null) return ""
  const value = Reflect.get(state, "omwInstanceId")
  return typeof value === "string" ? value : ""
}

function mobileHistoryState(view: "list" | "detail", instanceId = ""): Record<string, unknown> {
  const current = typeof window.history.state === "object" && window.history.state !== null
    ? window.history.state as Record<string, unknown>
    : {}
  const historySearch = stoppedHistory.searchState()
  return {
    ...current,
    omwMobileView: view,
    omwInstanceId: instanceId,
    omwQuery: query.value,
    omwFilter: filter.value,
    omwIncludeHidden: includeHidden.value,
    omwListScroll: listScrollPosition,
    omwHistoryOpen: [...historyOpen.value],
    omwHistoryQuery: historySearch.draft,
    omwHistoryCommittedQuery: historySearch.committed,
  }
}

function replaceMobileHistory(view: "list" | "detail", instanceId = ""): void {
  window.history.replaceState(mobileHistoryState(view, instanceId), "")
}

function persistMobileListHistory(): void {
  if (!isMobileViewport() || mobileHistoryView() !== "list") return
  replaceMobileHistory("list")
}

function handleMobileListScroll(): void {
  if (document.visibilityState === "visible" && isMobileViewport() && mobileHistoryView() === "list") {
    listScrollPosition = window.scrollY
  }
}

function pushMobileHistory(instanceId: string): void {
  if (mobileHistoryView() === "detail") replaceMobileHistory("detail", instanceId)
  else {
    replaceMobileHistory("list")
    window.history.pushState(mobileHistoryState("detail", instanceId), "")
  }
}

function applyMobileHistoryContext(): boolean {
  const state = window.history.state
  if (typeof state !== "object" || state === null) return false
  const historyOverviewQuery = Reflect.get(state, "omwQuery")
  const historyFilter = Reflect.get(state, "omwFilter")
  const historyIncludeHidden = Reflect.get(state, "omwIncludeHidden")
  const historyScroll = Reflect.get(state, "omwListScroll")
  const historyDisclosure = Reflect.get(state, "omwHistoryOpen")
  const savedHistoryQuery = Reflect.get(state, "omwHistoryQuery")
  const historyChanged = stoppedHistory.restoreSearch(savedHistoryQuery, Reflect.get(state, "omwHistoryCommittedQuery"))
  const nextQuery = typeof historyOverviewQuery === "string" ? historyOverviewQuery : ""
  const nextFilter = filters.value.some((item) => item.value === historyFilter) ? historyFilter as OverviewFilter : "all"
  const nextIncludeHidden = historyIncludeHidden === true
  const changed = query.value !== nextQuery || filter.value !== nextFilter || includeHidden.value !== nextIncludeHidden || historyChanged
  query.value = nextQuery
  filter.value = nextFilter
  includeHidden.value = nextIncludeHidden
  if (typeof historyScroll === "number" && Number.isFinite(historyScroll)) listScrollPosition = historyScroll
  if (Array.isArray(historyDisclosure)) historyOpen.value = new Set(historyDisclosure.filter((value): value is string => typeof value === "string"))
  return changed
}

async function restoreMobileHistory(): Promise<void> {
  if (!isMobileViewport() || mobileHistoryView() !== "detail") return
  const instanceId = mobileHistoryInstanceId()
  if (!overviewLastSucceededAt.value || !overview.value.instances.some((instance) => instance.id === instanceId)) return
  selectedId.value = instanceId
  returnToInstanceId = instanceId
  mobileDetailOpen.value = true
  resetSelectedScope()
  await loadSessions()
}

async function handleMobileHistoryChange(): Promise<void> {
  if (!isMobileViewport()) return
  const generation = ++mobileHistoryGeneration
  if (mobileHistoryView() === "detail") {
    const instanceId = mobileHistoryInstanceId()
    if (!overview.value.instances.some((instance) => instance.id === instanceId)) await loadOverview(false, "background")
    if (generation !== mobileHistoryGeneration || mobileHistoryView() !== "detail" || mobileHistoryInstanceId() !== instanceId) return
    await restoreMobileHistory()
    if (generation === mobileHistoryGeneration && mobileDetailOpen.value) await revealSelectedDetail(generation, instanceId)
    return
  }
  mobileDetailOpen.value = false
  await restoreListContext(generation)
}

function handleForegroundRefresh(): void {
  refresh.foreground()
  syncPrimaryTodos()
  // hidden 仍是開啟的頁面：保留已知 0 基準，讓瀏覽器允許的背景輪詢能偵測新事項。
  if (document.visibilityState !== "visible") { persistMobileListHistory(); return }
  notificationStatus.value = notificationPreference.status()
  if (notificationPageActive && notificationReady && notificationPreference.enabled()) { suspendNotifications(); void pollNotifications() }
  else if (notificationPageActive && notificationPreference.enabled() && !notificationBusy.value) void startNotifications()
  connectivityStale.value = connectivity.value !== null
  if (overviewStale.value && confirmation.value?.requiresFreshOverview) {
    ensureFreshOverviewMutation(confirmation.value.freshnessErrorTarget)
    closeConfirmation()
  }
  void loadConnectivity("background")
}

function handlePageHide(): void {
  notificationPageActive = false
  suspendNotifications()
  persistMobileListHistory()
}

function handlePageShow(): void {
  notificationPageActive = true
  handleForegroundRefresh()
}

function suspendNotifications(): void {
  notificationGeneration++
  pendingTracker.reset()
  if (notificationFlight) notificationNeedsDrain = true
  notificationController?.abort()
}

async function startNotifications(): Promise<void> {
  const generation = ++notificationGeneration
  notificationReady = false
  notificationBusy.value = true
  try {
    if ("serviceWorker" in navigator) {
      let timer: number | undefined
      try {
        notificationRegistration = await Promise.race([
          navigator.serviceWorker.register("/notification-sw.js", { scope: "/" }).then(() => navigator.serviceWorker.ready),
          new Promise<never>((_, reject) => { timer = window.setTimeout(() => reject(new Error("Service Worker timeout")), 15_000) }),
        ])
      } finally { window.clearTimeout(timer) }
      if (typeof notificationRegistration.showNotification !== "function") throw new Error(t("notification.unsupported"))
    }
    if (generation !== notificationGeneration || !notificationPageActive || !notificationPreference.enabled()) return
    notificationReady = true
    notificationStatus.value = notificationPreference.status()
    pendingTracker.reset()
    await pollNotifications()
  } catch {
    if (generation !== notificationGeneration) return
    notificationReady = false
    notificationPreference.fail()
    notificationStatus.value = notificationPreference.status()
    notificationError.value = "notification.failed"
  } finally {
    if (generation === notificationGeneration || !notificationReady) notificationBusy.value = false
  }
}

async function toggleNotifications(event: Event): Promise<void> {
  if (!(event.target instanceof HTMLInputElement)) return
  if (!event.target.checked) {
    notificationPreference.disable()
    notificationReady = false
    suspendNotifications()
    notificationStatus.value = notificationPreference.status()
    notificationError.value = ""
    return
  }
  notificationBusy.value = true
  notificationError.value = ""
  // enable() 在此同步進入 requestPermission，保留 checkbox click 的 user activation。
  const allowed = await notificationPreference.enable()
  notificationStatus.value = notificationPreference.status()
  if (allowed) await startNotifications()
  else {
    notificationBusy.value = false
    if (notificationStatus.value === "off") notificationError.value = "notification.permissionDenied"
  }
}

async function pollNotifications(): Promise<void> {
  if (!notificationReady || !notificationPreference.enabled() || !notificationPageActive || appDisposed || managerStopped.value
    || mutating.value || lifecyclePending.value || switchingSessionId.value) return
  // 等待者只能排一輪；若各自接著讀，舊回應可能在新回應後把待處理基準改回 0。
  if (notificationFlight) {
    notificationQueued = true
    await notificationFlight
    return
  }
  const generation = notificationGeneration
  const controller = new AbortController()
  notificationController = controller
  const timeout = window.setTimeout(() => controller.abort(), 15_000)
  const flight = (async () => {
    try {
      if (notificationNeedsDrain) {
        await managerApi.notificationOverview(controller.signal)
        if (generation !== notificationGeneration) return
        notificationNeedsDrain = false
      }
      const response = await managerApi.notificationOverview(controller.signal)
      if (generation !== notificationGeneration || !notificationPageActive || !notificationPreference.enabled()) return
      notificationError.value = ""
      for (const event of pendingTracker.observe(response.notifications ?? response.instances)) {
        if (generation !== notificationGeneration || !notificationPageActive || !notificationPreference.enabled()) break
        const title = t("notification.title")
        const body = t("notification.body", { id: event.instanceId, count: number(event.count) })
        const url = `${window.location.origin}/#instance=${encodeURIComponent(event.instanceId)}`
        try {
          if (notificationRegistration) {
            await notificationRegistration.showNotification(title, { body, data: { url }, tag: `omw-${event.instanceId}` })
          } else {
            const notice = new Notification(title, { body, tag: `omw-${event.instanceId}` })
            notice.onclick = () => { window.location.hash = `instance=${encodeURIComponent(event.instanceId)}`; window.focus(); notice.close() }
          }
        } catch {
          notificationPreference.fail()
          notificationReady = false
          notificationStatus.value = notificationPreference.status()
          notificationError.value = "notification.displayFailed"
          pendingTracker.reset()
          return
        }
      }
    } catch {
      if (generation !== notificationGeneration) return
      pendingTracker.reset()
      if (controller.signal.aborted) notificationNeedsDrain = true
      notificationError.value = "notification.pollFailed"
    } finally {
      window.clearTimeout(timeout)
    }
  })()
  notificationFlight = flight
  await flight
  if (notificationFlight === flight) notificationFlight = null
  if (notificationController === controller) notificationController = null
  if (notificationQueued) {
    notificationQueued = false
    void pollNotifications()
  }
}

function handleNotificationHash(): void { void revealNotificationTarget(overview.value.instances) }

async function revealNotificationTarget(instances: ManagedInstance[]): Promise<void> {
  const id = new URLSearchParams(window.location.hash.slice(1)).get("instance")
  if (!id || !overviewLastSucceededAt.value) return
  const target = instances.find((item) => item.id === id)
  if (!target) {
    if (query.value || filter.value !== "all" || !includeHidden.value) {
      query.value = ""
      filter.value = "all"
      includeHidden.value = true
      void loadOverview(false, "background")
    } else if (!overviewStale.value) {
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search)
      showNotice("notice.notificationMissing")
    }
    return
  }
  window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search)
  if (isMobileViewport()) {
    listScrollPosition = window.scrollY
    returnToInstanceId = id
    mobileDetailOpen.value = true
    pushMobileHistory(id)
    void revealSelectedDetail()
  }
  selectedId.value = id
  resetSelectedScope()
  await loadSessions()
}

async function restoreMobileListScroll(): Promise<void> {
  await nextTick()
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())))
  if (mobileHistoryView() === "list") window.scrollTo({ top: listScrollPosition, behavior: "auto" })
}

async function restoreListContext(expectedGeneration?: number): Promise<void> {
  await nextTick()
  if (expectedGeneration !== undefined
    && (expectedGeneration !== mobileHistoryGeneration || mobileHistoryView() === "detail")) return
  window.scrollTo({ top: listScrollPosition, behavior: "auto" })
  const row = returnToInstanceId
    ? document.querySelector<HTMLElement>(`.instance-row[data-instance-id="${CSS.escape(returnToInstanceId)}"]`)
    : null
  const fallback = document.querySelector<HTMLElement>('.search-row input, .instance-list')
  ;(row ?? fallback)?.focus({ preventScroll: true })
}

function handleMobileBreakpointChange(event: MediaQueryListEvent): void {
  if (!event.matches && !selectedId.value && overview.value.instances.length) {
    selectedId.value = overview.value.instances[0]?.id ?? ""
    resetSelectedScope()
    void loadSessions()
  }
  if (event.matches && !mobileHistoryView()) replaceMobileHistory("list")
  syncPrimaryTodos()
  void nextTick(() => {
    const active = document.activeElement as HTMLElement | null
    if (!active || active.getClientRects().length > 0) return
    if (event.matches && mobileDetailOpen.value) detailPane.value?.focus({ preventScroll: true })
    else document.querySelector<HTMLElement>('.search-row input')?.focus({ preventScroll: true })
  })
}

function isMobileViewport(): boolean {
  return mobileBreakpoint?.matches ?? window.matchMedia("(max-width: 860px)").matches
}

function toggleHistory(): void {
  const next = new Set(historyOpen.value)
  if (next.has(STOPPED_HISTORY_KEY)) next.delete(STOPPED_HISTORY_KEY)
  else next.add(STOPPED_HISTORY_KEY)
  historyOpen.value = next
  if (historyExpanded()) void stoppedHistory.load()
  persistMobileListHistory()
}

function historyExpanded(): boolean {
  return historyOpen.value.has(STOPPED_HISTORY_KEY)
}

watch(includeHidden, (hidden) => {
  stoppedHistory.scope(hidden)
  if (historyExpanded()) void stoppedHistory.load()
}, { flush: "sync" })

async function searchHistory(): Promise<void> {
  const submitted = stoppedHistory.submit()
  persistMobileListHistory()
  await submitted
}

async function clearOverviewFilters(): Promise<void> {
  query.value = ""
  filter.value = "all"
  includeHidden.value = false
  await loadOverview(true, "user")
}

async function loadSessions(): Promise<void> {
  const instanceId = selectedId.value
  const generation = ++sessionsGeneration
  if (!instanceId) {
    sessionsInstanceId = ""
    sessions.value = { roots: [], unknownParent: [] }
    sessionsLoaded.value = false
    sessionsError.value = ""
    sessionPage.value = 1
    sessionsLoading.value = false
    return
  }
  if (sessionsInstanceId !== instanceId) {
    sessionsInstanceId = instanceId
    sessions.value = { roots: [], unknownParent: [] }
    sessionsLoaded.value = false
    sessionsError.value = ""
    sessionPage.value = 1
  }
  sessionsLoading.value = true
  sessionsError.value = ""
  try {
    const next = await managerApi.sessions(instanceId)
    if (generation !== sessionsGeneration || selectedId.value !== instanceId) return
    sessions.value = next
    sessionPage.value = Math.min(sessionPage.value, Math.max(1, Math.ceil(next.roots.length / SESSION_PAGE_SIZE)))
    sessionsLoaded.value = true
  } catch (cause) {
    if (generation !== sessionsGeneration || selectedId.value !== instanceId) return
    sessions.value = { roots: [], unknownParent: [] }
    sessionsLoaded.value = true
    sessionsError.value = message(cause, "sessions")
    sessionPage.value = 1
  } finally {
    if (generation === sessionsGeneration && selectedId.value === instanceId) sessionsLoading.value = false
  }
}

async function setFilter(value: OverviewFilter): Promise<void> {
  filter.value = value
  await loadOverview(true, "user")
}

function editShortcut(shortcut: DirectoryShortcut): void {
  shortcutId.value = shortcut.id
  shortcutName.value = shortcut.name
  shortcutDirectory.value = shortcut.directory
}

function clearShortcutForm(): void {
  shortcutId.value = null
  shortcutName.value = ""
  shortcutDirectory.value = ""
}

async function saveShortcut(): Promise<void> {
  await mutate(async () => {
    const payload = { name: shortcutName.value, directory: shortcutDirectory.value }
    if (shortcutId.value) await managerApi.updateShortcut(shortcutId.value, payload)
    else await managerApi.createShortcut(payload)
    clearShortcutForm()
    showNotice("notice.shortcutSaved")
    await refreshAfterMutation()
  })
}

function removeShortcut(shortcut: DirectoryShortcut): void {
  requestConfirmation({
    titleKey: "confirm.shortcutRemoveTitle",
    descriptionKey: "confirm.shortcutRemoveDescription",
    descriptionParams: { name: shortcut.name },
    confirmLabelKey: "confirm.shortcutRemoveAction",
    tone: "danger",
    accept: () => deleteShortcut(shortcut),
  })
}

async function deleteShortcut(shortcut: DirectoryShortcut): Promise<void> {
  await mutate(async () => {
    await managerApi.deleteShortcut(shortcut.id)
    showNotice("notice.shortcutRemoved")
    await refreshAfterMutation()
  })
}

async function browse(directory: string): Promise<void> {
  const generation = ++browseGeneration
  browserPath.value = directory
  listing.value = null
  browseError.value = ""
  browsingPath.value = directory
  try {
    const result = await managerApi.browse(directory)
    if (generation !== browseGeneration) return
    listing.value = result
    browserPath.value = result.current
  } catch (cause) {
    if (generation === browseGeneration) browseError.value = message(cause, "browse")
  } finally {
    if (generation === browseGeneration) browsingPath.value = ""
  }
}

function updateBrowserPath(value: string): void {
  browserPath.value = value
  if (value !== listing.value?.current) {
    // 輸入一旦離開已確認的目錄，舊 listing 與在途回應都不能再提供啟動目標。
    browseGeneration++
    listing.value = null
    browsingPath.value = ""
    browseError.value = ""
  }
}

async function start(directory: string): Promise<void> {
  if (browsingPath.value || !listing.value || browserPath.value !== listing.value.current || directory !== listing.value.current) return
  await mutate(async () => {
    if (!await ensureInstanceCapacity("action")) return
    const instance = await managerApi.start(directory)
    await selectNewInstance(instance)
    lifecycleError.value = ""
    showNotice(instance.state === "ready" ? "notice.started" : "notice.startedUnreachable", { id: shortId(instance.id) })
    revealDetailAfterStartPanelClose = true
    closeStartPanel(false, true)
  })
}

async function selectNewInstance(target: ManagedInstance | string): Promise<boolean> {
  const instanceId = typeof target === "string" ? target : target.id
  query.value = ""
  filter.value = "all"
  await refreshAfterMutation()

  let instance = overview.value.instances.find((item) => item.id === instanceId)
  if (!instance && typeof target !== "string") {
    replaceInstance(target)
    instance = target
  }
  if (!instance) return false

  selectedId.value = instanceId
  mobileDetailOpen.value = true
  if (isMobileViewport()) pushMobileHistory(instanceId)
  resetSelectedScope()
  await loadSessions()
  return true
}

function stopInstance(instance: ManagedInstance): void {
  requestConfirmation({
    titleKey: "confirm.stopTitle",
    descriptionKey: "confirm.stopDescription",
    descriptionParams: { id: shortId(instance.id) },
    confirmLabelKey: "confirm.stopAction",
    tone: "danger",
    requiresFreshOverview: true,
    accept: () => performStopInstance(instance),
  })
}

async function performStopInstance(instance: ManagedInstance): Promise<void> {
  await lifecycleMutation("stop", async () => {
    replaceInstance(await managerApi.stop(instance.id))
    showNotice("notice.stopped")
    await refreshAfterMutation()
  })
}

function startFreshInstance(instance: ManagedInstance): void {
  requestConfirmation({
    titleKey: "confirm.startTitle",
    descriptionKey: "confirm.startDescription",
    confirmLabelKey: "confirm.startAction",
    tone: "positive",
    requiresFreshOverview: true,
    accept: () => performFreshStart(instance),
  })
}

async function performFreshStart(instance: ManagedInstance): Promise<void> {
  await lifecycleMutation("start", async () => {
    if (!await ensureInstanceCapacity("lifecycle")) return
    const started = await managerApi.start(instance.projectDirectory)
    await selectNewInstance(started)
    showNotice("notice.freshStart", { id: shortId(started.id) })
  })
}

async function recheckInstance(instance: ManagedInstance): Promise<void> {
  await lifecycleMutation("recheck", async () => {
    replaceInstance(await managerApi.recheck(instance.id))
    showNotice("notice.rechecked")
    await refreshAfterMutation()
  })
}

function resumeInstance(instance: ManagedInstance): void {
  requestConfirmation({
    titleKey: "confirm.resumeTitle",
    descriptionKey: "confirm.resumeDescription",
    confirmLabelKey: "confirm.resumeAction",
    tone: "positive",
    requiresFreshOverview: true,
    accept: () => performResumeInstance(instance),
  })
}

async function performResumeInstance(instance: ManagedInstance): Promise<void> {
  await lifecycleMutation("resume", async () => {
    if (!await ensureInstanceCapacity("lifecycle")) return
    const resumed = await managerApi.resume(instance.id)
    await selectNewInstance(resumed)
    showNotice("notice.resumed", { id: shortId(resumed.id) })
  }, async (cause) => {
    const newInstanceId = errorNewInstanceId(cause)
    if (!newInstanceId) return message(cause, "lifecycle")
    const visible = await selectNewInstance(newInstanceId)
    if (visible) {
      return localError("lifecycle", "notice.resumePartial", { id: shortId(newInstanceId) })
    }
    return localError("lifecycle", "notice.resumePartialNotVisible", { id: shortId(newInstanceId) })
  })
}

async function setInstanceTracking(instance: ManagedInstance, hidden: boolean): Promise<void> {
  await lifecycleMutation("tracking", async () => {
    replaceInstance(await managerApi.setTracking(instance.id, hidden))
    showNotice(hidden ? "notice.hidden" : "notice.restored")
    if (hidden && selectedId.value === instance.id && isMobileViewport()) {
      selectedId.value = ""
      resetSelectedScope()
      mobileDetailOpen.value = false
      replaceMobileHistory("list")
    }
    await refreshAfterMutation()
  })
}

function removeInstance(instance: ManagedInstance): void {
  requestConfirmation({
    titleKey: "confirm.removeTitle",
    descriptionKey: "confirm.removeDescription",
    descriptionParams: { id: shortId(instance.id) },
    confirmLabelKey: "confirm.removeAction",
    tone: "danger",
    requiresFreshOverview: true,
    accept: () => performRemoveInstance(instance),
  })
}

async function performRemoveInstance(instance: ManagedInstance): Promise<void> {
  await lifecycleMutation("remove", async () => {
    await managerApi.remove(instance.id)
    const removedSelection = selectedId.value === instance.id
    if (removedSelection) {
      selectedId.value = ""
      resetSelectedScope()
      if (isMobileViewport()) {
        mobileDetailOpen.value = false
        replaceMobileHistory("list")
      }
    }
    showNotice("notice.removed")
    await refreshAfterMutation()
    if (removedSelection && isMobileViewport()) await restoreListContext()
  })
}

async function lifecycleMutation(
  action: LifecycleAction,
  operation: () => Promise<void>,
  onError?: (cause: unknown) => Promise<string>,
): Promise<void> {
  if (lifecyclePending.value) return
  if (!ensureFreshOverviewMutation("lifecycle")) return
  invalidateOverview()
  beginUserAction()
  lifecycleError.value = ""
  lifecyclePending.value = action
  try {
    await operation()
  } catch (cause) {
    lifecycleError.value = onError ? await onError(cause) : message(cause, "lifecycle")
  } finally {
    lifecyclePending.value = null
  }
}

function replaceInstance(instance: ManagedInstance): void {
  const existingIndex = overview.value.instances.findIndex((item) => item.id === instance.id)
  const instances = [...overview.value.instances]
  if (existingIndex === -1) instances.push(instance)
  else instances.splice(existingIndex, 1, instance)
  overview.value = { ...overview.value, instances }
}

function resetSelectedScope(): void {
  sessionsGeneration++
  sessionsInstanceId = ""
  sessions.value = { roots: [], unknownParent: [] }
  sessionsLoaded.value = false
  sessionsError.value = ""
  sessionPage.value = 1
}

async function openWithPopup(
  instance: ManagedInstance,
  request: () => Promise<OpenUrlResponse>,
  expectedSessionId?: string,
): Promise<OpenUrlResponse> {
  if (opening.value) throw new LocalError("popup.busy")
  const instanceId = instance.id
  // 必須在 click 的 user activation 內、任何 await 之前取得 handle，否則瀏覽器可能封鎖延遲開啟的分頁。
  const popup = window.open("about:blank", "_blank")
  if (!popup) throw new LocalError("popup.blocked")

  opening.value = true
  try {
    popup.opener = null
    const referrerPolicy = popup.document.createElement("meta")
    referrerPolicy.name = "referrer"
    referrerPolicy.content = "no-referrer"
    popup.document.head.append(referrerPolicy)
    popup.document.title = t("popup.connecting")
    if (expectedSessionId && expectedSessionId === instance.primarySession?.sessionId) {
      renderSessionWaiting(popup.document, instance, expectedSessionId, t)
    } else {
      popup.document.body.textContent = t("popup.connectingWeb")
    }

    const response = await request()
    const sessionMatches = expectedSessionId === undefined
      ? typeof response.sessionId === "string" && response.sessionId.length > 0
      : response.sessionId === expectedSessionId
    if (response.instanceId !== instanceId || !sessionMatches) {
      throw new LocalError("popup.mismatch")
    }
    const destination = new URL(response.url)
    if ((destination.protocol !== "http:" && destination.protocol !== "https:") || destination.username || destination.password) {
      throw new LocalError("popup.unsafe")
    }
    popup.location.replace(destination.href)
    // New Session 建立並開啟的頁也能由進入主 Session 重用；只有通過回應驗證的頁才登記。
    sessionTabs.set(JSON.stringify([instanceId, response.sessionId]), popup)
    return response
  } catch (cause) {
    if (!popup.closed) popup.close()
    throw cause
  } finally {
    opening.value = false
  }
}

async function openWeb(instance: ManagedInstance, sessionId: string): Promise<void> {
  beginUserAction()
  try {
    await openWithPopup(instance, () => managerApi.openUrl(instance.id, sessionId), sessionId)
  } catch (cause) {
    actionError.value = message(cause, "action")
  }
}

async function openPrimarySession(instance: ManagedInstance): Promise<void> {
  if (!instance.primarySession) return
  const sessionId = instance.primarySession.sessionId
  // Session metadata 可跨 Instance 共用，分頁只能依實際綁定的 Instance + Session 重用。
  const key = JSON.stringify([instance.id, sessionId])
  const existing = sessionTabs.get(key)
  if (existing && !existing.closed) {
    beginUserAction()
    if (opening.value) {
      actionError.value = "已有連線請求正在進行中。"
      return
    }
    // 只依 Manager 的 binding 識別目標；跨來源下無法得知使用者是否在 OpenCode 分頁內自行切換 Session。
    existing.focus()
    return
  }
  sessionTabs.delete(key)
  await openWeb(instance, sessionId)
}

async function refreshSelectedInstance(instanceId: string): Promise<void> {
  await refreshAfterMutation()
  if (selectedId.value === instanceId) await loadSessions()
}

function openNewSession(instance: ManagedInstance): void {
  requestConfirmation({
    titleKey: "confirm.createTitle",
    descriptionKey: "confirm.createDescription",
    confirmLabelKey: "confirm.createAction",
    tone: "caution",
    requiresFreshOverview: true,
    freshnessErrorTarget: "action",
    accept: () => createNewSession(instance),
  })
}

async function createNewSession(instance: ManagedInstance): Promise<void> {
  if (!ensureFreshOverviewMutation("action")) return
  invalidateOverview()
  beginUserAction()
  try {
    const response = await openWithPopup(instance, () => managerApi.createSession(instance.id))
    await refreshSelectedInstance(instance.id)
    showNotice("notice.newSession", { id: shortId(response.sessionId ?? "") })
  } catch (cause) {
    if (cause instanceof ApiError && cause.code === "SESSION_CREATED_URL_FAILED") {
      const createdSessionId = errorSessionId(cause.details)
      await refreshSelectedInstance(instance.id)
      actionError.value = createdSessionId
        ? localError("action", "notice.sessionCreatedUrlFailed", { id: createdSessionId })
        : message(cause, "action")
      return
    }
    actionError.value = message(cause, "action")
  }
}

function selectPrimarySession(instance: ManagedInstance, session: SessionMetadata): void {
  requestConfirmation({
    titleKey: "confirm.switchTitle",
    descriptionKey: "confirm.switchDescription",
    descriptionParams: { title: session.title, id: session.id },
    confirmLabelKey: "confirm.switchAction",
    tone: "caution",
    requiresFreshOverview: true,
    freshnessErrorTarget: "action",
    accept: () => performSelectPrimarySession(instance, session.id),
  })
}

async function performSelectPrimarySession(instance: ManagedInstance, sessionId: string): Promise<void> {
  if (!ensureFreshOverviewMutation("action")) return
  invalidateOverview()
  beginUserAction()
  switchingSessionId.value = sessionId
  try {
    const response = await managerApi.selectPrimarySession(instance.id, sessionId)
    if (response.instanceId !== instance.id || response.sessionId !== sessionId) throw new Error(t("session.bindingMismatch"))
    await refreshSelectedInstance(instance.id)
    showNotice("notice.switchPrimary", { id: shortId(sessionId) })
  } catch (cause) {
    actionError.value = message(cause, "action")
  } finally {
    switchingSessionId.value = ""
  }
}

function compareSessionMetadata(left: SessionMetadata, right: SessionMetadata): number {
  const leftUpdatedAt = typeof left.updatedAt === "number" && Number.isFinite(left.updatedAt) ? left.updatedAt : null
  const rightUpdatedAt = typeof right.updatedAt === "number" && Number.isFinite(right.updatedAt) ? right.updatedAt : null
  if (leftUpdatedAt !== null && rightUpdatedAt !== null) {
    if (leftUpdatedAt !== rightUpdatedAt) return rightUpdatedAt - leftUpdatedAt
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  }
  if (leftUpdatedAt !== null) return -1
  if (rightUpdatedAt !== null) return 1
  // 同時間與缺漏時間都用 id 收斂，避免 reload 因 API 回傳順序不同而讓 Session 在頁面間跳動。
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

function requestConfirmation(request: ConfirmationRequest): void {
  if (confirmation.value || confirmationAccepting.value) return
  beginUserAction()
  confirmationReturnFocus.value = document.activeElement instanceof HTMLElement ? document.activeElement : null
  confirmationDisplay.value = request
  confirmationClosing = false
  confirmationLeaveCompleted = false
  confirmation.value = request
}

function closeConfirmation(): void {
  confirmationClosing = true
  confirmation.value = null
}

function setConfirmationOpen(open: boolean): void {
  if (!open && !confirmationAccepting.value) closeConfirmation()
}

async function acceptConfirmation(): Promise<void> {
  const request = confirmation.value
  if (!request || confirmationAccepting.value) return
  if (request.requiresFreshOverview && !ensureFreshOverviewMutation(request.freshnessErrorTarget)) {
    closeConfirmation()
    return
  }
  confirmationAccepting.value = true
  closeConfirmation()
  try {
    // Invoke before yielding so popup actions retain the confirmation click's user activation.
    await request.accept()
  } finally {
    confirmationAccepting.value = false
    restoreConfirmationFocus()
    if (confirmationLeaveCompleted && !confirmation.value) {
      confirmationDisplay.value = null
      confirmationClosing = false
    }
  }
}

function finishConfirmationLeave(): void {
  if (!confirmationClosing) return
  confirmationLeaveCompleted = true
  if (!confirmationAccepting.value && !confirmation.value) {
    confirmationDisplay.value = null
    confirmationClosing = false
  }
}

function restoreConfirmationFocus(): void {
  // Dialog 已正常還原焦點或使用者已移往其他控制項時，不因 API 完成再次搶走焦點。
  const current = document.activeElement
  if (current instanceof HTMLElement && current !== document.body && current.isConnected
    && !current.matches(":disabled") && !current.closest("[inert]")) return
  const fallback = confirmationFallbackFocus()
  const requested = confirmationReturnFocus.value
  const globalFallback = document.querySelector<HTMLElement>("[data-dialog-focus-fallback]")
  const target = [requested, fallback, globalFallback].find((element): element is HTMLElement => Boolean(
    element?.isConnected
    && !element.matches(":disabled, [aria-disabled=\"true\"]")
    && !element.closest("[inert]")
    && !element.hidden
    && element.getClientRects().length > 0,
  ))
  target?.focus({ preventScroll: true })
}

function confirmationFallbackFocus(): HTMLElement | null {
  if (!startPanelBlocking.value || startPanelClosing.value || !startPanel.value) return null
  const shortcutNameInput = startPanel.value.querySelector<HTMLElement>('.shortcut-form input:not([disabled])')
  if (shortcutNameInput && !shortcutNameInput.hidden && shortcutNameInput.getClientRects().length > 0) return shortcutNameInput
  return Array.from(startPanel.value.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
  )).find((element) => !element.hidden && element.getClientRects().length > 0) ?? null
}

async function mutate(operation: () => Promise<void>): Promise<void> {
  beginUserAction()
  invalidateOverview()
  mutating.value = true
  try {
    await operation()
  } catch (cause) {
    actionError.value = message(cause, "action")
  } finally {
    mutating.value = false
  }
}

function openManagerSettings(): void {
  cancelSwipe()
  beginUserAction()
  managerSettingsReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  managerSettingsBodyOverflow = document.body.style.overflow
  document.body.style.overflow = "hidden"
  managerSettingsError.value = ""
  managerSettingsSuccess.value = ""
  currentManagerPassword.value = ""
  nextManagerPassword.value = ""
  confirmManagerPassword.value = ""
  managerSettingsOpen.value = true
  void nextTick(() => {
    const dialog = managerSettingsDialog.value
    const initialFocus = dialog?.querySelector<HTMLElement>('input[autocomplete="username"]')
      ?? dialog?.querySelector<HTMLElement>('input[type="checkbox"]:not([disabled]), button:not([disabled])')
    initialFocus?.focus()
  })
}

function closeManagerSettings(force = false): void {
  if (!managerSettingsOpen.value || (managerSettingsBusy.value && !force)) return
  cancelSwipe()
  managerSettingsSuccess.value = ""
  managerSettingsOpen.value = false
  document.body.style.overflow = managerSettingsBodyOverflow
  const target = managerSettingsReturnFocus
  void nextTick(() => {
    if (target?.isConnected && !target.closest("[inert]")) target.focus({ preventScroll: true })
  })
}

async function updateManagerCredentials(): Promise<void> {
  if (!credentialUpdateSupported.value) return
  managerSettingsError.value = ""
  managerSettingsSuccess.value = ""
  if (nextManagerPassword.value !== confirmManagerPassword.value) {
    managerSettingsError.value = localError("settings", "settings.passwordMismatch")
    return
  }
  managerSettingsBusy.value = true
  try {
    await managerApi.updateCredentials({
      currentPassword: currentManagerPassword.value,
      username: managerUsername.value,
      password: nextManagerPassword.value,
    })
    currentManagerPassword.value = ""
    nextManagerPassword.value = ""
    confirmManagerPassword.value = ""
    managerSettingsSuccess.value = "settings.updated"
    showNotice(managerSettingsSuccess.value)
  } catch (cause) {
    managerSettingsError.value = message(cause, "settings")
  } finally {
    managerSettingsBusy.value = false
  }
}

function stopManager(): void {
  if (!managerShutdownSupported.value) return
  requestConfirmation({
    titleKey: "confirm.stopManagerTitle",
    descriptionKey: "confirm.stopManagerDescription",
    confirmLabelKey: "confirm.stopManagerAction",
    tone: "danger",
    accept: performStopManager,
  })
}

async function performStopManager(): Promise<void> {
  beginUserAction()
  managerSettingsBusy.value = true
  try {
    await managerApi.shutdown()
    window.clearInterval(pollTimer)
    window.clearInterval(connectivityPollTimer)
    suspendNotifications()
    closeManagerSettings(true)
    managerStopped.value = true
  } catch (cause) {
    managerSettingsError.value = message(cause, "settings")
  } finally {
    managerSettingsBusy.value = false
  }
}

function beginUserAction(): void {
  actionError.value = ""
  errorDetails.action = null
  clearNotice()
}

function showNotice(key: MessageKey, params?: Record<string, string | number>): void {
  if (activeSwipe?.kind === "notice") cancelSwipe()
  window.clearTimeout(noticeTimer)
  notice.value = { key, ...(params ? { params } : {}) }
  noticeTimer = window.setTimeout(() => { notice.value = null }, 6_000)
}

function clearNotice(): void {
  if (activeSwipe?.kind === "notice") cancelSwipe()
  window.clearTimeout(noticeTimer)
  notice.value = null
}

watch(actionError, () => {
  if (activeSwipe?.kind === "error") cancelSwipe()
})

function openStartPanel(): void {
  cancelSwipe()
  beginUserAction()
  if (!startPanelBlocking.value) {
    returnFocusElement = document.activeElement instanceof HTMLElement ? document.activeElement : null
    previousBodyOverflow = document.body.style.overflow
  }
  startPanelMotion.value = currentStartPanelMotion()
  startPanelClosing.value = false
  startPanelBlocking.value = true
  document.body.style.overflow = "hidden"
  startPanelOpen.value = true
  void nextTick(() => {
    const initialFocus = startPanel.value?.querySelector<HTMLElement>(".shortcut-form input")
      ?? startPanel.value?.querySelector<HTMLElement>(".start-panel-head button")
    initialFocus?.focus()
  })
}

function closeStartPanel(restoreFocus = true, force = false): void {
  if ((mutating.value && !force) || startPanelClosing.value) return
  cancelSwipe()
  startPanelMotion.value = currentStartPanelMotion()
  restoreFocusAfterStartPanelClose = restoreFocus
  startPanelClosing.value = true
  // Apply inert before Vue starts the leave transition so the retained DOM cannot submit again.
  void nextTick(() => {
    if (startPanelClosing.value) startPanelOpen.value = false
  })
}

function finishStartPanelClose(): void {
  if (startPanelOpen.value) return
  const focusTarget = restoreFocusAfterStartPanelClose ? returnFocusElement : null
  const shouldRevealDetail = revealDetailAfterStartPanelClose
  startPanelClosing.value = false
  startPanelBlocking.value = false
  revealDetailAfterStartPanelClose = false
  document.body.style.overflow = previousBodyOverflow
  void nextTick(() => {
    if (focusTarget) focusTarget.focus()
    else if (shouldRevealDetail) void revealSelectedDetail()
  })
}

function cancelStartPanelClose(): void {
  startPanelClosing.value = false
  startPanelBlocking.value = true
}

function currentStartPanelMotion(): "pointer" | "reduced" | "none" {
  if (inputModality !== "pointer") return "none"
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "reduced" : "pointer"
}

function handleDocumentPointerdown(event: PointerEvent): void {
  inputModality = "pointer"
  // 新的 pointerdown 一定屬於下一次操作；不可沿用上一個滑動留下的合成 click 防護。
  clearSwipeClickGuard?.()
  // 第二指落在遮罩時，原本的 backdrop 關閉事件不得搶在 pointercancel 前關閉面板。
  suppressMultitouchBackdropClick = event.pointerType === "touch" && !event.isPrimary
}

function handleStartBackdropPointerdown(event: PointerEvent): void {
  if (event.pointerType === "touch" && !event.isPrimary) return
  closeStartPanel()
}

function handleSettingsBackdropClick(): void {
  if (!suppressMultitouchBackdropClick) closeManagerSettings()
}

function cancelSwipeOnSecondPointer(event: PointerEvent): void {
  if (activeSwipe && event.pointerId !== activeSwipe.id) cancelSwipe()
}

function setSwipeDrag(kind: SwipeKind, distance: number): void {
  if (kind === "panel") panelDrag.value = distance
  else if (kind === "settings") settingsDrag.value = distance
  else if (kind === "notice") noticeDrag.value = distance
  else errorDrag.value = distance
}

function cancelSwipe(): void {
  if (!activeSwipe) return
  const { kind, id, target } = activeSwipe
  swipes[kind].cancel()
  if (target.hasPointerCapture(id)) target.releasePointerCapture(id)
  setSwipeDrag(kind, 0)
  activeSwipe = null
}

function startSwipe(event: PointerEvent, kind: SwipeKind): void {
  if (event.pointerType !== "touch" || !event.isPrimary || activeSwipe
    || (kind === "panel" && (!isMobileViewport() || mutating.value || startPanelClosing.value))
    || (kind === "settings" && (!isMobileViewport() || managerSettingsBusy.value))
    || ((kind === "notice" || kind === "error") && (managerSettingsOpen.value || (event.target as Element).closest("button")))) return
  const target = event.currentTarget as HTMLElement
  if (!swipes[kind].start(event.pointerId, event.clientX, event.clientY)) return
  activeSwipe = { kind, id: event.pointerId, x: event.clientX, y: event.clientY, target }
  target.setPointerCapture(event.pointerId)
}

function moveSwipe(event: PointerEvent, kind: SwipeKind): void {
  if (activeSwipe?.kind !== kind || activeSwipe.id !== event.pointerId) return
  setSwipeDrag(kind, swipes[kind].move(event.pointerId, event.clientX, event.clientY))
}

function endSwipe(event: PointerEvent, kind: SwipeKind): void {
  if (activeSwipe?.kind !== kind || activeSwipe.id !== event.pointerId) return
  const { x, y } = activeSwipe
  const dismiss = swipes[kind].end(event.pointerId, event.clientX, event.clientY)
  cancelSwipe()
  if (!dismiss) return
  // 觸控合成 click 可能在 pointerup 後才送到已卸載的通知下方；只擋這次 click。
  const blockClick = (click: MouseEvent) => {
    if (click instanceof PointerEvent) {
      if (click.pointerType !== "touch" || click.pointerId !== event.pointerId) return
    } else {
      const nearStart = Math.abs(click.clientX - x) <= 24 && Math.abs(click.clientY - y) <= 24
      const nearEnd = Math.abs(click.clientX - event.clientX) <= 24 && Math.abs(click.clientY - event.clientY) <= 24
      if (!nearStart && !nearEnd) return
    }
    click.preventDefault()
    click.stopImmediatePropagation()
    clear()
  }
  let timer: number
  const clear = () => {
    document.removeEventListener("click", blockClick, true)
    window.clearTimeout(timer)
    if (clearSwipeClickGuard === clear) clearSwipeClickGuard = null
  }
  clearSwipeClickGuard?.()
  clearSwipeClickGuard = clear
  document.addEventListener("click", blockClick, true)
  timer = window.setTimeout(clear, 350)
  if (kind === "panel") closeStartPanel()
  else if (kind === "settings") closeManagerSettings()
  else if (kind === "notice") clearNotice()
  else actionError.value = ""
}

function trapStartPanelFocus(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault()
    closeStartPanel()
    return
  }
  if (event.key !== "Tab" || !startPanel.value) return
  const focusable = Array.from(startPanel.value.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
  )).filter((element) => !element.hidden && element.getClientRects().length > 0)
  if (!focusable.length) return
  const first = focusable[0]
  const last = focusable.at(-1)
  if (!startPanel.value.contains(document.activeElement)) {
    event.preventDefault()
    first?.focus()
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first?.focus()
  }
}

function handleDocumentKeydown(event: KeyboardEvent): void {
  inputModality = "keyboard"
  if (confirmation.value) return
  if (managerSettingsOpen.value) {
    if (event.key === "Escape") {
      event.preventDefault()
      closeManagerSettings()
    } else if (event.key === "Tab" && managerSettingsDialog.value) {
      const focusable = Array.from(managerSettingsDialog.value.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )).filter((element) => !element.hidden && element.getClientRects().length > 0)
      const first = focusable[0]
      const last = focusable.at(-1)
      if (first && last && (!managerSettingsDialog.value.contains(document.activeElement)
        || (event.shiftKey && document.activeElement === first)
        || (!event.shiftKey && document.activeElement === last))) {
        event.preventDefault()
        if (event.shiftKey && managerSettingsDialog.value.contains(document.activeElement)) last.focus()
        else first.focus()
      }
    }
    return
  }
  if (startPanelOpen.value) trapStartPanelFocus(event)
}

async function revealSelectedDetail(expectedGeneration?: number, expectedInstanceId?: string): Promise<void> {
  await nextTick()
  if (expectedGeneration !== undefined
    && (expectedGeneration !== mobileHistoryGeneration
      || mobileHistoryView() !== "detail"
      || mobileHistoryInstanceId() !== expectedInstanceId)) return
  if (!detailPane.value) return
  detailPane.value.focus({ preventScroll: true })
  if (isMobileViewport()) window.scrollTo({ top: 0, behavior: "auto" })
}

function statusCategory(instance: ManagedInstance): InstanceStatusCategory {
  if (instance.state === "stopped") return "stopped"
  if (instance.state === "failed" || instance.state === "unreachable") return "unknown"
  if (instance.state !== "ready") return "unknown"
  const disposition = primarySessionDisposition(instance.primarySummary)
  if (disposition === "attention") return "attention"
  return disposition === "unknown" ? "unknown" : "operable"
}

function statusCategoryLabel(instance: ManagedInstance): string {
  return { operable: t("state.operable"), attention: t("state.attention"), unknown: t("state.unknown"), stopped: t("state.stopped") }[statusCategory(instance)]
}

function attentionSummary(instance: ManagedInstance): string {
  if (instance.primarySummary.scope === "unbound") return t("session.unboundAttention")
  const items: string[] = []
  if ((instance.primarySummary.pendingQuestions ?? 0) > 0) items.push(t("session.questions", { count: number(instance.primarySummary.pendingQuestions!) }))
  if ((instance.primarySummary.pendingPermissions ?? 0) > 0) items.push(t("session.permissions", { count: number(instance.primarySummary.pendingPermissions!) }))
  return items.length ? t("session.attention", { items: items.join("、") }) : t("session.noActive")
}

function statusHeadline(instance: ManagedInstance): string {
  if (instance.state === "stopped") return t("state.stopped")
  if (instance.state === "starting" || instance.state === "failed" || instance.state === "unreachable") {
    return t("session.unknownState", { state: stateLabel(instance.state) })
  }
  if (statusCategory(instance) === "attention") return attentionSummary(instance)
  const disposition = primarySessionDisposition(instance.primarySummary)
  if (disposition === "unknown") {
    return t(instance.primarySummary.scope === "unknown" ? "session.unknownScope" : "session.unknownActivity")
  }
  return t(disposition === "retry" ? "state.retry" : "state.working")
}

function stateLabel(state: ManagedInstance["state"]): string {
  return { starting: t("state.starting"), ready: t("state.ready"), failed: t("state.failed"), unreachable: t("state.unreachable"), stopped: t("state.stopped") }[state]
}
function primarySourceLabel(source: NonNullable<ManagedInstance["primarySession"]>["source"]): string {
  return { activity: t("session.sourceActivity"), "new-session": t("session.sourceNew"), manual: t("session.sourceManual") }[source]
}
function count(value: number | null): string { return value == null ? t("common.unknown") : number(value) }
function safeManagerUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const parsed = new URL(value)
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.search || parsed.hash) return null
    return value
  } catch {
    return null
  }
}
function checkedAtLabel(value: string | undefined): string {
  if (!value) return t("common.unknown")
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? t("common.unknown") : formatDate(date)
}
function managerMappingLabel(value: boolean | null | undefined): string {
  return value === true ? t("settings.matched") : value === false ? t("settings.mismatched") : t("common.unknown")
}
function shortId(value: string): string { return value.slice(0, 8) }
function projectFolderName(directory: string): string {
  const normalized = directory.replace(/[\\/]+$/, "")
  return normalized.split(/[\\/]/).at(-1) || directory
}
function instanceTitle(instance: ManagedInstance): string {
  return instance.primarySession?.title ?? t("session.unbound")
}
function detailTitle(instance: ManagedInstance): string {
  return instance.primarySession?.title ?? projectFolderName(instance.projectDirectory)
}
function instancePid(instance: ManagedInstance): string {
  return instance.pid == null ? t("settings.pidUnknown") : `#${instance.pid}`
}
function instanceRowLabel(instance: ManagedInstance): string {
  const identity = instance.pid == null ? `${instancePid(instance)} · ${shortId(instance.id)}` : instancePid(instance)
  return t("aria.instanceRow", { project: instance.projectName || projectFolderName(instance.projectDirectory), path: instance.projectDirectory, title: instanceTitle(instance), headline: statusHeadline(instance), state: stateLabel(instance.state), identity, selection: selectedId.value === instance.id ? t("aria.selected") : "" })
}
function actionPending(action: LifecycleAction): boolean { return lifecyclePending.value === action }
function ensureFreshOverviewMutation(target: "lifecycle" | "action" = "lifecycle"): boolean {
  if (!overviewMutationsBlocked.value) return true
  if (target === "action") actionError.value = localError("action", "error.stale")
  else lifecycleError.value = localError("lifecycle", "error.stale")
  return false
}
function recoveryActionAllowed(action: RecoveryAction): boolean {
  const recovery = selected.value?.recovery
  const key = recoveryActionKeys[action]
  return recoveryMetadataValid.value && recovery?.[key] === true && (action !== "resume" || !instanceCapacityBlocked.value)
}
async function ensureInstanceCapacity(area: "action" | "lifecycle"): Promise<boolean> {
  if (!workerMode.value) return true
  const state = await loadWorkerCapacity(true)
  if (state === "available") return true
  const key = state === "occupied" ? "worker.capacityFull" : "worker.capacityUnknown"
  if (area === "action") actionError.value = localError(area, key)
  else lifecycleError.value = localError(area, key)
  return false
}
function recoveryActionLabel(instance: ManagedInstance, action: RecoveryAction): string {
  return action === "tracking" && instance.trackingHidden ? t("ui.trackResume") : {
    recheck: t("ui.recheck"), resume: t("ui.resume"), tracking: t("ui.trackStop"), remove: t("ui.remove"),
  }[action]
}
function lifecycleReason(instance: ManagedInstance, action: RecoveryAction): string {
  if (action === "recheck") {
    if (instance.state === "ready") return t("recovery.currentlyReady")
    if (instance.state === "stopped") return t("recovery.stopped")
    return t("recovery.recheckUnavailable")
  }
  if (action === "resume") {
    if (instanceCapacityBlocked.value) return t(workerCapacityMessage.value)
    if (instance.state === "ready") return t("recovery.resumeReady")
    if (!instance.primarySession) return t("session.unboundCannotResume")
    return t("session.stateNotEligible")
  }
  if (action === "tracking") {
    if (instance.state === "ready") return t("recovery.currentlyReady")
    if (instance.state === "stopped") return t(instance.recovery.removeAllowed === false ? "recovery.trackingStopped" : "recovery.useRemove")
    return t("recovery.trackingUnavailable")
  }
  if (instance.state !== "stopped") return t("recovery.notStopped")
  return t("recovery.portReserved")
}
function errorSessionId(details: unknown): string | null {
  if (typeof details !== "object" || details === null || !("sessionId" in details)) return null
  const sessionId = Reflect.get(details, "sessionId")
  return typeof sessionId === "string" && sessionId ? sessionId : null
}
function errorNewInstanceId(cause: unknown): string | null {
  if (!(cause instanceof ApiError) || typeof cause.details !== "object" || cause.details === null || !("newInstanceId" in cause.details)) return null
  const instanceId = Reflect.get(cause.details, "newInstanceId")
  return typeof instanceId === "string" && instanceId ? instanceId : null
}
function message(cause: unknown, area: ErrorArea): string {
  const presented = presentError(cause, t)
  errorDetails[area] = presented
  return presented.summary
}
function localError(area: ErrorArea, key: MessageKey, params?: Record<string, string | number>): string {
  const summary = t(key, params)
  errorDetails[area] = { summary, summaryKey: key, ...(params ? { params } : {}), code: null, diagnostic: null }
  return summary
}
function displayedError(area: ErrorArea, current: string): string {
  const presented = errorDetails[area]
  return presented && current === presented.summary ? t(presented.summaryKey, presented.params) : current
}
</script>

<template>
  <div class="app-root" :data-mobile-view="mobileDetailOpen ? 'detail' : 'list'">
  <div class="shell" :inert="startPanelBlocking || managerSettingsOpen || undefined">
    <header class="topbar">
      <div class="topbar-brand">
        <p class="eyebrow">{{ workerMode ? t('worker.brandEyebrow') : t('ui.eyebrow') }}</p>
        <div class="topbar-title">
          <h1>{{ t('ui.productName') }}</h1>
          <small v-if="connectivity?.manager.version" class="version-chip">{{ connectivity.manager.version }}</small>
        </div>
      </div>
      <div class="topbar-actions">
        <Button variant="success" data-dialog-focus-fallback @click="openStartPanel"><PlusIcon />{{ t('ui.startInstance') }}</Button>
        <Button variant="outline" size="sm" class="no-press-transform" @click="openManagerSettings"><Settings2Icon />{{ t('ui.managerSettings') }}</Button>
        <Button variant="outline" size="sm" class="no-press-transform" :disabled="loading || overviewRefreshing" @click="loadOverview(true, 'user')">
          <RefreshCwIcon />{{ t('common.reload') }}
        </Button>
      </div>
    </header>

    <section v-if="managerStopped" class="manager-stopped" role="status">
      <PowerIcon />
      <div><strong>{{ t('ui.managerStopped') }}</strong><p>{{ t('ui.managerStoppedDescription') }}</p></div>
    </section>

    <section class="connectivity" :data-tone="connectivityTone" :data-mode="connectivityMode" aria-labelledby="connectivity-title" :aria-busy="connectivityLoading">
      <div class="connectivity-status">
        <span class="connectivity-signal"><WifiIcon /></span>
        <div class="connectivity-status-copy">
          <p class="eyebrow">{{ workerMode ? t('worker.connection') : t('connectivity.eyebrow') }}</p>
          <h2 id="connectivity-title">{{ connectivityHeadline }}</h2>
          <p v-if="workerMode" class="connectivity-qualifier">{{ t('worker.description') }}</p>
          <p v-else-if="tailscaleSupported" class="connectivity-qualifier">{{ serveLabel }} · {{ t('ui.tailnetNotice') }}</p>
        </div>
        <Button v-if="canRegisterConnectivity" variant="outline" size="sm" class="connectivity-register no-press-transform" :disabled="connectivityLoading" @click="registerConnectivity">
          <RefreshCwIcon />{{ t('ui.register') }}
        </Button>
        <Button v-if="tailscaleSupported && connectivity?.remoteAccess === 'available'" variant="outline" size="sm" :disabled="connectivityRegistering" @click="remoteEnableOpen = true">{{ t('ui.remoteEnable') }}</Button>
      </div>
      <div v-if="tailscaleSupported" class="connectivity-access">
        <div class="connectivity-entry">
          <span>{{ t('ui.remoteEntry') }}<span v-if="remoteUrl">{{ t('ui.verified') }}</span></span>
          <code :title="remoteUrl ?? undefined">{{ remoteUrl ?? t('ui.remoteNotVerified') }}</code>
        </div>
        <div class="connectivity-actions">
          <Button variant="outline" size="sm" class="no-press-transform" :disabled="!remoteUrl" @click="copyPhoneUrl()"><CopyIcon />{{ t('ui.copyUrl') }}</Button>
          <Button v-if="shareSupported" variant="outline" size="sm" class="no-press-transform" :disabled="!remoteUrl" @click="sharePhoneUrl"><Share2Icon />{{ t('ui.share') }}</Button>
        </div>
      </div>
      <div v-if="connectivityWarnings.length || registrationFailure || connectivityError" class="connectivity-warnings" aria-live="polite">
        <p v-for="warning in connectivityWarnings" :key="warning"><AlertTriangleIcon />{{ warning }}</p>
        <p v-if="tailscaleSupported && registrationFailure"><AlertTriangleIcon /><ErrorDetails :summary="registrationFailure.summary" :code="registrationFailure.code" /></p>
        <p v-if="connectivityError"><AlertTriangleIcon /><ErrorDetails :summary="displayedError('connectivity', connectivityError)" :code="errorDetails.connectivity?.code" :diagnostic="errorDetails.connectivity?.diagnostic" /></p>
      </div>
      <p v-if="tailscaleSupported && connectivity?.remoteAccess === 'disabled'" class="connectivity-warnings">{{ t('ui.remoteDisabled') }}</p>
      <form v-if="tailscaleSupported && remoteEnableOpen" class="credential-form connectivity-warnings" :aria-label="t('ui.confirmRemote')" @submit.prevent="enableRemoteAccess">
        <h3>{{ t('ui.confirmRemote') }}</h3>
        <p>{{ t('ui.remotePrivacy') }}</p>
        <p>{{ t('ui.remoteCredentials') }}</p>
        <label><span>{{ t('ui.currentUsername') }}</span><Input v-model="remoteEnableUsername" autocomplete="username" required :disabled="connectivityRegistering" /></label>
        <label><span>{{ t('ui.currentPassword') }}</span><Input v-model="remoteEnablePassword" type="password" autocomplete="current-password" required :disabled="connectivityRegistering" /></label>
        <p v-if="remoteEnableError" role="alert"><ErrorDetails :summary="displayedError('remote', remoteEnableError)" :code="errorDetails.remote?.code" :diagnostic="errorDetails.remote?.diagnostic" /></p>
        <div class="connectivity-actions">
          <Button type="button" variant="outline" :disabled="connectivityRegistering" @click="cancelRemoteEnable">{{ t('common.cancel') }}</Button>
          <Button type="submit" :disabled="connectivityRegistering">{{ connectivityRegistering ? t('ui.enabling') : t('ui.consent') }}</Button>
        </div>
      </form>
      <div v-if="connectivityFallbackOpen && remoteUrl" ref="connectivityFallback" class="connectivity-copy-fallback" role="status">
        <label for="connectivity-copy-url">{{ connectivityCopyMessage ? t(connectivityCopyMessage) : '' }}</label>
        <Input id="connectivity-copy-url" :model-value="remoteUrl" readonly :aria-label="t('aria.remoteCopy')" @focus="($event.target as HTMLInputElement).select()" />
      </div>
      <details class="connectivity-details">
        <summary>{{ t('ui.connectionDetails') }}</summary>
        <dl>
          <div v-if="!workerMode"><dt>{{ t('ui.localEndpoint') }}</dt><dd><code>{{ localUrl }}</code></dd></div>
          <div v-if="tailscaleSupported"><dt>{{ t('ui.tailscaleVersion') }}</dt><dd><code>{{ connectivity?.tailscale.version ?? t('common.unknown') }}</code></dd></div>
          <div><dt>{{ t('ui.nodeVersion') }}</dt><dd><code>{{ connectivity?.nodeVersion ?? t('common.unknown') }}</code></dd></div>
          <div v-if="tailscaleSupported"><dt>{{ t('ui.serveMatch') }}</dt><dd>{{ managerMappingLabel(connectivity?.serve.managerMapped) }}</dd></div>
          <div v-if="tailscaleSupported"><dt>{{ t('ui.portsMatched') }}</dt><dd><code>{{ connectivity?.serve.mappedInstancePorts ?? t('common.unknown') }} / {{ connectivity?.serve.expectedInstancePorts ?? t('common.unknown') }}</code></dd></div>
          <div><dt>{{ t('ui.checkedAt') }}</dt><dd><time :datetime="connectivity?.checkedAt">{{ checkedAtLabel(connectivity?.checkedAt) }}</time></dd></div>
        </dl>
        <p v-if="tailscaleSupported">{{ t('ui.serveNote') }}</p>
      </details>
    </section>

    <section class="overview-freshness" :data-state="overviewFreshnessState" :aria-label="t('aria.freshness')">
      <AlertTriangleIcon v-if="overviewFreshnessState === 'failed' || overviewFreshnessState === 'unavailable'" />
      <RefreshCwIcon v-else />
      <div :tabindex="overviewError ? 0 : -1">
        <strong v-if="overviewFreshnessState === 'unavailable'">{{ t('ui.overviewUnavailable') }}</strong>
        <strong v-else-if="overviewFreshnessState === 'initial'">{{ t('ui.overviewInitial') }}</strong>
        <strong v-else-if="overviewFreshnessState === 'refreshing'" role="status">{{ t('ui.overviewRefreshing') }}</strong>
        <strong v-else-if="overviewFreshnessState === 'changed'">{{ t('ui.overviewChanged') }}</strong>
        <strong v-else-if="overviewFreshnessState === 'failed'" role="alert">{{ t('ui.overviewFailed') }}</strong>
        <span v-else>{{ t('ui.overviewFresh') }}</span>
        <small v-if="overviewLastSucceededAt"><time :datetime="overviewLastSucceededAt">{{ t('ui.lastSuccess', { time: checkedAtLabel(overviewLastSucceededAt) }) }}</time></small>
        <small v-else-if="overviewError"><ErrorDetails :summary="overviewError" :code="overviewFailure?.code" :diagnostic="overviewFailure?.diagnostic" /></small>
        <small v-if="overviewError && overviewLastSucceededAt"><ErrorDetails :summary="overviewError" :code="overviewFailure?.code" :diagnostic="overviewFailure?.diagnostic" /></small>
      </div>
      <Button variant="outline" size="sm" class="overview-retry no-press-transform" :class="{ 'retry-hidden': !overviewError && overviewFreshnessState !== 'changed' }" :tabindex="overviewError || overviewFreshnessState === 'changed' ? 0 : -1" :disabled="overviewRefreshing || (!overviewError && overviewFreshnessState !== 'changed')" @click="loadOverview(true, 'user')">
        {{ overviewError ? t('ui.retryUpdate') : t('ui.updateData') }}
      </Button>
    </section>

    <section class="workspace">
      <aside class="instance-pane">
        <form class="search-row" @submit.prevent="loadOverview(true, 'user')">
          <Input v-model="query" :placeholder="t('ui.searchPlaceholder')" :aria-label="t('aria.search')" />
          <Button type="submit" variant="outline" size="icon" class="no-press-transform" :aria-label="t('aria.searchAction')"><SearchIcon /></Button>
        </form>
        <div ref="filtersRail" class="filters" role="group" :aria-label="t('aria.filter')" @scroll.passive="updateFilterHints">
          <button v-for="item in filters" :key="item.value" type="button" :class="{ active: filter === item.value }" :aria-pressed="filter === item.value" @click="setFilter(item.value)">{{ item.label }}</button>
        </div>
        <p v-if="filterCanLeft || filterCanRight" class="filter-hint">
          <span v-if="filterCanLeft">{{ t('ui.scrollLeft') }}</span><span v-if="filterCanRight">{{ t('ui.scrollRight') }}</span>
        </p>
        <label class="hidden-toggle">
          <input v-model="includeHidden" type="checkbox" @change="loadOverview(true, 'user')">
          <span>{{ t('ui.includeHidden') }}</span>
        </label>
        <div v-if="loading && !overviewLastSucceededAt" class="loading-copy"><LoaderCircleIcon class="spin" />{{ t('ui.loadingApi') }}</div>
        <div class="instance-list" tabindex="-1">
          <header v-if="overview.instances.length" class="instance-list-heading"><span>{{ t('ui.listHeading') }}</span><b>{{ t('ui.notStopped', { count: number(currentInstances.length) }) }}</b></header>
          <button
            v-for="instance in currentInstances"
            :key="instance.id"
            type="button"
            class="instance-row"
            :class="{ selected: selectedId === instance.id }"
            :data-instance-id="instance.id"
            :aria-label="instanceRowLabel(instance)"
            :aria-current="selectedId === instance.id ? 'true' : undefined"
            @click="choose(instance)"
          >
            <span class="state-dot" :data-category="statusCategory(instance)" />
            <span class="instance-copy">
              <strong :title="instanceTitle(instance)">{{ instanceTitle(instance) }}</strong>
              <small class="instance-path" :title="instance.projectDirectory">{{ projectFolderName(instance.projectDirectory) }} · {{ instance.projectDirectory }}</small>
              <small class="instance-identity">{{ instancePid(instance) }} · {{ shortId(instance.id) }}</small>
            </span>
            <span class="instance-meta"><b :data-category="statusCategory(instance)" :title="statusHeadline(instance)">{{ statusHeadline(instance) }}</b></span>
          </button>
          <section class="stopped-history">
            <button type="button" class="history-toggle" :aria-expanded="historyExpanded()" aria-controls="instance-history" @click="toggleHistory">
              <ChevronDownIcon :class="{ rotated: historyExpanded() }" />{{ overview.history ? t('ui.historyCount', { count: number(overview.history.total) }) : t('history.title') }}
            </button>
            <div v-show="historyExpanded()" id="instance-history" class="history-list" :aria-busy="historyLoading">
              <form class="history-search-row" @submit.prevent="searchHistory">
                <Input v-model="historyQuery" :placeholder="t('history.search')" :aria-label="t('history.searchLabel')" />
                <Button type="submit" variant="outline" size="icon" :aria-label="t('history.searchAction')" :disabled="historyLoading"><SearchIcon /></Button>
              </form>
              <p class="history-status" role="status">
                <template v-if="historyLoading">{{ historyLoaded ? t('history.loadingMore') : t('common.loading') }}</template>
                <template v-else-if="historyLoaded && historyTotal !== null">{{ t('history.progress', { loaded: number(stoppedInstances.length), total: number(historyTotal) }) }}</template>
                <template v-else>{{ t('history.notLoaded') }}</template>
              </p>
              <p v-if="historyLoaded && !stoppedInstances.length && !historyLoading && !historyError" class="history-status">{{ historyAppliedQuery.trim() ? t('history.noMatches') : t('history.empty') }}</p>
              <div v-if="historyError" class="history-status" role="alert"><ErrorDetails :summary="historyError.summary" :code="historyError.code" :diagnostic="historyError.diagnostic" />
                <Button variant="outline" :disabled="historyLoading" @click="stoppedHistory.load(false, true)">{{ t('common.retry') }}</Button>
              </div>
              <button
                v-for="instance in stoppedInstances"
                :key="instance.id"
                type="button"
                class="instance-row stopped-row"
                :class="{ selected: selectedId === instance.id }"
                :data-instance-id="instance.id"
                :aria-label="instanceRowLabel(instance)"
                :aria-current="selectedId === instance.id ? 'true' : undefined"
                @click="choose(instance)"
              >
                <span class="state-dot" :data-category="statusCategory(instance)" />
                <span class="instance-copy">
                  <strong :title="instanceTitle(instance)">{{ instanceTitle(instance) }}</strong>
                  <small class="instance-path" :title="instance.projectDirectory">{{ projectFolderName(instance.projectDirectory) }} · {{ instance.projectDirectory }}</small>
                  <small class="instance-identity">{{ instancePid(instance) }} · {{ shortId(instance.id) }}</small>
                </span>
                <span class="instance-meta"><b :data-category="statusCategory(instance)" :title="statusHeadline(instance)">{{ statusHeadline(instance) }}</b></span>
              </button>
              <div class="history-actions">
                <Button v-if="historyNextOffset !== null" variant="outline" :disabled="historyLoading" @click="stoppedHistory.load(true)">{{ t('history.more') }}</Button>
                <Button variant="ghost" :disabled="historyLoading" @click="stoppedHistory.load(false, true)"><RefreshCwIcon />{{ t('history.refresh') }}</Button>
              </div>
            </div>
          </section>
        </div>
        <div v-if="!loading && !overviewError && overview.instances.length === 0" class="instance-empty">
          <template v-if="appliedQuery.trim() || appliedFilter !== 'all'">
            <p>{{ t('ui.filterEmpty') }}</p>
            <p>{{ t('history.separateSearch') }}</p>
            <Button variant="outline" @click="clearOverviewFilters">{{ t('ui.clearFilter') }}</Button>
          </template>
          <template v-else>
            <p>{{ overview.history?.total ? t('history.noCurrent') : t('ui.noInstances') }}</p>
            <p v-if="overview.history?.total">{{ t('history.separateSearch') }}</p>
            <Button variant="success" @click="openStartPanel"><PlusIcon />{{ t('ui.startInstance') }}</Button>
          </template>
        </div>
      </aside>

      <main ref="detailPane" class="detail-pane" tabindex="-1">
        <template v-if="selected">
          <Button variant="ghost" class="mobile-back no-press-transform" @click="returnToList"><ChevronLeftIcon />{{ t('ui.backToList') }}</Button>
          <div class="detail-head">
            <div>
              <p class="eyebrow">{{ t('ui.projectInstance') }}</p>
              <h2>{{ detailTitle(selected) }}</h2>
              <p v-if="selected.primarySession" class="detail-folder">{{ projectFolderName(selected.projectDirectory) }}</p>
              <p v-else class="detail-unbound">{{ t('session.unbound') }}</p>
              <code class="detail-path">{{ selected.projectDirectory }}</code>
            </div>
            <div class="detail-head-controls">
              <span class="state-chip" :data-category="statusCategory(selected)"><strong>{{ statusCategoryLabel(selected) }}</strong><small>{{ stateLabel(selected.state) }}</small></span>
              <Button
                variant="outline"
                size="sm"
                class="lifecycle-trigger"
                aria-controls="instance-lifecycle-panel"
                :aria-expanded="lifecycleOpen"
                @click="lifecycleOpen = !lifecycleOpen; lifecycleError = ''"
              >
                <Settings2Icon />{{ t('ui.instanceActions') }}<ChevronDownIcon :class="{ rotated: lifecycleOpen }" />
              </Button>
            </div>
          </div>
          <section
            v-if="lifecycleOpen"
            id="instance-lifecycle-panel"
            class="lifecycle-panel"
            aria-labelledby="instance-lifecycle-title"
            :aria-busy="Boolean(lifecyclePending)"
          >
            <div class="lifecycle-copy">
              <p id="instance-lifecycle-title">{{ t('ui.instanceActions') }}</p>
              <span>{{ workerMode ? t('worker.title') : selected.kind === 'local-tui' ? t('ui.localSource') : t('ui.backgroundSource') }} · {{ instancePid(selected) }}</span>
            </div>
            <p class="lifecycle-note">{{ t('ui.resumeNote') }}</p>
            <p v-if="workerMode" class="lifecycle-note" role="status">{{ t(workerCapacityMessage) }}</p>
            <p v-if="recoveryDiagnostic" class="lifecycle-diagnostic" role="alert"><AlertTriangleIcon />{{ recoveryDiagnostic }}</p>
            <div class="lifecycle-actions">
              <Button variant="destructive" size="sm" :disabled="overviewMutationsBlocked || Boolean(lifecyclePending) || !selected.stopAllowed" @click="stopInstance(selected)">
                <CircleStopIcon />{{ actionPending('stop') ? t('ui.stopping') : t('ui.stop') }}
              </Button>
              <Button variant="outline" size="sm" :disabled="overviewMutationsBlocked || Boolean(lifecyclePending) || !recoveryActionAllowed('recheck')" @click="recheckInstance(selected)">
                <RefreshCwIcon :class="{ spin: actionPending('recheck') }" />{{ actionPending('recheck') ? t('ui.rechecking') : t('ui.recheck') }}
              </Button>
              <Button v-if="selected.state === 'stopped' && !selected.primarySession" variant="success" size="sm" :disabled="overviewMutationsBlocked || Boolean(lifecyclePending) || instanceCapacityBlocked" @click="startFreshInstance(selected)">
                <PlayIcon />{{ actionPending('start') ? t('ui.starting') : t('ui.start') }}
              </Button>
              <Button variant="success" size="sm" :disabled="overviewMutationsBlocked || Boolean(lifecyclePending) || !recoveryActionAllowed('resume')" @click="resumeInstance(selected)">
                <PlayIcon />{{ actionPending('resume') ? t('ui.resuming') : t('ui.resume') }}
              </Button>
              <Button variant="outline" size="sm" :disabled="overviewMutationsBlocked || Boolean(lifecyclePending) || !recoveryActionAllowed('tracking')" @click="setInstanceTracking(selected, !selected.trackingHidden)">
                <EyeIcon v-if="selected.trackingHidden" /><EyeOffIcon v-else />{{ actionPending('tracking') ? t('ui.tracking') : selected.trackingHidden ? t('ui.trackResume') : t('ui.trackStop') }}
              </Button>
              <Button variant="outline" size="sm" class="remove-instance-button" :disabled="overviewMutationsBlocked || Boolean(lifecyclePending) || !recoveryActionAllowed('remove')" @click="removeInstance(selected)">
                <Trash2Icon />{{ actionPending('remove') ? t('ui.removing') : t('ui.remove') }}
              </Button>
            </div>
            <p v-if="lifecyclePending" class="lifecycle-reason" role="status">{{ t('ui.unavailableBusy') }}</p>
            <p v-else-if="lifecycleUnavailableReasons.length" class="lifecycle-reason">
              {{ t('ui.unavailableReason') }}<span v-for="item in lifecycleUnavailableReasons" :key="item.label">{{ item.label }}：{{ item.reason }}</span>
            </p>
            <p v-if="lifecycleError" class="lifecycle-error" role="alert"><AlertTriangleIcon /><ErrorDetails :summary="displayedError('lifecycle', lifecycleError)" :code="errorDetails.lifecycle?.code" :diagnostic="errorDetails.lifecycle?.diagnostic" /></p>
          </section>
          <div class="primary-session-card" :class="{ unbound: !selected.primarySession }">
            <span class="primary-session-label">{{ t('session.primaryTitle') }}</span>
            <template v-if="selected.primarySession">
              <strong>{{ selected.primarySession.title }}</strong>
              <code class="primary-session-id">{{ shortId(selected.primarySession.sessionId) }}</code>
              <small>{{ t('session.sourceBinding', { source: primarySourceLabel(selected.primarySession.source) }) }}</small>
            </template>
            <strong v-else>{{ t('session.unbound') }}</strong>
          </div>
          <p v-if="statusCategory(selected) === 'attention'" class="status-attention primary-session-attention"><AlertTriangleIcon />{{ attentionSummary(selected) }}</p>
          <p v-else-if="selected.state === 'ready' && selected.primarySummary.scope === 'unknown'" class="inline-error primary-session-attention"><AlertTriangleIcon />{{ t('session.unknownWorkScope') }}</p>
          <div class="detail-actions primary-actions">
            <a v-if="nativeWebAvailable" class="native-web-link" :href="nativeWebRoot!" target="_blank" rel="noopener noreferrer">{{ t('worker.openNative') }}<ExternalLinkIcon /></a>
            <Button :disabled="opening || selected.state !== 'ready' || !selected.primarySession" @click="openPrimarySession(selected)"><ExternalLinkIcon />{{ opening ? t('ui.connecting') : t('session.openPrimary') }}</Button>
            <Button variant="outline" class="new-session-button" :disabled="overviewMutationsBlocked || opening || selected.state !== 'ready'" @click="openNewSession(selected)"><PlusIcon />{{ opening ? t('ui.connecting') : t('terms.newSession') }}</Button>
          </div>
          <p v-if="workerMode" class="status-note">{{ t('worker.providerLogin') }}</p>
          <section class="primary-todos" :aria-label="t('todo.heading')" :aria-busy="todosLoading">
            <div class="primary-todos-head">
              <h3>{{ t('todo.heading') }}</h3>
              <span v-if="todosLoaded" class="primary-todos-count" :aria-label="t('todo.countsAria', { completed: number(todoCompletedCount), total: number(todoActiveCount), cancelled: number(todoCancelledCount) })">
                {{ t('todo.counts', { completed: number(todoCompletedCount), total: number(todoActiveCount), cancelled: number(todoCancelledCount) }) }}
              </span>
            </div>
            <div class="primary-todos-content">
              <div ref="todoMeasuredContent">
                <p v-if="!selected.primarySession" class="primary-todos-note">{{ t('todo.unbound') }}</p>
                <p v-else-if="todosLoading && !todosLoaded" class="primary-todos-note" role="status">{{ t('todo.loading') }}</p>
                 <p v-else-if="todoFailure" class="primary-todos-error" role="alert"><ErrorDetails :summary="todoFailure.summary" :code="todoFailure.code" :diagnostic="todoFailure.diagnostic" /><span v-if="todosStale">{{ t('todo.stale') }}</span></p>
                <p v-if="selected.primarySession && todosLoaded && primaryTodos.length === 0 && !todosError" class="primary-todos-note">{{ t('todo.empty') }}</p>
                <ol v-if="selected.primarySession && todosLoaded && primaryTodos.length" class="primary-todos-timeline" :class="{ 'is-stale': todosStale }">
                  <li v-for="(todo, index) in primaryTodos" :key="`${todo.content}:${index}`" :data-status="todo.status">
                    <span class="primary-todo-step" role="img" :aria-label="todoStatusLabels[todo.status]" :title="todoStatusLabels[todo.status]">
                      <CheckIcon v-if="todo.status === 'completed'" />
                      <span v-else-if="todo.status === 'in_progress'" class="primary-todo-bars" aria-hidden="true"><i /><i /><i /></span>
                      <CircleIcon v-else-if="todo.status === 'pending'" />
                      <CircleSlash2Icon v-else />
                    </span>
                    <p>{{ todo.content }}</p>
                  </li>
                </ol>
                <p v-if="selected.primarySession && !todosLoaded && !todosLoading && !todosError" class="primary-todos-note">{{ t('todo.notLoaded') }}</p>
              </div>
            </div>
          </section>
          <details class="main-session-details">
            <summary>{{ t('session.bindingInfo') }}</summary>
            <p>{{ t('session.bindingDescription') }}</p>
          </details>
          <details :key="`technical-${selected.id}`" class="technical-info">
            <summary>{{ t('terms.technicalInfo') }}</summary>
            <div class="identity-strip">
              <span><small>{{ t('ui.technicalInstance') }}</small><code>{{ selected.id }}</code></span>
              <span><small>{{ workerMode ? t('worker.nativeEntry') : t('ui.technicalEndpoint') }}</small><code>{{ workerMode ? nativeWebRoot ?? t('common.unknown') : `127.0.0.1:${selected.port}` }}</code></span>
              <span><small>{{ t('ui.technicalPid') }}</small><code>{{ selected.pid ?? t('common.unknown') }}</code></span>
              <span><small>{{ t('ui.technicalVersion') }}</small><code>{{ selected.healthVersion ?? t('common.unknown') }}</code></span>
            </div>
          </details>
          <div class="summary-grid">
            <article><ActivityIcon /><span><small>{{ t('session.scope') }}</small><strong>{{ count(selected.primarySummary.busySessions) }}</strong><b>{{ t('session.busy') }}</b></span></article>
            <article><span class="summary-mark">Q</span><span><small>{{ t('session.request') }}</small><strong>{{ count(selected.primarySummary.pendingQuestions) }}</strong><b>{{ t('session.pendingQuestion') }}</b></span></article>
            <article><span class="summary-mark">P</span><span><small>{{ t('session.request') }}</small><strong>{{ count(selected.primarySummary.pendingPermissions) }}</strong><b>{{ t('session.pendingPermission') }}</b></span></article>
          </div>
          <p v-if="selected.primarySummary.scope === 'known' && selected.primarySummary.busySessions === 0 && selected.primarySummary.retrySessions === 0" class="status-note">{{ t('session.noBusy') }}</p>
          <p v-if="selected.primarySummary.scope === 'known' && selected.primarySummary.busySessions === 0 && (selected.primarySummary.retrySessions ?? 0) > 0" class="status-note">{{ t('session.retrying') }}</p>
           <p v-if="selectedSummaryFailure" class="inline-error"><ErrorDetails :summary="selectedSummaryFailure.summary" :code="selectedSummaryFailure.code" /></p>
          <p v-if="tailscaleSupported && selected.remoteUrlUnavailableReason" class="inline-error"><ErrorDetails :summary="t('ui.remoteUnavailable')" :diagnostic="safeDiagnostic(selected.remoteUrlUnavailableReason)" /></p>
           <p v-if="selectedFailure" class="inline-error"><ErrorDetails :summary="selectedFailure.summary" :code="selectedFailure.code" /></p>

          <details :key="selected.id" class="advanced-sessions">
            <summary>{{ t('session.history') }}</summary>
            <section class="sessions-panel">
              <div class="section-heading"><div><p class="eyebrow">{{ t('session.projectInfo') }}</p><h3>{{ t('terms.mainSession') }}</h3></div><Button variant="ghost" size="sm" class="no-press-transform" @click="loadSessions"><RefreshCwIcon :class="{ spin: sessionsLoading }" />{{ t('common.reload') }}</Button></div>
              <p class="scope-note">{{ t('session.sharedMetadata') }}</p>
              <ul class="session-list main-session-list">
                <SessionTreeNode
                  v-for="session in visibleSessionRoots"
                  :key="`${selected.id}:${session.id}`"
                  :instance-id="selected.id"
                  :session="session"
                  :open-disabled="selected.state !== 'ready' || opening"
                  :switch-disabled="overviewMutationsBlocked || opening || Boolean(switchingSessionId) || selected.state !== 'ready'"
                  allow-switch
                  @open="openWeb(selected, $event)"
                  @switch="selectPrimarySession(selected, session)"
                />
              </ul>
              <nav v-if="sessions.roots.length" class="session-pagination" :aria-label="t('session.pagination')">
                <Button variant="outline" size="sm" :disabled="sessionPage === 1" @click="sessionPage--">{{ t('session.previous') }}</Button>
                <span>{{ t('common.page', { page: number(sessionPage), total: number(sessionPageCount) }) }}</span>
                <Button variant="outline" size="sm" :disabled="sessionPage === sessionPageCount" @click="sessionPage++">{{ t('session.next') }}</Button>
              </nav>
              <p v-if="sessionsError" class="inline-error"><ErrorDetails :summary="displayedError('sessions', sessionsError)" :code="errorDetails.sessions?.code" :diagnostic="errorDetails.sessions?.diagnostic" /></p>
              <p v-else-if="sessionsLoaded && !sessionsLoading && sessions.roots.length === 0" class="empty-copy">{{ t('session.noRoots') }}</p>
              <div v-if="sessions.unknownParent.length" class="unknown-parent">
                <h4><AlertTriangleIcon />{{ t('session.parentMissing') }}</h4>
                <ul class="session-list">
                  <SessionTreeNode v-for="session in sessions.unknownParent" :key="`${selected.id}:${session.id}`" :instance-id="selected.id" :session="session" :open-disabled="selected.state !== 'ready' || opening" @open="openWeb(selected, $event)" />
                </ul>
              </div>
            </section>
          </details>
        </template>
        <div v-else class="detail-empty"><ServerIcon /><p>{{ t('ui.emptyDetail') }}</p></div>
      </main>
    </section>
  </div>

  <Transition name="start-panel" @after-leave="finishStartPanelClose" @leave-cancelled="cancelStartPanelClose">
  <div
    v-if="startPanelOpen"
    class="start-panel-overlay"
    :data-motion="startPanelMotion"
    :inert="startPanelClosing || undefined"
    :aria-hidden="startPanelClosing || undefined"
    @pointerdown.self="handleStartBackdropPointerdown($event)"
  >
    <section
      ref="startPanel"
      class="start-panel"
      :style="panelDrag ? { transform: `translateY(${panelDrag}px)` } : undefined"
      role="dialog"
      aria-modal="true"
      aria-labelledby="start-panel-title"
      tabindex="-1"
    >
      <header class="start-panel-head">
        <div><p class="eyebrow">{{ t('ui.startEyebrow') }}</p><h2 id="start-panel-title">{{ t('ui.startInstance') }}</h2></div>
        <div class="panel-drag-area" aria-hidden="true" @pointerdown="startSwipe($event, 'panel')" @pointermove="moveSwipe($event, 'panel')" @pointerup="endSwipe($event, 'panel')" @pointercancel="cancelSwipe" @lostpointercapture="cancelSwipe" />
        <Button variant="ghost" size="icon" :aria-label="t('aria.closeStart')" :disabled="mutating" @click="closeStartPanel()"><XIcon /></Button>
      </header>
      <div class="start-panel-body">
        <p v-if="workerMode" class="lifecycle-note" role="status">{{ t(workerCapacityMessage) }}</p>
        <p v-if="actionError" class="lifecycle-error" role="alert"><ErrorDetails :summary="displayedError('action', actionError)" :code="errorDetails.action?.code" :diagnostic="errorDetails.action?.diagnostic" /></p>
        <section class="shortcut-rail" aria-labelledby="shortcuts-title">
          <div class="section-heading">
            <div><p class="eyebrow">{{ t('ui.shortcutEyebrow') }}</p><h3 id="shortcuts-title">{{ t('terms.directoryShortcut') }}</h3></div>
            <span>{{ t('common.count', { count: number(overview.shortcuts.length) }) }}</span>
          </div>
          <div class="shortcut-list">
            <article v-for="shortcut in overview.shortcuts" :key="shortcut.id" class="shortcut-card">
              <button type="button" class="shortcut-main" @click="browse(shortcut.directory)">
                <FolderIcon /><span><strong>{{ shortcut.name }}</strong><code>{{ shortcut.directory }}</code></span>
              </button>
              <div class="shortcut-actions">
                <Button variant="ghost" size="icon" :aria-label="t('aria.editShortcut')" @click="editShortcut(shortcut)"><PencilIcon /></Button>
                <Button variant="ghost" size="icon" :aria-label="t('aria.removeShortcut')" @click="removeShortcut(shortcut)"><Trash2Icon /></Button>
              </div>
            </article>
            <p v-if="overview.shortcuts.length === 0" class="empty-copy">{{ t('ui.shortcutEmpty') }}</p>
          </div>
          <form class="shortcut-form" @submit.prevent="saveShortcut">
            <Input v-model="shortcutName" :placeholder="t('ui.shortcutName')" :aria-label="t('aria.shortcutName')" />
            <Input v-model="shortcutDirectory" :placeholder="t('ui.shortcutPath')" :aria-label="t('aria.shortcutDirectory')" />
            <Button type="submit" :disabled="mutating" :aria-label="shortcutId ? t('ui.shortcutUpdate') : t('ui.shortcutAdd')"><FolderPlusIcon /><span class="button-label">{{ shortcutId ? t('ui.shortcutUpdate') : t('ui.shortcutAdd') }}</span></Button>
            <Button v-if="shortcutId" type="button" variant="ghost" @click="clearShortcutForm">{{ t('common.cancel') }}</Button>
          </form>
        </section>

        <section class="browser-panel">
          <div class="section-heading"><div><p class="eyebrow">{{ t('ui.directoryEyebrow') }}</p><h3>{{ t('ui.browseAndStart') }}</h3></div></div>
          <form class="browse-form" @submit.prevent="browse(browserPath)">
            <Input :model-value="browserPath" :placeholder="workerMode ? t('worker.directoryPlaceholder') : t('ui.browsePlaceholder')" :aria-label="t('ui.browseAndStart')" @update:model-value="updateBrowserPath" />
            <Button type="submit" variant="outline" :aria-label="t('ui.browse')"><SearchIcon /><span class="button-label">{{ t('ui.browse') }}</span></Button>
          </form>
          <p v-if="browsingPath" class="browse-status" role="status">{{ t('ui.browsing', { path: browsingPath }) }}</p>
          <div v-else-if="browseError" class="browse-error" role="alert">
            <p><ErrorDetails :summary="t('ui.browseFailed', { path: browserPath })" :code="errorDetails.browse?.code" :diagnostic="errorDetails.browse?.diagnostic" /></p>
            <Button type="button" variant="outline" size="sm" @click="browse(browserPath)">{{ t('ui.retryBrowse') }}</Button>
          </div>
          <template v-if="listing">
            <div class="current-directory">
              <code>{{ listing.current }}</code>
              <Button variant="success" :disabled="mutating || Boolean(browsingPath) || browserPath !== listing.current || instanceCapacityBlocked" @click="start(listing.current)"><PlusIcon />{{ t('ui.startFresh') }}</Button>
            </div>
            <button v-if="listing.parent" type="button" class="directory-row" @click="browse(listing.parent)"><ChevronLeftIcon />{{ t('ui.parentDirectory') }}</button>
            <button v-for="child in listing.children" :key="child.path" type="button" class="directory-row" @click="browse(child.path)"><FolderIcon />{{ child.name }}</button>
            <p v-for="item in listing.errors" :key="item.path" class="inline-error"><ErrorDetails :summary="t('ui.browseFailed', { path: item.path })" :diagnostic="safeDiagnostic(item.message)" /></p>
          </template>
        </section>
      </div>
    </section>
  </div>
  </Transition>

  <div v-if="managerSettingsOpen" class="start-panel-overlay manager-settings-overlay" @click.self="handleSettingsBackdropClick()">
    <section ref="managerSettingsDialog" class="manager-settings" role="dialog" aria-modal="true" aria-labelledby="manager-settings-title" :style="settingsDrag ? { transform: `translateY(${settingsDrag}px)` } : undefined">
      <header class="start-panel-head">
        <div><p class="eyebrow">{{ t('ui.settingsEyebrow') }}</p><h2 id="manager-settings-title">{{ t('ui.managerSettings') }}</h2></div>
        <div class="panel-drag-area" aria-hidden="true" @pointerdown="startSwipe($event, 'settings')" @pointermove="moveSwipe($event, 'settings')" @pointerup="endSwipe($event, 'settings')" @pointercancel="cancelSwipe" @lostpointercapture="cancelSwipe" />
        <Button variant="ghost" size="icon" :aria-label="t('aria.closeSettings')" :disabled="managerSettingsBusy" @click="closeManagerSettings()"><XIcon /></Button>
      </header>
      <div class="manager-settings-body">
        <section class="notification-settings" :aria-label="t('ui.notificationSettings')">
          <label><input type="checkbox" :checked="notificationStatus === 'on'" :disabled="notificationBusy || notificationStatus === 'unsupported' || notificationStatus === 'blocked' || notificationStatus === 'unavailable'" @change="toggleNotifications">{{ t('ui.notifyToggle') }}</label>
          <p v-if="notificationBusy">{{ t('ui.notifyBusy') }}</p>
          <p v-else-if="notificationStatus === 'on' && !notificationError">{{ t('ui.notifyOn') }}</p>
          <p v-else-if="notificationStatus === 'on'">{{ t('ui.notifyOnUnavailable') }}</p>
          <p v-else-if="notificationStatus === 'blocked'">{{ t('ui.notifyBlocked') }}</p>
          <p v-else-if="notificationStatus === 'unsupported'">{{ t('ui.notifyUnsupported') }}</p>
          <p v-else-if="notificationStatus === 'unavailable'">{{ t('ui.notifyUnavailable') }}</p>
          <p v-else>{{ t('ui.notifyOff') }}</p>
          <p v-if="notificationError" role="alert">{{ t(notificationError) }}</p>
          <small>{{ t('ui.notifyCaveat') }}</small>
        </section>
        <p v-if="workerMode">{{ t('worker.credentials') }}</p>
        <form v-if="credentialUpdateSupported" class="credential-form" @submit.prevent="updateManagerCredentials">
          <div><p class="eyebrow">{{ t('ui.account') }}</p><h3>{{ t('ui.accountHeading') }}</h3></div>
          <p>{{ t('ui.accountDescription') }}</p>
          <label><span>{{ t('ui.account') }}</span><Input v-model="managerUsername" autocomplete="username" required /></label>
          <label><span>{{ t('ui.passwordCurrent') }}</span><Input v-model="currentManagerPassword" type="password" autocomplete="current-password" required /></label>
          <label><span>{{ t('ui.passwordNew') }}</span><Input v-model="nextManagerPassword" type="password" autocomplete="new-password" minlength="16" required /></label>
          <label><span>{{ t('ui.passwordConfirm') }}</span><Input v-model="confirmManagerPassword" type="password" autocomplete="new-password" minlength="16" required /></label>
          <Button type="submit" :disabled="managerSettingsBusy">{{ managerSettingsBusy ? t('ui.updating') : t('ui.updateCredentials') }}</Button>
          <!-- 對話框開啟時 toast-region 為 inert，成功訊息需留在對話框內供讀屏讀取。 -->
          <p v-if="managerSettingsSuccess" role="status">{{ t(managerSettingsSuccess) }}</p>
        </form>
        <section v-if="managerShutdownSupported" class="manager-shutdown-panel">
          <div><p class="eyebrow">{{ t('ui.managerLifecycle') }}</p><h3>{{ t('ui.stopManager') }}</h3></div>
          <p>{{ t('ui.stopManagerDescription') }}</p>
          <Button variant="destructive" :disabled="managerSettingsBusy" @click="stopManager"><PowerIcon />{{ t('ui.stopManager') }}</Button>
        </section>
        <p v-if="managerSettingsError" class="lifecycle-error" role="alert"><AlertTriangleIcon /><ErrorDetails :summary="displayedError('settings', managerSettingsError)" :code="errorDetails.settings?.code" :diagnostic="errorDetails.settings?.diagnostic" /></p>
      </div>
    </section>
  </div>

  <ConfirmationDialog
    :open="Boolean(confirmation)"
     :title="confirmationDisplay ? t(confirmationDisplay.titleKey) : ''"
     :description="confirmationDisplay ? t(confirmationDisplay.descriptionKey, confirmationDisplay.descriptionParams) : ''"
     :confirm-label="confirmationDisplay ? t(confirmationDisplay.confirmLabelKey) : ''"
    :tone="confirmationDisplay?.tone ?? 'positive'"
    :busy="confirmationAccepting"
    :motion="currentStartPanelMotion()"
    :return-focus="confirmationReturnFocus"
    :fallback-focus="confirmationFallbackFocus()"
    @update:open="setConfirmationOpen"
    @confirm="acceptConfirmation"
    @after-leave="finishConfirmationLeave"
  />

  <div class="toast-region" :inert="managerSettingsOpen || undefined" aria-live="polite">
    <Transition name="toast"><div v-if="notice" class="toast toast-success" role="status" :style="noticeDrag ? { transform: `translateX(${noticeDrag}px)` } : undefined" @pointerdown="startSwipe($event, 'notice')" @pointermove="moveSwipe($event, 'notice')" @pointerup="endSwipe($event, 'notice')" @pointercancel="cancelSwipe" @lostpointercapture="cancelSwipe">
       <span>{{ t(notice.key, notice.params) }}</span><button type="button" :aria-label="t('common.closeNotice')" @click="clearNotice"><XIcon /></button>
    </div></Transition>
    <Transition name="toast"><div v-if="actionError" class="toast toast-error" role="alert" :style="errorDrag ? { transform: `translateX(${errorDrag}px)` } : undefined" @pointerdown="startSwipe($event, 'error')" @pointermove="moveSwipe($event, 'error')" @pointerup="endSwipe($event, 'error')" @pointercancel="cancelSwipe" @lostpointercapture="cancelSwipe">
      <AlertTriangleIcon /><ErrorDetails :summary="displayedError('action', actionError)" :code="errorDetails.action?.code" :diagnostic="errorDetails.action?.diagnostic" /><button type="button" :aria-label="t('common.closeError')" @click="actionError = ''"><XIcon /></button>
    </div></Transition>
  </div>
  </div>
</template>
