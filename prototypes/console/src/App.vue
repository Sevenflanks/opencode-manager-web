<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue"
import {
  CircleStopIcon,
  Clock3Icon,
  CommandIcon,
  FolderRootIcon,
  Globe2Icon,
  HeartPulseIcon,
  ListFilterIcon,
  RadioIcon,
  RotateCcwIcon,
  SearchIcon,
  ServerIcon,
  TerminalSquareIcon,
  ZapIcon,
} from "lucide-vue-next"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import ProjectSessionTree from "@/components/ProjectSessionTree.vue"

type Source = "tui" | "headless"
type Lifecycle = "running" | "stopped" | "unknown"
type Connection = "online" | "unreachable" | "stopped"
type Filter = "all" | "active" | "attention" | "unreachable"

interface ProjectSession {
  id: string
  title: string
  updated: string
  parentID?: string
}

interface SessionObservation {
  busy: boolean
  question: boolean
  permission: boolean
}

interface Project {
  id: string
  name: string
  path: string
  shortcut: string
  sessions: ProjectSession[]
}

interface ManagerEvent {
  time: string
  label: "啟動背景執行個體" | "登錄本機 TUI" | "Health check 成功" | "Health check 失敗" | "主動停止執行個體"
  tone?: "warning"
}

interface ConsoleInstance {
  id: string
  projectId: string
  source: Source
  ownedByManager: boolean
  lifecycle: Lifecycle
  connection: Connection
  endpoint: string
  pid: string
  port: string
  summaryApplicable: boolean
  summaryKnown: boolean
  sessionObservations: Record<string, SessionObservation>
  lastSuccessfulHealth: string
  lastHealthAttempt: string
  managerEvents: ManagerEvent[]
  demoStep: number
}

const projects: Project[] = [
  {
    id: "omw",
    name: "opencode-manager-web",
    path: "C:/work/opencode-manager-web",
    shortcut: "管理器主專案",
    sessions: [
      { id: "ses_8aa", title: "Prototype A 資訊收斂", updated: "14:42" },
      { id: "ses_shared_04", title: "狀態來源邊界驗證", updated: "14:31" },
      { id: "ses_8aa_child_01", parentID: "ses_8aa", title: "盤點 Session parent metadata", updated: "14:40" },
      { id: "ses_8aa_child_02", parentID: "ses_8aa", title: "核對 Instance scoped status", updated: "14:37" },
      { id: "ses_8aa_grandchild_01", parentID: "ses_8aa_child_01", title: "檢查巢狀展開行為", updated: "14:36" },
      { id: "ses_missing_parent_child_01", parentID: "ses_parent_not_loaded_9f3c", title: "保留未載入父節點的 Session", updated: "14:29" },
      { id: "ses_orphan_loaded_child_01", parentID: "ses_missing_parent_child_01", title: "未載入父節點案例的已載入子 Session", updated: "14:27" },
    ],
  },
  {
    id: "ledger",
    name: "ledger-sync",
    path: "C:/work/ledger-sync",
    shortcut: "帳務同步",
    sessions: [
      { id: "ses_7e1", title: "核對同步批次", updated: "13:58" },
      { id: "ses_2bf", title: "整理測試 fixture", updated: "13:44" },
      { id: "ses_7e1_child_01", parentID: "ses_7e1", title: "檢查批次差異", updated: "13:51" },
    ],
  },
  {
    id: "docs",
    name: "platform-handbook",
    path: "C:/work/platform-handbook",
    shortcut: "平台文件",
    sessions: [
      { id: "ses_441", title: "更新操作章節", updated: "12:26" },
      { id: "ses_441_child_01", parentID: "ses_441", title: "核對章節截圖", updated: "12:21" },
    ],
  },
  {
    id: "lab",
    name: "agent-lab",
    path: "D:/fixtures/agent-lab",
    shortcut: "實驗沙盒",
    sessions: [
      { id: "ses_a12", title: "比較 prompt fixture", updated: "14:06" },
      { id: "ses_a13", title: "檢查輸出差異", updated: "14:03" },
      { id: "ses_a12_child_01", parentID: "ses_a12", title: "整理比較結果", updated: "14:01" },
    ],
  },
]

