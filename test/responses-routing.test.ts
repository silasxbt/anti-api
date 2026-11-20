import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import type { RoutingConfig } from "../src/services/routing/config"
import type { ProviderAccount } from "../src/services/auth/types"
import {
    chatCompletionToResponsesObject,
    chatPayloadToResponses,
    chatSseToEvents,
    claudeMessagesToResponsesInput,
    claudeToolsToResponsesTools,
    responseObjectToChatCompletion,
    responsesObjectToCompletion,
    responsesSseToEvents,
    responsesSseToOpenAIChatSse,
} from "../src/lib/direct-stream"

let currentConfig: RoutingConfig = {
    version: 2,
    updatedAt: new Date().toISOString(),
    flows: [],
    accountRouting: { smartSwitch: false, routes: [] },
}

const accounts: Record<string, ProviderAccount> = {
    "cp-1": { id: "cp-1", provider: "copilot", accessToken: "cp-tok", label: "Copilot 1" },
    "cx-1": { id: "cx-1", provider: "codex", accessToken: "cx-tok", label: "Codex 1" },
    "gk-1": { id: "gk-1", provider: "grok", accessToken: "gk-tok", label: "Grok 1" },
}

const directCalls: Array<{ fn: string; model: string; payload: Record<string, any> }> = []
let copilotChatDirectMode: "direct" | "null" = "direct"

const realConfig = await import("../src/services/routing/config")
mock.module("~/services/routing/config", () => ({
    ...realConfig,
    loadRoutingConfig: () => currentConfig,
    isSeparateThinkingModelsEnabled: () => false,
    isHiddenCodexModel: () => false,
}))

const realChat = await import("../src/services/antigravity/chat")
mock.module("~/services/antigravity/chat", () => ({
    ...realChat,
    isAntigravityModelSupportedForAccount: () => true,
    createChatCompletionWithOptions: async (req: any) => ({
        contentBlocks: [
            { type: "thinking", thinking: "pondering" },
            { type: "text", text: `agy:${req.model}` },
        ],
        stopReason: "end_turn",
        usage: { inputTokens: 12, cacheReadTokens: 3, outputTokens: 7 },
    }),
    createAntigravityEventStreamWithOptions: async function* (req: any) {
        yield { type: "start" as const, model: req.model }
        yield { type: "thinking_delta" as const, text: "step1" }
        yield { type: "text_delta" as const, text: `stream:${req.model}` }
        yield {
            type: "finish" as const,
            stopReason: "end_turn" as const,
            usage: { inputTokens: 10, cacheReadTokens: 2, outputTokens: 5 },
        }
    },
}))

mock.module("~/services/antigravity/account-manager", () => ({
    accountManager: {
        load: () => {},
        hasAccount: () => true,
        isAccountRateLimited: () => false,
        isAccountInFlight: () => false,
        markRateLimitedFromError: async () => ({ reason: "unknown", durationMs: 1_000 }),
        clearAllRateLimits: () => {},
    },
}))

