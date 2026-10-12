<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue"
import { ActivityIcon, AlertTriangleIcon, CheckCircle2Icon, ChevronLeftIcon, CopyIcon, RefreshCwIcon, ServerIcon, WifiOffIcon } from "lucide-vue-next"
import { primarySessionDisposition } from "@omw/contracts"
import type { CoordinatorInstance, CoordinatorOverview, CoordinatorWorker } from "@omw/contracts"
import { coordinatorApi, createManagerApi, type ManagerApi } from "./api"
import App from "./App.vue"
import { Button } from "./components/ui/button"
import ConfirmationDialog from "./components/ui/dialog/ConfirmationDialog.vue"
import { useMessages } from "./i18n"

const { t, number, date } = useMessages()
const data = ref<CoordinatorOverview | null>(null)
const tab = ref<"instances" | "workers">("instances")
const workerFilter = ref("")
const loading = ref(false)
const failed = ref(false)
const checkFailed = ref(false)
const checking = ref(false)
const checkTarget = ref<CoordinatorWorker | null>(null)
const returnFocus = ref<HTMLElement | null>(null)
const copied = ref("")
const copyFailed = ref("")
const tabButtons = ref<HTMLButtonElement[]>([])
const workspaceHeading = ref<HTMLElement | null>(null)
const active = shallowRef<{ id: string; generation: string; initialInstanceId: string; api: ManagerApi; key: number } | null>(null)
let workspaceSequence = 0
let disposed = false
let generation = 0
let controller: AbortController | null = null
let checkController: AbortController | null = null
let timer: number | undefined
const workers = computed(() => data.value?.workers ?? [])
const filteredWorkers = computed(() => workers.value.filter(worker => !workerFilter.value || identity(worker) === workerFilter.value))
const rows = computed(() => (data.value?.instances ?? []).filter(row => !workerFilter.value || identity(row) === workerFilter.value))
const activeWorker = computed(() => workers.value.find(worker => worker.id === active.value?.id && worker.generation === active.value.generation) ?? null)
function identity(worker: { id: string; generation: string } | CoordinatorInstance) {
  return JSON.stringify(["workerId" in worker ? worker.workerId : worker.id, worker.generation])
}
function workerFor(row: CoordinatorInstance) { return workers.value.find(worker => worker.id === row.workerId && worker.generation === row.generation) }
function mutable(worker: CoordinatorWorker | null | undefined) {
  return Boolean(worker && worker.health === "online" && worker.freshness === "fresh" && !failed.value && !checking.value)
}
const startAllowed = computed(() => mutable(activeWorker.value) && activeWorker.value?.capacity?.state === "available")
function time(value: string | null | undefined) {
  const parsed = value ? new Date(value) : null
  return parsed && !Number.isNaN(parsed.getTime()) ? date(parsed) : t("coordinator.unknown")
}
function count(value: number | null | undefined) { return value == null ? t("coordinator.unknown") : number(value) }
function healthLabel(worker: CoordinatorWorker) {
  // endedAt 是後端已跨過寬限期的觀察；單次失敗不能由 UI 宣稱 Task 結束。
  if (worker.kind === "task" && worker.health === "offline" && worker.endedAt) return t("coordinator.taskEnded")
  return t(({ connecting: "coordinator.connecting", online: "coordinator.online", unstable: "coordinator.unstable", offline: "coordinator.offline" } as const)[worker.health])
}
function stateIcon(worker: CoordinatorWorker) {
  return worker.health === "online" ? CheckCircle2Icon : worker.health === "offline" ? WifiOffIcon : worker.health === "unstable" ? AlertTriangleIcon : RefreshCwIcon
}
function healthCount(health: CoordinatorWorker["health"]) {
  return data.value ? number(workers.value.filter(worker => worker.health === health).length) : t("coordinator.unknown")
}
function stale(row: CoordinatorInstance) { return failed.value || row.freshness !== "fresh" || !mutable(workerFor(row)) }
function summary(row: CoordinatorInstance) {
  const instance = row.instance
  if (instance.state !== "ready") return t(({
    stopped: "coordinator.stopped", starting: "coordinator.starting", failed: "coordinator.failed", unreachable: "coordinator.unreachable",
  } as const)[instance.state])
  const disposition = primarySessionDisposition(instance.primarySummary)
  if (disposition === "unknown") return t("coordinator.unknownScope")
  if (instance.primarySummary.scope === "unbound") return t("coordinator.unbound")
  return t("coordinator.activitySummary", {
    busy: count(instance.primarySummary.busySessions), questions: count(instance.primarySummary.pendingQuestions), permissions: count(instance.primarySummary.pendingPermissions),
  })
}
async function load() {
  if (disposed || checking.value) return
  const current = ++generation
  controller?.abort()
  const request = new AbortController()
  controller = request
  const timeout = window.setTimeout(() => request.abort(), 15_000)
  loading.value = true
  try {
    const next = await coordinatorApi.overview(request.signal)
    if (current !== generation || disposed) return
    data.value = next
    failed.value = false
  } catch {
    if (current === generation && !disposed) failed.value = true
  } finally {
    window.clearTimeout(timeout)
    if (current === generation && !disposed) loading.value = false
  }
}
function closeWorkspace() {
  active.value?.api.dispose()
  active.value = null
}
function applyFilter() { closeWorkspace() }
function viewInstances(worker: CoordinatorWorker) {
  closeWorkspace()
  workerFilter.value = identity(worker)
  tab.value = "instances"
}
async function openWorkspace(worker: CoordinatorWorker, initialInstanceId = "") {
  closeWorkspace()
  if (worker.health !== "online" && worker.health !== "unstable") return
  const id = worker.id, execution = worker.generation
  const client = createManagerApi(`/api/v1/coordinator/workers/${encodeURIComponent(id)}/${encodeURIComponent(execution)}/proxy`, () => {
    return !disposed && active.value?.api === client && mutable(workers.value.find(item => item.id === id && item.generation === execution))
  })
  active.value = { id, generation: execution, initialInstanceId, api: client, key: ++workspaceSequence }
  await nextTick()
  workspaceHeading.value?.focus()
}
watch(activeWorker, worker => {
  if (active.value && (!worker || worker.health === "offline" || worker.health === "connecting")) closeWorkspace()
}, { flush: "sync" })
function setTab(next: "instances" | "workers") { closeWorkspace(); tab.value = next }
function navigateTabs(event: KeyboardEvent) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
  event.preventDefault()
  const next = event.key === "Home" ? 0 : event.key === "End" ? 1 : tab.value === "instances" ? 1 : 0
  setTab(next === 0 ? "instances" : "workers")
  tabButtons.value[next]?.focus()
}
function requestCheck(worker: CoordinatorWorker) {
  returnFocus.value = document.activeElement instanceof HTMLElement ? document.activeElement : null
  checkTarget.value = worker
}
async function check() {
  const target = checkTarget.value
  checkTarget.value = null
  if (!target || checking.value || !workers.value.some(worker => identity(worker) === identity(target))) return
  // Check 不是 restart；不重送任何 Worker Start/Session/Stop。取消舊 overview，避免倒序覆蓋。
  checking.value = true
  generation++
  controller?.abort()
  loading.value = false
  checkFailed.value = false
  checkController = new AbortController()
  const timeout = window.setTimeout(() => checkController?.abort(), 15_000)
  try { await coordinatorApi.check(target.id, target.generation, checkController.signal) }
  catch { if (!disposed) checkFailed.value = true }
  finally {
    window.clearTimeout(timeout)
    checking.value = false
    if (!disposed) await load()
  }
}
async function copy(worker: CoordinatorWorker) {
  copied.value = ""; copyFailed.value = ""
  try {
    // 只複製明列的診斷欄位；不 dump generic response 或機器間認證。
    await navigator.clipboard.writeText(JSON.stringify({ id: worker.id, generation: worker.generation, address: worker.address, diagnosticCode: worker.diagnosticCode }, null, 2))
    copied.value = identity(worker)
  } catch { copyFailed.value = identity(worker) }
}
onMounted(() => {
  void load()
  timer = window.setInterval(() => { if (document.visibilityState === "visible" && !loading.value) void load() }, 10_000)
})
onBeforeUnmount(() => { disposed = true; generation++; window.clearInterval(timer); controller?.abort(); checkController?.abort(); closeWorkspace() })
</script>

