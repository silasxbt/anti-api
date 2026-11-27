/**
 * Helpers shared by the native "direct" upstream pass-through paths
 * (Copilot / Codex / Grok): usage extraction and SSE re-framing.
 */

import { UpstreamError } from "~/lib/error"
import {
    normalizeStopReason,
    type BufferedCompletion,
    type RoutedStreamEvent,
    type StopReason,
} from "~/lib/stream-events"
import type { ClaudeContentBlock, ClaudeMessage, ClaudeTool } from "~/lib/translator"

/** Anthropic-style usage: `inputTokens` excludes prompt-cache hits. */
export interface DirectUsage {
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
}

export interface DirectOptions {
    /** Called once with the final usage when the upstream reports it (JSON body or end of SSE stream). */
    onUsage?: (usage: DirectUsage) => void
}

export type DirectJsonResult = {
    kind: "json"
    status: number
    data: any
    resolvedModel: string
    usage?: DirectUsage
}

export type DirectSseResult = {
    kind: "sse"
    status: number
    stream: AsyncGenerator<string, void, unknown>
    resolvedModel: string
}

export type DirectResult = DirectJsonResult | DirectSseResult

function toCount(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function normalizeUsage(total: unknown, output: unknown, cached: unknown): DirectUsage {
    const input = toCount(total)
    const cacheRead = Math.min(toCount(cached), input)
    return {
        inputTokens: input - cacheRead,
        outputTokens: toCount(output),
        cacheReadTokens: cacheRead,
    }
}

/**
 * OpenAI Responses usage (`response.usage` or `response.completed` event payload).
 * Accepts either the response object, or an event wrapping it in `.response`.
 */
export function extractResponsesUsage(data: any): DirectUsage | undefined {
    const usage = data?.response?.usage ?? data?.usage
    if (!usage || typeof usage !== "object") return undefined
    return normalizeUsage(
        usage.input_tokens,
        usage.output_tokens,
        usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens
    )
}

/** OpenAI Chat Completions usage (JSON body or the final `include_usage` chunk). */
export function extractChatUsage(data: any): DirectUsage | undefined {
    const usage = data?.usage
    if (!usage || typeof usage !== "object") return undefined
    return normalizeUsage(
        usage.prompt_tokens ?? usage.input_tokens,
        usage.completion_tokens ?? usage.output_tokens,
        usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens
    )
}

/** Re-frame arbitrary text chunks into complete SSE event blocks, each terminated by a blank line. */
export async function* sseEventBlocks(
    chunks: AsyncIterable<string>
): AsyncGenerator<string, void, unknown> {
    let buffer = ""
    for await (const chunk of chunks) {
        buffer += chunk
        const parts = buffer.split(/\r?\n\r?\n/)
        buffer = parts.pop() ?? ""
        for (const part of parts) {
            if (part.trim()) yield `${part}\n\n`
        }
    }
    if (buffer.trim()) yield `${buffer}\n\n`
}

/** Extract `event:` name and joined `data:` payload from one SSE block. */
export function parseSseBlock(block: string): { event?: string; data: string } | null {
    let event: string | undefined
    const dataLines: string[] = []
    for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) {
            event = line.slice(6).trim()
        } else if (line.startsWith("data:")) {
            const value = line.slice(5)
            dataLines.push(value.startsWith(" ") ? value.slice(1) : value)
        }
    }
    if (dataLines.length === 0) return null
    return { event, data: dataLines.join("\n") }
}

/** Parse the JSON payload of an SSE block (null for `[DONE]`, comments or invalid JSON). */
export function parseSseJson(block: string): any | null {
    const parsed = parseSseBlock(block)
    if (!parsed) return null
    const data = parsed.data.trim()
    if (!data || data === "[DONE]") return null
    try {
        return JSON.parse(data)
    } catch {
        return null
    }
}

/**
 * Pass SSE blocks through untouched while remembering the last usage reported by `extract`.
 * `onUsage` fires once after the upstream stream ends normally.
 */
export async function* tapSseUsage(
    blocks: AsyncIterable<string>,
    extract: (json: any) => DirectUsage | undefined,
    onUsage?: (usage: DirectUsage) => void
): AsyncGenerator<string, void, unknown> {
    let last: DirectUsage | undefined
    for await (const block of blocks) {
        // Cheap pre-check: only JSON-parse blocks that can carry usage.
        if (onUsage && block.includes("\"usage\"")) {
            const usage = extract(parseSseJson(block))
            if (usage) last = usage
        }
        yield block
    }
    if (last && onUsage) {
        try {
            onUsage(last)
        } catch {
            // Usage recording must never break the stream.
        }
    }
}

/** Fire `onUsage` for a JSON body, swallowing recorder errors. */
export function reportUsage(usage: DirectUsage | undefined, onUsage?: (usage: DirectUsage) => void): void {
    if (!usage || !onUsage) return
    try {
        onUsage(usage)
    } catch {
        // Usage recording must never break the response.
    }
}

/** Yield a fixed list of strings as an async generator. */
export async function* yieldAll(items: Iterable<string>): AsyncGenerator<string, void, unknown> {
    for (const item of items) yield item
}

/** Read a fetch `Response` body as text; an unreadable body yields "" instead of throwing. */
export async function readResponseText(response: Response): Promise<string> {
    try {
        return await response.text()
    } catch {
        return ""
    }
}