const realCopilot = await import("../src/services/copilot/chat")
mock.module("~/services/copilot/chat", () => ({
    ...realCopilot,
    createCopilotResponsesDirect: async (_acc: any, model: string, payload: Record<string, any>) => {
        directCalls.push({ fn: "copilot-responses", model, payload })
        if (payload.stream) {
            return {
                kind: "sse" as const,
                status: 200,
                resolvedModel: model,
                stream: (async function* () {
                    yield `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_cp", status: "in_progress" } })}\n\n`
                    yield `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_cp", status: "completed", output_text: "cp-sse" } })}\n\n`
                })(),
            }
        }
        return {
            kind: "json" as const,
            status: 200,
            resolvedModel: model,
            data: { id: "resp_cp", object: "response", status: "completed", model, output: [], output_text: "cp-direct" },
        }
    },
    createCopilotChatDirect: async (_acc: any, model: string, payload: Record<string, any>) => {
        directCalls.push({ fn: "copilot-chat", model, payload })
        if (copilotChatDirectMode === "null") return null
        return {
            kind: "json" as const,
            status: 200,
            resolvedModel: model,
            data: { id: "chat_cp", object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content: "cp-chat-direct" }, finish_reason: "stop" }] },
        }
    },
    createCopilotCompletion: async () => ({
        contentBlocks: [{ type: "text", text: "cp-fallback" }],
        stopReason: "end_turn",
        usage: { inputTokens: 4, outputTokens: 2 },
    }),
    createCopilotEventStream: async function* (_acc: any, model: string) {
        directCalls.push({ fn: "copilot-events", model, payload: {} })
        yield { type: "start" as const, model }
        yield { type: "text_delta" as const, text: "cp-anth-sse" }
        yield { type: "finish" as const, stopReason: "end_turn" as const, usage: { inputTokens: 3, outputTokens: 2 } }
    },
}))

const realCodex = await import("../src/services/codex/chat")
mock.module("~/services/codex/chat", () => ({
    ...realCodex,
    createCodexResponsesDirect: async (_acc: any, model: string, payload: Record<string, any>) => {
        directCalls.push({ fn: "codex-responses", model, payload })
        return {
            kind: "json" as const,
            status: 200,
            resolvedModel: model,
            data: { id: "resp_cx", object: "response", status: "completed", model, output: [], output_text: "cx-direct" },
        }
    },
    createCodexChatDirect: async (_acc: any, model: string, payload: Record<string, any>) => {
        directCalls.push({ fn: "codex-chat", model, payload })
        return {
            kind: "json" as const,
            status: 200,
            resolvedModel: model,
            data: { id: "chat_cx", object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content: "cx-chat-direct" }, finish_reason: "stop" }] },
        }
    },
    createCodexEventStream: async function* (_acc: any, model: string) {
        directCalls.push({ fn: "codex-events", model, payload: {} })
        yield { type: "start" as const, model }
        yield { type: "text_delta" as const, text: "cx-anth-sse" }
        yield { type: "finish" as const, stopReason: "end_turn" as const, usage: { inputTokens: 5, outputTokens: 2 } }
    },
    createCodexCompletion: async () => ({
        contentBlocks: [{ type: "text", text: "cx-anth-json" }],
        stopReason: "end_turn",
        usage: { inputTokens: 5, outputTokens: 2 },
    }),
}))

const realGrok = await import("../src/services/grok/chat")
mock.module("~/services/grok/chat", () => ({
    ...realGrok,
    createGrokResponsesDirect: async (_acc: any, model: string, payload: Record<string, any>) => {
        directCalls.push({ fn: "grok-responses", model, payload })
        return {
            kind: "json" as const,
            status: 200,
            resolvedModel: model,
            data: { id: "resp_gk", object: "response", status: "completed", model, output: [], output_text: "gk-direct" },
        }
    },
    createGrokChatDirect: async (_acc: any, model: string, payload: Record<string, any>) => {
        directCalls.push({ fn: "grok-chat", model, payload })
        return {
            kind: "json" as const,
            status: 200,
            resolvedModel: model,
            data: { id: "chat_gk", object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content: "gk-chat-direct" }, finish_reason: "stop" }] },
        }
    },
    createGrokCompletion: async () => ({
        contentBlocks: [{ type: "text", text: "gk-anth-json" }],
        stopReason: "end_turn",
        usage: { inputTokens: 5, outputTokens: 2 },
    }),
}))

const realStore = await import("../src/services/auth/store")
mock.module("~/services/auth/store", () => ({
    ...realStore,
    authStore: {
        ...realStore.authStore,
        getAccount: (_p: string, id: string) => accounts[id] ?? null,
        isRateLimited: () => false,
        markRateLimited: () => 1_000,
        markSuccess: () => {},
        listAccounts: (p?: string) => Object.values(accounts).filter(a => !p || a.provider === p),
    },
}))