<template>
  <div class="coordinator shell">
    <header class="coordinator-header">
      <div><h1>{{ t('ui.productName') }}</h1><p class="coordinator-role"><ServerIcon aria-hidden="true" />{{ t('coordinator.modeTitle') }}</p></div>
      <dl class="coordinator-counts" :aria-label="t('coordinator.connectionSummary')">
        <div><dt><CheckCircle2Icon aria-hidden="true" />{{ t('coordinator.online') }}</dt><dd>{{ healthCount('online') }}</dd></div>
        <div><dt><AlertTriangleIcon aria-hidden="true" />{{ t('coordinator.unstable') }}</dt><dd>{{ healthCount('unstable') }}</dd></div>
        <div><dt><WifiOffIcon aria-hidden="true" />{{ t('coordinator.offline') }}</dt><dd>{{ healthCount('offline') }}</dd></div>
        <div v-if="workers.some(worker => worker.health === 'connecting')"><dt>{{ t('coordinator.connecting') }}</dt><dd>{{ healthCount('connecting') }}</dd></div>
      </dl>
    </header>
    <nav :aria-label="t('coordinator.navigation')">
      <div class="coordinator-tabs" role="tablist" :aria-label="t('coordinator.navigation')" @keydown="navigateTabs">
        <button id="coordinator-instances-tab" :ref="el => tabButtons[0] = el as HTMLButtonElement" role="tab" :aria-selected="tab === 'instances'" aria-controls="coordinator-instances" :tabindex="tab === 'instances' ? 0 : -1" @click="setTab('instances')">{{ t('coordinator.instancesTab') }}</button>
        <button id="coordinator-workers-tab" :ref="el => tabButtons[1] = el as HTMLButtonElement" role="tab" :aria-selected="tab === 'workers'" aria-controls="coordinator-workers" :tabindex="tab === 'workers' ? 0 : -1" @click="setTab('workers')">{{ t('coordinator.workersTab') }}</button>
      </div>
    </nav>
    <div v-if="failed" class="coordinator-error" role="alert"><p>{{ data ? t('coordinator.staleError') : t('coordinator.overviewError') }}</p><Button variant="outline" :disabled="loading || checking" @click="load">{{ t('coordinator.retry') }}</Button></div>
    <div v-else-if="checkFailed" class="coordinator-error" role="alert"><p>{{ t('coordinator.checkError') }}</p><Button variant="outline" :disabled="loading || checking" @click="load">{{ t('coordinator.reload') }}</Button></div>
    <p v-if="loading && !data" class="coordinator-empty" role="status">{{ t('coordinator.loading') }}</p>
    <p v-if="data && !workers.length" class="coordinator-empty">{{ t('coordinator.noWorkers') }}</p>
    <section v-show="tab === 'instances'" id="coordinator-instances" role="tabpanel" aria-labelledby="coordinator-instances-tab" tabindex="0">
      <template v-if="data && workers.length">
        <div class="coordinator-toolbar">
          <label for="coordinator-worker-filter">{{ t('coordinator.filterWorker') }}</label>
          <select id="coordinator-worker-filter" v-model="workerFilter" @change="applyFilter"><option value="">{{ t('coordinator.allWorkers') }}</option><option v-for="worker in workers" :key="identity(worker)" :value="identity(worker)">{{ worker.name }}</option></select>
          <span>{{ t('coordinator.visibleInstances', { count: number(rows.length) }) }}</span>
        </div>
        <div v-if="workerFilter" class="coordinator-worker-context" v-for="worker in filteredWorkers" :key="identity(worker)">
          <h2>{{ worker.name }}</h2><span>{{ healthLabel(worker) }}</span>
          <Button v-if="mutable(worker) && worker.capacity?.state === 'available'" variant="outline" @click="openWorkspace(worker)">{{ t('coordinator.manageWorker') }}</Button>
        </div>
        <p v-for="worker in filteredWorkers.filter(worker => worker.instanceCount === null)" :key="identity(worker)" class="coordinator-note">{{ t('coordinator.unknownInstances', { name: worker.name }) }}</p>
        <p v-if="!rows.length" class="coordinator-empty">{{ t('coordinator.noInstances') }}</p>
        <div class="coordinator-instance-list">
          <article v-for="row in rows" :key="identity(row) + row.instance.id" class="coordinator-instance" :data-worker-id="row.workerId" :data-generation="row.generation" :data-instance-id="row.instance.id">
            <div class="coordinator-instance-copy"><h2>{{ row.instance.primarySession?.title ?? row.instance.projectName }}</h2><code>{{ row.instance.projectDirectory }}</code><p>{{ t('coordinator.sourceWorker', { name: row.workerName }) }}</p><code class="coordinator-id">{{ row.instance.id }}</code></div>
            <div class="coordinator-instance-status"><p><ActivityIcon aria-hidden="true" />{{ summary(row) }}</p><p v-if="stale(row)" class="coordinator-warning">{{ t('coordinator.lastKnown', { time: time(row.observedAt) }) }}</p><p class="coordinator-note">{{ row.instance.primarySession ? t('coordinator.todosDetail') : t('coordinator.unbound') }}</p></div>
            <Button v-if="workerFor(row)?.health === 'online' || workerFor(row)?.health === 'unstable'" variant="outline" @click="openWorkspace(workerFor(row)!, row.instance.id)">{{ t('coordinator.viewDetails') }}</Button>
            <p v-else class="coordinator-note">{{ t('coordinator.offlineRead') }}</p>
          </article>
        </div>
      </template>
      <section v-if="active && activeWorker" class="coordinator-workspace" :aria-label="t('coordinator.workerWorkspace', { name: activeWorker.name })">
        <header><Button variant="ghost" @click="closeWorkspace"><ChevronLeftIcon aria-hidden="true" />{{ t('coordinator.closeWorkspace') }}</Button><h2 ref="workspaceHeading" tabindex="-1">{{ t('coordinator.workerWorkspace', { name: activeWorker.name }) }}</h2><code>{{ activeWorker.generation }}</code></header>
        <App :key="active.key" :api="active.api" embedded :initial-instance-id="active.initialInstanceId" :worker-context="{ name: activeWorker.name, id: activeWorker.id, generation: activeWorker.generation, nativeOrigin: activeWorker.nativeOrigin }" :mutation-allowed="mutable(activeWorker)" :start-allowed="startAllowed" />
      </section>
    </section>
    <section v-show="tab === 'workers'" id="coordinator-workers" role="tabpanel" aria-labelledby="coordinator-workers-tab" tabindex="0">
      <div class="coordinator-workers">
        <article v-for="worker in workers" :key="identity(worker)" class="coordinator-worker" :data-worker-id="worker.id" :data-generation="worker.generation">
          <header><h2>{{ worker.name }}</h2><p class="coordinator-health" :data-health="worker.health"><component :is="stateIcon(worker)" aria-hidden="true" />{{ healthLabel(worker) }}</p></header>
          <p>{{ worker.kind === 'task' ? t('coordinator.task') : t('coordinator.resident') }}</p>
          <p>{{ t('coordinator.instanceCount', { count: count(worker.instanceCount) }) }}</p>
          <p v-if="worker.freshness === 'unknown'" class="coordinator-note">{{ t('coordinator.waitingData') }}</p>
          <p v-else-if="failed || worker.freshness !== 'fresh'" class="coordinator-warning">{{ t('coordinator.lastKnown', { time: time(worker.dataUpdatedAt) }) }}</p>
          <p>{{ t('coordinator.lastSuccess', { time: time(worker.lastHealthyAt) }) }}</p>
          <div class="coordinator-worker-actions"><Button variant="outline" @click="viewInstances(worker)">{{ t('coordinator.viewInstances') }}</Button><Button variant="ghost" :disabled="checking" @click="requestCheck(worker)"><RefreshCwIcon aria-hidden="true" />{{ t('coordinator.recheck') }}</Button></div>
          <details><summary>{{ t('coordinator.details') }}</summary><dl><div><dt>{{ t('coordinator.address') }}</dt><dd><code>{{ worker.address }}</code></dd></div><div><dt>{{ t('coordinator.generation') }}</dt><dd><code>{{ worker.generation }}</code></dd></div><div><dt>{{ t('coordinator.diagnosticCode') }}</dt><dd><code>{{ worker.diagnosticCode ?? t('coordinator.noDiagnostic') }}</code></dd></div></dl><Button variant="ghost" @click="copy(worker)"><CopyIcon aria-hidden="true" />{{ t('coordinator.copyDiagnostic') }}</Button><p v-if="copied === identity(worker)" role="status">{{ t('coordinator.copied') }}</p><p v-if="copyFailed === identity(worker)" role="alert">{{ t('coordinator.copyError') }}</p></details>
        </article>
      </div>
    </section>
    <ConfirmationDialog :open="Boolean(checkTarget)" :title="t('coordinator.recheck')" :description="checkTarget ? t('coordinator.checkDescription', { name: checkTarget.name, id: checkTarget.id, generation: checkTarget.generation }) : ''" :confirm-label="t('coordinator.recheck')" tone="caution" :return-focus="returnFocus" @update:open="open => { if (!open) checkTarget = null }" @confirm="check" />
  </div>
