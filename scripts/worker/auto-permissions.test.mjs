import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"
import test from "node:test"

// 真正 npm dist／public v1 hooks；SDK 僅有 memory synthetic 回應，沒有 fetch 或 provider。
const { default: plugin } = await import("../../deploy/worker/auto-permissions/dist/dist/v1-server.js")
const config = JSON.parse(await readFile(new URL("../../deploy/worker/profile/opencode.json", import.meta.url), "utf8"))
const options = config.plugin[1][1]
const reviewerID = "auto-permissions-reviewer"
const verdict = decision => ({ data: { info: { id: "synthetic-review-message", sessionID: "synthetic-review", role: "assistant",
  structured: { decision, reasonCode: "synthetic_review", reason: "Synthetic authorized fixture action." } }, parts: [] } })
async function until(check) {
  const deadline = Date.now() + 2000
  while (!check()) {
    assert.ok(Date.now() < deadline, "synthetic fixture deadline exceeded")
    await delay(5)
  }
}
async function fixture(run, { prompt = async () => verdict("allow"), parentModel = "gpt-6-luna", timeoutMs } = {}) {
  const pending = new Map(), replies = [], prompts = [], created = [], deleted = [], aborted = []
  const messages = Array.from({ length: 10 }, (_, i) => ({
    info: { id: `synthetic-user-${i}`, sessionID: "synthetic-parent", role: "user", time: { created: i }, agent: "astra",
      model: { providerID: "openai", modelID: parentModel, variant: "high" } },
    parts: [{ id: `synthetic-text-${i}`, sessionID: "synthetic-parent", messageID: `synthetic-user-${i}`, type: "text", text: `Synthetic user context ${i}` }],
  }))
  messages.push({ info: { id: "synthetic-tool-message", sessionID: "synthetic-parent", role: "assistant", time: { created: 11 } },
    parts: [{ id: "synthetic-tool-part", sessionID: "synthetic-parent", messageID: "synthetic-tool-message", type: "tool", callID: "synthetic-call", tool: "read",
      state: { status: "running", input: { filePath: "/synthetic-workspace/src/item.ts" }, time: { start: 11 } } }] })
  const client = {
    global: { health: async () => ({ data: { healthy: true, version: "1.18.34" } }) },
    app: { agents: async () => ({ data: [] }), skills: async () => ({ data: [] }) },
    session: {
      get: async () => ({ data: { id: "synthetic-parent", directory: "/synthetic-workspace", title: "Synthetic parent" } }),
      messages: async () => ({ data: messages }),
      create: async input => { const id = `synthetic-review-${created.length}`; created.push({ id, input }); return { data: { id } } },
      prompt: async (input, request) => { prompts.push(input); return prompt(input, request) },
      abort: async input => { aborted.push(input.path.id); return { data: true } },
      delete: async input => { deleted.push(input.path.id); return { data: true } },
    },
    permission: { list: async () => ({ data: [...pending.values()] }) },
    postSessionIdPermissionsPermissionId: async input => {
      replies.push(input); pending.delete(input.path.permissionID); return { data: true }
    },
  }
  const hooks = await plugin.server({ client, directory: "/synthetic-workspace" }, { ...options, ...(timeoutMs ? { timeoutMs } : {}) })
  let id = 0
  const ask = async ({ action = "read", resources = ["/synthetic-workspace/src/item.ts"], always = [] } = {}) => {
    const request = { id: `synthetic-request-${id++}`, sessionID: "synthetic-parent", permission: action, patterns: resources,
      always, metadata: {}, tool: { messageID: "synthetic-tool-message", callID: "synthetic-call" } }
    pending.set(request.id, request)
    await hooks.event({ event: { type: "permission.asked", properties: request } })
    await until(() => replies.some(reply => reply.path.permissionID === request.id))
    return replies.find(reply => reply.path.permissionID === request.id)
  }
  try { await run({ hooks, ask, replies, prompts, created, deleted, aborted, pending }) }
  finally { await hooks.dispose(); await until(() => deleted.length === created.length) }
}

