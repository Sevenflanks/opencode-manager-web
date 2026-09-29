<script setup lang="ts">
import type { SessionMetadata } from "@omw/contracts"
import { ChevronRightIcon, ExternalLinkIcon, LoaderCircleIcon } from "lucide-vue-next"
import { ref, watch } from "vue"
import { managerApi } from "@/api"
import { Button } from "@/components/ui/button"
import ErrorDetails from "@/components/ErrorDetails.vue"
import { presentError, type PresentedError } from "@/error-presentation"
import { useMessages } from "@/i18n"

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
const diagnostic = ref<PresentedError | null>(null)
const { t } = useMessages()
let scopeVersion = 0

watch(
  () => [props.instanceId, props.session.id] as const,
  () => {
    scopeVersion++
    expanded.value = false
    loaded.value = false
    loading.value = false
    children.value = []
    diagnostic.value = null
  },
)

async function toggle(): Promise<void> {
  expanded.value = !expanded.value
  if (!expanded.value || loaded.value) return
  const requestedScope = ++scopeVersion
  const instanceId = props.instanceId
  const sessionId = props.session.id
  loading.value = true
  diagnostic.value = null
  try {
    const response = await managerApi.children(instanceId, sessionId)
    if (requestedScope !== scopeVersion || instanceId !== props.instanceId || sessionId !== props.session.id) return
    children.value = response.children
    loaded.value = true
  } catch (cause) {
    if (requestedScope !== scopeVersion) return
    diagnostic.value = presentError(cause, t)
  } finally {
    if (requestedScope === scopeVersion) loading.value = false
  }
}
</script>

<template>
  <li class="session-node" :style="{ '--depth': depth ?? 0 }">
    <div class="session-row">
      <Button variant="ghost" size="icon" class="tree-toggle" :aria-label="expanded ? t('session.collapseChildren') : t('session.loadChildren')" @click="toggle">
        <LoaderCircleIcon v-if="loading" class="spin" />
        <ChevronRightIcon v-else :class="{ rotated: expanded }" />
      </Button>
      <button class="session-copy" type="button" :disabled="openDisabled" @click="emit('open', session.id)">
        <strong>{{ session.title }}</strong>
        <code>{{ session.id }}</code>
      </button>
      <Button variant="ghost" size="icon" :aria-label="t('session.openInWeb')" :disabled="openDisabled" @click="emit('open', session.id)">
        <ExternalLinkIcon />
      </Button>
      <Button
        v-if="allowSwitch"
        variant="outline"
        size="sm"
        class="session-switch-button"
        :aria-label="t('session.chooseAria', { title: session.title })"
        :disabled="switchDisabled"
        @click="emit('switch')"
      >{{ t('session.choose') }}</Button>
    </div>
    <p v-if="diagnostic" class="inline-error"><ErrorDetails :summary="t(diagnostic.summaryKey)" :code="diagnostic.code" :diagnostic="diagnostic.diagnostic" /></p>
    <p v-if="expanded && loaded && children.length === 0" class="tree-empty">{{ t('session.noChildren') }}</p>
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