const seedInstances: ConsoleInstance[] = [
  {
    id: "ins-7f2a", projectId: "omw", source: "headless", ownedByManager: true,
    lifecycle: "running", connection: "online", endpoint: "http://127.0.0.1:4096", pid: "18420", port: "4096",
    summaryApplicable: true, summaryKnown: true,
    sessionObservations: { ses_8aa_child_01: { busy: true, question: true, permission: false } },
    lastSuccessfulHealth: "14:42:18（假資料）", lastHealthAttempt: "14:42:18 成功（假資料）", demoStep: 1,
    managerEvents: [
      { time: "14:42:18", label: "Health check 成功" },
      { time: "14:38:09", label: "啟動背景執行個體" },
    ],
  },
  {
    id: "ins-15bc", projectId: "omw", source: "tui", ownedByManager: false,
    lifecycle: "running", connection: "online", endpoint: "http://127.0.0.1:4098", pid: "17604", port: "4098",
    summaryApplicable: true, summaryKnown: true,
    sessionObservations: {
      ses_8aa: { busy: true, question: false, permission: false },
      ses_shared_04: { busy: false, question: false, permission: true },
    },
    lastSuccessfulHealth: "14:41:52（假資料）", lastHealthAttempt: "14:41:52 成功（假資料）", demoStep: 1,
    managerEvents: [
      { time: "14:41:52", label: "Health check 成功" },
      { time: "14:26:44", label: "登錄本機 TUI" },
    ],
  },
  {
    id: "ins-9c01", projectId: "ledger", source: "headless", ownedByManager: true,
    lifecycle: "running", connection: "online", endpoint: "http://127.0.0.1:4097", pid: "16112", port: "4097",
    summaryApplicable: true, summaryKnown: true, sessionObservations: {},
    lastSuccessfulHealth: "14:40:16（假資料）", lastHealthAttempt: "14:40:16 成功（假資料）", demoStep: 2,
    managerEvents: [
      { time: "14:40:16", label: "Health check 成功" },
      { time: "14:35:02", label: "啟動背景執行個體" },
    ],
  },
  {
    id: "ins-a802", projectId: "ledger", source: "headless", ownedByManager: true,
    lifecycle: "running", connection: "online", endpoint: "http://127.0.0.1:4102", pid: "15984", port: "4102",
    summaryApplicable: true, summaryKnown: false, sessionObservations: {},
    lastSuccessfulHealth: "14:39:48（假資料）", lastHealthAttempt: "14:39:48 成功；pending 查詢失敗（假資料）", demoStep: -1,
    managerEvents: [
      { time: "14:39:48", label: "Health check 成功" },
      { time: "14:31:14", label: "啟動背景執行個體" },
    ],
  },
  {
    id: "ins-3d55", projectId: "docs", source: "tui", ownedByManager: false,
    lifecycle: "unknown", connection: "unreachable", endpoint: "http://127.0.0.1:4104", pid: "—", port: "4104",
    summaryApplicable: true, summaryKnown: false, sessionObservations: {},
    lastSuccessfulHealth: "13:31:09（假資料）", lastHealthAttempt: "14:39:15 失敗（假資料）", demoStep: 3,
    managerEvents: [
      { time: "14:39:15", label: "Health check 失敗", tone: "warning" },
      { time: "13:31:09", label: "Health check 成功" },
      { time: "13:12:40", label: "登錄本機 TUI" },
    ],
  },
  {
    id: "ins-e431", projectId: "docs", source: "headless", ownedByManager: true,
    lifecycle: "stopped", connection: "stopped", endpoint: "http://127.0.0.1:4106", pid: "—", port: "4106",
    summaryApplicable: false, summaryKnown: false, sessionObservations: {},
    lastSuccessfulHealth: "12:54:20（假資料）", lastHealthAttempt: "不適用（已停止）", demoStep: 2,
    managerEvents: [
      { time: "13:02:11", label: "主動停止執行個體" },
      { time: "12:54:20", label: "Health check 成功" },
      { time: "12:48:03", label: "啟動背景執行個體" },
    ],
  },
  {
    id: "ins-b708", projectId: "lab", source: "headless", ownedByManager: true,
    lifecycle: "running", connection: "online", endpoint: "http://127.0.0.1:4110", pid: "20216", port: "4110",
    summaryApplicable: true, summaryKnown: true,
    sessionObservations: {
      ses_a12: { busy: true, question: false, permission: false },
      ses_a13: { busy: true, question: false, permission: false },
    },
    lastSuccessfulHealth: "14:42:06（假資料）", lastHealthAttempt: "14:42:06 成功（假資料）", demoStep: 3,
    managerEvents: [
      { time: "14:42:06", label: "Health check 成功" },
      { time: "13:58:33", label: "啟動背景執行個體" },
    ],
  },
]