/** Collect an async text stream into one string (used to read upstream error bodies). */
export async function readTextStream(chunks: AsyncIterable<string>): Promise<string> {
    let text = ""
    try {
        for await (const chunk of chunks) text += chunk
    } catch {
        // Keep whatever arrived before the stream broke.
    }
    return text
}

/** Normalize a Responses `input` (string | item | item[]) to an item array. */
export function normalizeResponsesInput(input: unknown): any[] {
    if (typeof input === "string") {
        return [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }]
    }
    if (Array.isArray(input)) return input
    if (input && typeof input === "object") return [input]
    return []
}

function contentToText(content: unknown): string {
    if (typeof content === "string") return content
    if (!Array.isArray(content)) return ""
    return content
        .map((part: any) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
        .filter(Boolean)
        .join(" ")
}

/** Text of the last user message in a Responses `input` ("" when there is none). */
export function extractResponsesPromptText(input: unknown): string {
    if (typeof input === "string") return input
    if (!Array.isArray(input)) return ""
    for (let i = input.length - 1; i >= 0; i--) {
        const item = input[i]
        if (typeof item === "string") return item
        if (!item || typeof item !== "object") continue
        const isMessage = item.type === undefined || item.type === "message"
        if (!isMessage || item.role !== "user") continue
        const text = contentToText(item.content)
        if (text.trim()) return text
    }
    return ""
}

/** One Responses-API SSE frame: `event: <type>` + `data: {"type": <type>, ...}`. */
export function formatResponsesEvent(event: string, data: Record<string, unknown> = {}): string {
    return `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`
}

function randomId(prefix: string): string {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`
}

/**
 * Replay a finished Responses object as the SSE event sequence a streaming call would have produced
 * (created → per-item added/delta/done → completed). Used when the upstream can only answer non-streaming.
 */
export function responseObjectToSseEvents(response: any): string[] {
    const events: string[] = []
    let seq = 0
    const emit = (event: string, data: Record<string, unknown> = {}) => {
        events.push(formatResponsesEvent(event, { sequence_number: seq++, ...data }))
    }

    const rawOutput: any[] = Array.isArray(response?.output) ? response.output : []
    const output = rawOutput.map(item => {
        if (!item || typeof item !== "object" || item.id) return item
        const prefix = item.type === "function_call" ? "fc" : item.type === "reasoning" ? "rs" : "msg"
        return { ...item, id: randomId(prefix) }
    })
    const full = {
        ...response,
        id: response?.id || randomId("resp"),
        object: "response",
        output,
    }
    const base = { ...full, status: "in_progress", output: [], usage: null }
    emit("response.created", { response: base })
    emit("response.in_progress", { response: base })

    output.forEach((item, outputIndex) => {
        if (!item || typeof item !== "object") return
        if (item.type === "message") {
            emit("response.output_item.added", {
                output_index: outputIndex,
                item: { ...item, status: "in_progress", content: [] },
            })
            const parts: any[] = Array.isArray(item.content) ? item.content : []
            parts.forEach((part, contentIndex) => {
                if (part?.type === "output_text" || part?.type === "text") {
                    const text = typeof part.text === "string" ? part.text : ""
                    const empty = { type: "output_text", text: "", annotations: [] }
                    const done = { type: "output_text", text, annotations: part.annotations ?? [] }
                    const ref = { item_id: item.id, output_index: outputIndex, content_index: contentIndex }
                    emit("response.content_part.added", { ...ref, part: empty })
                    if (text) emit("response.output_text.delta", { ...ref, delta: text })
                    emit("response.output_text.done", { ...ref, text })
                    emit("response.content_part.done", { ...ref, part: done })
                }
            })
        } else if (item.type === "function_call") {
            const args = typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {})
            emit("response.output_item.added", {
                output_index: outputIndex,
                item: { ...item, status: "in_progress", arguments: "" },
            })
            if (args) emit("response.function_call_arguments.delta", { item_id: item.id, output_index: outputIndex, delta: args })
            emit("response.function_call_arguments.done", {
                item_id: item.id,
                output_index: outputIndex,
                name: item.name,
                arguments: args,
            })
        } else {
            emit("response.output_item.added", { output_index: outputIndex, item })
        }
        emit("response.output_item.done", { output_index: outputIndex, item })
    })

    emit(full.status === "incomplete" ? "response.incomplete" : "response.completed", {
        response: { ...full, status: full.status || "completed" },
    })
    return events
}

/** Convert a Responses request body into an OpenAI Chat Completions request body (non-streaming). */
export function responsesPayloadToChat(payload: Record<string, any>, model: string): Record<string, any> {
    const messages: any[] = []
    const instructions = typeof payload.instructions === "string" ? payload.instructions.trim() : ""
    if (instructions) messages.push({ role: "system", content: instructions })

    for (const item of normalizeResponsesInput(payload.input)) {
        if (!item || typeof item !== "object") continue
        const type = item.type ?? (item.role ? "message" : undefined)

        if (type === "message") {
            const role = item.role === "developer" ? "system" : item.role
            const parts: any[] = Array.isArray(item.content)
                ? item.content
                : [{ type: "input_text", text: String(item.content ?? "") }]
            const text = parts
                .filter(p => typeof p?.text === "string")
                .map(p => p.text)
                .join("")

            if (role === "assistant") {
                if (text) messages.push({ role: "assistant", content: text })
                continue
            }
            const images = parts.filter(p => p?.type === "input_image" && (p.image_url || p.file_id))
            const chatRole = role === "system" ? "system" : "user"
            if (images.length > 0 && chatRole === "user") {
                const content: any[] = []
                if (text) content.push({ type: "text", text })
                for (const image of images) {
                    const url = typeof image.image_url === "string" ? image.image_url : image.image_url?.url
                    if (url) content.push({ type: "image_url", image_url: { url } })
                }
                messages.push({ role: "user", content })
            } else {
                messages.push({ role: chatRole, content: text })
            }
        } else if (type === "function_call") {
            let target = messages[messages.length - 1]
            if (!target || target.role !== "assistant") {
                target = { role: "assistant", content: null }
                messages.push(target)
            }
            target.tool_calls = target.tool_calls || []
            target.tool_calls.push({
                id: item.call_id || item.id || randomId("call"),
                type: "function",
                function: {
                    name: item.name || "tool",
                    arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
                },
            })
        } else if (type === "function_call_output") {
            messages.push({
                role: "tool",
                tool_call_id: item.call_id,
                content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
            })
        }
    }

    const body: Record<string, any> = { model, messages, stream: false }

    if (Array.isArray(payload.tools)) {
        const tools = payload.tools
            .filter((t: any) => t?.type === "function" && t.name)
            .map((t: any) => ({
                type: "function",
                function: {
                    name: t.name,
                    ...(t.description ? { description: t.description } : {}),
                    parameters: t.parameters ?? { type: "object", properties: {} },
                },
            }))
        if (tools.length > 0) body.tools = tools
    }

    const choice = payload.tool_choice
    if (choice !== undefined && body.tools) {
        body.tool_choice = choice && typeof choice === "object" && choice.type === "function" && choice.name
            ? { type: "function", function: { name: choice.name } }
            : choice
    }
    if (payload.parallel_tool_calls !== undefined && body.tools) body.parallel_tool_calls = payload.parallel_tool_calls
    if (typeof payload.max_output_tokens === "number") body.max_tokens = payload.max_output_tokens
    if (typeof payload.temperature === "number") body.temperature = payload.temperature
    if (typeof payload.top_p === "number") body.top_p = payload.top_p
    if (typeof payload.reasoning?.effort === "string") body.reasoning_effort = payload.reasoning.effort

    const format = payload.text?.format
    if (format?.type === "json_object") {
        body.response_format = { type: "json_object" }
    } else if (format?.type === "json_schema" && format.schema) {
        body.response_format = {
            type: "json_schema",
            json_schema: { name: format.name || "response", schema: format.schema, ...(format.strict !== undefined ? { strict: format.strict } : {}) },
        }
    }
    return body
}

/** Convert a Chat Completions JSON response into a Responses-API response object. */
export function chatCompletionToResponsesObject(data: any, model: string): Record<string, any> {
    const choice = data?.choices?.[0]
    const message = choice?.message
    const output: any[] = []

    const reasoning = typeof message?.reasoning_content === "string" ? message.reasoning_content : ""
    if (reasoning) {
        output.push({
            type: "reasoning",
            id: randomId("rs"),
            status: "completed",
            summary: [{ type: "summary_text", text: reasoning }],
        })
    }

    const text = typeof message?.content === "string" ? message.content : ""
    if (text) {
        output.push({
            type: "message",
            id: randomId("msg"),
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text, annotations: [] }],
        })
    }
    for (const call of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
        output.push({
            type: "function_call",
            id: randomId("fc"),
            status: "completed",
            call_id: call.id || randomId("call"),
            name: call.function?.name || "tool",
            arguments: typeof call.function?.arguments === "string"
                ? call.function.arguments
                : JSON.stringify(call.function?.arguments ?? {}),
        })
    }

    const usage = data?.usage
    const inputTokens = toCount(usage?.prompt_tokens ?? usage?.input_tokens)
    const outputTokens = toCount(usage?.completion_tokens ?? usage?.output_tokens)
    const truncated = choice?.finish_reason === "length"

    return {
        id: randomId("resp"),
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status: truncated ? "incomplete" : "completed",
        error: null,
        incomplete_details: truncated ? { reason: "max_output_tokens" } : null,
        model,
        output,
        output_text: text,
        usage: {
            input_tokens: inputTokens,
            input_tokens_details: {
                cached_tokens: toCount(usage?.prompt_tokens_details?.cached_tokens),
            },
            output_tokens: outputTokens,
            output_tokens_details: { reasoning_tokens: toCount(usage?.completion_tokens_details?.reasoning_tokens) },
            total_tokens: inputTokens + outputTokens,
        },
    }
}

function safeJsonParseObject(value: unknown): Record<string, unknown> {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>
    }
    if (typeof value !== "string" || !value.trim()) return {}
    try {
        const parsed = JSON.parse(value)
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : { value: parsed }
    } catch {
        return {}
    }
}

function openAITextFromContent(content: unknown): string {
    if (typeof content === "string") return content
    if (!Array.isArray(content)) return ""
    return content
        .map((part: any) => {
            if (typeof part === "string") return part
            if ((part?.type === "text" || part?.type === "input_text" || part?.type === "output_text") && typeof part.text === "string") {
                return part.text
            }
            return ""
        })
        .filter(Boolean)
        .join("")
}

/**
 * Convert an OpenAI Chat Completions request body into a Responses API request body in 1 hop.
 */
export function chatPayloadToResponses(
    payload: Record<string, any>,
    model: string
): Record<string, any> {
    const input: any[] = []
    const instructionParts: string[] = []

    for (const msg of Array.isArray(payload.messages) ? payload.messages : []) {
        if (!msg || typeof msg !== "object") continue
        if (msg.role === "system" || msg.role === "developer") {
            const text = openAITextFromContent(msg.content).trim()
            if (text) instructionParts.push(text)
            continue
        }

        if (msg.role === "user") {
            const parts: any[] = []
            if (typeof msg.content === "string") {
                parts.push({ type: "input_text", text: msg.content })
            } else if (Array.isArray(msg.content)) {
                for (const part of msg.content) {
                    if (!part || typeof part !== "object") continue
                    if ((part.type === "text" || part.type === "input_text") && typeof part.text === "string") {
                        parts.push({ type: "input_text", text: part.text })
                    } else if (part.type === "image_url") {
                        const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url
                        if (typeof url === "string" && url) {
                            parts.push({ type: "input_image", image_url: url })
                        }
                    } else if (part.type === "input_audio" && part.input_audio?.data) {
                        parts.push({ type: "input_audio", input_audio: part.input_audio })
                    } else if (part.type === "audio_url" && part.audio_url?.url) {
                        parts.push({ type: "input_audio", audio_url: part.audio_url })
                    }
                }
            }
            input.push({
                type: "message",
                role: "user",
                content: parts.length > 0 ? parts : [{ type: "input_text", text: "" }],
            })
            continue
        }

        if (msg.role === "assistant") {
            const text = openAITextFromContent(msg.content)
            if (text) {
                input.push({
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text }],
                })
            }
            for (const tc of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
                const sig = tc?.thought_signature ?? tc?.thoughtSignature ?? tc?.function?.thought_signature
                input.push({
                    type: "function_call",
                    call_id: tc?.id || randomId("call"),
                    name: tc?.function?.name || "tool",
                    arguments: typeof tc?.function?.arguments === "string"
                        ? tc.function.arguments
                        : JSON.stringify(tc?.function?.arguments ?? {}),
                    ...(sig ? { thought_signature: sig } : {}),
                })
            }
            continue
        }

        if (msg.role === "tool") {
            input.push({
                type: "function_call_output",
                call_id: msg.tool_call_id || randomId("call"),
                output: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? ""),
            })
        }
    }

    const body: Record<string, any> = {
        model,
        input,
        stream: payload.stream === true,
        store: false,
    }

    if (instructionParts.length > 0) {
        body.instructions = instructionParts.join("\n\n")
    }

    if (Array.isArray(payload.tools) && payload.tools.length > 0) {
        const tools = payload.tools
            .filter((t: any) => t?.type === "function" && t.function?.name)
            .map((t: any) => ({
                type: "function",
                name: t.function.name,
                ...(t.function.description ? { description: t.function.description } : {}),
                parameters: t.function.parameters ?? { type: "object", properties: {} },
            }))
        if (tools.length > 0) body.tools = tools
    }

    if (payload.tool_choice !== undefined && body.tools) {
        const tc = payload.tool_choice
        body.tool_choice = tc && typeof tc === "object" && tc.type === "function" && tc.function?.name
            ? { type: "function", name: tc.function.name }
            : tc
    }
    if (payload.parallel_tool_calls !== undefined && body.tools) {
        body.parallel_tool_calls = payload.parallel_tool_calls
    }
    const maxTokens = payload.max_completion_tokens ?? payload.max_tokens
    if (typeof maxTokens === "number" && maxTokens > 0) {
        body.max_output_tokens = maxTokens
    }
    if (typeof payload.temperature === "number") body.temperature = payload.temperature
    if (typeof payload.top_p === "number") body.top_p = payload.top_p

    if (payload.reasoning && typeof payload.reasoning === "object") {
        body.reasoning = payload.reasoning
    } else if (typeof payload.reasoning_effort === "string" && payload.reasoning_effort.trim()) {
        body.reasoning = { effort: payload.reasoning_effort.trim(), summary: "auto" }
    }

    if (payload.response_format && typeof payload.response_format === "object") {
        if (payload.response_format.type === "json_object") {
            body.text = { format: { type: "json_object" } }
        } else if (payload.response_format.type === "json_schema" && payload.response_format.json_schema?.schema) {
            const js = payload.response_format.json_schema
            body.text = {
                format: {
                    type: "json_schema",
                    name: js.name || "response",
                    schema: js.schema,
                    ...(js.strict !== undefined ? { strict: js.strict } : {}),
                },
            }
        }
    }

    return body
}

/**
 * Convert a Responses API JSON response object into an OpenAI Chat Completions JSON response in 1 hop.
 */
export function responseObjectToChatCompletion(resp: any, model: string): Record<string, any> {
    const output = Array.isArray(resp?.output) ? resp.output : []
    const textParts: string[] = []
    const reasoningParts: string[] = []
    const toolCalls: any[] = []

    for (const item of output) {
        if (!item || typeof item !== "object") continue
        if (item.type === "reasoning") {
            if (Array.isArray(item.summary)) {
                for (const s of item.summary) {
                    if (typeof s?.text === "string" && s.text) reasoningParts.push(s.text)
                }
            } else if (Array.isArray(item.content)) {
                for (const c of item.content) {
                    if (typeof c?.text === "string" && c.text) reasoningParts.push(c.text)
                }
            }
        } else if (item.type === "message") {
            if (typeof item.content === "string") {
                textParts.push(item.content)
            } else if (Array.isArray(item.content)) {
                for (const c of item.content) {
                    if ((c?.type === "output_text" || c?.type === "text") && typeof c.text === "string") {
                        textParts.push(c.text)
                    } else if (c?.type === "tool_call") {
                        toolCalls.push({
                            id: c.id || randomId("call"),
                            type: "function",
                            function: {
                                name: c.name || "tool",
                                arguments: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments ?? {}),
                            },
                        })
                    }
                }
            }
        } else if (item.type === "function_call" || item.type === "tool_call") {
            const sig = item.thought_signature ?? item.thoughtSignature
            toolCalls.push({
                id: item.call_id || item.id || randomId("call"),
                type: "function",
                function: {
                    name: item.name || "tool",
                    arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
                },
                ...(sig ? { thought_signature: sig } : {}),
            })
        } else if (item.type === "output_text" && typeof item.text === "string") {
            textParts.push(item.text)
        }
    }

    if (textParts.length === 0 && typeof resp?.output_text === "string") {
        textParts.push(resp.output_text)
    }

    const textContent = textParts.join("")
    const reasoningContent = reasoningParts.join("")
    const isMaxTokens = resp?.status === "incomplete" || resp?.incomplete_details?.reason === "max_output_tokens"
    const finishReason = toolCalls.length > 0 ? "tool_calls" : isMaxTokens ? "length" : "stop"

    const message: Record<string, any> = {
        role: "assistant",
        content: toolCalls.length > 0 && !textContent ? null : textContent,
    }
    if (reasoningContent) message.reasoning_content = reasoningContent
    if (toolCalls.length > 0) message.tool_calls = toolCalls

    const usage = resp?.usage || {}
    const inputTokens = toCount(usage.input_tokens ?? usage.prompt_tokens)
    const outputTokens = toCount(usage.output_tokens ?? usage.completion_tokens)
    const cachedTokens = toCount(usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens)

    return {
        id: `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message, finish_reason: finishReason }],
        usage: {
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
            prompt_tokens_details: { cached_tokens: cachedTokens },
        },
    }
}

