import assert from "node:assert/strict"
import test from "node:test"
import { createSwipeDismiss } from "../src/swipe-dismiss.ts"

test("單指下拉只有放開且超過門檻才關閉，反向移動可取消", () => {
  const swipe = createSwipeDismiss("down", 80)
  assert.equal(swipe.start(1, 20, 100), true)
  assert.equal(swipe.move(1, 20, 190), 90)
  assert.equal(swipe.move(1, 20, 130), 30)
  assert.equal(swipe.end(1, 20, 130), false)
  swipe.start(2, 20, 100)
  assert.equal(swipe.move(2, 20, 190), 90)
  assert.equal(swipe.end(2, 20, 190), true)
})

test("取消、第二指及非追蹤指標都不能觸發關閉", () => {
  const swipe = createSwipeDismiss("horizontal", 70)
  swipe.start(1, 100, 20)
  assert.equal(swipe.move(2, 0, 20), 0)
  assert.equal(swipe.move(1, 0, 20), -100)
  swipe.cancel()
  assert.equal(swipe.end(1, 0, 20), false)
  swipe.start(1, 100, 20)
  assert.equal(swipe.start(2, 40, 20), false)
  assert.equal(swipe.end(1, 40, 20), false)
  swipe.start(3, 100, 20)
  assert.equal(swipe.move(3, 80, 150), 0, "垂直頁面捲動不應觸發水平關閉")
  assert.equal(swipe.end(3, 80, 150), false)
})

test("pointerup 回到起點時不得沿用前一次超過門檻的位移", () => {
  const panel = createSwipeDismiss("down", 80)
  panel.start(1, 20, 100)
  panel.move(1, 20, 210)
  assert.equal(panel.end(1, 20, 120), false)

  const toast = createSwipeDismiss("horizontal", 80)
  toast.start(2, 100, 20)
  toast.move(2, 210, 20)
  assert.equal(toast.end(2, 120, 20), false)
})