const instances = ref<ConsoleInstance[]>(structuredClone(seedInstances))
const selectedId = ref(instances.value[0].id)
const selectedShortcut = ref(projects[0].id)
const search = ref("")
const statusFilter = ref<Filter>("all")
const highlightedId = ref<string | null>(null)
const dialogMode = ref<"open" | "stop" | null>(null)
const dialogOpen = ref(false)
let highlightTimer: ReturnType<typeof setTimeout> | undefined

const filteredInstances = computed(() => instances.value.filter((instance) => {
  const project = projectFor(instance)
  const term = search.value.trim().toLowerCase()
  const sessions = projectSessions(project)
  const matchesTerm = !term || [
    instanceName(instance), instance.id, project.name, project.path,
    ...sessions.flatMap((session) => [session.id, session.title]),
  ].some((value) => value.toLowerCase().includes(term))
  const matchesStatus = statusFilter.value === "all"
    || (statusFilter.value === "active" && instance.summaryApplicable && instance.summaryKnown && summaryCounts(instance).busy > 0)
    || (statusFilter.value === "attention" && instance.summaryKnown && (summaryCounts(instance).question > 0 || summaryCounts(instance).permission > 0))
    || (statusFilter.value === "unreachable" && instance.connection === "unreachable")
  return matchesTerm && matchesStatus
}))
const selected = computed(() => instances.value.find((item) => item.id === selectedId.value) ?? instances.value[0])
const selectedProject = computed(() => projectFor(selected.value))
const selectedSessions = computed(() => projectSessions(selectedProject.value))
const onlineCount = computed(() => instances.value.filter((item) => item.connection === "online").length)
const attentionCount = computed(() => instances.value.filter((item) => item.summaryKnown && (summaryCounts(item).question > 0 || summaryCounts(item).permission > 0)).length)

function projectFor(instance: ConsoleInstance) {
  return projects.find((project) => project.id === instance.projectId) ?? projects[0]
}

function projectSessions(project: Project) {
  return [...new Map(project.sessions.map((session) => [session.id, session])).values()]
}

function summaryCounts(instance: ConsoleInstance) {
  return Object.values(instance.sessionObservations).reduce((counts, observation) => ({
    busy: counts.busy + Number(observation.busy),
    question: counts.question + Number(observation.question),
    permission: counts.permission + Number(observation.permission),
  }), { busy: 0, question: 0, permission: 0 })
}

function instanceName(instance: ConsoleInstance) {
  return `${projectFor(instance).name} · ${instance.id.replace("ins-", "")}`
}

function sourceLabel(source: Source) {
  return source === "headless" ? "管理器背景" : "本機 TUI"
}

