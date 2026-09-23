<script setup lang="ts">
import { primarySessionDisposition } from "@omw/contracts"
import type { ConnectivityInfo, DirectoryListing, DirectoryShortcut, ManagedInstance, OpenUrlResponse, OverviewFilter, SessionMetadata, SessionRootsResponse } from "@omw/contracts"
import {
  ActivityIcon,
  AlertTriangleIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  CircleStopIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  ExternalLinkIcon,
  FolderIcon,
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
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue"
import { ApiError, managerApi } from "@/api"
import SessionTreeNode from "@/components/SessionTreeNode.vue"
import { Button } from "@/components/ui/button"
import ConfirmationDialog from "@/components/ui/dialog/ConfirmationDialog.vue"
import { Input } from "@/components/ui/input"

const filters: Array<{ value: OverviewFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "active", label: "有執行中" },
  { value: "attention", label: "需處理" },
  { value: "unreachable", label: "已失聯" },
]
const SESSION_PAGE_SIZE = 10
type LifecycleAction = "start" | "stop" | "recheck" | "resume" | "tracking" | "remove"
type RecoveryAction = "recheck" | "resume" | "tracking" | "remove"
type ConfirmationTone = "positive" | "caution" | "danger"
type InstanceStatusCategory = "operable" | "attention" | "unknown" | "stopped"
interface ConfirmationRequest {
  title: string
  description: string
  confirmLabel: string
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
const recoveryActionNames: Record<RecoveryAction, string> = {
  recheck: "重新檢查",
  resume: "接續",
  tracking: "停止追蹤",
  remove: "移除紀錄",
}
const recoveryDiagnosticMessage = "操作資訊尚未取得。可能是前後端版本不一致；請重啟 OMW 並重新整理。"

const overview = ref<{ shortcuts: DirectoryShortcut[]; instances: ManagedInstance[] }>({ shortcuts: [], instances: [] })
const connectivity = ref<ConnectivityInfo | null>(null)
const connectivityLoading = ref(false)
const connectivityRegistering = ref(false)
const connectivityError = ref("")
const connectivityStale = ref(false)
const connectivityFallbackOpen = ref(false)
const connectivityFallback = ref<HTMLElement | null>(null)
const connectivityCopyMessage = ref("")
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
const loading = ref(true)
const mutating = ref(false)
const actionError = ref("")
const overviewError = ref("")
const overviewLastSucceededAt = ref("")
const overviewStale = ref(false)
const notice = ref("")
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
const sessions = ref<SessionRootsResponse>({ roots: [], unknownParent: [] })
const sessionsLoading = ref(false)
const sessionsLoaded = ref(false)
const sessionsError = ref("")
const sessionPage = ref(1)
const switchingSessionId = ref("")
const opening = ref(false)
const lifecycleOpen = ref(false)
const lifecyclePending = ref<LifecycleAction | null>(null)
const lifecycleError = ref("")
const confirmation = ref<ConfirmationRequest | null>(null)
const confirmationDisplay = ref<ConfirmationRequest | null>(null)
const confirmationAccepting = ref(false)
const confirmationReturnFocus = ref<HTMLElement | null>(null)
const managerSettingsOpen = ref(false)
const managerSettingsBusy = ref(false)
const managerSettingsError = ref("")
const managerUsername = ref("omw")
const currentManagerPassword = ref("")
const nextManagerPassword = ref("")
const confirmManagerPassword = ref("")
const managerStopped = ref(false)
let confirmationClosing = false
let confirmationLeaveCompleted = false
let pollTimer: number | undefined
let connectivityPollTimer: number | undefined
let noticeTimer: number | undefined
let returnFocusElement: HTMLElement | null = null
let previousBodyOverflow = ""
let inputModality: "pointer" | "keyboard" = "keyboard"
let restoreFocusAfterStartPanelClose = true
let revealDetailAfterStartPanelClose = false
let overviewGeneration = 0
let connectivityReadGeneration = 0
let connectivityMutationGeneration = 0
let mobileHistoryGeneration = 0
let mobileBreakpoint: MediaQueryList | undefined
let listScrollPosition = 0
let returnToInstanceId = ""
// Root 請求可能亂序完成；只有最新選取的 Instance 可更新 data、error 與 loading state。
let sessionsGeneration = 0
let sessionsInstanceId = ""

const selected = computed(() => overview.value.instances.find((instance) => instance.id === selectedId.value) ?? null)
const sessionPageCount = computed(() => Math.max(1, Math.ceil(sessions.value.roots.length / SESSION_PAGE_SIZE)))
const sortedSessionRoots = computed(() => [...sessions.value.roots].sort(compareSessionMetadata))
const visibleSessionRoots = computed(() => sortedSessionRoots.value.slice(
  (sessionPage.value - 1) * SESSION_PAGE_SIZE,
  sessionPage.value * SESSION_PAGE_SIZE,
))
const connectivityMode = computed<"loopback" | "tailnet" | "unknown">(() => {
  const value = connectivity.value?.mode as string | undefined
  return value === "loopback" || value === "tailnet" ? value : "unknown"
})
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
  return connectivityMode.value === "tailnet"
    && !connectivityRegistering.value
    && (state === "failed" || (state === "idle" && !remoteUrl.value))
})
const localUrl = computed(() => safeManagerUrl(connectivity.value?.manager.localUrl) ?? "未知")
const connectivityTone = computed(() => {
  if (connectivityStale.value || !connectivity.value) return "unknown"
  if (tailscaleState.value !== "connected" || serveState.value === "mismatch" || connectivity.value.serve.funnel === "enabled") return "warning"
  return serveState.value === "verified" ? "ready" : "unknown"
})
const connectivityHeadline = computed(() => {
  if (connectivityStale.value) return "連線資料已過期"
  if (!connectivity.value) return connectivityLoading.value ? "正在檢查連線" : "連線狀態未知"
  if (connectivityRegistering.value || connectivity.value.registration.state === "registering") return "正在連線 Tailscale"
  if (connectivity.value.registration.state === "failed") {
    return connectivity.value.registration.trigger === "manual" ? "連線 Tailscale 失敗" : "尚未連線 Tailscale"
  }
  if (connectivity.value.registration.state === "verified") return "遠端入口已連線"
  return {
    connected: "本機 Tailscale 在線",
    offline: "本機 Tailscale 離線",
    "needs-login": "Tailscale 需要登入",
    unavailable: "Tailscale 無法使用",
    unknown: "Tailscale 狀態未知",
  }[tailscaleState.value]
})
const serveLabel = computed(() => ({
  verified: "Serve 映射吻合",
  mismatch: "Serve 映射不符",
  unknown: "Serve 映射未知",
  "not-configured": "尚未設定 Serve",
})[serveState.value])
const connectivityWarnings = computed(() => {
  const warnings: string[] = []
  if (connectivityStale.value) warnings.push("無法取得最新連線狀態；以下為上次成功檢查結果。")
  if (tailscaleState.value === "offline") warnings.push("本機 Tailscale 目前離線，遠端入口可能無法連線。")
  if (tailscaleState.value === "needs-login") warnings.push("本機 Tailscale 需要登入後才能使用 Tailnet 入口。")
  if (tailscaleState.value === "unavailable") warnings.push("找不到可用的本機 Tailscale 狀態。")
  if (serveState.value === "mismatch") warnings.push("Serve 映射與目前 OMW 設定不符，遠端入口目前不可用。")
  if (connectivity.value?.serve.funnel === "enabled") warnings.push("偵測到 Funnel，請核對公開範圍")
  const registration = connectivity.value?.registration
  if (registration?.state === "failed" && registration.trigger === "manual" && registration.diagnostic) {
    warnings.push(`${registration.diagnostic.message} ${registration.diagnostic.nextStep}（${registration.diagnostic.code}）`)
  }
  return warnings
})
const recoveryMetadataValid = computed(() => {
  const recovery = selected.value?.recovery
  return typeof recovery === "object" && recovery !== null
    && Object.values(recoveryActionKeys).every((key) => typeof recovery[key] === "boolean")
})
const recoveryDiagnostic = computed(() => selected.value && !recoveryMetadataValid.value ? recoveryDiagnosticMessage : "")
const overviewMutationsBlocked = computed(() => overviewStale.value)
const overviewFreshnessState = computed<"loading" | "unavailable" | "fresh" | "stale">(() => {
  if (!overviewLastSucceededAt.value) return overviewError.value ? "unavailable" : "loading"
  return overviewStale.value ? "stale" : "fresh"
})
const lifecycleUnavailableReasons = computed(() => {
  if (!selected.value || !recoveryMetadataValid.value || lifecyclePending.value) return []
  return (Object.keys(recoveryActionKeys) as RecoveryAction[])
    .filter((action) => !recoveryActionAllowed(action))
    .map((action) => ({ label: recoveryActionLabel(selected.value!, action), reason: lifecycleReason(selected.value!, action) }))
})
const projectGroups = computed(() => {
  const groups = new Map<string, { key: string; name: string; directory: string; instances: ManagedInstance[] }>()
  for (const instance of overview.value.instances) {
    const key = normalizedDirectoryKey(instance.projectDirectory)
    const group = groups.get(key) ?? {
      key,
      name: projectFolderName(instance.projectDirectory),
      directory: instance.projectDirectory,
      instances: [],
    }
    group.instances.push(instance)
    groups.set(key, group)
  }
  return [...groups.values()]
    .map((group) => {
      const instances = group.instances.toSorted((left, right) =>
        Date.parse(right.launchedAt) - Date.parse(left.launchedAt) || left.id.localeCompare(right.id))
      return {
        ...group,
        instances,
        activeInstances: instances.filter((instance) => instance.state !== "stopped"),
        stoppedInstances: instances.filter((instance) => instance.state === "stopped"),
      }
    })
    .toSorted((left, right) => left.name.localeCompare(right.name, "zh-TW") || left.directory.localeCompare(right.directory, "zh-TW"))
})