</template>

<style scoped>
.coordinator { color: #e7ebed; }
.coordinator-header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 20px; padding: 12px 0 22px; border-bottom: 1px solid #2c3236; }
.coordinator-role { display: flex; align-items: center; gap: 8px; margin-top: 7px; color: #b6e4e1; font-size: .9rem; }
.coordinator svg { width: 17px; height: 17px; flex: 0 0 17px; }
.coordinator-counts { display: flex; flex-wrap: wrap; gap: 12px 24px; margin: 0; font-variant-numeric: tabular-nums; }
.coordinator-counts > div { display: flex; gap: 8px; align-items: center; }
.coordinator-counts dt { display: flex; align-items: center; gap: 6px; color: #aeb8bd; font-size: .8rem; }
.coordinator-counts dd { margin: 0; font-weight: 600; }
.coordinator-tabs { display: flex; gap: 24px; margin-bottom: 20px; border-bottom: 1px solid #30373b; }
.coordinator-tabs button { min-height: 52px; border: 0; border-bottom: 2px solid transparent; color: #aeb8bd; background: transparent; font-weight: 600; }
.coordinator-tabs button[aria-selected="true"] { border-bottom-color: #50c8c6; color: #bdf0ee; }
.coordinator-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 18px; font-size: .85rem; }
.coordinator-toolbar select { min-width: 160px; max-width: 100%; min-height: 44px; padding: 6px 10px; border: 1px solid #354047; background: #171b1e; color: #e7ebed; }
.coordinator-toolbar > span { color: #aeb8bd; margin-left: auto; }
.coordinator-instance-list { border: 1px solid #30373b; background: #111416; }
.coordinator-instance { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 180px; align-items: center; gap: 18px; padding: 20px; }
.coordinator-instance > button { justify-self: end; }
.coordinator-tabs button:hover { color: #e7ebed; }
.coordinator select:focus-visible, .coordinator details summary:focus-visible { outline: 2px solid #50c8c6; outline-offset: 3px; }
.coordinator-instance + .coordinator-instance { border-top: 1px solid #30373b; }
.coordinator-instance-copy, .coordinator-instance-status { display: grid; min-width: 0; gap: 7px; overflow-wrap: anywhere; }
.coordinator-instance-copy code { font-size: .78rem; color: #aeb8bd; }
.coordinator-instance-copy p { color: #b6e4e1; font-size: .85rem; }
.coordinator-instance-copy .coordinator-id { font-size: .7rem; }
.coordinator-instance-status > p:first-child { display: flex; align-items: flex-start; gap: 8px; font-size: .85rem; }
.coordinator-note { color: #aeb8bd; font-size: .8rem; line-height: 1.6; }
.coordinator-warning { color: #e2b36e; font-size: .8rem; line-height: 1.6; }
.coordinator-empty { padding: 28px 0; color: #aeb8bd; max-width: 65ch; line-height: 1.7; }
.coordinator-error { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 14px; border: 1px solid #765b2f; background: #211a12; color: #f0c77f; margin: 0 0 18px; }
.coordinator-workers { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 360px), 1fr)); gap: 16px; }
.coordinator-worker { min-width: 0; border: 1px solid #30373b; background: #111416; padding: 18px; }
.coordinator-worker > header { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.coordinator-worker h2 { overflow-wrap: anywhere; }
.coordinator-worker > p { margin-top: 8px; color: #aeb8bd; font-size: .83rem; line-height: 1.5; }
.coordinator-health { display: flex; align-items: flex-start; gap: 6px; color: #aeb8bd; font-size: .83rem; }
.coordinator-health[data-health="online"] { color: #8bddaa; }
.coordinator-health[data-health="unstable"] { color: #f0c77f; }
.coordinator-worker-actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 18px 0 12px; }
.coordinator-worker details { border-top: 1px solid #30373b; padding-top: 10px; color: #aeb8bd; font-size: .8rem; }
.coordinator-worker summary { cursor: pointer; min-height: 36px; align-content: center; }
.coordinator-worker dl { display: grid; gap: 12px; }
.coordinator-worker dd { margin: 4px 0 0; overflow-wrap: anywhere; color: #e7ebed; }
.coordinator-workspace { margin-top: 24px; border-top: 1px solid #354047; }
.coordinator-workspace > header, .coordinator-worker-context { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 14px 0; }
.coordinator-workspace > header code { color: #aeb8bd; overflow-wrap: anywhere; font-size: .75rem; }
.coordinator-workspace :deep(.shell) { padding: 0; }
.coordinator-workspace :deep(.app-root[data-mobile-view="detail"]) { padding-top: 0; }
.coordinator ::selection { color: #e7ebed; background: #173d3c; }
@media (max-width: 860px) {
  .coordinator { padding: 16px; }
  .coordinator-header { align-items: flex-start; gap: 18px; }
  .coordinator-counts { gap: 12px 18px; }
  .coordinator-instance { grid-template-columns: minmax(0, 1fr); gap: 16px; padding: 18px 14px; }
  .coordinator-instance > button { justify-self: start; }
  .coordinator-toolbar { display: grid; grid-template-columns: auto minmax(0, 1fr); }
  .coordinator-toolbar > span { grid-column: 1 / -1; margin-left: 0; }
}
</style>