test("固定 npm artifact 用 Node 載入 v1 server；config 建立 hidden no-tool reviewer", { timeout: 4000 }, () => fixture(async ({ hooks }) => {
  assert.equal(typeof plugin.server, "function")
  assert.equal(plugin.tui, undefined)
  const effective = structuredClone(config)
  await hooks.config(effective)
  const reviewer = effective.agent[reviewerID]
  assert.equal(reviewer.model, "openai/gpt-6-luna")
  assert.equal(reviewer.variant, "low")
  assert.equal(reviewer.hidden, true)
  assert.equal(reviewer.mode, "subagent")
  assert.deepEqual(reviewer.tools, { "*": false })
  assert.deepEqual(reviewer.permission, { "*": "deny" })
}))
test("asked→once 使用指定非-fast reviewer，最多8 user messages、tool args、cwd；temporary session 刪除", { timeout: 4000 }, () => fixture(async f => {
  const reply = await f.ask()
  assert.deepEqual(reply, { path: { id: "synthetic-parent", permissionID: "synthetic-request-0" }, body: { response: "once" } })
  assert.equal(f.prompts.length, 1)
  assert.deepEqual(f.prompts[0].body.model, { providerID: "openai", modelID: "gpt-6-luna" })
  assert.equal(f.prompts[0].body.variant, "low")
  assert.equal(f.prompts[0].body.agent, reviewerID)
  const payload = JSON.parse(f.prompts[0].body.parts[0].text.split("\n")[1])
  assert.deepEqual(payload.context.userMessages, Array.from({ length: 8 }, (_, i) => `Synthetic user context ${i + 2}`))
  assert.equal(payload.context.directory, "/synthetic-workspace")
  assert.deepEqual(payload.request.toolInput, { filePath: "/synthetic-workspace/src/item.ts" })
  assert.deepEqual(f.created[0].input.body.permission, [
    { permission: "*", pattern: "*", action: "deny" }, { permission: "StructuredOutput", pattern: "*", action: "allow" },
  ])
  await until(() => f.deleted.length === 1)
}))
test("allow_session 僅 narrow non-sensitive pattern 回覆always；相同 instance 可重用", { timeout: 4000 }, () => fixture(async f => {
  const request = { always: ["/synthetic-workspace/src/*.ts"] }
  assert.equal((await f.ask(request)).body.response, "always")
  assert.equal((await f.ask(request)).body.response, "once")
  assert.equal(f.prompts.length, 1)
}, { prompt: async () => verdict("allow_session") }))
test("新instance 不重用前一instance 的session approval", { timeout: 4000 }, async () => {
  const request = { always: ["/synthetic-workspace/src/*.ts"] }
  await fixture(async f => { assert.equal((await f.ask(request)).body.response, "always") }, { prompt: async () => verdict("allow_session") })
  await fixture(async f => {
    assert.equal((await f.ask(request)).body.response, "reject")
    assert.equal(f.prompts.length, 1)
  }, { prompt: async () => verdict("deny") })
})
test("僅reviewer Session 隔離ordinary system prompts；dispose清除marker", { timeout: 4000 }, () => fixture(async ({ hooks }) => {
  const effective = structuredClone(config)
  await hooks.config(effective)
  const ordinary = { system: ["synthetic ordinary project instructions"] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "synthetic-parent" }, ordinary)
  assert.deepEqual(ordinary.system, ["synthetic ordinary project instructions"])
  await hooks["chat.message"]({ sessionID: "synthetic-review", agent: reviewerID })
  const reviewer = { system: ["synthetic ordinary project instructions"] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "synthetic-review" }, reviewer)
  assert.deepEqual(reviewer.system, [effective.agent[reviewerID].prompt])
  await hooks.dispose()
  const after = { system: ["synthetic ordinary project instructions"] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "synthetic-review" }, after)
  assert.deepEqual(after.system, ["synthetic ordinary project instructions"])
}))
for (const [label, request] of [
  ["broad", { always: ["*"] }],
  ["sensitive", { resources: ["/synthetic-workspace/.env"], always: ["/synthetic-workspace/.env"] }],
  ["dangerous-shell", { action: "bash", resources: ["git push origin feature"], always: ["git push origin feature"] }],
]) test(`allow_session ${label} 不擴成always`, { timeout: 4000 }, () => fixture(async f => {
  assert.equal((await f.ask(request)).body.response, "once")
}, { prompt: async () => verdict("allow_session") }))
test("有效deny直接reject，不向父模型重試", { timeout: 4000 }, () => fixture(async f => {
  assert.equal((await f.ask()).body.response, "reject")
  assert.equal(f.prompts.length, 1)
}, { parentModel: "gpt-6.1-sol-fast", prompt: async () => verdict("deny") }))
test("指定reviewer失敗後只fallback父模型一次，保留其variant", { timeout: 4000 }, () => fixture(async f => {
  assert.equal((await f.ask()).body.response, "once")
  assert.deepEqual(f.prompts.map(p => [p.body.model.modelID, p.body.variant]), [["gpt-6-luna", "low"], ["gpt-6.1-sol-fast", "high"]])
  assert.equal(f.deleted.length, 2)
}, { parentModel: "gpt-6.1-sol-fast", prompt: async input => {
  if (input.body.model.modelID === "gpt-6-luna") throw new Error("synthetic reviewer unavailable")
  return verdict("allow")
} }))
for (const [label, prompt] of [
  ["error", async () => { throw new Error("synthetic SDK failure") }],
  ["invalid", async () => ({ data: { info: { role: "assistant", structured: { decision: "invalid" } }, parts: [] } })],
  ["timeout", async (_input, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("synthetic abort", "AbortError")), { once: true }))],
]) test(`${label} 主／fallback均失敗→reject與temporary cleanup`, { timeout: 4000 }, () => fixture(async f => {
  assert.equal((await f.ask()).body.response, "reject")
  assert.equal(f.prompts.length, 2)
  await until(() => f.deleted.length === 2)
  if (label === "timeout") assert.equal(f.aborted.length, 2)
}, { parentModel: "gpt-6.1-sol-fast", prompt, timeoutMs: 100 }))
test("dispose 中止in-flight reviewer、清temporary session，不reply已關閉request", { timeout: 4000 }, () => fixture(async f => {
  const request = { id: "synthetic-dispose", sessionID: "synthetic-parent", permission: "read", patterns: ["/synthetic-workspace/src/item.ts"], always: [], metadata: {} }
  f.pending.set(request.id, request)
  await f.hooks.event({ event: { type: "permission.asked", properties: request } })
  await until(() => f.prompts.length === 1)
  await f.hooks.dispose()
  await until(() => f.deleted.length === 1)
  assert.equal(f.aborted.length, 1)
  assert.deepEqual(f.replies, [])
  await f.hooks.event({ event: { type: "permission.asked", properties: request } })
  await delay(10)
  assert.equal(f.prompts.length, 1)
}, { prompt: async (_input, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("synthetic dispose", "AbortError")), { once: true })) }))