/**
 * Live 1-hop stream converter: Responses API SSE blocks -> OpenAI Chat Completions SSE frames.
 */
export async function* responsesSseToOpenAIChatSse(
    blocks: AsyncIterable<string>,
    model: string,
    options: { includeUsage?: boolean; provider?: string } = {}
): AsyncGenerator<string, void, unknown> {
    const chatId = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`
    const created = Math.floor(Date.now() / 1000)
    const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`
    const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) =>
        frame({
            id: chatId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta, finish_reason }],
        })

    let sentRole = false
    const ensureRole = () => {
        if (sentRole) return null
        sentRole = true
        return chunk({ role: "assistant" })
    }

    let nextToolIndex = 0
    const toolIndexByKey = new Map<string, number>()
    const emittedCallKeys = new Set<string>()
    let sawToolCalls = false
    let finishReason: "stop" | "length" | "tool_calls" = "stop"
    let lastUsage: any = null

    for await (const block of blocks) {
        const event = parseSseJson(block)
        if (!event || typeof event !== "object") continue

        switch (event.type) {
            case "response.created":
            case "response.in_progress": {
                const roleFrame = ensureRole()
                if (roleFrame) yield roleFrame
                break
            }
            case "response.reasoning_summary_text.delta":
            case "response.reasoning_text.delta": {
                if (typeof event.delta === "string" && event.delta) {
                    const roleFrame = ensureRole()
                    if (roleFrame) yield roleFrame
                    yield chunk({ reasoning_content: event.delta })
                }
                break
            }
            case "response.output_text.delta": {
                if (typeof event.delta === "string" && event.delta) {
                    const roleFrame = ensureRole()
                    if (roleFrame) yield roleFrame
                    yield chunk({ content: event.delta })
                }
                break
            }
            case "response.output_item.added": {
                const item = event.item
                if (item?.type === "function_call") {
                    const roleFrame = ensureRole()
                    if (roleFrame) yield roleFrame
                    const key = String(item.id ?? event.output_index ?? nextToolIndex)
                    let idx = toolIndexByKey.get(key)
                    if (idx === undefined) {
                        idx = nextToolIndex++
                        toolIndexByKey.set(key, idx)
                        if (typeof event.output_index === "number") toolIndexByKey.set(String(event.output_index), idx)
                        if (item.id) toolIndexByKey.set(String(item.id), idx)
                    }
                    emittedCallKeys.add(key)
                    sawToolCalls = true
                    yield chunk({
                        tool_calls: [{
                            index: idx,
                            id: item.call_id || item.id || randomId("call"),
                            type: "function",
                            function: { name: item.name || "tool", arguments: "" },
                        }],
                    })
                }
                break
            }
            case "response.function_call_arguments.delta": {
                if (typeof event.delta === "string" && event.delta) {
                    const roleFrame = ensureRole()
                    if (roleFrame) yield roleFrame
                    const key = String(event.item_id ?? event.output_index ?? 0)
                    let idx = toolIndexByKey.get(key)
                    if (idx === undefined && typeof event.output_index === "number") {
                        idx = toolIndexByKey.get(String(event.output_index))
                    }
                    if (idx === undefined) {
                        idx = nextToolIndex++
                        toolIndexByKey.set(key, idx)
                    }
                    sawToolCalls = true
                    yield chunk({
                        tool_calls: [{
                            index: idx,
                            function: { arguments: event.delta },
                        }],
                    })
                }
                break
            }
            case "response.output_item.done": {
                const item = event.item
                if (item?.type === "function_call") {
                    const key = String(item.id ?? event.output_index ?? "")
                    if (!emittedCallKeys.has(key) && !toolIndexByKey.has(key)) {
                        const roleFrame = ensureRole()
                        if (roleFrame) yield roleFrame
                        const idx = nextToolIndex++
                        toolIndexByKey.set(key, idx)
                        sawToolCalls = true
                        yield chunk({
                            tool_calls: [{
                                index: idx,
                                id: item.call_id || item.id || randomId("call"),
                                type: "function",
                                function: {
                                    name: item.name || "tool",
                                    arguments: typeof item.arguments === "string"
                                        ? item.arguments
                                        : JSON.stringify(item.arguments ?? {}),
                                },
                            }],
                        })
                    }
                }
                break
            }
            case "response.completed":
            case "response.incomplete": {
                const resp = event.response ?? event
                if (resp?.usage) lastUsage = resp.usage
                const isIncomplete = event.type === "response.incomplete"
                    || resp?.status === "incomplete"
                    || resp?.incomplete_details?.reason === "max_output_tokens"
                finishReason = sawToolCalls ? "tool_calls" : isIncomplete ? "length" : "stop"
                break
            }
            case "response.failed":
            case "error": {
                const errPayload = event.response?.error ?? event.error ?? event
                const err = new UpstreamError(options.provider || "upstream", 502, JSON.stringify(errPayload))
                if (sentRole) (err as any).streamingStarted = true
                throw err
            }
        }
    }

    const roleFrame = ensureRole()
    if (roleFrame) yield roleFrame
    yield chunk({}, finishReason)

    if (options.includeUsage && lastUsage) {
        const inputTokens = toCount(lastUsage.input_tokens ?? lastUsage.prompt_tokens)
        const outputTokens = toCount(lastUsage.output_tokens ?? lastUsage.completion_tokens)
        const cachedTokens = toCount(lastUsage.input_tokens_details?.cached_tokens ?? lastUsage.prompt_tokens_details?.cached_tokens)
        yield frame({
            id: chatId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [],
            usage: {
                prompt_tokens: inputTokens,
                completion_tokens: outputTokens,
                total_tokens: inputTokens + outputTokens,
                prompt_tokens_details: { cached_tokens: cachedTokens },
            },
        })
    }

    yield "data: [DONE]\n\n"
}

