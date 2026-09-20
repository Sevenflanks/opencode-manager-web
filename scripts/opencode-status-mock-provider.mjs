import http from "node:http"

const MAX_BODY_BYTES = 1024 * 1024

function requestTool(body, name) {
  return (body.tools ?? []).find((tool) => (tool.function?.name ?? tool.name) === name)
}

function toolSchema(tool) {
  return tool?.function?.parameters ?? tool?.inputSchema ?? tool?.parameters ?? {}
}

function schemaSummary(tool) {
  const schema = toolSchema(tool)
  return {
    name: tool?.function?.name ?? tool?.name ?? null,
    required: Array.isArray(schema.required) ? schema.required : [],
    properties: Object.keys(schema.properties ?? {}).sort(),
  }
}

function hasToolResult(body) {
  return (body.messages ?? []).some(
    (message) => message.role === "tool" || JSON.stringify(message.content ?? "").includes("tool-result"),
  )
}

function questionArguments(tool) {
  const schema = toolSchema(tool)
  const key = schema.properties?.questions ? "questions" : Object.keys(schema.properties ?? {})[0]
  if (key !== "questions") throw new Error("The installed question tool schema has no questions property.")
  return {
    questions: [
      {
        question: "Select the fixed spike fixture.",
        header: "Fixture",
        options: [{ label: "fixed-answer", description: "Local test data only" }],
        multiple: false,
      },
    ],
  }
}

function readArguments(tool, fixturePath) {
  const schema = toolSchema(tool)
  const properties = schema.properties ?? {}
  const pathKey = ["filePath", "path", "file_path"].find((key) => key in properties)
  if (!pathKey) throw new Error("The installed read tool schema has no recognized path property.")
  const result = { [pathKey]: fixturePath }
  if ((schema.required ?? []).includes("offset")) result.offset = 1
  if ((schema.required ?? []).includes("limit")) result.limit = 1
  return result
}

function completionChunk(model, delta, finishReason = null, usage) {
  return {
    id: "chatcmpl-local-fixture",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  }
}

function writeSse(response, body, output) {
  const model = body.model ?? "mock"
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "close",
  })
  response.write(`data: ${JSON.stringify(completionChunk(model, { role: "assistant" }))}\n\n`)
  if (output.toolCall) {
    response.write(
      `data: ${JSON.stringify(
        completionChunk(model, {
          tool_calls: [
            {
              index: 0,
              id: output.toolCall.id,
              type: "function",
              function: { name: output.toolCall.name, arguments: JSON.stringify(output.toolCall.arguments) },
            },
          ],
        }),
      )}\n\n`,
    )
    response.write(`data: ${JSON.stringify(completionChunk(model, {}, "tool_calls"))}\n\n`)
  } else {
    response.write(`data: ${JSON.stringify(completionChunk(model, { content: output.text }))}\n\n`)
    response.write(`data: ${JSON.stringify(completionChunk(model, {}, "stop"))}\n\n`)
  }
  response.write(
    `data: ${JSON.stringify(
      completionChunk(model, {}, null, { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 }),
    )}\n\n`,
  )
  response.end("data: [DONE]\n\n")
}

function writeJson(response, body, output) {
  const message = output.toolCall
    ? {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: output.toolCall.id,
            type: "function",
            function: { name: output.toolCall.name, arguments: JSON.stringify(output.toolCall.arguments) },
          },
        ],
      }
    : { role: "assistant", content: output.text }
  response.writeHead(200, { "content-type": "application/json" })
  response.end(
    JSON.stringify({
      id: "chatcmpl-local-fixture",
      object: "chat.completion",
      created: 0,
      model: body.model ?? "mock",
      choices: [{ index: 0, message, finish_reason: output.toolCall ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    }),
  )
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error("Mock provider request body exceeded 1 MiB.")
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

export async function startMockProvider({ fixturePath }) {
  const events = []
  const waiters = new Set()
  const gates = new Map()

  function record(event) {
    events.push({ at: new Date().toISOString(), ...event })
    for (const wake of waiters) wake()
  }

  function waitFor(predicate, timeoutMs = 10000) {
    const existing = events.find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check)
        reject(new Error(`Mock provider event was not observed within ${timeoutMs} ms.`))
      }, timeoutMs)
      const check = () => {
        const event = events.find(predicate)
        if (!event) return
        clearTimeout(timer)
        waiters.delete(check)
        resolve(event)
      }
      waiters.add(check)
    })
  }

  function gate(name) {
    let release
    const promise = new Promise((resolve) => {
      release = resolve
    })
    gates.set(name, { promise, release })
    return promise
  }

  function release(name) {
    gates.get(name)?.release()
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1")
      if (request.method === "GET" && url.pathname === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ object: "list", data: [{ id: "mock", object: "model" }] }))
        return
      }
      if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
        response.writeHead(404, { "content-type": "application/json" })
        response.end(JSON.stringify({ error: { message: "Local fixture route not found" } }))
        return
      }

      const body = await readJson(request)
      const serializedMessages = JSON.stringify(body.messages ?? [])
      const followUp = hasToolResult(body)
      const questionTool = requestTool(body, "question")
      const readTool = requestTool(body, "read")
      const scenario = ["question", "permission", "abort", "busy"].find((name) =>
        serializedMessages.includes(`SPIKE_${name.toUpperCase()}_FIXTURE`),
      ) ?? "other"
      let phase = "other"
      let output = { text: "LOCAL_MOCK_FIXED_RESPONSE" }

      if (!followUp && serializedMessages.includes("SPIKE_QUESTION_FIXTURE") && questionTool) {
        phase = "question"
        output = {
          toolCall: {
            id: "call_question_fixture",
            name: "question",
            arguments: questionArguments(questionTool),
          },
        }
      } else if (!followUp && serializedMessages.includes("SPIKE_PERMISSION_FIXTURE") && readTool) {
        phase = "permission"
        output = {
          toolCall: {
            id: "call_read_fixture",
            name: "read",
            arguments: readArguments(readTool, fixturePath),
          },
        }
      } else if (!followUp && serializedMessages.includes("SPIKE_ABORT_FIXTURE") && body.tools?.length) {
        phase = "abort"
      } else if (!followUp && serializedMessages.includes("SPIKE_BUSY_FIXTURE") && body.tools?.length) {
        phase = "busy"
      }

      record({
        scenario,
        phase,
        stream: body.stream === true,
        tools: [questionTool, readTool].filter(Boolean).map(schemaSummary),
        tool_count: body.tools?.length ?? 0,
        follow_up: followUp,
      })

      if (phase === "busy" || phase === "abort") await gate(phase)
      if (body.stream === true) writeSse(response, body, output)
      else writeJson(response, body, output)
    } catch (error) {
      record({ phase: "provider-error", error: error.message })
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: { message: "Local mock provider fixture failed" } }))
    }
  })

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  return {
    port: address.port,
    events,
    waitFor,
    release,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  }
}
