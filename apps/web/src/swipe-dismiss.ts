export function createSwipeDismiss(direction: "down" | "horizontal", threshold: number) {
  let pointerId: number | null = null
  let originX = 0
  let originY = 0
  let distance = 0

  return {
    start(id: number, x: number, y: number): boolean {
      if (pointerId !== null) {
        // 第二指代表可能正在縮放；整次手勢作廢，不讓任一指的 pointerup 誤關閉。
        pointerId = null
        distance = 0
        return false
      }
      pointerId = id
      originX = x
      originY = y
      distance = 0
      return true
    },
    move(id: number, x: number, y: number): number {
      if (id !== pointerId) return 0
      const dx = x - originX
      const dy = y - originY
      distance = direction === "down"
        ? dy > Math.abs(dx) ? Math.max(0, dy) : 0
        : Math.abs(dx) > Math.abs(dy) ? dx : 0
      return distance
    },
    end(id: number): boolean {
      if (id !== pointerId) return false
      const dismiss = Math.abs(distance) >= threshold
      pointerId = null
      distance = 0
      return dismiss
    },
    cancel(): void {
      pointerId = null
      distance = 0
    },
  }
}