onMounted(async () => {
  mobileBreakpoint = window.matchMedia("(max-width: 860px)")
  if (isMobileViewport()) window.history.scrollRestoration = "manual"
  mobileBreakpoint.addEventListener("change", handleMobileBreakpointChange)
  document.addEventListener("pointerdown", handleDocumentPointerdown, true)
  document.addEventListener("keydown", handleDocumentKeydown, true)
  window.addEventListener("scroll", handleMobileListScroll, { passive: true })
  window.addEventListener("popstate", handleMobileHistoryChange)
  shareSupported.value = typeof navigator.share === "function"
  if (isMobileViewport() && !mobileHistoryView()) replaceMobileHistory("list")
  if (isMobileViewport()) applyMobileHistoryContext()
  void loadConnectivity("background")
  const overviewLoaded = await loadOverview(true, "background")
  if (overviewLoaded && isMobileViewport() && mobileHistoryView() === "list") await restoreMobileListScroll()
  document.addEventListener("visibilitychange", handleForegroundRefresh)
  window.addEventListener("pageshow", handleForegroundRefresh)
  window.addEventListener("pagehide", handlePageHide)
  connectivityPollTimer = window.setInterval(() => void loadConnectivity("background"), 30_000)
  pollTimer = window.setInterval(() => void loadOverview(false, "background"), 5_000)
})
onBeforeUnmount(() => {
  window.clearInterval(pollTimer)
  window.clearInterval(connectivityPollTimer)
  window.clearTimeout(noticeTimer)
  document.removeEventListener("pointerdown", handleDocumentPointerdown, true)
  document.removeEventListener("keydown", handleDocumentKeydown, true)
  window.removeEventListener("scroll", handleMobileListScroll)
  document.removeEventListener("visibilitychange", handleForegroundRefresh)
  window.removeEventListener("pageshow", handleForegroundRefresh)
  window.removeEventListener("pagehide", handlePageHide)
  window.removeEventListener("popstate", handleMobileHistoryChange)
  mobileBreakpoint?.removeEventListener("change", handleMobileBreakpointChange)
  if (startPanelBlocking.value) document.body.style.overflow = previousBodyOverflow
  overviewGeneration++
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
  } catch (cause) {
    if (generation !== connectivityReadGeneration) return
    // 保留最後一次成功結果供診斷，但一定降級為 stale，避免舊的綠色狀態被當成目前可用。
    connectivityStale.value = connectivity.value !== null
    connectivityError.value = connectivity.value
      ? `更新失敗：${message(cause)}`
      : "暫時無法取得連線狀態。"
  } finally {
    if (generation === connectivityReadGeneration) connectivityLoading.value = false
  }
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
    connectivityError.value = `連線 Tailscale 失敗：${message(cause)}`
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
    if (generation === connectivityMutationGeneration) remoteEnableError.value = message(cause)
  } finally {
    remoteEnablePassword.value = ""
    if (generation === connectivityMutationGeneration) connectivityRegistering.value = false
  }
}

async function copyPhoneUrl(successMessage = "遠端入口已複製。"): Promise<boolean> {
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
    connectivityCopyMessage.value = "無法自動複製，請選取網址手動複製。"
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
  void result.then(() => showNotice("系統分享已完成。"), handleShareFailure)
}

async function handleShareFailure(cause: unknown): Promise<void> {
  if (cause instanceof DOMException && cause.name === "AbortError") return
  const copied = await copyPhoneUrl("分享失敗，已改為複製網址。")
  if (!copied) connectivityCopyMessage.value = "分享失敗，請選取網址手動分享。"
}

async function loadOverview(showLoading = true, source: "user" | "background" = "user"): Promise<boolean> {
  if (source === "background" && document.visibilityState === "hidden") return false
  if (source === "user") beginUserAction()
  const generation = ++overviewGeneration
  const requestedQuery = query.value
  const requestedFilter = filter.value
  const requestedIncludeHidden = includeHidden.value
  const requestedHistoryGeneration = mobileHistoryGeneration
  const detailTarget = isMobileViewport() && mobileHistoryView() === "detail" ? mobileHistoryInstanceId() : ""
  const detailRouteIsCurrent = () => Boolean(detailTarget)
    && requestedHistoryGeneration === mobileHistoryGeneration
    && mobileHistoryView() === "detail"
    && mobileHistoryInstanceId() === detailTarget
  if (showLoading) loading.value = true
  try {
    let next = await managerApi.overview(requestedQuery, requestedFilter, requestedIncludeHidden)
    if (generation !== overviewGeneration) return false
    let appliedQueryValue = requestedQuery
    let appliedFilterValue = requestedFilter
    // 篩選結果不能當成 Instance 已移除；只有同一 includeHidden 範圍的未篩選成功結果才能確認缺少。
    if (detailRouteIsCurrent() && !next.instances.some((item) => item.id === detailTarget)
      && (requestedQuery.trim() || requestedFilter !== "all")) {
      const fallback = await managerApi.overview("", "all", requestedIncludeHidden)
      if (generation !== overviewGeneration) return false
      if (detailRouteIsCurrent() && fallback.instances.some((item) => item.id === detailTarget)) {
        next = fallback
        query.value = ""
        filter.value = "all"
        appliedQueryValue = ""
        appliedFilterValue = "all"
        replaceMobileHistory("detail", detailTarget)
      }
    }
    overview.value = next
    appliedQuery.value = appliedQueryValue
    appliedFilter.value = appliedFilterValue
    overviewLastSucceededAt.value = new Date().toISOString()
    overviewStale.value = false
    overviewError.value = ""

    if (detailRouteIsCurrent() && next.instances.some((item) => item.id === detailTarget)) {
      if (selectedId.value !== detailTarget || !mobileDetailOpen.value) await restoreMobileHistory()
    } else if (detailRouteIsCurrent()) {
      selectedId.value = ""
      resetSelectedScope()
      mobileDetailOpen.value = false
      replaceMobileHistory("list")
      showNotice("原執行個體已不存在，已返回列表。")
      void restoreListContext()
    } else if ((!isMobileViewport() || requestedHistoryGeneration === mobileHistoryGeneration)
      && selectedId.value && !next.instances.some((item) => item.id === selectedId.value)) {
      selectedId.value = ""
      resetSelectedScope()
    }
    if (!selectedId.value && !isMobileViewport()) {
      selectedId.value = next.instances[0]?.id ?? ""
      lifecycleError.value = ""
      if (selectedId.value) await loadSessions()
    }
    if (generation !== overviewGeneration) return false
    if (source === "user") persistMobileListHistory()
    return true
  } catch (cause) {
    if (generation !== overviewGeneration) return false
    overviewError.value = message(cause)
    overviewStale.value = Boolean(overviewLastSucceededAt.value)
    return false
  } finally {
    if (generation === overviewGeneration) loading.value = false
  }
}

