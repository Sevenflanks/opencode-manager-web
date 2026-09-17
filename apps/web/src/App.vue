<script setup lang="ts">
import type { DirectoryListing, DirectoryShortcut, ManagedInstance, OverviewFilter, SessionRootsResponse } from "@omw/contracts"
import {
  ActivityIcon,
  AlertTriangleIcon,
  ChevronLeftIcon,
  CircleStopIcon,
  ExternalLinkIcon,
  FolderIcon,
  FolderPlusIcon,
  LoaderCircleIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  ServerIcon,
  Trash2Icon,
} from "lucide-vue-next"
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import { managerApi } from "@/api"
import SessionTreeNode from "@/components/SessionTreeNode.vue"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

const filters: Array<{ value: OverviewFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "active", label: "有執行中" },
  { value: "attention", label: "需處理" },
  { value: "unreachable", label: "無法連線" },
]
const overview = ref<{ shortcuts: DirectoryShortcut[]; instances: ManagedInstance[] }>({ shortcuts: [], instances: [] })
const query = ref("")
const filter = ref<OverviewFilter>("all")
const selectedId = ref("")
const loading = ref(true)
const mutating = ref(false)
const error = ref("")
const notice = ref("")
const shortcutId = ref<string | null>(null)
const shortcutName = ref("")
const shortcutDirectory = ref("")
const browserPath = ref("")
const listing = ref<DirectoryListing | null>(null)
const sessions = ref<SessionRootsResponse>({ roots: [], unknownParent: [] })
const sessionsLoading = ref(false)
let pollTimer: number | undefined

const selected = computed(() => overview.value.instances.find((instance) => instance.id === selectedId.value) ?? null)

onMounted(async () => {
  await loadOverview()
  pollTimer = window.setInterval(() => void loadOverview(false), 5_000)
})
onBeforeUnmount(() => window.clearInterval(pollTimer))

async function loadOverview(showLoading = true): Promise<void> {
  if (showLoading) loading.value = true
  try {
    overview.value = await managerApi.overview(query.value, filter.value)
    if (!overview.value.instances.some((item) => item.id === selectedId.value)) {
      selectedId.value = overview.value.instances[0]?.id ?? ""
      if (selectedId.value) await loadSessions()
    }
    error.value = ""
  } catch (cause) {
    error.value = message(cause)
  } finally {
    loading.value = false
  }
}

async function choose(instance: ManagedInstance): Promise<void> {
  selectedId.value = instance.id
  await loadSessions()
}

async function loadSessions(): Promise<void> {
  if (!selectedId.value) return
  sessionsLoading.value = true
  try {
    sessions.value = await managerApi.sessions(selectedId.value)
  } catch (cause) {
    sessions.value = { roots: [], unknownParent: [] }
    error.value = message(cause)
  } finally {
    sessionsLoading.value = false
  }
}

async function setFilter(value: OverviewFilter): Promise<void> {
  filter.value = value
  await loadOverview()
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
    notice.value = "Directory Shortcut 已儲存。"
    await loadOverview(false)
  })
}

async function removeShortcut(shortcut: DirectoryShortcut): Promise<void> {
  if (!window.confirm(`移除「${shortcut.name}」？既有 Instance 不會被停止。`)) return
  await mutate(async () => {
    await managerApi.deleteShortcut(shortcut.id)
    notice.value = "Shortcut 已移除；Instance 未受影響。"
    await loadOverview(false)
  })
}

async function browse(directory: string): Promise<void> {
  try {
    listing.value = await managerApi.browse(directory)
    browserPath.value = listing.value.current
    error.value = ""
  } catch (cause) {
    error.value = message(cause)
  }
}

async function start(directory: string): Promise<void> {
  await mutate(async () => {
    const instance = await managerApi.start(directory)
    notice.value = `Instance ${shortId(instance.id)} 已由真實 health 證明 ready。`
    await loadOverview(false)
    await choose(instance)
  })
}

async function stop(instance: ManagedInstance): Promise<void> {
  if (!window.confirm(`停止 ${instance.projectName} 的 Instance ${shortId(instance.id)}？`)) return
  await mutate(async () => {
    await managerApi.stop(instance.id)
    notice.value = "已核對 process identity 並停止背景 Instance。"
    await loadOverview(false)
  })
}

