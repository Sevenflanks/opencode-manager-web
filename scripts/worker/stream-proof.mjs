import assert from "node:assert/strict"

// 只保留初始連線事件的 type／transport，不記錄串流內容或任何 provider 資料。
export async function firstSseEvent(url, { headers = {}, timeout = 20_000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error("SSE first event deadline exceeded")), timeout)
  let reader
  try {
    const response = await fetch(url, { headers, signal: controller.signal, redirect: "error" })
    assert.equal(response.status, 200, "native SSE status")
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/)
    reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = "", bytes = 0
    for (;;) {
      const { done, value } = await reader.read()
      assert.equal(done, false, "native SSE 在第一事件前結束")
      bytes += value.length
      assert.ok(bytes <= 64_000, "SSE initial frame 超過證據上限")
      buffer += decoder.decode(value, { stream: true })
      for (;;) {
        const boundary = /\r?\n\r?\n/.exec(buffer)
        if (!boundary) break
        const frame = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary[0].length)
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")
        if (!data) continue
        const event = JSON.parse(data)
        const type = event.type ?? event.payload?.type
        assert.equal(type, "server.connected", "native SSE 初始事件")
        return { transport: "SSE", status: response.status, firstEventType: type, bodyRecorded: false }
      }
    }
  } finally {
    controller.abort()
    await reader?.cancel().catch(() => undefined)
    clearTimeout(timer)
  }
}