async function choose(instance: ManagedInstance): Promise<void> {
  beginUserAction()
  if (isMobileViewport()) {
    listScrollPosition = window.scrollY
    returnToInstanceId = instance.id
    mobileDetailOpen.value = true
    pushMobileHistory(instance.id)
  }
  selectedId.value = instance.id
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
  return {
    ...current,
    omwMobileView: view,
    omwInstanceId: instanceId,
    omwQuery: query.value,
    omwFilter: filter.value,
    omwIncludeHidden: includeHidden.value,
    omwListScroll: listScrollPosition,
    omwHistoryOpen: [...historyOpen.value],
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
  const historyQuery = Reflect.get(state, "omwQuery")
  const historyFilter = Reflect.get(state, "omwFilter")
  const historyIncludeHidden = Reflect.get(state, "omwIncludeHidden")
  const historyScroll = Reflect.get(state, "omwListScroll")
  const historyDisclosure = Reflect.get(state, "omwHistoryOpen")
  const nextQuery = typeof historyQuery === "string" ? historyQuery : ""
  const nextFilter = filters.some((item) => item.value === historyFilter) ? historyFilter as OverviewFilter : "all"
  const nextIncludeHidden = historyIncludeHidden === true
  const changed = query.value !== nextQuery || filter.value !== nextFilter || includeHidden.value !== nextIncludeHidden
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
  if (document.visibilityState !== "visible") {
    persistMobileListHistory()
    return
  }
  connectivityStale.value = connectivity.value !== null
  overviewStale.value = Boolean(overviewLastSucceededAt.value)
  if (overviewStale.value && confirmation.value?.requiresFreshOverview) {
    ensureFreshOverviewMutation(confirmation.value.freshnessErrorTarget)
    closeConfirmation()
  }
  void loadConnectivity("background")
  void loadOverview(false, "background")
}

function handlePageHide(): void {
  persistMobileListHistory()
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

function toggleHistory(groupKey: string): void {
  const next = new Set(historyOpen.value)
  if (next.has(groupKey)) next.delete(groupKey)
  else next.add(groupKey)
  historyOpen.value = next
  persistMobileListHistory()
}

function historyExpanded(group: { key: string; stoppedInstances: ManagedInstance[] }): boolean {
  return Boolean(appliedQuery.value.trim())
    || historyOpen.value.has(group.key)
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
    sessionsError.value = message(cause)
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
    showNotice("目錄捷徑已儲存。")
    await loadOverview(false, "background")
  })
}

function removeShortcut(shortcut: DirectoryShortcut): void {
  requestConfirmation({
    title: "移除目錄捷徑？",
    description: `將移除「${shortcut.name}」；既有執行個體不會被停止。`,
    confirmLabel: "移除捷徑",
    tone: "danger",
    accept: () => deleteShortcut(shortcut),
  })
}

async function deleteShortcut(shortcut: DirectoryShortcut): Promise<void> {
  await mutate(async () => {
    await managerApi.deleteShortcut(shortcut.id)
    showNotice("目錄捷徑已移除；執行個體未受影響。")
    await loadOverview(false, "background")
  })
}

async function browse(directory: string): Promise<void> {
  beginUserAction()
  try {
    listing.value = await managerApi.browse(directory)
    browserPath.value = listing.value.current
  } catch (cause) {
    actionError.value = message(cause)
  }
}

async function start(directory: string): Promise<void> {
  await mutate(async () => {
    const instance = await managerApi.start(directory)
    await selectNewInstance(instance)
    lifecycleError.value = ""
    showNotice(instance.state === "ready"
      ? `執行個體已啟動（${shortId(instance.id)}）。`
      : `執行個體已啟動，目前無法連線，請查看狀態（${shortId(instance.id)}）。`)
    revealDetailAfterStartPanelClose = true
    closeStartPanel(false, true)
  })
}

async function selectNewInstance(target: ManagedInstance | string): Promise<boolean> {
  const instanceId = typeof target === "string" ? target : target.id
  query.value = ""
  filter.value = "all"
  await loadOverview(false, "background")

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
    title: "停止整個執行個體？",
    description: `將停止 ${shortId(instance.id)} 的整個程序與所有進行中的工作，但不會刪除 OpenCode Sessions 或專案檔案。`,
    confirmLabel: "停止執行個體",
    tone: "danger",
    requiresFreshOverview: true,
    accept: () => performStopInstance(instance),
  })
}

async function performStopInstance(instance: ManagedInstance): Promise<void> {
  await lifecycleMutation("stop", async () => {
    replaceInstance(await managerApi.stop(instance.id))
    showNotice("背景執行個體已停止。")
    await loadOverview(false, "background")
  })
}

function startFreshInstance(instance: ManagedInstance): void {
  requestConfirmation({
    title: "啟動新的執行個體？",
    description: "將在相同專案目錄啟動新的背景程序與 PID；不建立 Session，也不變更這筆已停止的舊紀錄。",
    confirmLabel: "啟動",
    tone: "positive",
    requiresFreshOverview: true,
    accept: () => performFreshStart(instance),
  })
}

async function performFreshStart(instance: ManagedInstance): Promise<void> {
  await lifecycleMutation("start", async () => {
    const started = await managerApi.start(instance.projectDirectory)
    await selectNewInstance(started)
    showNotice(`已啟動新的背景執行個體（${shortId(started.id)}）；尚未建立或綁定 Session。`)
  })
}

async function recheckInstance(instance: ManagedInstance): Promise<void> {
  await lifecycleMutation("recheck", async () => {
    replaceInstance(await managerApi.recheck(instance.id))
    showNotice("執行個體狀態已重新檢查。")
    await loadOverview(false, "background")
  })
}

function resumeInstance(instance: ManagedInstance): void {
  requestConfirmation({
    title: "接續主要對話？",
    description: "將啟動新的背景程序與 PID 接續已綁定的主要 Session；不會停止舊程序，也不會傳送模型訊息。",
    confirmLabel: "接續對話",
    tone: "positive",
    requiresFreshOverview: true,
    accept: () => performResumeInstance(instance),
  })
}

async function performResumeInstance(instance: ManagedInstance): Promise<void> {
  await lifecycleMutation("resume", async () => {
    const resumed = await managerApi.resume(instance.id)
    await selectNewInstance(resumed)
    showNotice(`已啟動新的背景執行個體（${shortId(resumed.id)}）；請確認後再進入主 Session。`)
  }, async (cause) => {
    const newInstanceId = errorNewInstanceId(cause)
    if (!newInstanceId) return message(cause)
    const visible = await selectNewInstance(newInstanceId)
    if (visible) {
      return `新的背景執行個體 ${shortId(newInstanceId)} 已啟動，但尚未完成主要 Session 綁定。列表已顯示並選取新的執行個體；不要重複接續。`
    }
    return `新的背景執行個體 ${shortId(newInstanceId)} 已啟動，但重新整理後尚未出現在列表。請稍後再重新整理；不要重複接續。`
  })
}

async function setInstanceTracking(instance: ManagedInstance, hidden: boolean): Promise<void> {
  await lifecycleMutation("tracking", async () => {
    replaceInstance(await managerApi.setTracking(instance.id, hidden))
    showNotice(hidden ? "已從主列表隱藏；程序與保留的連線埠不受影響。" : "已恢復追蹤此執行個體。")
    if (hidden && selectedId.value === instance.id && isMobileViewport()) {
      selectedId.value = ""
      resetSelectedScope()
      mobileDetailOpen.value = false
      replaceMobileHistory("list")
    }
    await loadOverview(false, "background")
  })
}