function summaryLabel(instance: ConsoleInstance) {
  if (!instance.summaryApplicable) return "不適用"
  if (!instance.summaryKnown) return "未知"
  const counts = summaryCounts(instance)
  const parts = [
    counts.busy > 0 ? `${counts.busy} 執行中` : "",
    counts.question > 0 ? `${counts.question} 待回答` : "",
    counts.permission > 0 ? `${counts.permission} 待授權` : "",
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(" · ") : "未回報執行中"
}

function summaryClass(instance: ConsoleInstance) {
  if (!instance.summaryApplicable) return "summary-na"
  if (!instance.summaryKnown) return "summary-unknown"
  const counts = summaryCounts(instance)
  if (counts.question > 0 || counts.permission > 0) return "summary-attention"
  if (counts.busy > 0) return "summary-busy"
  return "summary-none"
}

function selectInstance(id: string) {
  selectedId.value = id
}

function flash(id: string) {
  highlightedId.value = id
  if (highlightTimer) clearTimeout(highlightTimer)
  highlightTimer = setTimeout(() => { highlightedId.value = null }, 900)
}

function simulateSummary(instance = selected.value) {
  if (!instance.summaryApplicable && instance.connection !== "unreachable") return
  const wasUnreachable = instance.connection === "unreachable"
  const nextStep = wasUnreachable ? 0 : (instance.demoStep + 1) % 4
  const sessions = projectSessions(projectFor(instance))
  const roots = sessions.filter((session) => !session.parentID)
  const firstChild = sessions.find((session) => session.parentID) ?? roots[0]
  const observations: Record<string, SessionObservation>[] = [
    roots[0] ? { [roots[0].id]: { busy: true, question: false, permission: false } } : {},
    firstChild ? { [firstChild.id]: { busy: true, question: true, permission: false } } : {},
    {},
    Object.fromEntries(roots.slice(0, 2).map((session) => [session.id, { busy: true, question: false, permission: false }])),
  ]
  instance.lifecycle = "running"
  instance.connection = "online"
  instance.summaryApplicable = true
  instance.summaryKnown = true
  instance.sessionObservations = observations[nextStep]
  if (wasUnreachable) {
    instance.lastSuccessfulHealth = "現在（假資料）"
    instance.lastHealthAttempt = "現在成功（假資料）"
    instance.managerEvents.unshift({ time: "現在", label: "Health check 成功" })
  }
  instance.demoStep = nextStep
  flash(instance.id)
}

function showDialog(mode: "open" | "stop", instance = selected.value) {
  selectedId.value = instance.id
  dialogMode.value = mode
  dialogOpen.value = true
}

function stopSelected() {
  if (!selected.value.ownedByManager || selected.value.source !== "headless" || selected.value.lifecycle !== "running") return
  selected.value.lifecycle = "stopped"
  selected.value.connection = "stopped"
  selected.value.summaryApplicable = false
  selected.value.summaryKnown = false
  selected.value.sessionObservations = {}
  selected.value.pid = "—"
  selected.value.lastHealthAttempt = "不適用（已停止）"
  selected.value.managerEvents.unshift({ time: "現在", label: "主動停止執行個體" })
  flash(selected.value.id)
  dialogOpen.value = false
}

function resetPrototype() {
  instances.value = structuredClone(seedInstances)
  selectedId.value = instances.value[0].id
  selectedShortcut.value = projects[0].id
  search.value = ""
  statusFilter.value = "all"
  highlightedId.value = null
}

onBeforeUnmount(() => {
  if (highlightTimer) clearTimeout(highlightTimer)
})
</script>

<template>
  <div class="console-shell">
    <header class="topbar">
      <div class="brand-lockup">
        <span class="brand-mark"><CommandIcon /></span>
        <div><strong>OMW / CONSOLE</strong><span>PROTOTYPE A · FIXTURE ONLY</span></div>
      </div>
      <div class="topbar-stats" aria-label="執行個體摘要">
        <span><RadioIcon /> ONLINE <strong>{{ onlineCount }}</strong></span>
        <span><HeartPulseIcon /> NEEDS ACTION <strong>{{ attentionCount }}</strong></span>
        <Badge variant="outline" class="mock-badge">假資料</Badge>
      </div>
    </header>

    <section class="command-strip" aria-label="搜尋與篩選">
      <label class="search-field">
        <span class="sr-only">搜尋專案、路徑、執行個體 ID、Session 標題或 ID</span>
        <SearchIcon />
        <Input v-model="search" placeholder="搜尋 project / path / instance / session…" />
      </label>
      <div class="filter-row" role="group" aria-label="狀態篩選">
        <ListFilterIcon />
        <Button v-for="option in [
          { value: 'all', label: '全部' },
          { value: 'active', label: '有執行中' },
          { value: 'attention', label: '需處理' },
          { value: 'unreachable', label: '無法連線' },
        ]" :key="option.value" size="sm" :variant="statusFilter === option.value ? 'secondary' : 'ghost'" @click="statusFilter = option.value as Filter">
          {{ option.label }}
        </Button>
      </div>
      <Button variant="outline" size="sm" class="reset-button" @click="resetPrototype"><RotateCcwIcon />重設</Button>
    </section>

    <main>
      <section class="console-layout" aria-labelledby="console-title">
        <div class="instance-index">
          <div class="section-heading">
            <div><span class="section-kicker">INSTANCE INDEX</span><h1 id="console-title">執行個體</h1></div>
            <span class="result-count">{{ filteredInstances.length }} / {{ instances.length }}</span>
          </div>
          <div class="table-labels" aria-hidden="true"><span>名稱 / 專案</span><span>來源</span><span>工作摘要</span><span>連線</span></div>
          <div v-if="filteredInstances.length" class="instance-list">
            <template v-for="instance in filteredInstances" :key="instance.id">
              <button class="instance-row" :class="{ selected: selectedId === instance.id, flashed: highlightedId === instance.id }" @click="selectInstance(instance.id)">
                <span class="instance-primary"><strong>{{ instanceName(instance) }}</strong><small>{{ projectFor(instance).path }} · {{ instance.id }}</small></span>
                <span class="source-cell"><component :is="instance.source === 'headless' ? ServerIcon : TerminalSquareIcon" />{{ sourceLabel(instance.source) }}</span>
                <span :class="['summary-cell', summaryClass(instance)]"><i></i>{{ summaryLabel(instance) }}</span>
                <span class="connection-cell" :class="instance.connection"><i></i>{{ instance.connection }}</span>
              </button>

              <div v-if="selectedId === instance.id" class="mobile-inline-detail">
                <div class="count-grid" :class="{ muted: !instance.summaryKnown || !instance.summaryApplicable }">
                  <div><span>執行中</span><strong>{{ instance.summaryKnown && instance.summaryApplicable ? summaryCounts(instance).busy : '—' }}</strong></div>
                  <div><span>待回答</span><strong>{{ instance.summaryKnown && instance.summaryApplicable ? summaryCounts(instance).question : '—' }}</strong></div>
                  <div><span>待授權</span><strong>{{ instance.summaryKnown && instance.summaryApplicable ? summaryCounts(instance).permission : '—' }}</strong></div>
                </div>
                <dl class="compact-facts">
                  <div><dt>Lifecycle</dt><dd>{{ instance.lifecycle }}</dd></div>
                  <div><dt>來源</dt><dd>{{ sourceLabel(instance.source) }}</dd></div>
                  <div><dt>PID / Port</dt><dd>{{ instance.pid }} / {{ instance.port }}</dd></div>
                  <div><dt>Endpoint</dt><dd><code>{{ instance.endpoint }}</code></dd></div>
                  <div><dt>聚合範圍</dt><dd>此 endpoint + project directory</dd></div>
                  <div><dt>最後成功 Health</dt><dd>{{ instance.lastSuccessfulHealth }}</dd></div>
                  <div><dt>最近 Health 嘗試</dt><dd>{{ instance.lastHealthAttempt }}</dd></div>
                </dl>
                <div class="session-block compact-section">
                   <div class="subheading"><h3>此專案的 Sessions</h3><span>已載入 {{ projectSessions(projectFor(instance)).length }}</span></div>
                   <p class="relation-note">同 project 共用 metadata；parentID 只建立已載入範圍內的關係，不代表這個執行個體目前使用哪個 Session。</p>
                   <ProjectSessionTree :sessions="projectSessions(projectFor(instance))" :observations="instance.sessionObservations" :summary-applicable="instance.summaryApplicable" :summary-known="instance.summaryKnown" />
                </div>
                <div class="event-block compact-section">
                  <div class="subheading"><h3>管理器觀察事件</h3><Clock3Icon /></div>
                  <ol><li v-for="event in instance.managerEvents" :key="`${event.time}-${event.label}`" :class="event.tone"><time>{{ event.time }}</time><span>{{ event.label }}（假資料）</span></li></ol>
                </div>
                <div class="inline-actions">
                  <Button size="sm" :disabled="!instance.summaryApplicable && instance.connection !== 'unreachable'" @click="simulateSummary(instance)"><ZapIcon />模擬摘要變更</Button>
                  <Button variant="outline" size="sm" @click="showDialog('open', instance)"><Globe2Icon />Open Web</Button>
                  <Button v-if="instance.ownedByManager && instance.source === 'headless' && instance.lifecycle === 'running'" variant="destructive" size="sm" @click="showDialog('stop', instance)"><CircleStopIcon />停止</Button>
                </div>
              </div>
            </template>
          </div>
          <p v-else class="empty-state">找不到符合目前條件的執行個體。</p>
        </div>

        <aside class="detail-panel" aria-label="選取的執行個體詳情">
          <div class="detail-head">
            <div><span class="section-kicker">SELECTED INSTANCE</span><h2>{{ instanceName(selected) }}</h2><code>{{ selected.id }}</code></div>
            <Badge variant="outline" :class="['summary-badge', summaryClass(selected)]">{{ summaryLabel(selected) }}</Badge>
          </div>
          <div class="count-grid" :class="{ muted: !selected.summaryKnown || !selected.summaryApplicable }">
            <div><span>執行中</span><strong>{{ selected.summaryKnown && selected.summaryApplicable ? summaryCounts(selected).busy : '—' }}</strong></div>
            <div><span>待回答</span><strong>{{ selected.summaryKnown && selected.summaryApplicable ? summaryCounts(selected).question : '—' }}</strong></div>
            <div><span>待授權</span><strong>{{ selected.summaryKnown && selected.summaryApplicable ? summaryCounts(selected).permission : '—' }}</strong></div>
          </div>
          <div class="meta-grid">
            <div><span>PROJECT</span><strong>{{ selectedProject.name }}</strong><small>{{ selectedProject.path }}</small></div>
            <div><span>SOURCE</span><strong>{{ sourceLabel(selected.source) }}</strong><small>{{ selected.ownedByManager ? '由管理器擁有' : '外部啟動後登錄' }}</small></div>
            <div><span>LIFECYCLE</span><strong>{{ selected.lifecycle }}</strong><small>PID {{ selected.pid }}</small></div>
            <div><span>CONNECTION</span><strong>{{ selected.connection }}</strong><small>PORT {{ selected.port }}</small></div>
          </div>
          <div class="scope-block">
            <div><span>INSTANCE ENDPOINT</span><code>{{ selected.endpoint }}</code></div>
            <p>工作摘要只聚合這個 endpoint 對 {{ selectedProject.path }} 回報的 status / question / permission；不從共用 Session metadata 推導。</p>
            <dl>
              <div><dt>最後成功 Health</dt><dd>{{ selected.lastSuccessfulHealth }}</dd></div>
              <div><dt>最近 Health 嘗試</dt><dd>{{ selected.lastHealthAttempt }}</dd></div>
            </dl>
          </div>
          <div class="session-block">
             <div class="subheading"><h3>此專案的 Sessions</h3><span>已載入 {{ selectedSessions.length }}</span></div>
             <p class="relation-note">Session metadata 在同 project 的執行個體間可見；parentID 關係只涵蓋已載入資料，不能判斷 TUI current session。</p>
             <ProjectSessionTree :sessions="selectedSessions" :observations="selected.sessionObservations" :summary-applicable="selected.summaryApplicable" :summary-known="selected.summaryKnown" />
          </div>
          <div class="event-block">
            <div class="subheading"><h3>管理器觀察事件</h3><Clock3Icon /></div>
            <ol><li v-for="event in selected.managerEvents" :key="`${event.time}-${event.label}`" :class="event.tone"><time>{{ event.time }}</time><span>{{ event.label }}（假資料）</span></li></ol>
          </div>
          <div class="detail-actions">
            <Button :disabled="!selected.summaryApplicable && selected.connection !== 'unreachable'" @click="simulateSummary()"><ZapIcon />模擬摘要變更</Button>
            <Button variant="outline" @click="showDialog('open')"><Globe2Icon />Open Web</Button>
            <Button v-if="selected.ownedByManager && selected.source === 'headless' && selected.lifecycle === 'running'" variant="destructive" @click="showDialog('stop')"><CircleStopIcon />停止背景執行個體</Button>
          </div>
        </aside>
      </section>

      <section class="shortcut-strip" aria-labelledby="shortcut-heading">
        <div><FolderRootIcon /><span><strong id="shortcut-heading">目錄捷徑</strong><small>方便從手機選取 Project 的入口，不是允許清單或存取權限邊界。</small></span></div>
        <div class="shortcut-options"><button v-for="project in projects" :key="project.id" :class="{ selected: selectedShortcut === project.id }" @click="selectedShortcut = project.id"><span>{{ project.shortcut }}</span><code>{{ project.path }}</code></button></div>
        <p>目前假選取：<code>{{ projects.find((project) => project.id === selectedShortcut)?.path }}</code> · 不會讀寫檔案系統</p>
      </section>
    </main>

    <footer><span>OMW CONSOLE · PROTOTYPE A</span><span>FIXTURE ONLY · NO API · NO STORAGE · NO PROCESS MUTATION</span></footer>

    <Dialog v-model:open="dialogOpen">
      <DialogContent class="console-dialog">
        <DialogHeader>
          <DialogTitle>{{ dialogMode === 'stop' ? '停止背景執行個體？' : 'Open Web（原型提示）' }}</DialogTitle>
          <DialogDescription v-if="dialogMode === 'stop'">只會在 prototype 記憶體中把 <code>{{ instanceName(selected) }}</code> 標為 stopped，工作摘要改為不適用；不會呼叫 API 或終止真實程序。</DialogDescription>
          <DialogDescription v-else><code>{{ instanceName(selected) }}</code> 的 Web 入口在正式產品中才會開啟。此 prototype 不會建立連線或開啟外部網址。</DialogDescription>
        </DialogHeader>
        <div class="dialog-facts"><span>INSTANCE</span><code>{{ selected.id }}</code><span>PROJECT</span><code>{{ selectedProject.path }}</code><span>ENDPOINT</span><code>{{ selected.endpoint }}</code></div>
        <DialogFooter>
          <Button variant="outline" @click="dialogOpen = false">取消</Button>
          <Button v-if="dialogMode === 'stop'" variant="destructive" @click="stopSelected"><CircleStopIcon />確認停止（假）</Button>
          <Button v-else @click="dialogOpen = false">了解</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