async function openWeb(instance: ManagedInstance, sessionId?: string): Promise<void> {
  try {
    const response = await managerApi.openUrl(instance.id, sessionId)
    window.open(response.url, "_blank", "noopener,noreferrer")
  } catch (cause) {
    error.value = message(cause)
  }
}

async function mutate(operation: () => Promise<void>): Promise<void> {
  mutating.value = true
  error.value = ""
  notice.value = ""
  try {
    await operation()
  } catch (cause) {
    error.value = message(cause)
  } finally {
    mutating.value = false
  }
}

function stateLabel(state: ManagedInstance["state"]): string {
  return { starting: "啟動中", ready: "可連線", failed: "啟動失敗", unreachable: "無法連線", stopped: "已停止" }[state]
}
function count(value: number | null): string { return value == null ? "未知" : String(value) }
function shortId(value: string): string { return value.slice(0, 8) }
function message(cause: unknown): string { return cause instanceof Error ? cause.message : "發生未知錯誤。" }
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <div>
        <p class="eyebrow">WINDOWS · LOOPBACK ONLY</p>
        <h1>OpenCode Manager</h1>
      </div>
      <Button variant="outline" size="sm" :disabled="loading" @click="loadOverview()">
        <RefreshCwIcon :class="{ spin: loading }" />重新整理
      </Button>
    </header>

    <div v-if="error" class="banner banner-error"><AlertTriangleIcon />{{ error }}</div>
    <div v-if="notice" class="banner banner-notice">{{ notice }}</div>

    <section class="shortcut-rail" aria-labelledby="shortcuts-title">
      <div class="section-heading">
        <div><p class="eyebrow">QUICK ACCESS</p><h2 id="shortcuts-title">Directory Shortcut</h2></div>
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
        <p v-if="overview.shortcuts.length === 0" class="empty-copy">尚無 Shortcut；這不會限制目錄瀏覽或既有 Instance。</p>
      </div>
      <form class="shortcut-form" @submit.prevent="saveShortcut">
        <Input v-model="shortcutName" placeholder="捷徑名稱" aria-label="Shortcut 名稱" />
        <Input v-model="shortcutDirectory" placeholder="既有目錄路徑" aria-label="Shortcut 目錄" />
        <Button type="submit" :disabled="mutating"><FolderPlusIcon />{{ shortcutId ? '更新捷徑' : '新增捷徑' }}</Button>
        <Button v-if="shortcutId" type="button" variant="ghost" @click="clearShortcutForm">取消</Button>
      </form>
    </section>

    <section class="browser-panel">
      <div class="section-heading"><div><p class="eyebrow">OS ACCESS</p><h2>目錄瀏覽與 Start</h2></div></div>
      <form class="browse-form" @submit.prevent="browse(browserPath)">
        <Input v-model="browserPath" placeholder="輸入 OMW process 可存取的目錄" aria-label="瀏覽目錄" />
        <Button type="submit" variant="outline"><SearchIcon />瀏覽</Button>
      </form>
      <template v-if="listing">
        <div class="current-directory">
          <code>{{ listing.current }}</code>
          <Button :disabled="mutating" @click="start(listing.current)"><PlusIcon />啟動全新 Instance</Button>
        </div>
        <button v-if="listing.parent" type="button" class="directory-row" @click="browse(listing.parent)"><ChevronLeftIcon />上層目錄</button>
        <button v-for="child in listing.children" :key="child.path" type="button" class="directory-row" @click="browse(child.path)"><FolderIcon />{{ child.name }}</button>
        <p v-for="item in listing.errors" :key="item.path" class="inline-error">{{ item.path }}：{{ item.message }}</p>
      </template>
    </section>

    <section class="workspace">
      <aside class="instance-pane">
        <form class="search-row" @submit.prevent="loadOverview()">
          <Input v-model="query" placeholder="搜尋 Project、path、Instance、Session" aria-label="搜尋" />
          <Button type="submit" variant="outline" size="icon" aria-label="執行搜尋"><SearchIcon /></Button>
        </form>
        <div class="filters" role="group" aria-label="Instance 篩選">
          <button v-for="item in filters" :key="item.value" type="button" :class="{ active: filter === item.value }" @click="setFilter(item.value)">{{ item.label }}</button>
        </div>
        <div v-if="loading" class="loading-copy"><LoaderCircleIcon class="spin" />讀取 Manager API…</div>
        <button
          v-for="instance in overview.instances"
          :key="instance.id"
          type="button"
          class="instance-row"
          :class="{ selected: selectedId === instance.id }"
          @click="choose(instance)"
        >
          <span class="state-dot" :data-state="instance.state" />
          <span class="instance-copy"><strong>{{ instance.projectName }}</strong><code>{{ instance.projectDirectory }}</code></span>
          <span class="instance-meta"><b>{{ stateLabel(instance.state) }}</b><code>{{ shortId(instance.id) }}</code></span>
        </button>
        <p v-if="!loading && overview.instances.length === 0" class="empty-copy">目前篩選下沒有 Instance。</p>
      </aside>

      <main class="detail-pane">
        <template v-if="selected">
          <div class="detail-head">
            <div><p class="eyebrow">PROJECT / INSTANCE</p><h2>{{ selected.projectName }}</h2><code>{{ selected.projectDirectory }}</code></div>
            <span class="state-chip" :data-state="selected.state">{{ stateLabel(selected.state) }}</span>
          </div>
          <div class="identity-strip">
            <span><small>INSTANCE</small><code>{{ selected.id }}</code></span>
            <span><small>ENDPOINT</small><code>127.0.0.1:{{ selected.port }}</code></span>
            <span><small>PID</small><code>{{ selected.pid ?? '未知' }}</code></span>
            <span><small>VERSION</small><code>{{ selected.healthVersion ?? '未知' }}</code></span>
          </div>
          <div class="summary-grid">
            <article><ActivityIcon /><span><small>此 Instance 回報</small><strong>{{ count(selected.summary.busySessions) }}</strong><b>執行中 Session</b></span></article>
            <article><span class="summary-mark">Q</span><span><small>request #</small><strong>{{ count(selected.summary.pendingQuestions) }}</strong><b>待回答</b></span></article>
            <article><span class="summary-mark">P</span><span><small>request #</small><strong>{{ count(selected.summary.pendingPermissions) }}</strong><b>待授權</b></span></article>
          </div>
           <p v-if="selected.summary.activity === 'none-reported'" class="status-note">此 Instance 成功回應，但未回報執行中。</p>
           <p v-if="selected.summary.activity === 'reported-non-busy'" class="status-note">此 Instance 回報已知的非 busy 狀態。</p>
           <p v-if="selected.summary.activity === 'unknown'" class="inline-error">摘要未知：{{ selected.summary.error ?? 'endpoint 無法連線' }}</p>
          <p v-if="selected.remoteUrlUnavailableReason" class="inline-error">Remote URL unavailable：{{ selected.remoteUrlUnavailableReason }}</p>
          <p v-if="selected.error" class="inline-error">{{ selected.error }}</p>
          <div class="detail-actions">
            <Button variant="outline" @click="openWeb(selected)"><ExternalLinkIcon />Open Web</Button>
            <Button variant="destructive" :disabled="mutating || !selected.stopAllowed" @click="stop(selected)"><CircleStopIcon />安全停止</Button>
          </div>

          <section class="sessions-panel">
            <div class="section-heading"><div><p class="eyebrow">PROJECT METADATA</p><h3>Main / Child Session</h3></div><Button variant="ghost" size="sm" @click="loadSessions"><RefreshCwIcon :class="{ spin: sessionsLoading }" />重新載入</Button></div>
            <p class="scope-note">Session metadata 可由同 Project 多個 Instance 共用，不代表執行 ownership。</p>
            <ul class="session-list">
              <SessionTreeNode v-for="session in sessions.roots" :key="`${selected.id}:${session.id}`" :instance-id="selected.id" :session="session" @open="openWeb(selected, $event)" />
            </ul>
            <p v-if="!sessionsLoading && sessions.roots.length === 0" class="empty-copy">沒有 Main Session。</p>
            <div v-if="sessions.unknownParent.length" class="unknown-parent">
              <h4><AlertTriangleIcon />父 Session 尚未載入</h4>
              <ul class="session-list">
                <SessionTreeNode v-for="session in sessions.unknownParent" :key="`${selected.id}:${session.id}`" :instance-id="selected.id" :session="session" @open="openWeb(selected, $event)" />
              </ul>
            </div>
          </section>
        </template>
        <div v-else class="detail-empty"><ServerIcon /><p>選擇 Instance 以查看 endpoint 可證明的資料。</p></div>
      </main>
    </section>
  </div>
</template>