/**
 * Live 1-hop stream converter: Responses API SSE blocks -> RoutedStreamEvent.
 */
export async function* responsesSseToEvents(
    blocks: AsyncIterable<string>,
    model: string,
    provider: string = "upstream"
): AsyncGenerator<RoutedStreamEvent, void, unknown> {
    let started = false
    const emittedToolIds = new Set<string>()
    let sawToolCalls = false
    let stopReason: StopReason = "end_turn"
    let lastUsage: DirectUsage | undefined
    let reasoningTokens = 0

    const ensureStart = () => {
        if (started) return null
        started = true
        return { type: "start" as const, model }
    }

    for await (const block of blocks) {
        const event = parseSseJson(block)
        if (!event || typeof event !== "object") continue

        switch (event.type) {
            case "response.created":
            case "response.in_progress": {
                const s = ensureStart()
                if (s) yield s
                break
            }
            case "response.reasoning_summary_text.delta":
            case "response.reasoning_text.delta": {
                if (typeof event.delta === "string" && event.delta) {
                    const s = ensureStart()
                    if (s) yield s
                    yield { type: "thinking_delta", text: event.delta }
                }
                break
            }
            case "response.output_text.delta": {
                if (typeof event.delta === "string" && event.delta) {
                    const s = ensureStart()
                    if (s) yield s
                    yield { type: "text_delta", text: event.delta }
                }
                break
            }
            case "response.output_item.done": {
                const item = event.item
                if (item?.type === "function_call") {
                    const s = ensureStart()
                    if (s) yield s
                    const callId = item.call_id || item.id || randomId("call")
                    emittedToolIds.add(callId)
                    sawToolCalls = true
                    const rawArgs = typeof item.arguments === "string"
                        ? item.arguments
                        : JSON.stringify(item.arguments ?? {})
                    yield {
                        type: "tool_call",
                        id: callId,
                        name: item.name || "tool",
                        input: safeJsonParseObject(rawArgs),
                        rawArguments: rawArgs,
                        thoughtSignature: item.thought_signature ?? item.thoughtSignature,
                    }
                }
                break
            }
            case "response.completed":
            case "response.incomplete": {
                const resp = event.response ?? event
                if (Array.isArray(resp?.output)) {
                    for (const item of resp.output) {
                        if (item?.type === "function_call") {
                            const callId = item.call_id || item.id || randomId("call")
                            if (!emittedToolIds.has(callId)) {
                                const s = ensureStart()
                                if (s) yield s
                                emittedToolIds.add(callId)
                                sawToolCalls = true
                                const rawArgs = typeof item.arguments === "string"
                                    ? item.arguments
                                    : JSON.stringify(item.arguments ?? {})
                                yield {
                                    type: "tool_call",
                                    id: callId,
                                    name: item.name || "tool",
                                    input: safeJsonParseObject(rawArgs),
                                    rawArguments: rawArgs,
                                    thoughtSignature: item.thought_signature ?? item.thoughtSignature,
                                }
                            }
                        }
                    }
                }
                const extracted = extractResponsesUsage(resp)
                if (extracted) lastUsage = extracted
                reasoningTokens = toCount(resp?.usage?.output_tokens_details?.reasoning_tokens)
                const isIncomplete = event.type === "response.incomplete"
                    || resp?.status === "incomplete"
                    || resp?.incomplete_details?.reason === "max_output_tokens"
                stopReason = sawToolCalls ? "tool_use" : isIncomplete ? "max_tokens" : "end_turn"
                break
            }
            case "response.failed":
            case "error": {
                const errPayload = event.response?.error ?? event.error ?? event
                const err = new UpstreamError(provider, 502, JSON.stringify(errPayload))
                if (started) (err as any).streamingStarted = true
                throw err
            }
        }
    }

    const s = ensureStart()
    if (s) yield s
    yield {
        type: "finish",
        stopReason,
        usage: lastUsage ? { ...lastUsage, reasoningTokens } : undefined,
    }
}

