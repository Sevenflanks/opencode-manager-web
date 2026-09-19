<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { useVModel } from "@vueuse/core"
import { cn } from "@/lib/utils"

const props = defineProps<{ modelValue?: string; class?: HTMLAttributes["class"] }>()
const emits = defineEmits<{ (event: "update:modelValue", payload: string): void }>()
const value = useVModel(props, "modelValue", emits, { passive: true, defaultValue: "" })
</script>

<template>
  <input
    v-model="value"
    :class="cn('h-10 w-full rounded-md border border-[#394146] bg-[#111416] px-3 text-sm text-[#e7ebed] outline-none placeholder:text-[#68757c] focus:border-[#50c8c6] focus:ring-2 focus:ring-[#50c8c6]/20', props.class)"
  >
</template>
