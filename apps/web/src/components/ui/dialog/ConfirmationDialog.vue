<script setup lang="ts">
import {
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogRoot,
  AlertDialogTitle,
} from "reka-ui"
import { nextTick } from "vue"
import { Button } from "@/components/ui/button"

type ConfirmationTone = "positive" | "caution" | "danger"

const props = withDefaults(defineProps<{
  open: boolean
  title: string
  description: string
  confirmLabel: string
  tone?: ConfirmationTone
  busy?: boolean
  motion?: "pointer" | "reduced" | "none"
  returnFocus?: HTMLElement | null
  fallbackFocus?: HTMLElement | null
}>(), {
  tone: "positive",
  busy: false,
  motion: "none",
  returnFocus: null,
  fallbackFocus: null,
})

const emit = defineEmits<{
  "update:open": [open: boolean]
  confirm: []
  "after-leave": []
}>()
let focusRestoreQueued = false

function isSafeFocusTarget(target: HTMLElement | null): target is HTMLElement {
  return Boolean(
    target?.isConnected
    && !target.matches(":disabled, [aria-disabled=\"true\"]")
    && !target.closest("[inert]")
    && !target.hidden
    && target.getClientRects().length > 0,
  )
}

function restoreFocus(event?: Event): void {
  event?.preventDefault()
  if (focusRestoreQueued) return
  focusRestoreQueued = true
  void nextTick(() => {
    const requested = props.returnFocus
    const fallback = props.fallbackFocus
    const globalFallback = document.querySelector<HTMLElement>("[data-dialog-focus-fallback]")
    const candidates = props.busy
      ? [fallback, requested, globalFallback]
      : [requested, fallback, globalFallback]
    candidates.find(isSafeFocusTarget)?.focus({ preventScroll: true })
    focusRestoreQueued = false
  })
}

function finishLeave(): void {
  restoreFocus()
  emit("after-leave")
}

function handlePresenceAfterLeave(): void {
  finishLeave()
}

function handleAnimationEnd(event: Event): void {
  if (event.target === event.currentTarget && (event.currentTarget as HTMLElement).dataset.state === "closed") finishLeave()
}
</script>

<template>
  <AlertDialogRoot :open="open" @update:open="emit('update:open', $event)">
    <AlertDialogPortal>
      <AlertDialogOverlay class="confirmation-overlay" :data-motion="motion" />
      <AlertDialogContent
        class="confirmation-content"
        :data-motion="motion"
        @close-auto-focus="restoreFocus"
        @after-leave="handlePresenceAfterLeave"
        @animationend="handleAnimationEnd"
      >
        <AlertDialogTitle class="confirmation-title">{{ title }}</AlertDialogTitle>
        <AlertDialogDescription class="confirmation-description">{{ description }}</AlertDialogDescription>
        <div class="confirmation-actions">
          <AlertDialogCancel as-child>
            <Button variant="outline" :disabled="busy">取消</Button>
          </AlertDialogCancel>
          <AlertDialogAction as-child>
            <Button
              :variant="tone === 'danger' ? 'destructive' : tone === 'positive' ? 'success' : 'outline'"
              :class="{ 'confirmation-caution': tone === 'caution' }"
              :disabled="busy"
              @click.capture="emit('confirm')"
            >
              {{ busy ? "處理中…" : confirmLabel }}
            </Button>
          </AlertDialogAction>
        </div>
      </AlertDialogContent>
    </AlertDialogPortal>
  </AlertDialogRoot>
</template>
