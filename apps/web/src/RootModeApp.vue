<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue"
import type { ConnectivityInfo } from "@omw/contracts"
import { managerApi } from "./api"
import App from "./App.vue"
import CoordinatorView from "./CoordinatorView.vue"
import { Button } from "./components/ui/button"
import { useMessages } from "./i18n"

const { t } = useMessages()
const mode = ref<ConnectivityInfo["mode"] | null>(null)
const loading = ref(false)
const failed = ref(false)
let controller: AbortController | null = null
let generation = 0
async function detect() {
  const current = ++generation
  controller?.abort()
  controller = new AbortController()
  const timeout = window.setTimeout(() => controller?.abort(), 15_000)
  loading.value = true
  failed.value = false
  try {
    const connectivity = await managerApi.connectivity(controller.signal)
    if (current !== generation) return
    if (!["coordinator", "worker", "loopback", "tailnet"].includes(connectivity.mode)) throw new Error("Unknown mode")
    mode.value = connectivity.mode
  } catch {
    if (current === generation) failed.value = true
  } finally {
    window.clearTimeout(timeout)
    if (current === generation) loading.value = false
  }
}
onMounted(detect)
onBeforeUnmount(() => { generation++; controller?.abort() })
</script>

<template>
  <CoordinatorView v-if="mode === 'coordinator'" />
  <App v-else-if="mode" />
  <main v-else class="shell">
    <h1>{{ t('ui.productName') }}</h1>
    <p v-if="loading" role="status">{{ t('coordinator.detecting') }}</p>
    <div v-if="failed" role="alert">
      <p>{{ t('coordinator.modeError') }}</p>
      <Button variant="outline" @click="detect">{{ t('coordinator.retry') }}</Button>
    </div>
  </main>
</template>