/**
 * Live 1-hop stream converter: OpenAI Chat Completions SSE blocks -> RoutedStreamEvent.
 */
export async function* chatSseToEvents(
    blocks: AsyncIterable<string>,
    model: string
): AsyncGenerator<RoutedStreamEvent, void, unknown> {
    let started = false
    const pendingTools = new Map<number, { id: string; name: string; arguments: string; thoughtSignature?: string }>()
    let finishReason: string | null = null
    let lastUsage: DirectUsage | undefined

    const ensureStart = () => {
        if (started) return null
        started = true
        return { type: "start" as const, model }
    }

    for await (const block of blocks) {
        const parsed = parseSseJson(block)
        if (!parsed || typeof parsed !== "object") continue

        if (parsed.error) {
            const err = new UpstreamError("upstream", 502, JSON.stringify(parsed.error))
            if (started) (err as any).streamingStarted = true
            throw err
        }

        const extractedUsage = extractChatUsage(parsed)
        if (extractedUsage) lastUsage = extractedUsage

        const choice = parsed.choices?.[0]
        if (!choice) continue
        if (typeof choice.finish_reason === "string" && choice.finish_reason) {
            finishReason = choice.finish_reason
        }

        const delta = choice.delta || {}
        const reasoning = typeof delta.reasoning_content === "string"
            ? delta.reasoning_content
            : typeof delta.reasoning === "string"
              ? delta.reasoning
              : ""
        if (reasoning) {
            const s = ensureStart()
            if (s) yield s
            yield { type: "thinking_delta", text: reasoning }
        }
        if (typeof delta.content === "string" && delta.content) {
            const s = ensureStart()
            if (s) yield s
            yield { type: "text_delta", text: delta.content }
        }
        if (Array.isArray(delta.tool_calls)) {
            const s = ensureStart()
            if (s) yield s
            for (const tc of delta.tool_calls) {
                const idx = typeof tc.index === "number" ? tc.index : 0
                const entry = pendingTools.get(idx) || { id: "", name: "", arguments: "" }
                if (typeof tc.id === "string" && tc.id) entry.id = tc.id
                if (typeof tc.function?.name === "string" && tc.function.name) entry.name += tc.function.name
                if (typeof tc.function?.arguments === "string") entry.arguments += tc.function.arguments
                const sig = tc.thought_signature ?? tc.thoughtSignature
                if (typeof sig === "string" && sig) entry.thoughtSignature = sig
                pendingTools.set(idx, entry)
            }
        }
    }

    const s = ensureStart()
    if (s) yield s

    const orderedTools = Array.from(pendingTools.entries()).sort((a, b) => a[0] - b[0])
    for (const [, tool] of orderedTools) {
        yield {
            type: "tool_call",
            id: tool.id || randomId("call"),
            name: tool.name || "tool",
            input: safeJsonParseObject(tool.arguments),
            rawArguments: tool.arguments || "{}",
            thoughtSignature: tool.thoughtSignature,
        }
    }

    const stopReason: StopReason = orderedTools.length > 0
        ? "tool_use"
        : normalizeStopReason(finishReason)
    yield {
        type: "finish",
        stopReason,
        usage: lastUsage,
    }
}

