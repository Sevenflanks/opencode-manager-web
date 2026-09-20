<script setup lang="ts">
import { computed, ref } from "vue"
import { ChevronRightIcon } from "lucide-vue-next"

defineOptions({ name: "ProjectSessionTree" })

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

const props = withDefaults(defineProps<{
  sessions: ProjectSession[]
  observations: Record<string, SessionObservation>
  summaryApplicable: boolean
  summaryKnown: boolean
  session?: ProjectSession
  label?: string
}>(), {
  session: undefined,
  label: undefined,
})

const expanded = ref(false)
const sessionIds = computed(() => new Set(props.sessions.map((session) => session.id)))
const roots = computed(() => props.sessions.filter((session) => !session.parentID))
const missingParentSessions = computed(() => props.sessions.filter((session) => session.parentID && !sessionIds.value.has(session.parentID)))
const directChildren = computed(() => props.session
  ? props.sessions.filter((session) => session.parentID === props.session?.id)
  : [])

const statusParts = computed(() => {
  if (!props.summaryApplicable) return ["不適用"]
  if (!props.summaryKnown) return ["未知"]
  if (!props.session) return []

  const observation = props.observations[props.session.id]
  if (!observation) return ["未回報執行中"]

  const parts = [
    observation.busy ? "執行中" : "",
    observation.question ? "待回答" : "",
    observation.permission ? "待授權" : "",
  ].filter(Boolean)
  return parts.length > 0 ? parts : ["未回報執行中"]
})

const statusTone = computed(() => {
  if (!props.summaryApplicable) return "na"
  if (!props.summaryKnown) return "unknown"
  const observation = props.session ? props.observations[props.session.id] : undefined
  if (observation?.question || observation?.permission) return "attention"
  if (observation?.busy) return "busy"
  return "none"
})
</script>

<template>
  <div v-if="!session" class="session-tree">
    <ProjectSessionTree
      v-for="root in roots"
      :key="root.id"
      :sessions="sessions"
      :observations="observations"
      :summary-applicable="summaryApplicable"
      :summary-known="summaryKnown"
      :session="root"
      label="主 Session"
    />

    <section v-if="missingParentSessions.length" class="missing-parent-group" aria-label="父 Session 尚未載入">
      <p>父 Session 尚未載入</p>
      <ProjectSessionTree
        v-for="orphan in missingParentSessions"
        :key="orphan.id"
        :sessions="sessions"
        :observations="observations"
        :summary-applicable="summaryApplicable"
        :summary-known="summaryKnown"
        :session="orphan"
        label="父 Session 尚未載入"
      />
    </section>
  </div>

  <div v-else class="session-branch">
    <article class="session-node">
      <div class="session-node-main">
        <span class="session-kind">{{ label }}</span>
        <strong :title="session.title">{{ session.title }}</strong>
        <code>{{ session.id }}</code>
        <span>Session 更新 {{ session.updated }}（假資料）</span>
        <span v-if="label === '父 Session 尚未載入'" class="parent-reference">parentID: <code>{{ session.parentID }}</code></span>
      </div>
      <div class="session-observation" :class="`session-observation-${statusTone}`">
        <span>此 instance 回報</span>
        <strong>{{ statusParts.join(" · ") }}</strong>
      </div>
      <button
        v-if="directChildren.length"
        class="session-expand"
        type="button"
        :aria-expanded="expanded"
        :aria-label="`${expanded ? '收合' : '展開'} ${session.title} 的已載入直接子 Session`"
        @click="expanded = !expanded"
      >
        <ChevronRightIcon :class="{ expanded }" />
        <span>已載入直接子 Session {{ directChildren.length }}</span>
      </button>
    </article>

    <div v-if="expanded" class="session-children">
      <ProjectSessionTree
        v-for="(child, index) in directChildren"
        :key="child.id"
        :sessions="sessions"
        :observations="observations"
        :summary-applicable="summaryApplicable"
        :summary-known="summaryKnown"
        :session="child"
        :label="`子 Session ${index + 1}`"
      />
    </div>
  </div>
</template>