const freshRouter = await import(`../src/services/routing/router.ts?${Date.now()}-${Math.random()}`)
mock.module("~/services/routing/router", () => ({ ...freshRouter }))

afterAll(() => {
    mock.restore()
})

beforeEach(() => {
    directCalls.length = 0
    copilotChatDirectMode = "direct"
    currentConfig = {
        version: 2,
        updatedAt: new Date().toISOString(),
        flows: [
            {
                id: "f-agy",
                name: "flow-agy",
                entries: [{ id: "e1", provider: "antigravity", accountId: "acc-1", modelId: "gemini-4-hydrogen", label: "Agy" }],
            },
            {
                id: "f-cp",
                name: "flow-cp",
                entries: [{ id: "e2", provider: "copilot", accountId: "cp-1", modelId: "copilot-auto", label: "CP" }],
            },
            {
                id: "f-cx",
                name: "flow-cx",
                entries: [{ id: "e3", provider: "codex", accountId: "cx-1", modelId: "gpt-5.3-codex", label: "CX" }],
            },
            {
                id: "f-gk",
                name: "flow-gk",
                entries: [{ id: "e4", provider: "grok", accountId: "gk-1", modelId: "grok-build", label: "GK" }],
            },
        ],
        accountRouting: { smartSwitch: false, routes: [] },
    }
})