/**
 * Convert Claude/Anthropic messages directly to Responses API `input` items in 1 hop.
 */
export function claudeMessagesToResponsesInput(messages: ClaudeMessage[]): {
    instructions?: string
    input: any[]
} {
    const input: any[] = []
    const instructionParts: string[] = []

    for (const msg of messages) {
        const role = msg.role as string
        if (role === "system") {
            const text = typeof msg.content === "string"
                ? msg.content
                : msg.content.filter(b => b.type === "text").map(b => b.text || "").join("")
            if (text.trim()) instructionParts.push(text.trim())
            continue
        }

        if (typeof msg.content === "string") {
            if (role === "assistant") {
                input.push({
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: msg.content }],
                })
            } else {
                input.push({
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: msg.content }],
                })
            }
            continue
        }

        const blocks = msg.content as ClaudeContentBlock[]
        if (role === "assistant") {
            const textParts: any[] = []
            const functionCalls: any[] = []
            for (const block of blocks) {
                if (block.type === "text" && block.text) {
                    textParts.push({ type: "output_text", text: block.text })
                } else if (block.type === "tool_use") {
                    const sig = (block as any).thought_signature ?? (block as any).thoughtSignature
                    functionCalls.push({
                        type: "function_call",
                        call_id: block.id || randomId("call"),
                        name: block.name || "tool",
                        arguments: JSON.stringify(block.input ?? {}),
                        ...(sig ? { thought_signature: sig } : {}),
                    })
                }
            }
            if (textParts.length > 0 || functionCalls.length === 0) {
                input.push({ type: "message", role: "assistant", content: textParts })
            }
            for (const fc of functionCalls) input.push(fc)
            continue
        }

        // User message: tool_result blocks become function_call_output; text/image/audio become user message.
        const userParts: any[] = []
        for (const block of blocks) {
            if (block.type === "tool_result") {
                let output: string | any[]
                if (typeof block.content === "string") {
                    output = block.content
                } else if (Array.isArray(block.content)) {
                    const outParts: any[] = []
                    for (const part of block.content) {
                        if (part?.type === "text" && typeof part.text === "string") {
                            outParts.push({ type: "input_text", text: part.text })
                        } else if (part?.type === "image" && part.source) {
                            const url = part.source.type === "base64"
                                ? `data:${part.source.media_type};base64,${part.source.data}`
                                : part.source.url
                            if (url) outParts.push({ type: "input_image", image_url: url })
                        } else if (part?.type === "audio" && part.source) {
                            if (part.source.type === "base64") {
                                outParts.push({
                                    type: "input_audio",
                                    input_audio: { data: part.source.data, format: part.source.media_type.replace("audio/", "") },
                                })
                            } else if (part.source.url) {
                                outParts.push({ type: "input_audio", audio_url: { url: part.source.url } })
                            }
                        }
                    }
                    output = outParts.length > 0 ? outParts : ""
                } else {
                    output = JSON.stringify(block.content ?? "")
                }
                input.push({
                    type: "function_call_output",
                    call_id: block.tool_use_id || randomId("call"),
                    output,
                })
            } else if (block.type === "text" && block.text) {
                userParts.push({ type: "input_text", text: block.text })
            } else if (block.type === "image" && block.source) {
                const url = block.source.type === "base64"
                    ? `data:${block.source.media_type};base64,${block.source.data}`
                    : block.source.url
                if (url) userParts.push({ type: "input_image", image_url: url })
            }
        }
        if (userParts.length > 0) {
            input.push({ type: "message", role: "user", content: userParts })
        }
    }

    return {
        instructions: instructionParts.length > 0 ? instructionParts.join("\n\n") : undefined,
        input,
    }
}