function removeInstance(instance: ManagedInstance): void {
  requestConfirmation({
    title: "移除 OMW 紀錄與綁定？",
    description: `將移除執行個體 ${shortId(instance.id)} 的 OMW 追蹤紀錄與綁定；不會刪除 OpenCode Sessions、專案檔案或其他資料。`,
    confirmLabel: "移除紀錄",
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
    showNotice("OMW 追蹤紀錄與綁定已移除；OpenCode Sessions 與檔案未受影響。")
    await loadOverview(false, "background")
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
  beginUserAction()
  lifecycleError.value = ""
  lifecyclePending.value = action
  try {
    await operation()
  } catch (cause) {
    lifecycleError.value = onError ? await onError(cause) : message(cause)
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
  if (opening.value) throw new Error("已有連線請求正在進行中。")
  const instanceId = instance.id
  // 必須在 click 的 user activation 內、任何 await 之前取得 handle，否則瀏覽器可能封鎖延遲開啟的分頁。
  const popup = window.open("about:blank", "_blank")
  if (!popup) throw new Error("瀏覽器封鎖了彈出視窗，請允許此網站開啟新分頁後再試。")

  opening.value = true
  try {
    popup.opener = null
    const referrerPolicy = popup.document.createElement("meta")
    referrerPolicy.name = "referrer"
    referrerPolicy.content = "no-referrer"
    popup.document.head.append(referrerPolicy)
    popup.document.title = "連線中…"
    popup.document.body.textContent = "正在連線到 OpenCode Web…"

    const response = await request()
    const sessionMatches = expectedSessionId === undefined
      ? typeof response.sessionId === "string" && response.sessionId.length > 0
      : response.sessionId === expectedSessionId
    if (response.instanceId !== instanceId || !sessionMatches) {
      throw new Error("Manager 回傳的 Open URL 與本次請求不符。")
    }
    const destination = new URL(response.url)
    if ((destination.protocol !== "http:" && destination.protocol !== "https:") || destination.username || destination.password) {
      throw new Error("Manager 回傳了不安全的 Open URL。")
    }
    popup.location.replace(destination.href)
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
    actionError.value = message(cause)
  }
}

async function openPrimarySession(instance: ManagedInstance): Promise<void> {
  if (!instance.primarySession) return
  await openWeb(instance, instance.primarySession.sessionId)
}

async function refreshSelectedInstance(instanceId: string): Promise<void> {
  await loadOverview(false, "background")
  if (selectedId.value === instanceId) await loadSessions()
}

function openNewSession(instance: ManagedInstance): void {
  requestConfirmation({
    title: "建立 New Session？",
    description: "將建立新的 Session、綁定為此執行個體的主要 Session，並在 OpenCode Web 開啟。",
    confirmLabel: "建立並開啟",
    tone: "caution",
    requiresFreshOverview: true,
    freshnessErrorTarget: "action",
    accept: () => createNewSession(instance),
  })
}

async function createNewSession(instance: ManagedInstance): Promise<void> {
  if (!ensureFreshOverviewMutation("action")) return
  beginUserAction()
  try {
    const response = await openWithPopup(instance, () => managerApi.createSession(instance.id))
    await refreshSelectedInstance(instance.id)
    showNotice(`New Session ${shortId(response.sessionId ?? "")} 已建立並綁定為主要 Session。`)
  } catch (cause) {
    if (cause instanceof ApiError && cause.code === "SESSION_CREATED_URL_FAILED") {
      const createdSessionId = errorSessionId(cause.details)
      await refreshSelectedInstance(instance.id)
      actionError.value = createdSessionId
        ? `Session ${createdSessionId} 已建立並綁定，但 URL 產生失敗。請重新整理綁定後使用「進入主 Session」開啟，不要再次建立 New Session。`
        : `${cause.message} 請重新整理綁定後使用「進入主 Session」開啟，不要再次建立 New Session。`
      return
    }
    actionError.value = message(cause)
  }
}

function selectPrimarySession(instance: ManagedInstance, session: SessionMetadata): void {
  requestConfirmation({
    title: "切換主要 Session？",
    description: `只會將 ${session.title}（${session.id}）綁定為此執行個體的主要 Session，不會開啟或跳轉 OpenCode Web。`,
    confirmLabel: "切換",
    tone: "caution",
    requiresFreshOverview: true,
    freshnessErrorTarget: "action",
    accept: () => performSelectPrimarySession(instance, session.id),
  })
}

async function performSelectPrimarySession(instance: ManagedInstance, sessionId: string): Promise<void> {
  if (!ensureFreshOverviewMutation("action")) return
  beginUserAction()
  switchingSessionId.value = sessionId
  try {
    const response = await managerApi.selectPrimarySession(instance.id, sessionId)
    if (response.instanceId !== instance.id || response.sessionId !== sessionId) throw new Error("Manager 回傳的主要 Session 綁定與本次請求不符。")
    await refreshSelectedInstance(instance.id)
    showNotice(`主要 Session 已切換為 ${shortId(sessionId)}。`)
  } catch (cause) {
    actionError.value = message(cause)
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
  mutating.value = true
  try {
    await operation()
  } catch (cause) {
    actionError.value = message(cause)
  } finally {
    mutating.value = false
  }
}

function openManagerSettings(): void {
  beginUserAction()
  managerSettingsError.value = ""
  currentManagerPassword.value = ""
  nextManagerPassword.value = ""
  confirmManagerPassword.value = ""
  managerSettingsOpen.value = true
}

async function updateManagerCredentials(): Promise<void> {
  managerSettingsError.value = ""
  if (nextManagerPassword.value !== confirmManagerPassword.value) {
    managerSettingsError.value = "兩次輸入的新密碼不一致。"
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
    showNotice("OMW 帳密已更新；後續請求將使用新帳密，遠端瀏覽器可能要求重新登入。")
  } catch (cause) {
    managerSettingsError.value = message(cause)
  } finally {
    managerSettingsBusy.value = false
  }
}

function stopManager(): void {
  requestConfirmation({
    title: "停止 OMW Manager？",
    description: "管理介面將立即中斷，但所有 OpenCode TUI、背景執行個體、Sessions 與 Project 工作都會繼續運作。這不是停止執行個體，也不是停止追蹤。",
    confirmLabel: "只停止 OMW",
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
    managerSettingsOpen.value = false
    managerStopped.value = true
  } catch (cause) {
    managerSettingsError.value = message(cause)
  } finally {
    managerSettingsBusy.value = false
  }
}

function beginUserAction(): void {
  actionError.value = ""
  clearNotice()
}

function showNotice(value: string): void {
  window.clearTimeout(noticeTimer)
  notice.value = value
  noticeTimer = window.setTimeout(() => { notice.value = "" }, 6_000)
}

function clearNotice(): void {
  window.clearTimeout(noticeTimer)
  notice.value = ""
}

function openStartPanel(): void {
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

function handleDocumentPointerdown(): void {
  inputModality = "pointer"
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
  return { operable: "可操作", attention: "需處理", unknown: "無法確認", stopped: "已停止" }[statusCategory(instance)]
}

function attentionSummary(instance: ManagedInstance): string {
  if (instance.primarySummary.scope === "unbound") return "需處理 · 未綁定主 Session"
  const items: string[] = []
  if ((instance.primarySummary.pendingQuestions ?? 0) > 0) items.push(`${instance.primarySummary.pendingQuestions} 項待回答`)
  if ((instance.primarySummary.pendingPermissions ?? 0) > 0) items.push(`${instance.primarySummary.pendingPermissions} 項待授權`)
  return items.length ? `需處理 · ${items.join("、")}` : "需處理 · 無執行中 Session"
}

function statusHeadline(instance: ManagedInstance): string {
  if (statusCategory(instance) === "attention") return attentionSummary(instance)
  if (instance.state === "ready" && primarySessionDisposition(instance.primarySummary) === "retry") return "重試中"
  return statusCategoryLabel(instance)
}

function statusContext(instance: ManagedInstance): string {
  const scope = instance.state === "ready" && instance.primarySummary.scope !== "unbound" ? "主 Session 工作範圍 · " : ""
  return `${scope}${stateLabel(instance.state)} · ${shortId(instance.id)}`
}

function stateLabel(state: ManagedInstance["state"]): string {
  return { starting: "啟動中", ready: "可連線", failed: "啟動失敗", unreachable: "已失聯", stopped: "已停止" }[state]
}
function primarySourceLabel(source: NonNullable<ManagedInstance["primarySession"]>["source"]): string {
  return { activity: "首次活動", "new-session": "New Session", manual: "手動切換" }[source]
}
function count(value: number | null): string { return value == null ? "未知" : String(value) }
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
  if (!value) return "未知"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "未知" : new Intl.DateTimeFormat("zh-TW", { dateStyle: "medium", timeStyle: "medium" }).format(date)
}
function managerMappingLabel(value: boolean | null | undefined): string {
  return value === true ? "吻合" : value === false ? "不吻合" : "未知"
}
function shortId(value: string): string { return value.slice(0, 8) }
function normalizedDirectoryKey(directory: string): string {
  return directory.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase("en-US")
}
function projectFolderName(directory: string): string {
  const normalized = directory.replace(/[\\/]+$/, "")
  return normalized.split(/[\\/]/).at(-1) || directory
}
function instanceTitle(instance: ManagedInstance): string {
  return instance.primarySession?.title ?? "尚未綁定主 Session"
}
function detailTitle(instance: ManagedInstance): string {
  return instance.primarySession?.title ?? projectFolderName(instance.projectDirectory)
}
function instancePid(instance: ManagedInstance): string {
  return instance.pid == null ? "PID 未知" : `#${instance.pid}`
}
function instanceRowLabel(instance: ManagedInstance): string {
  const identity = instance.pid == null ? `${instancePid(instance)} · ${shortId(instance.id)}` : instancePid(instance)
  return `${identity} ${instanceTitle(instance)}`
}
function actionPending(action: LifecycleAction): boolean { return lifecyclePending.value === action }
function ensureFreshOverviewMutation(target: "lifecycle" | "action" = "lifecycle"): boolean {
  if (!overviewMutationsBlocked.value) return true
  const staleMessage = "執行個體資料已過期；請先重試更新，成功後再執行此操作。"
  if (target === "action") actionError.value = staleMessage
  else lifecycleError.value = staleMessage
  return false
}
function recoveryActionAllowed(action: RecoveryAction): boolean {
  const recovery = selected.value?.recovery
  const key = recoveryActionKeys[action]
  return recoveryMetadataValid.value && recovery?.[key] === true
}
function recoveryActionLabel(instance: ManagedInstance, action: RecoveryAction): string {
  return action === "tracking" && instance.trackingHidden ? "恢復追蹤" : recoveryActionNames[action]
}
function lifecycleReason(instance: ManagedInstance, action: RecoveryAction): string {
  if (action === "recheck") {
    if (instance.state === "ready") return "目前可連線"
    if (instance.state === "stopped") return "已停止不需檢查"
    return "目前狀態不允許重新檢查"
  }
  if (action === "resume") {
    if (instance.state === "ready") return "目前可連線無需接續"
    if (!instance.primarySession) return "尚未綁定主要 Session，無對話可接續"
    return "state未符合"
  }
  if (action === "tracking") {
    if (instance.state === "ready") return "目前可連線"
    if (instance.state === "stopped") return instance.recovery.removeAllowed === false ? "不適用停止追蹤" : "可用移除紀錄"
    return "目前狀態不允許停止追蹤"
  }
  if (instance.state !== "stopped") return "尚未確認停止"
  return "仍有保留連線埠未安全釋放"
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
function message(cause: unknown): string { return cause instanceof Error ? cause.message : "發生未知錯誤。" }
</script>

<template>
  <div class="app-root" :data-mobile-view="mobileDetailOpen ? 'detail' : 'list'">
  <div class="shell" :inert="startPanelBlocking || undefined">
    <header class="topbar">
      <div>
        <p class="eyebrow">WINDOWS · CONNECTIVITY CONSOLE</p>
        <h1>OpenCode Manager</h1>
      </div>
      <div class="topbar-actions">
        <Button variant="success" data-dialog-focus-fallback @click="openStartPanel"><PlusIcon />啟動執行個體</Button>
        <Button variant="outline" size="sm" class="no-press-transform" @click="openManagerSettings"><Settings2Icon />OMW 設定</Button>
        <Button variant="outline" size="sm" class="no-press-transform" :disabled="loading" @click="loadOverview(true, 'user')">
          <RefreshCwIcon :class="{ spin: loading }" />重新整理
        </Button>
      </div>
    </header>

    <section v-if="managerStopped" class="manager-stopped" role="status">
      <PowerIcon />
      <div><strong>OMW Manager 已停止</strong><p>OpenCode TUI、背景執行個體、Sessions 與 Project 工作仍繼續運作。重新執行 <code>omw</code> 可恢復管理介面。</p></div>
    </section>

    <section class="connectivity" :data-tone="connectivityTone" aria-labelledby="connectivity-title" :aria-busy="connectivityLoading">
      <div class="connectivity-status">
        <span class="connectivity-signal"><WifiIcon /></span>
        <div class="connectivity-status-copy">
          <p class="eyebrow">TAILNET / SERVE</p>
          <h2 id="connectivity-title">{{ connectivityHeadline }}</h2>
          <p class="connectivity-qualifier">{{ serveLabel }} · 遠端裝置仍須連上 Tailnet</p>
        </div>
        <Button v-if="canRegisterConnectivity" variant="outline" size="sm" class="connectivity-register no-press-transform" :disabled="connectivityLoading" @click="registerConnectivity">
          <RefreshCwIcon />自動註冊
        </Button>
        <Button v-if="connectivity?.remoteAccess === 'available'" variant="outline" size="sm" :disabled="connectivityRegistering" @click="remoteEnableOpen = true">啟用遠端存取</Button>
      </div>
      <div class="connectivity-access">
        <div class="connectivity-entry">
          <span>遠端入口<span v-if="remoteUrl">（已驗證）</span></span>
          <code :title="remoteUrl ?? undefined">{{ remoteUrl ?? '尚未驗證遠端入口' }}</code>
        </div>
        <div class="connectivity-actions">
          <Button variant="outline" size="sm" class="no-press-transform" :disabled="!remoteUrl" @click="copyPhoneUrl()"><CopyIcon />複製網址</Button>
          <Button v-if="shareSupported" variant="outline" size="sm" class="no-press-transform" :disabled="!remoteUrl" @click="sharePhoneUrl"><Share2Icon />分享</Button>
        </div>
      </div>
      <div v-if="connectivityWarnings.length || connectivityError" class="connectivity-warnings" aria-live="polite">
        <p v-for="warning in connectivityWarnings" :key="warning"><AlertTriangleIcon />{{ warning }}</p>
        <p v-if="connectivityError"><AlertTriangleIcon />{{ connectivityError }}</p>
      </div>
      <p v-if="connectivity?.remoteAccess === 'disabled'" class="connectivity-warnings">OMW_REMOTE_ACCESS=0 已明確停用遠端存取；請移除此停用設定並重新啟動 OMW 後再啟用。</p>
      <form v-if="remoteEnableOpen" class="credential-form connectivity-warnings" aria-label="確認啟用遠端存取" @submit.prevent="enableRemoteAccess">
        <h3>確認啟用遠端存取</h3>
        <p>將透過 Tailscale Serve 開放 OMW 與目前 Instance port 範圍給 Tailnet policy 允許的裝置。OpenCode ports 沒有額外帳密保護，請確認 Tailnet 裝置存取政策。OMW 會要求 Basic 登入，並保存非機密設定，下次啟動自動註冊。</p>
        <p>請使用目前 OMW 帳號與密碼確認。只使用已安裝且已登入的 Tailscale，不會啟用 Funnel。</p>
        <label><span>目前 OMW 帳號</span><Input v-model="remoteEnableUsername" autocomplete="username" required :disabled="connectivityRegistering" /></label>
        <label><span>目前 OMW 密碼</span><Input v-model="remoteEnablePassword" type="password" autocomplete="current-password" required :disabled="connectivityRegistering" /></label>
        <p v-if="remoteEnableError" role="alert">{{ remoteEnableError }}</p>
        <div class="connectivity-actions">
          <Button type="button" variant="outline" :disabled="connectivityRegistering" @click="cancelRemoteEnable">取消</Button>
          <Button type="submit" :disabled="connectivityRegistering">{{ connectivityRegistering ? '啟用中…' : '同意並啟用' }}</Button>
        </div>
      </form>
      <div v-if="connectivityFallbackOpen && remoteUrl" ref="connectivityFallback" class="connectivity-copy-fallback" role="status">
        <label for="connectivity-copy-url">{{ connectivityCopyMessage }}</label>
        <Input id="connectivity-copy-url" :model-value="remoteUrl" readonly aria-label="手動複製遠端入口" @focus="($event.target as HTMLInputElement).select()" />
      </div>
      <details class="connectivity-details">
        <summary>連線詳細資料</summary>
        <dl>
          <div><dt>Local endpoint</dt><dd><code>{{ localUrl }}</code></dd></div>
          <div><dt>OMW Manager version</dt><dd><code>{{ connectivity?.manager.version ?? '未知' }}</code></dd></div>
          <div><dt>Tailscale version</dt><dd><code>{{ connectivity?.tailscale.version ?? '未知' }}</code></dd></div>
          <div><dt>Node version</dt><dd><code>{{ connectivity?.nodeVersion ?? '未知' }}</code></dd></div>
          <div><dt>Serve manager match</dt><dd>{{ managerMappingLabel(connectivity?.serve.managerMapped) }}</dd></div>
          <div><dt>Instance ports matched</dt><dd><code>{{ connectivity?.serve.mappedInstancePorts ?? '未知' }} / {{ connectivity?.serve.expectedInstancePorts ?? '未知' }}</code></dd></div>
          <div><dt>checkedAt</dt><dd><time :datetime="connectivity?.checkedAt">{{ checkedAtLabel(connectivity?.checkedAt) }}</time></dd></div>
        </dl>
        <p>本機 Tailscale 在線只代表這台電腦，不代表手機已連上 Tailnet。Serve 映射吻合也僅代表設定一致，不保證手機目前可達。</p>
      </details>
    </section>

    <section
      v-if="overviewLastSucceededAt || overviewError"
      class="overview-freshness"
      :data-state="overviewFreshnessState"
      role="status"
    >
      <AlertTriangleIcon v-if="overviewFreshnessState === 'stale' || overviewFreshnessState === 'unavailable'" />
      <div>
        <strong v-if="overviewFreshnessState === 'unavailable'">尚未取得執行個體資料</strong>
        <strong v-else-if="overviewFreshnessState === 'stale'">資料已過期，最後更新 <time :datetime="overviewLastSucceededAt">{{ checkedAtLabel(overviewLastSucceededAt) }}</time></strong>
        <span v-else>資料最後更新 <time :datetime="overviewLastSucceededAt">{{ checkedAtLabel(overviewLastSucceededAt) }}</time></span>
        <small v-if="overviewError">{{ overviewError }}</small>
      </div>
      <Button v-if="overviewError" variant="outline" size="sm" class="no-press-transform" :disabled="loading" @click="loadOverview(true, 'user')">
        <RefreshCwIcon :class="{ spin: loading }" />重試更新
      </Button>
    </section>

    <section class="workspace">
      <aside class="instance-pane">
        <form class="search-row" @submit.prevent="loadOverview(true, 'user')">
          <Input v-model="query" placeholder="搜尋 Project、path、Instance、Session" aria-label="搜尋" />
          <Button type="submit" variant="outline" size="icon" class="no-press-transform" aria-label="執行搜尋"><SearchIcon /></Button>
        </form>
        <div class="filters" role="group" aria-label="Instance 篩選">
          <button v-for="item in filters" :key="item.value" type="button" :class="{ active: filter === item.value }" @click="setFilter(item.value)">{{ item.label }}</button>
        </div>
        <label class="hidden-toggle">
          <input v-model="includeHidden" type="checkbox" @change="loadOverview(true, 'user')">
          <span>顯示已停止追蹤</span>
        </label>
        <div v-if="loading" class="loading-copy"><LoaderCircleIcon class="spin" />讀取 Manager API…</div>
        <div class="instance-list" tabindex="-1">
          <section v-for="(group, groupIndex) in projectGroups" :key="group.key" class="project-group">
            <header class="project-group-head" :title="group.directory">
              <FolderIcon />
              <span><strong>{{ group.name }}</strong><code>{{ group.directory }}</code></span>
              <b>{{ group.instances.length }}</b>
            </header>
            <button
              v-for="instance in group.activeInstances"
              :key="instance.id"
              type="button"
              class="instance-row"
              :class="{ selected: selectedId === instance.id }"
              :data-instance-id="instance.id"
              :aria-label="instanceRowLabel(instance)"
              @click="choose(instance)"
            >
              <span class="state-dot" :data-category="statusCategory(instance)" />
              <span class="instance-copy">
                <span class="instance-title-line"><code class="instance-pid">{{ instancePid(instance) }}</code><strong :title="instanceTitle(instance)">{{ instanceTitle(instance) }}</strong></span>
              </span>
              <span class="instance-meta"><b :data-category="statusCategory(instance)">{{ statusHeadline(instance) }}</b><span>{{ statusContext(instance) }}</span></span>
            </button>
            <template v-if="group.stoppedInstances.length">
              <button
                type="button"
                class="history-toggle"
                :aria-expanded="historyExpanded(group)"
                :aria-controls="`instance-history-${groupIndex}`"
                @click="toggleHistory(group.key)"
              >
                <ChevronDownIcon :class="{ rotated: historyExpanded(group) }" />已停止紀錄 ({{ group.stoppedInstances.length }})
              </button>
              <div v-show="historyExpanded(group)" :id="`instance-history-${groupIndex}`" class="history-list">
                <button
                  v-for="instance in group.stoppedInstances"
                  :key="instance.id"
                  type="button"
                  class="instance-row"
                  :class="{ selected: selectedId === instance.id }"
                  :data-instance-id="instance.id"
                  :aria-label="instanceRowLabel(instance)"
                  @click="choose(instance)"
                >
                  <span class="state-dot" :data-category="statusCategory(instance)" />
                  <span class="instance-copy">
                    <span class="instance-title-line"><code class="instance-pid">{{ instancePid(instance) }}</code><strong :title="instanceTitle(instance)">{{ instanceTitle(instance) }}</strong></span>
                  </span>
                  <span class="instance-meta"><b :data-category="statusCategory(instance)">{{ statusHeadline(instance) }}</b><span>{{ statusContext(instance) }}</span></span>
                </button>
              </div>
            </template>
          </section>
        </div>
        <div v-if="!loading && overview.instances.length === 0" class="instance-empty">
          <template v-if="appliedQuery.trim() || appliedFilter !== 'all'">
            <p>沒有符合目前搜尋或篩選條件的執行個體。</p>
            <Button variant="outline" @click="clearOverviewFilters">清除篩選</Button>
          </template>
          <template v-else>
            <p>目前還沒有執行個體。</p>
            <Button variant="success" @click="openStartPanel"><PlusIcon />啟動執行個體</Button>
          </template>
        </div>
      </aside>

      <main ref="detailPane" class="detail-pane" tabindex="-1">
        <template v-if="selected">
          <Button variant="ghost" class="mobile-back no-press-transform" @click="returnToList"><ChevronLeftIcon />返回列表</Button>
          <div class="detail-head">
            <div>
              <p class="eyebrow">PROJECT / INSTANCE</p>
              <h2>{{ detailTitle(selected) }}</h2>
              <p v-if="selected.primarySession" class="detail-folder">{{ projectFolderName(selected.projectDirectory) }}</p>
              <p v-else class="detail-unbound">尚未綁定主 Session</p>
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
                <Settings2Icon />執行個體操作<ChevronDownIcon :class="{ rotated: lifecycleOpen }" />
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
              <p id="instance-lifecycle-title">執行個體操作</p>
              <span>{{ selected.kind === 'local-tui' ? '來源：Local TUI' : '來源：背景執行個體' }} · {{ instancePid(selected) }}</span>
            </div>
            <p class="lifecycle-note">接續對話會啟動新的背景程序與 PID，並接續已綁定的主要 Session；不停止舊程序，也不傳送模型訊息。</p>
            <p v-if="recoveryDiagnostic" class="lifecycle-diagnostic" role="alert"><AlertTriangleIcon />{{ recoveryDiagnostic }}</p>
            <div class="lifecycle-actions">
              <Button variant="destructive" size="sm" :disabled="overviewMutationsBlocked || Boolean(lifecyclePending) || !selected.stopAllowed" @click="stopInstance(selected)">
                <CircleStopIcon />{{ actionPending('stop') ? '停止中…' : '停止執行個體' }}
              </Button>
              <Button variant="outline" size="sm" :disabled="overviewMutationsBlocked || Boolean(lifecyclePending) || !recoveryActionAllowed('recheck')" @click="recheckInstance(selected)">
                <RefreshCwIcon :class="{ spin: actionPending('recheck') }" />{{ actionPending('recheck') ? '重新檢查中…' : '重新檢查' }}
              </Button>
              <Button v-if="selected.state === 'stopped' && !selected.primarySession" variant="success" size="sm" :disabled="overviewMutationsBlocked || Boolean(lifecyclePending)" @click="startFreshInstance(selected)">
                <PlayIcon />{{ actionPending('start') ? '啟動中…' : '啟動' }}
              </Button>
              <Button variant="success" size="sm" :disabled="overviewMutationsBlocked || Boolean(lifecyclePending) || !recoveryActionAllowed('resume')" @click="resumeInstance(selected)">
                <PlayIcon />{{ actionPending('resume') ? '接續中…' : '接續對話' }}
              </Button>
              <Button variant="outline" size="sm" :disabled="overviewMutationsBlocked || Boolean(lifecyclePending) || !recoveryActionAllowed('tracking')" @click="setInstanceTracking(selected, !selected.trackingHidden)">
                <EyeIcon v-if="selected.trackingHidden" /><EyeOffIcon v-else />{{ actionPending('tracking') ? '更新中…' : selected.trackingHidden ? '恢復追蹤' : '停止追蹤' }}
              </Button>
              <Button variant="outline" size="sm" class="remove-instance-button" :disabled="overviewMutationsBlocked || Boolean(lifecyclePending) || !recoveryActionAllowed('remove')" @click="removeInstance(selected)">
                <Trash2Icon />{{ actionPending('remove') ? '移除中…' : '移除紀錄' }}
              </Button>
            </div>
            <p v-if="lifecyclePending" class="lifecycle-reason" role="status">不可用原因：正在處理操作，請稍候</p>
            <p v-else-if="lifecycleUnavailableReasons.length" class="lifecycle-reason">
              不可用原因：<span v-for="item in lifecycleUnavailableReasons" :key="item.label">{{ item.label }}：{{ item.reason }}</span>
            </p>
            <p v-if="lifecycleError" class="lifecycle-error" role="alert"><AlertTriangleIcon />{{ lifecycleError }}</p>
          </section>
          <div class="primary-session-card" :class="{ unbound: !selected.primarySession }">
            <span class="primary-session-label">主要 Session</span>
            <template v-if="selected.primarySession">
              <strong>{{ selected.primarySession.title }}</strong>
              <code class="primary-session-id">{{ shortId(selected.primarySession.sessionId) }}</code>
              <small>{{ primarySourceLabel(selected.primarySession.source) }}綁定</small>
            </template>
            <strong v-else>尚未綁定主 Session</strong>
          </div>
          <p v-if="statusCategory(selected) === 'attention'" class="status-attention primary-session-attention"><AlertTriangleIcon />{{ attentionSummary(selected) }}</p>
          <p v-else-if="selected.state === 'ready' && selected.primarySummary.scope === 'unknown'" class="inline-error primary-session-attention"><AlertTriangleIcon />無法確認主 Session 工作範圍。</p>
          <div class="detail-actions primary-actions">
            <Button :disabled="opening || selected.state !== 'ready' || !selected.primarySession" @click="openPrimarySession(selected)"><ExternalLinkIcon />{{ opening ? '連線中…' : '進入主 Session' }}</Button>
            <Button variant="outline" class="new-session-button" :disabled="overviewMutationsBlocked || opening || selected.state !== 'ready'" @click="openNewSession(selected)"><PlusIcon />{{ opening ? '連線中…' : 'New Session' }}</Button>
          </div>
          <details class="main-session-details">
            <summary>主要 Session 綁定說明</summary>
            <p>主要 Session 固定綁定於這個 Instance；一般活動與 Project 共用歷史不會自動改綁。只有 New Session 或進階手動切換會更新。</p>
          </details>
          <details :key="`technical-${selected.id}`" class="technical-info">
            <summary>Technical info</summary>
            <div class="identity-strip">
              <span><small>INSTANCE</small><code>{{ selected.id }}</code></span>
              <span><small>ENDPOINT</small><code>127.0.0.1:{{ selected.port }}</code></span>
              <span><small>PID</small><code>{{ selected.pid ?? '未知' }}</code></span>
              <span><small>VERSION</small><code>{{ selected.healthVersion ?? '未知' }}</code></span>
            </div>
          </details>
          <div class="summary-grid">
            <article><ActivityIcon /><span><small>主 Session 範圍</small><strong>{{ count(selected.primarySummary.busySessions) }}</strong><b>執行中 Session</b></span></article>
            <article><span class="summary-mark">Q</span><span><small>主 Session request</small><strong>{{ count(selected.primarySummary.pendingQuestions) }}</strong><b>待回答</b></span></article>
            <article><span class="summary-mark">P</span><span><small>主 Session request</small><strong>{{ count(selected.primarySummary.pendingPermissions) }}</strong><b>待授權</b></span></article>
          </div>
          <p v-if="selected.primarySummary.scope === 'known' && selected.primarySummary.busySessions === 0 && selected.primarySummary.retrySessions === 0" class="status-note">主 Session 工作範圍目前沒有執行中的 Session；請查看對話並決定下一步。</p>
          <p v-if="selected.primarySummary.scope === 'known' && selected.primarySummary.busySessions === 0 && (selected.primarySummary.retrySessions ?? 0) > 0" class="status-note">主 Session 工作範圍正在重試。</p>
          <p v-if="selected.primarySummary.activity === 'unknown'" class="inline-error">主 Session 摘要未知：{{ selected.primarySummary.error ?? 'endpoint 無法連線' }}</p>
          <p v-if="selected.remoteUrlUnavailableReason" class="inline-error">Remote URL unavailable：{{ selected.remoteUrlUnavailableReason }}</p>
          <p v-if="selected.error" class="inline-error">{{ selected.error }}</p>

          <details :key="selected.id" class="advanced-sessions">
            <summary>Main / Child Session 歷史</summary>
            <section class="sessions-panel">
              <div class="section-heading"><div><p class="eyebrow">PROJECT METADATA</p><h3>Main Session</h3></div><Button variant="ghost" size="sm" class="no-press-transform" @click="loadSessions"><RefreshCwIcon :class="{ spin: sessionsLoading }" />重新載入</Button></div>
              <p class="scope-note">Session metadata 可由同 Project 多個 Instance 共用，不代表主要 Session 綁定或執行 ownership。</p>
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
              <nav v-if="sessions.roots.length" class="session-pagination" aria-label="Main Session 分頁">
                <Button variant="outline" size="sm" :disabled="sessionPage === 1" @click="sessionPage--">上一頁</Button>
                <span>第 {{ sessionPage }} / {{ sessionPageCount }} 頁</span>
                <Button variant="outline" size="sm" :disabled="sessionPage === sessionPageCount" @click="sessionPage++">下一頁</Button>
              </nav>
              <p v-if="sessionsError" class="inline-error">Main Session 載入失敗：{{ sessionsError }}</p>
              <p v-else-if="sessionsLoaded && !sessionsLoading && sessions.roots.length === 0" class="empty-copy">此 Project 尚無 Main Session。</p>
              <div v-if="sessions.unknownParent.length" class="unknown-parent">
                <h4><AlertTriangleIcon />父 Session 尚未載入</h4>
                <ul class="session-list">
                  <SessionTreeNode v-for="session in sessions.unknownParent" :key="`${selected.id}:${session.id}`" :instance-id="selected.id" :session="session" :open-disabled="selected.state !== 'ready' || opening" @open="openWeb(selected, $event)" />
                </ul>
              </div>
            </section>
          </details>
        </template>
        <div v-else class="detail-empty"><ServerIcon /><p>選擇執行個體以查看詳細狀態。</p></div>
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
    @pointerdown.self="closeStartPanel()"
  >
    <section
      ref="startPanel"
      class="start-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="start-panel-title"
      tabindex="-1"
    >
      <header class="start-panel-head">
        <div><p class="eyebrow">START INSTANCE</p><h2 id="start-panel-title">啟動執行個體</h2></div>
        <Button variant="ghost" size="icon" aria-label="關閉啟動面板" :disabled="mutating" @click="closeStartPanel()"><XIcon /></Button>
      </header>
      <div class="start-panel-body">
        <section class="shortcut-rail" aria-labelledby="shortcuts-title">
          <div class="section-heading">
            <div><p class="eyebrow">QUICK ACCESS</p><h3 id="shortcuts-title">目錄捷徑</h3></div>
            <span>{{ overview.shortcuts.length }} 個</span>
          </div>
          <div class="shortcut-list">
            <article v-for="shortcut in overview.shortcuts" :key="shortcut.id" class="shortcut-card">
              <button type="button" class="shortcut-main" @click="browse(shortcut.directory)">
                <FolderIcon /><span><strong>{{ shortcut.name }}</strong><code>{{ shortcut.directory }}</code></span>
              </button>
              <div class="shortcut-actions">
                <Button variant="ghost" size="icon" aria-label="編輯 Shortcut" @click="editShortcut(shortcut)"><PencilIcon /></Button>
                <Button variant="ghost" size="icon" aria-label="移除 Shortcut" @click="removeShortcut(shortcut)"><Trash2Icon /></Button>
              </div>
            </article>
            <p v-if="overview.shortcuts.length === 0" class="empty-copy">尚無目錄捷徑，仍可直接瀏覽既有目錄。</p>
          </div>
          <form class="shortcut-form" @submit.prevent="saveShortcut">
            <Input v-model="shortcutName" placeholder="捷徑名稱" aria-label="Shortcut 名稱" />
            <Input v-model="shortcutDirectory" placeholder="既有目錄路徑" aria-label="Shortcut 目錄" />
            <Button type="submit" :disabled="mutating" :aria-label="shortcutId ? '更新捷徑' : '新增目錄'"><FolderPlusIcon /><span class="button-label">{{ shortcutId ? '更新捷徑' : '新增目錄' }}</span></Button>
            <Button v-if="shortcutId" type="button" variant="ghost" @click="clearShortcutForm">取消</Button>
          </form>
        </section>

        <section class="browser-panel">
          <div class="section-heading"><div><p class="eyebrow">DIRECTORY</p><h3>瀏覽並啟動</h3></div></div>
          <form class="browse-form" @submit.prevent="browse(browserPath)">
            <Input v-model="browserPath" placeholder="輸入 OMW 程序可存取的目錄" aria-label="瀏覽目錄" />
            <Button type="submit" variant="outline" aria-label="瀏覽"><SearchIcon /><span class="button-label">瀏覽</span></Button>
          </form>
          <template v-if="listing">
            <div class="current-directory">
              <code>{{ listing.current }}</code>
              <Button variant="success" :disabled="mutating" @click="start(listing.current)"><PlusIcon />啟動全新 Instance</Button>
            </div>
            <button v-if="listing.parent" type="button" class="directory-row" @click="browse(listing.parent)"><ChevronLeftIcon />上層目錄</button>
            <button v-for="child in listing.children" :key="child.path" type="button" class="directory-row" @click="browse(child.path)"><FolderIcon />{{ child.name }}</button>
            <p v-for="item in listing.errors" :key="item.path" class="inline-error">{{ item.path }}：{{ item.message }}</p>
          </template>
        </section>
      </div>
    </section>
  </div>
  </Transition>

  <div v-if="managerSettingsOpen" class="start-panel-overlay manager-settings-overlay" @pointerdown.self="managerSettingsOpen = false">
    <section class="manager-settings" role="dialog" aria-modal="true" aria-labelledby="manager-settings-title">
      <header class="start-panel-head">
        <div><p class="eyebrow">MANAGER SETTINGS</p><h2 id="manager-settings-title">OMW 設定</h2></div>
        <Button variant="ghost" size="icon" aria-label="關閉 OMW 設定" :disabled="managerSettingsBusy" @click="managerSettingsOpen = false"><XIcon /></Button>
      </header>
      <div class="manager-settings-body">
        <form class="credential-form" @submit.prevent="updateManagerCredentials">
          <div><p class="eyebrow">ACCOUNT</p><h3>修改 OMW 帳號與密碼</h3></div>
          <p>本機與遠端模式都必須驗證目前密碼。更新不會變更 launcher token、資料目錄、SQLite 或 OpenCode Sessions。</p>
          <label><span>帳號</span><Input v-model="managerUsername" autocomplete="username" required /></label>
          <label><span>目前密碼</span><Input v-model="currentManagerPassword" type="password" autocomplete="current-password" required /></label>
          <label><span>新密碼（至少 16 字元）</span><Input v-model="nextManagerPassword" type="password" autocomplete="new-password" minlength="16" required /></label>
          <label><span>再次輸入新密碼</span><Input v-model="confirmManagerPassword" type="password" autocomplete="new-password" minlength="16" required /></label>
          <Button type="submit" :disabled="managerSettingsBusy">{{ managerSettingsBusy ? '更新中…' : '更新帳密' }}</Button>
        </form>
        <section class="manager-shutdown-panel">
          <div><p class="eyebrow">MANAGER LIFECYCLE</p><h3>停止 OMW</h3></div>
          <p>只停止管理介面。OpenCode TUI、背景執行個體、Sessions 與 Project 工作不會被停止或刪除。</p>
          <Button variant="destructive" :disabled="managerSettingsBusy" @click="stopManager"><PowerIcon />停止 OMW</Button>
        </section>
        <p v-if="managerSettingsError" class="lifecycle-error" role="alert"><AlertTriangleIcon />{{ managerSettingsError }}</p>
      </div>
    </section>
  </div>

  <ConfirmationDialog
    :open="Boolean(confirmation)"
    :title="confirmationDisplay?.title ?? ''"
    :description="confirmationDisplay?.description ?? ''"
    :confirm-label="confirmationDisplay?.confirmLabel ?? ''"
    :tone="confirmationDisplay?.tone ?? 'positive'"
    :busy="confirmationAccepting"
    :motion="currentStartPanelMotion()"
    :return-focus="confirmationReturnFocus"
    :fallback-focus="confirmationFallbackFocus()"
    @update:open="setConfirmationOpen"
    @confirm="acceptConfirmation"
    @after-leave="finishConfirmationLeave"
  />

  <div class="toast-region" aria-live="polite">
    <Transition name="toast"><div v-if="notice" class="toast toast-success" role="status">
      <span>{{ notice }}</span><button type="button" aria-label="關閉成功通知" @click="clearNotice"><XIcon /></button>
    </div></Transition>
    <Transition name="toast"><div v-if="actionError" class="toast toast-error" role="alert">
      <AlertTriangleIcon /><span>{{ actionError }}</span><button type="button" aria-label="關閉錯誤通知" @click="actionError = ''"><XIcon /></button>
    </div></Transition>
  </div>
  </div>
</template>