describe("Direct-first /v1/responses & /v1/chat/completions HTTP routing", () => {
    const LOCAL_HEADERS = { host: "localhost:8964", "content-type": "application/json" }

    test("server /v1/responses and /responses return 200 JSON and SSE via Antigravity 1-hop adapter", async () => {
        const { server } = await import("../src/server")

        const jsonRes = await server.request("/v1/responses", {
            method: "POST",
            headers: LOCAL_HEADERS,
            body: JSON.stringify({ model: "flow-agy", input: "hello" }),
        })
        expect(jsonRes.status).toBe(200)
        const jsonBody = await jsonRes.json()
        expect(jsonBody.object).toBe("response")
        expect(jsonBody.status).toBe("completed")
        expect(jsonBody.output_text).toBe("agy:gemini-4-hydrogen")

        const sseRes = await server.request("/responses", {
            method: "POST",
            headers: LOCAL_HEADERS,
            body: JSON.stringify({ model: "flow-agy", input: "hello", stream: true }),
        })
        expect(sseRes.status).toBe(200)
        expect(sseRes.headers.get("content-type")).toContain("text/event-stream")
        const sseText = await sseRes.text()
        expect(sseText).toContain("event: response.created")
        expect(sseText).toContain("event: response.reasoning_summary_text.delta")
        expect(sseText).toContain("stream:gemini-4-hydrogen")
        expect(sseText).toContain("event: response.completed")
    })

    test("createPublicServer enforces auth on /v1/responses and /responses", async () => {
        const { createPublicServer } = await import("../src/server")
        const app = createPublicServer("pub-secret")

        const unauth = await app.request("/v1/responses", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "flow-agy", input: "hi" }),
        })
        expect(unauth.status).toBe(401)

        const authed = await app.request("/v1/responses", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: "Bearer pub-secret",
            },
            body: JSON.stringify({ model: "flow-agy", input: "hi" }),
        })
        expect(authed.status).toBe(200)
    })

    test("native /responses providers (Copilot, Codex, Grok) receive untouched raw payload", async () => {
        const { server } = await import("../src/server")

        const rawExtra = { type: "web_search" }
        const cpRes = await server.request("/v1/responses", {
            method: "POST",
            headers: LOCAL_HEADERS,
            body: JSON.stringify({ model: "flow-cp", input: "search", tools: [rawExtra] }),
        })
        expect(cpRes.status).toBe(200)
        expect((await cpRes.json()).output_text).toBe("cp-direct")
        expect(directCalls[0]).toMatchObject({ fn: "copilot-responses", model: "copilot-auto" })
        expect(directCalls[0].payload.tools).toEqual([rawExtra])

        const cxRes = await server.request("/v1/responses", {
            method: "POST",
            headers: LOCAL_HEADERS,
            body: JSON.stringify({ model: "flow-cx", input: "code", stream: false }),
        })
        expect(cxRes.status).toBe(200)
        expect((await cxRes.json()).output_text).toBe("cx-direct")

        const gkRes = await server.request("/v1/responses", {
            method: "POST",
            headers: LOCAL_HEADERS,
            body: JSON.stringify({ model: "flow-gk", input: "ask" }),
        })
        expect(gkRes.status).toBe(200)
        expect((await gkRes.json()).output_text).toBe("gk-direct")
    })

    test("/v1/chat/completions uses direct Copilot chat and falls back cleanly when createCopilotChatDirect returns null", async () => {
        const { server } = await import("../src/server")

        const directRes = await server.request("/v1/chat/completions", {
            method: "POST",
            headers: LOCAL_HEADERS,
            body: JSON.stringify({ model: "flow-cp", messages: [{ role: "user", content: "hi" }] }),
        })
        expect(directRes.status).toBe(200)
        expect((await directRes.json()).choices[0].message.content).toBe("cp-chat-direct")

        copilotChatDirectMode = "null"
        const fallbackRes = await server.request("/v1/chat/completions", {
            method: "POST",
            headers: LOCAL_HEADERS,
            body: JSON.stringify({ model: "flow-cp", messages: [{ role: "user", content: "hi" }] }),
        })
        expect(fallbackRes.status).toBe(200)
        expect((await fallbackRes.json()).choices[0].message.content).toBe("cp-fallback")
    })

    test("chatCompletionToResponsesObject preserves reasoning_content and output_text", () => {
        const resp = chatCompletionToResponsesObject(
            {
                choices: [
                    {
                        finish_reason: "stop",
                        message: {
                            role: "assistant",
                            reasoning_content: "step A",
                            content: "final answer",
                        },
                    },
                ],
                usage: { prompt_tokens: 10, completion_tokens: 5 },
            },
            "gpt-5"
        )
        expect(resp.output_text).toBe("final answer")
        expect(resp.output).toHaveLength(2)
        expect(resp.output[0]).toMatchObject({ type: "reasoning", summary: [{ type: "summary_text", text: "step A" }] })
        expect(resp.output[1]).toMatchObject({ type: "message", content: [{ type: "output_text", text: "final answer" }] })
    })

    test("/v1/chat/completions dispatches 1-hop direct adapters for Codex and Grok", async () => {
        const { server } = await import("../src/server")

        const cxRes = await server.request("/v1/chat/completions", {
            method: "POST",
            headers: LOCAL_HEADERS,
            body: JSON.stringify({ model: "flow-cx", messages: [{ role: "user", content: "hi" }] }),
        })
        expect(cxRes.status).toBe(200)
        expect((await cxRes.json()).choices[0].message.content).toBe("cx-chat-direct")
        expect(directCalls.some(c => c.fn === "codex-chat")).toBe(true)

        const gkRes = await server.request("/v1/chat/completions", {
            method: "POST",
            headers: LOCAL_HEADERS,
            body: JSON.stringify({ model: "flow-gk", messages: [{ role: "user", content: "hi" }] }),
        })
        expect(gkRes.status).toBe(200)
        expect((await gkRes.json()).choices[0].message.content).toBe("gk-chat-direct")
        expect(directCalls.some(c => c.fn === "grok-chat")).toBe(true)
    })

    test("/v1/messages (Anthropic) works across Antigravity, Copilot, Codex, and Grok with live SSE and system/thinking", async () => {
        const { server } = await import("../src/server")

        const agyRes = await server.request("/v1/messages", {
            method: "POST",
            headers: LOCAL_HEADERS,
            body: JSON.stringify({
                model: "flow-agy",
                system: "Be concise.",
                max_tokens: 128,
                messages: [{ role: "user", content: "hi" }],
            }),
        })
        expect(agyRes.status).toBe(200)
        const agyJson = await agyRes.json()
        expect(agyJson.content).toEqual([
            { type: "thinking", thinking: "pondering" },
            { type: "text", text: "agy:gemini-4-hydrogen" },
        ])

        const cpSse = await server.request("/v1/messages", {
            method: "POST",
            headers: LOCAL_HEADERS,
            body: JSON.stringify({
                model: "flow-cp",
                max_tokens: 128,
                stream: true,
                messages: [{ role: "user", content: "hi" }],
            }),
        })
        expect(cpSse.status).toBe(200)
        expect(await cpSse.text()).toContain("cp-anth-sse")

        const cxSse = await server.request("/v1/messages", {
            method: "POST",
            headers: LOCAL_HEADERS,
            body: JSON.stringify({
                model: "flow-cx",
                max_tokens: 128,
                stream: true,
                messages: [{ role: "user", content: "hi" }],
            }),
        })
        expect(cxSse.status).toBe(200)
        expect(await cxSse.text()).toContain("cx-anth-sse")

        const gkRes = await server.request("/v1/messages", {
            method: "POST",
            headers: LOCAL_HEADERS,
            body: JSON.stringify({
                model: "flow-gk",
                max_tokens: 128,
                messages: [{ role: "user", content: "hi" }],
            }),
        })
        expect(gkRes.status).toBe(200)
        expect((await gkRes.json()).content[0].text).toBe("gk-anth-json")
    })
})

