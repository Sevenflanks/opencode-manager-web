<script setup lang="ts">
import { computed } from "vue"
import { useMessages } from "@/i18n"
const props = defineProps<{ summary: string; code?: string | null | undefined; diagnostic?: string | null | undefined }>()
const { t } = useMessages()
const hasDetail = computed(() => Boolean(props.code || props.diagnostic))
</script>

<template>
  <span>{{ summary }}</span>
  <details v-if="hasDetail" class="error-details">
    <summary>{{ t("error.details") }}</summary>
    <code v-if="code">{{ t("error.code", { code }) }}</code>
    <p v-if="diagnostic">{{ t("error.diagnostic", { message: diagnostic }) }}</p>
  </details>
</template>
