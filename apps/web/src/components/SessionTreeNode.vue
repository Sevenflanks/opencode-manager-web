<script setup lang="ts">
import type { SessionMetadata } from "@omw/contracts"
import { ChevronRightIcon, ExternalLinkIcon, LoaderCircleIcon } from "lucide-vue-next"
import { ref, watch } from "vue"
import { managerApi } from "@/api"
import { Button } from "@/components/ui/button"

const props = withDefaults(defineProps<{
  instanceId: string
  session: SessionMetadata
  depth?: number
  openDisabled?: boolean
  allowSwitch?: boolean
  switchDisabled?: boolean
}>(), {
  openDisabled: false,
  allowSwitch: false,
  switchDisabled: false,
})
const emit = defineEmits<{ open: [sessionId: string]; switch: [] }>()
const expanded = ref(false)
const loaded = ref(false)
const loading = ref(false)
const children = ref<SessionMetadata[]>([])
const error = ref("")
let scopeVersion = 0

watch(
  () => [props.instanceId, props.session.id] as const,
  () => {
    scopeVersion++
    expanded.value = false
    loaded.value = false
    loading.value = false
    children.value = []
    error.value = ""
  },
)

async function toggle(): Promise<void> {
  expanded.value = !expanded.value
  if (!expanded.value || loaded.value) return
  const requestedScope = ++scopeVersion
  const instanceId = props.instanceId
  const sessionId = props.session.id
  loading.value = true
  error.value = ""
  try {
    const response = await managerApi.children(instanceId, sessionId)
    if (requestedScope !== scopeVersion || instanceId !== props.instanceId || sessionId !== props.session.id) return
    children.value = response.children
    loaded.value = true
  } catch (cause) {
    if (requestedScope !== scopeVersion) return
    error.value = cause instanceof Error ? cause.message : "無法載入 Child Session。"
  } finally {
    if (requestedScope === scopeVersion) loading.value = false
  }
}
</script>

<template>
  <li class="session-node" :style="{ '--depth': depth ?? 0 }">
    <div class="session-row">
      <Button variant="ghost" size="icon" class="tree-toggle" :aria-label="expanded ? '收合 Child Session' : '載入 Child Session'" @click="toggle">
        <LoaderCircleIcon v-if="loading" class="spin" />
        <ChevronRightIcon v-else :class="{ rotated: expanded }" />
      </Button>
      <button class="session-copy" type="button" :disabled="openDisabled" @click="emit('open', session.id)">
        <strong>{{ session.title }}</strong>
        <code>{{ session.id }}</code>
      </button>
      <Button variant="ghost" size="icon" aria-label="在 OpenCode Web 開啟 Session" :disabled="openDisabled" @click="emit('open', session.id)">
        <ExternalLinkIcon />
      </Button>
      <Button
        v-if="allowSwitch"
        variant="outline"
        size="sm"
        class="session-switch-button"
        :aria-label="`切換為主要 Session：${session.title}`"
        :disabled="switchDisabled"
        @click="emit('switch')"
      >切換</Button>
    </div>
    <p v-if="error" class="inline-error">{{ error }}</p>
    <p v-if="expanded && loaded && children.length === 0" class="tree-empty">沒有已載入的 direct children</p>
    <ul v-if="expanded && children.length" class="session-list">
      <SessionTreeNode
        v-for="child in children"
        :key="`${instanceId}:${child.id}`"
        :instance-id="instanceId"
        :session="child"
        :depth="(depth ?? 0) + 1"
        :open-disabled="openDisabled"
        @open="emit('open', $event)"
      />
    </ul>
  </li>
</template>