export function claudeToolsToResponsesTools(tools?: ClaudeTool[]): any[] | undefined {
    if (!tools || tools.length === 0) return undefined
    return tools.map(tool => ({
        type: "function",
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        parameters: tool.input_schema || { type: "object", properties: {} },
    }))
}

/**
 * Convert a Responses API JSON response directly to BufferedCompletion in 1 hop.
 */
export function responsesObjectToCompletion(data: any): BufferedCompletion {
    const output = Array.isArray(data?.output) ? data.output : []
    const contentBlocks: BufferedCompletion["contentBlocks"] = []
    let hasToolUse = false

    for (const item of output) {
        if (!item || typeof item !== "object") continue
        if (item.type === "reasoning") {
            const parts = Array.isArray(item.summary) ? item.summary : Array.isArray(item.content) ? item.content : []
            const thinking = parts.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("")
            if (thinking) contentBlocks.push({ type: "thinking", thinking })
        } else if (item.type === "message" && Array.isArray(item.content)) {
            for (const part of item.content) {
                if ((part?.type === "output_text" || part?.type === "text") && typeof part.text === "string" && part.text) {
                    contentBlocks.push({ type: "text", text: part.text })
                } else if (part?.type === "tool_call") {
                    hasToolUse = true
                    contentBlocks.push({
                        type: "tool_use",
                        id: part.id || randomId("call"),
                        name: part.name || "tool",
                        input: safeJsonParseObject(part.arguments),
                    })
                }
            }
        } else if (item.type === "function_call" || item.type === "tool_call") {
            hasToolUse = true
            const sig = item.thought_signature ?? item.thoughtSignature
            contentBlocks.push({
                type: "tool_use",
                id: item.call_id || item.id || randomId("call"),
                name: item.name || "tool",
                input: safeJsonParseObject(item.arguments),
                ...(sig ? { thought_signature: sig, thoughtSignature: sig } : {}),
            })
        } else if (item.type === "output_text" && typeof item.text === "string" && item.text) {
            contentBlocks.push({ type: "text", text: item.text })
        }
    }

    if (!contentBlocks.some(b => b.type === "text") && typeof data?.output_text === "string" && data.output_text) {
        contentBlocks.push({ type: "text", text: data.output_text })
    }

    const isMaxTokens = data?.status === "incomplete" || data?.incomplete_details?.reason === "max_output_tokens"
    const stopReason = hasToolUse ? "tool_use" : isMaxTokens ? "max_tokens" : "end_turn"
    const usage = extractResponsesUsage(data)

    return {
        contentBlocks,
        stopReason,
        usage: usage ? {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens,
            reasoningTokens: toCount(data?.usage?.output_tokens_details?.reasoning_tokens),
        } : { inputTokens: 0, outputTokens: 0 },
    }
}