describe("1-hop direct-stream converters", () => {
    test("chatPayloadToResponses and responseObjectToChatCompletion preserve tools, instructions, reasoning, and usage", () => {
        const req = chatPayloadToResponses(
            {
                model: "gpt-5.3-codex",
                stream: true,
                max_completion_tokens: 512,
                reasoning_effort: "high",
                tool_choice: { type: "function", function: { name: "get_weather" } },
                tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }],
                messages: [
                    { role: "system", content: "Sys prompt" },
                    { role: "user", content: "Weather?" },
                    {
                        role: "assistant",
                        content: null,
                        tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Rome\"}" } }],
                    },
                    { role: "tool", tool_call_id: "call_1", content: "Sunny" },
                ],
            },
            "gpt-5.3-codex"
        )
        expect(req.instructions).toBe("Sys prompt")
        expect(req.max_output_tokens).toBe(512)
        expect(req.reasoning).toEqual({ effort: "high", summary: "auto" })
        expect(req.tool_choice).toEqual({ type: "function", name: "get_weather" })
        expect(req.input).toHaveLength(3)

        const chat = responseObjectToChatCompletion(
            {
                status: "completed",
                output: [
                    { type: "reasoning", summary: [{ type: "summary_text", text: "thinking..." }] },
                    { type: "message", content: [{ type: "output_text", text: "It is sunny." }] },
                    { type: "function_call", call_id: "call_2", name: "done", arguments: "{}" },
                ],
                usage: { input_tokens: 15, output_tokens: 8, input_tokens_details: { cached_tokens: 3 } },
            },
            "gpt-5.3-codex"
        )
        expect(chat.choices[0].finish_reason).toBe("tool_calls")
        expect(chat.choices[0].message.reasoning_content).toBe("thinking...")
        expect(chat.choices[0].message.content).toBe("It is sunny.")
        expect(chat.choices[0].message.tool_calls[0].id).toBe("call_2")
        expect(chat.usage.prompt_tokens_details.cached_tokens).toBe(3)
    })

    test("responsesSseToOpenAIChatSse and responsesSseToEvents stream reasoning, text, tools, and finish in 1 hop", async () => {
        const blocks = [
            `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "r1", status: "in_progress" } })}\n\n`,
            `event: response.reasoning_summary_text.delta\ndata: ${JSON.stringify({ type: "response.reasoning_summary_text.delta", delta: "plan " })}\n\n`,
            `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "answer" })}\n\n`,
            `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 1, item: { id: "fc_1", call_id: "c1", type: "function_call", name: "ping" } })}\n\n`,
            `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_1", delta: "{\"ok\":true}" })}\n\n`,
            `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 1, item: { id: "fc_1", call_id: "c1", type: "function_call", name: "ping", arguments: "{\"ok\":true}" } })}\n\n`,
            `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "r1", status: "completed", usage: { input_tokens: 10, output_tokens: 4 } } })}\n\n`,
        ]

        async function* gen() {
            for (const b of blocks) yield b
        }

        const chatFrames: string[] = []
        for await (const frame of responsesSseToOpenAIChatSse(gen(), "gpt-5.3-codex", { includeUsage: true })) {
            chatFrames.push(frame)
        }
        const chatJoined = chatFrames.join("")
        expect(chatJoined).toContain('"reasoning_content":"plan "')
        expect(chatJoined).toContain('"content":"answer"')
        expect(chatJoined).toContain('"finish_reason":"tool_calls"')
        expect(chatJoined).toContain('"prompt_tokens":10')
        expect(chatJoined).toContain("data: [DONE]")

        const events: any[] = []
        for await (const ev of responsesSseToEvents(gen(), "gpt-5.3-codex")) {
            events.push(ev)
        }
        expect(events.map(e => e.type)).toEqual(["start", "thinking_delta", "text_delta", "tool_call", "finish"])
        expect(events[3]).toMatchObject({ id: "c1", name: "ping", input: { ok: true } })
        expect(events[4]).toMatchObject({ stopReason: "tool_use" })
    })

    test("chatSseToEvents and claudeMessagesToResponsesInput / responsesObjectToCompletion convert in 1 hop", async () => {
        async function* chatBlocks() {
            yield `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", reasoning_content: "hmm" } }] })}\n\n`
            yield `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`
            yield `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 2 } })}\n\n`
            yield "data: [DONE]\n\n"
        }
        const evs: any[] = []
        for await (const ev of chatSseToEvents(chatBlocks(), "claude-sonnet-4.5")) {
            evs.push(ev)
        }
        expect(evs).toEqual([
            { type: "start", model: "claude-sonnet-4.5" },
            { type: "thinking_delta", text: "hmm" },
            { type: "text_delta", text: "hi" },
            { type: "finish", stopReason: "end_turn", usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 0 } },
        ])

        const converted = claudeMessagesToResponsesInput([
            { role: "system" as any, content: "System rules" },
            { role: "user", content: [{ type: "text", text: "Run" }] },
            { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "do_x", input: { a: 1 } }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
        ])
        expect(converted.instructions).toBe("System rules")
        expect(converted.input).toHaveLength(3)
        expect(claudeToolsToResponsesTools([{ name: "do_x", input_schema: { type: "object" } }])).toEqual([
            { type: "function", name: "do_x", parameters: { type: "object" } },
        ])

        const completion = responsesObjectToCompletion({
            status: "completed",
            output: [
                { type: "reasoning", summary: [{ type: "summary_text", text: "thought" }] },
                { type: "message", content: [{ type: "output_text", text: "done" }] },
            ],
            usage: { input_tokens: 10, output_tokens: 3, input_tokens_details: { cached_tokens: 2 } },
        })
        expect(completion.contentBlocks).toEqual([
            { type: "thinking", thinking: "thought" },
            { type: "text", text: "done" },
        ])
        expect(completion.usage).toMatchObject({ inputTokens: 8, cacheReadTokens: 2, outputTokens: 3 })
    })
})
