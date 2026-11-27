/**
 * OpenAI Responses API (/v1/responses) Direct 1-Hop Translator & SSE Formatter
 */

import { RequestValidationError } from "~/lib/error"
import { normalizeStopReason, type BufferedCompletion, type RoutedStreamEvent, type StreamUsage } from "~/lib/stream-events"
import type { ClaudeContentBlock, ClaudeMessage, ClaudeTool } from "~/lib/translator"
import { mapModel } from "~/routes/openai/translator"
import type {
    ResponseObject,
    ResponseOutputFunctionCallItem,
    ResponseOutputItem,
    ResponseOutputMessageItem,
    ResponseOutputReasoningItem,
    ResponseUsage,
    ResponsesContentPart,
    ResponsesCreateRequest,
    ResponsesInputItem,
    ResponsesTool,
    ResponsesToolChoice,
} from "./types"

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value)
}

export function generateResponseId(): string {
    return `resp_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`
}

function generateItemId(prefix: "msg" | "fc" | "rs"): string {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`
}

export function extractResponsesReasoningEffort(
    payload: ResponsesCreateRequest
): "low" | "medium" | "high" | undefined {
    const raw = payload?.reasoning?.effort ?? payload?.reasoning_effort
    if (typeof raw !== "string") return undefined
    const normalized = raw.trim().toLowerCase()
    if (normalized === "xhigh" || normalized === "high" || normalized === "max") {
        return "high"
    }
    if (normalized === "medium") {
        return "medium"
    }
    if (normalized === "low" || normalized === "minimal") {
        return "low"
    }
    return undefined
}

export function extractResponsesPromptText(input: ResponsesCreateRequest["input"]): string {
    if (typeof input === "string") {
        return input
    }
    if (!Array.isArray(input)) {
        return ""
    }

    for (let i = input.length - 1; i >= 0; i--) {
        const item = input[i]
        if (!isRecord(item)) continue
        const itemType = item.type ?? "message"
        if (itemType !== "message") continue
        if (item.role !== "user") continue

        if (typeof item.content === "string") {
            if (item.content.trim()) return item.content
            continue
        }
        if (Array.isArray(item.content)) {
            const texts: string[] = []
            for (const part of item.content) {
                if (!isRecord(part)) continue
                if (
                    (part.type === "input_text" || part.type === "text" || part.type === "output_text") &&
                    typeof part.text === "string" &&
                    part.text
                ) {
                    texts.push(part.text)
                }
            }
            const joined = texts.join(" ").trim()
            if (joined) return joined
        }
    }

    return ""
}

const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_INLINE_IMAGE_BASE64_CHARS = Math.ceil(MAX_INLINE_IMAGE_BYTES / 3) * 4
const MAX_INLINE_IMAGE_WHITESPACE_CHARS = 16 * 1024

function isBase64Character(charCode: number): boolean {
    return (
        (charCode >= 0x41 && charCode <= 0x5a) ||
        (charCode >= 0x61 && charCode <= 0x7a) ||
        (charCode >= 0x30 && charCode <= 0x39) ||
        charCode === 0x2b ||
        charCode === 0x2f
    )
}

function isAsciiWhitespace(charCode: number): boolean {
    return charCode === 0x09 || charCode === 0x0a || charCode === 0x0c || charCode === 0x0d || charCode === 0x20
}

function validateBase64Data(data: string, label: string = "image_url"): void {
    if (data.length % 4 !== 0) {
        throw new RequestValidationError(`${label} data URI must contain valid base64 data`)
    }

    let firstPadding = -1
    for (let index = 0; index < data.length; index++) {
        const charCode = data.charCodeAt(index)
        if (charCode === 0x3d) {
            if (firstPadding === -1) firstPadding = index
            continue
        }
        if (firstPadding !== -1 || !isBase64Character(charCode)) {
            throw new RequestValidationError(`${label} data URI must contain valid base64 data`)
        }
    }

    if (firstPadding === -1) return
    const paddingLength = data.length - firstPadding
    const unpaddedLength = firstPadding % 4
    if (
        (paddingLength !== 1 && paddingLength !== 2) ||
        (paddingLength === 1 && unpaddedLength !== 3) ||
        (paddingLength === 2 && unpaddedLength !== 2)
    ) {
        throw new RequestValidationError(`${label} data URI must contain valid base64 data`)
    }
}

function parseDataImageUrl(url: string): ClaudeContentBlock["source"] | null {
    const separator = url.indexOf(",")
    if (separator === -1) return null
    const header = url.slice(0, separator)
    const match = header.match(/^data:(image\/[A-Za-z0-9.+-]+);base64$/i)
    if (!match) return null

    const rawData = url.slice(separator + 1)
    if (!rawData) {
        throw new RequestValidationError("input_image data URI must include base64 image data")
    }
    if (rawData.length > MAX_INLINE_IMAGE_BASE64_CHARS + MAX_INLINE_IMAGE_WHITESPACE_CHARS) {
        throw new RequestValidationError("input_image data URI exceeds the 10 MiB image limit")
    }

    for (let index = 0; index < rawData.length; index++) {
        const charCode = rawData.charCodeAt(index)
        if (charCode === 0x3d || isBase64Character(charCode) || isAsciiWhitespace(charCode)) continue
        throw new RequestValidationError("input_image data URI must contain valid base64 image data")
    }

    const data = rawData.replace(/[\t\n\f\r ]/g, "")
    if (!data) {
        throw new RequestValidationError("input_image data URI must include base64 image data")
    }
    if (data.length > MAX_INLINE_IMAGE_BASE64_CHARS) {
        throw new RequestValidationError("input_image data URI exceeds the 10 MiB image limit")
    }
    validateBase64Data(data, "input_image")

    const decoded = Buffer.from(data, "base64")
    if (decoded.byteLength > MAX_INLINE_IMAGE_BYTES) {
        throw new RequestValidationError("input_image data URI exceeds the 10 MiB image limit")
    }

    return {
        type: "base64",
        media_type: match[1].toLowerCase(),
        data,
    }
}

function parseDataAudioUrl(url: string): ClaudeContentBlock["source"] | null {
    const separator = url.indexOf(",")
    if (separator === -1) return null
    const header = url.slice(0, separator)
    const match = header.match(/^data:(audio\/[A-Za-z0-9.+-]+);base64$/i)
    if (!match) return null

    const rawData = url.slice(separator + 1)
    if (!rawData) {
        throw new RequestValidationError("audio data URI must include base64 audio data")
    }
    const data = rawData.replace(/[\t\n\f\r ]/g, "")
    if (!data) {
        throw new RequestValidationError("audio data URI must include base64 audio data")
    }
    validateBase64Data(data, "input_audio")

    return {
        type: "base64",
        media_type: match[1].toLowerCase(),
        data,
    }
}

function parseFunctionCallArguments(value: unknown, index: number): Record<string, unknown> {
    const raw = value === undefined || value === null || value === "" ? "{}" : value
    if (typeof raw !== "string") {
        throw new RequestValidationError(`function_call at index ${index} must include JSON string arguments`)
    }

    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        throw new RequestValidationError(`function_call at index ${index} has invalid JSON arguments`)
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new RequestValidationError(`function_call at index ${index} arguments must be a JSON object`)
    }
    return parsed as Record<string, unknown>
}

function translateResponsesContentPart(part: ResponsesContentPart, index: number): ClaudeContentBlock {
    if (!isRecord(part)) {
        throw new RequestValidationError(`content part at index ${index} must be an object`)
    }

    if (part.type === "input_text" || part.type === "text" || part.type === "output_text") {
        if (typeof part.text !== "string") {
            throw new RequestValidationError(`content part at index ${index} must include text`)
        }
        return { type: "text", text: part.text }
    }

    if (part.type === "refusal") {
        const refusalText = typeof part.refusal === "string" ? part.refusal : ""
        return { type: "text", text: refusalText }
    }

    if (part.type === "input_image" || part.type === "image_url") {
        const rawImageUrl =
            typeof part.image_url === "string"
                ? part.image_url
                : isRecord(part.image_url) && typeof part.image_url.url === "string"
                  ? part.image_url.url
                  : undefined

        if (typeof rawImageUrl !== "string" || !rawImageUrl.trim()) {
            throw new RequestValidationError(`input_image part at index ${index} must include image_url`)
        }

        const url = rawImageUrl.trim()
        const inlineAudio = parseDataAudioUrl(url)
        if (inlineAudio) {
            return { type: "audio", source: inlineAudio }
        }

        const inlineImage = parseDataImageUrl(url)
        if (inlineImage) {
            return { type: "image", source: inlineImage }
        }

        let parsed: URL
        try {
            parsed = new URL(url)
        } catch {
            throw new RequestValidationError(`input_image part at index ${index} must be a data URI or an http(s) URL`)
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw new RequestValidationError(`input_image part at index ${index} must use http(s) or a base64 data URI`)
        }
        return { type: "image", source: { type: "url", url: parsed.toString() } }
    }

    if (part.type === "input_audio" || part.type === "audio_url") {
        const audioObj = isRecord(part.input_audio) ? part.input_audio : part
        if (typeof audioObj.data === "string") {
            const format = (typeof audioObj.format === "string" ? audioObj.format : "wav").toLowerCase()
            const mediaType = format === "mp3" ? "audio/mp3" : format === "wav" ? "audio/wav" : `audio/${format}`
            const data = audioObj.data.replace(/[\t\n\f\r ]/g, "")
            if (!data) {
                throw new RequestValidationError(`input_audio part at index ${index} must include base64 audio data`)
            }
            validateBase64Data(data, "input_audio")
            return {
                type: "audio",
                source: {
                    type: "base64",
                    media_type: mediaType,
                    data,
                },
            }
        }

        const rawAudioUrl =
            typeof part.audio_url === "string"
                ? part.audio_url
                : isRecord(part.audio_url) && typeof part.audio_url.url === "string"
                  ? part.audio_url.url
                  : undefined

        if (typeof rawAudioUrl === "string" && rawAudioUrl.trim()) {
            const url = rawAudioUrl.trim()
            const inlineAudio = parseDataAudioUrl(url)
            if (inlineAudio) {
                return { type: "audio", source: inlineAudio }
            }
            let parsed: URL
            try {
                parsed = new URL(url)
            } catch {
                throw new RequestValidationError(`input_audio part at index ${index} must be a data URI or an http(s) URL`)
            }
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
                throw new RequestValidationError(`input_audio part at index ${index} must use http(s) or a base64 data URI`)
            }
            return { type: "audio", source: { type: "url", url: parsed.toString() } }
        }

        throw new RequestValidationError(`input_audio part at index ${index} must include data or audio_url`)
    }

    if (part.type === "input_file") {
        if (typeof part.file_data === "string" && part.file_data.trim()) {
            const raw = part.file_data.trim()
            const inlineAudio = parseDataAudioUrl(raw)
            if (inlineAudio) {
                return { type: "audio", source: inlineAudio }
            }
            const inlineImage = parseDataImageUrl(raw)
            if (inlineImage) {
                return { type: "image", source: inlineImage }
            }
            return {
                type: "text",
                text: part.filename ? `[File: ${part.filename}]\n${raw}` : raw,
            }
        }
        if (typeof part.file_id === "string" && part.file_id.trim()) {
            return { type: "text", text: `[File ID: ${part.file_id}]` }
        }
        throw new RequestValidationError(`input_file part at index ${index} must include file_data or file_id`)
    }

    throw new RequestValidationError(`Unsupported Responses content part type at index ${index}`)
}

function translateMessageContent(content: unknown, itemIndex: number): string | ClaudeContentBlock[] {
    if (content === null || content === undefined) return ""
    if (typeof content === "string") return content
    if (!Array.isArray(content)) {
        throw new RequestValidationError(`input item at index ${itemIndex} content must be a string or an array of content parts`)
    }
    return content.map((part, partIdx) => translateResponsesContentPart(part as ResponsesContentPart, partIdx))
}

function toContentBlocks(content: string | ClaudeContentBlock[]): ClaudeContentBlock[] {
    if (typeof content === "string") {
        return content ? [{ type: "text", text: content }] : []
    }
    return [...content]
}

const RESPONSES_MEDIA_PART_TYPES = new Set(["input_image", "image_url", "input_audio", "audio_url"])

function translateFunctionOutput(output: unknown, itemIndex: number): string | ClaudeContentBlock[] {
    if (output === null || output === undefined) return ""
    if (typeof output === "string") return output
    if (Array.isArray(output)) {
        const hasMedia = output.some(
            part => isRecord(part) && typeof part.type === "string" && RESPONSES_MEDIA_PART_TYPES.has(part.type)
        )
        if (hasMedia) {
            const blocks: ClaudeContentBlock[] = []
            for (let i = 0; i < output.length; i++) {
                const part = output[i]
                if (isRecord(part) && (part.type === "input_text" || part.type === "text" || part.type === "output_text")) {
                    if (typeof part.text !== "string") {
                        throw new RequestValidationError(`function_call_output part at index ${i} must include text`)
                    }
                    blocks.push({ type: "text", text: part.text })
                } else if (isRecord(part) && typeof part.type === "string" && RESPONSES_MEDIA_PART_TYPES.has(part.type)) {
                    blocks.push(translateResponsesContentPart(part as unknown as ResponsesContentPart, i))
                } else {
                    blocks.push({ type: "text", text: JSON.stringify(part) })
                }
            }
            return blocks
        }

        const texts: string[] = []
        for (let i = 0; i < output.length; i++) {
            const part = output[i]
            if (isRecord(part) && (part.type === "input_text" || part.type === "text" || part.type === "output_text")) {
                if (typeof part.text !== "string") {
                    throw new RequestValidationError(`function_call_output part at index ${i} must include text`)
                }
                texts.push(part.text)
            } else {
                texts.push(JSON.stringify(part))
            }
        }
        return texts.join("\n")
    }
    if (typeof output === "object") {
        return JSON.stringify(output)
    }
    throw new RequestValidationError(`function_call_output at index ${itemIndex} has invalid output`)
}

export function translateResponsesInput(
    input: ResponsesCreateRequest["input"],
    instructions?: string | null
): ClaudeMessage[] {
    const messages: ClaudeMessage[] = []

    if (typeof instructions === "string" && instructions.trim().length > 0) {
        messages.push({
            role: "user",
            content: instructions,
        })
    }

    if (typeof input === "string") {
        messages.push({
            role: "user",
            content: input,
        })
        return messages
    }

    if (!Array.isArray(input)) {
        throw new RequestValidationError("input must be a string or an array of input items")
    }

    for (let index = 0; index < input.length; index++) {
        const item = input[index]
        if (!isRecord(item)) {
            throw new RequestValidationError(`input item at index ${index} must be an object`)
        }

        const itemType = item.type ?? ("role" in item ? "message" : undefined)

        if (itemType === "message") {
            const role = item.role
            if (role !== "user" && role !== "assistant" && role !== "system" && role !== "developer") {
                throw new RequestValidationError(`input message at index ${index} has invalid role "${String(role)}"`)
            }

            const translatedContent = translateMessageContent(item.content, index)
            const claudeRole: "user" | "assistant" = role === "assistant" ? "assistant" : "user"

            messages.push({
                role: claudeRole,
                content: translatedContent,
            })
            continue
        }

        if (itemType === "function_call") {
            if (typeof item.call_id !== "string" || !item.call_id.trim()) {
                throw new RequestValidationError(`function_call at index ${index} must include call_id`)
            }
            if (typeof item.name !== "string" || !item.name.trim()) {
                throw new RequestValidationError(`function_call at index ${index} must include name`)
            }
            const parsedArgs = parseFunctionCallArguments(item.arguments, index)
            const toolUseBlock: ClaudeContentBlock & { thought_signature?: string; thoughtSignature?: string } = {
                type: "tool_use",
                id: item.call_id,
                name: item.name,
                input: parsedArgs,
            }
            const sig =
                (typeof item.thought_signature === "string" && item.thought_signature) ||
                (typeof item.thoughtSignature === "string" && item.thoughtSignature) ||
                undefined
            if (sig) {
                toolUseBlock.thought_signature = sig
                toolUseBlock.thoughtSignature = sig
            }

            const lastMessage = messages[messages.length - 1]
            if (lastMessage && lastMessage.role === "assistant") {
                const blocks = toContentBlocks(lastMessage.content)
                blocks.push(toolUseBlock)
                lastMessage.content = blocks
            } else {
                messages.push({
                    role: "assistant",
                    content: [toolUseBlock],
                })
            }
            continue
        }

        if (itemType === "function_call_output") {
            if (typeof item.call_id !== "string" || !item.call_id.trim()) {
                throw new RequestValidationError(`function_call_output at index ${index} must include call_id`)
            }
            const outputContent = translateFunctionOutput(item.output, index)
            const toolResultBlock: ClaudeContentBlock = {
                type: "tool_result",
                tool_use_id: item.call_id,
                content: outputContent,
            }

            const lastMessage = messages[messages.length - 1]
            if (
                lastMessage &&
                lastMessage.role === "user" &&
                Array.isArray(lastMessage.content) &&
                lastMessage.content.length > 0 &&
                lastMessage.content.every(b => b.type === "tool_result")
            ) {
                lastMessage.content.push(toolResultBlock)
            } else {
                messages.push({
                    role: "user",
                    content: [toolResultBlock],
                })
            }
            continue
        }

        if (itemType === "reasoning") {
            // Reasoning items from previous turns are optional context; skip or ignore safely
            continue
        }

        if (itemType === "item_reference") {
            if (typeof item.id !== "string" || !item.id.trim()) {
                throw new RequestValidationError(`item_reference at index ${index} must include id`)
            }
            continue
        }

        throw new RequestValidationError(`Unsupported input item type "${String(itemType)}" at index ${index}`)
    }

    if (messages.length === 0) {
        throw new RequestValidationError("input must produce at least one message")
    }

    return messages
}

export function translateResponsesTools(tools?: ResponsesTool[] | null): ClaudeTool[] | undefined {
    if (!tools || tools.length === 0) return undefined
    if (!Array.isArray(tools)) {
        throw new RequestValidationError("tools must be an array")
    }

    const result: ClaudeTool[] = []

    for (let index = 0; index < tools.length; index++) {
        const tool = tools[index]
        if (!isRecord(tool)) {
            throw new RequestValidationError(`tool at index ${index} must be an object`)
        }

        if (tool.type !== "function") {
            throw new RequestValidationError(`Unsupported tool type "${String(tool.type)}" at index ${index}`)
        }

        const fn = isRecord(tool.function) ? tool.function : tool
        const name = fn.name
        if (typeof name !== "string" || !name.trim()) {
            throw new RequestValidationError(`tool at index ${index} must include a function name`)
        }

        const description = fn.description
        if (description !== undefined && typeof description !== "string") {
            throw new RequestValidationError(`tool at index ${index} description must be a string`)
        }

        const parameters = fn.parameters
        if (parameters !== undefined && parameters !== null && !isRecord(parameters)) {
            throw new RequestValidationError(`tool at index ${index} parameters must be an object`)
        }

        result.push({
            name,
            description: description as string | undefined,
            input_schema: (parameters as Record<string, unknown>) || { type: "object", properties: {} },
        })
    }

    return result.length > 0 ? result : undefined
}

export function translateResponsesToolChoice(
    toolChoice?: ResponsesToolChoice | null
): { type: "auto" | "any" | "tool" | "none"; name?: string } | undefined {
    if (toolChoice === undefined || toolChoice === null) return undefined

    if (typeof toolChoice === "string") {
        if (toolChoice === "auto") return { type: "auto" }
        if (toolChoice === "none") return { type: "none" }
        if (toolChoice === "required") return { type: "any" }
        throw new RequestValidationError(`Unsupported tool_choice "${toolChoice}"`)
    }

    if (isRecord(toolChoice)) {
        if (toolChoice.type === "function") {
            const nestedFn = "function" in toolChoice && isRecord(toolChoice.function) ? toolChoice.function : undefined
            const name =
                typeof toolChoice.name === "string"
                    ? toolChoice.name
                    : nestedFn && typeof nestedFn.name === "string"
                      ? nestedFn.name
                      : undefined
            if (!name || !name.trim()) {
                throw new RequestValidationError("tool_choice of type function must include name")
            }
            return { type: "tool", name }
        }
        if (toolChoice.type === "auto") return { type: "auto" }
        if (toolChoice.type === "none") return { type: "none" }
        if (toolChoice.type === "required" || toolChoice.type === "any") return { type: "any" }
    }

    throw new RequestValidationError("Invalid tool_choice")
}

export function responsesToRoutedInput(payload: ResponsesCreateRequest): {
    model: string
    messages: ClaudeMessage[]
    tools?: ClaudeTool[]
    toolChoice?: { type: "auto" | "any" | "tool" | "none"; name?: string }
    maxTokens?: number
    reasoningEffort?: "low" | "medium" | "high"
} {
    const reasoningEffort = extractResponsesReasoningEffort(payload)
    const model = mapModel(payload.model, reasoningEffort)
    const messages = translateResponsesInput(payload.input, payload.instructions)
    const tools = translateResponsesTools(payload.tools)
    const toolChoice = translateResponsesToolChoice(payload.tool_choice)
    const maxTokens =
        typeof payload.max_output_tokens === "number" && payload.max_output_tokens > 0
            ? payload.max_output_tokens
            : undefined

    return {
        model,
        messages,
        tools,
        toolChoice,
        maxTokens,
        reasoningEffort,
    }
}

function buildResponseUsage(usage?: Partial<StreamUsage>): ResponseUsage {
    const uncachedInput = usage?.inputTokens ?? 0
    const cachedTokens = usage?.cacheReadTokens ?? 0
    const inputTokens = uncachedInput + cachedTokens
    const outputTokens = usage?.outputTokens ?? 0
    const reasoningTokens = usage?.reasoningTokens ?? 0

    return {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        input_tokens_details: {
            cached_tokens: cachedTokens,
        },
        output_tokens_details: {
            reasoning_tokens: reasoningTokens,
        },
    }
}

function buildBaseResponseObject(opts: {
    id: string
    model: string
    createdAt: number
    payload: ResponsesCreateRequest
    status: ResponseObject["status"]
    output: ResponseOutputItem[]
    outputText: string
    usage: ResponseUsage | null
    incompleteDetails: ResponseObject["incomplete_details"]
}): ResponseObject {
    const { id, model, createdAt, payload, status, output, outputText, usage, incompleteDetails } = opts
    const effort = extractResponsesReasoningEffort(payload) ?? (payload.reasoning?.effort as string | null) ?? null

    return {
        id,
        object: "response",
        created_at: createdAt,
        status,
        error: null,
        incomplete_details: incompleteDetails,
        instructions: typeof payload.instructions === "string" ? payload.instructions : null,
        max_output_tokens: typeof payload.max_output_tokens === "number" ? payload.max_output_tokens : null,
        model,
        output,
        output_text: outputText,
        parallel_tool_calls: payload.parallel_tool_calls ?? true,
        previous_response_id: payload.previous_response_id ?? null,
        reasoning: {
            effort,
            summary: payload.reasoning?.summary ?? null,
        },
        store: payload.store ?? false,
        temperature: typeof payload.temperature === "number" ? payload.temperature : 1,
        text: {
            format: payload.text?.format ?? { type: "text" },
        },
        tool_choice: payload.tool_choice ?? "auto",
        tools: Array.isArray(payload.tools) ? payload.tools : [],
        top_p: typeof payload.top_p === "number" ? payload.top_p : 1,
        truncation: payload.truncation ?? "disabled",
        usage,
        user: payload.user ?? null,
        metadata: isRecord(payload.metadata) ? (payload.metadata as Record<string, string>) : {},
    }
}

export function completionToResponseObject(
    completion: BufferedCompletion,
    opts: {
        id?: string
        model: string
        createdAt?: number
        payload: ResponsesCreateRequest
    }
): ResponseObject {
    const id = opts.id || generateResponseId()
    const createdAt = opts.createdAt ?? Math.floor(Date.now() / 1000)
    const normalizedStop = normalizeStopReason(completion.stopReason)
    const isMaxTokens = normalizedStop === "max_tokens"
    const status: ResponseObject["status"] = isMaxTokens ? "incomplete" : "completed"
    const incompleteDetails = isMaxTokens ? { reason: "max_output_tokens" } : null

    const output: ResponseOutputItem[] = []
    const textChunks: string[] = []

    for (const block of completion.contentBlocks || []) {
        if (block.type === "thinking") {
            const text = block.thinking ?? block.text ?? ""
            if (text) {
                const reasoningItem: ResponseOutputReasoningItem = {
                    id: generateItemId("rs"),
                    type: "reasoning",
                    status: "completed",
                    summary: [{ type: "summary_text", text }],
                }
                output.push(reasoningItem)
            }
            continue
        }

        if (block.type === "text") {
            const text = block.text ?? ""
            textChunks.push(text)
            const messageItem: ResponseOutputMessageItem = {
                id: generateItemId("msg"),
                type: "message",
                status: isMaxTokens ? "incomplete" : "completed",
                role: "assistant",
                content: [
                    {
                        type: "output_text",
                        text,
                        annotations: [],
                    },
                ],
            }
            output.push(messageItem)
            continue
        }

        if (block.type === "tool_use") {
            const callId = block.id || generateItemId("fc")
            const sig = block.thought_signature || block.thoughtSignature
            const fcItem: ResponseOutputFunctionCallItem = {
                id: generateItemId("fc"),
                type: "function_call",
                status: "completed",
                call_id: callId,
                name: block.name || "tool",
                arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {}),
                ...(sig ? { thought_signature: sig } : {}),
            }
            output.push(fcItem)
            continue
        }
    }

    if (output.length === 0) {
        output.push({
            id: generateItemId("msg"),
            type: "message",
            status: isMaxTokens ? "incomplete" : "completed",
            role: "assistant",
            content: [
                {
                    type: "output_text",
                    text: "",
                    annotations: [],
                },
            ],
        })
    }

    const usage = buildResponseUsage(completion.usage)

    return buildBaseResponseObject({
        id,
        model: opts.model,
        createdAt,
        payload: opts.payload,
        status,
        output,
        outputText: textChunks.join(""),
        usage,
        incompleteDetails,
    })
}

export async function* eventsToResponsesSse(
    events: AsyncIterable<RoutedStreamEvent> | Iterable<RoutedStreamEvent>,
    opts: {
        id?: string
        model: string
        createdAt?: number
        payload: ResponsesCreateRequest
    }
): AsyncGenerator<string, void, unknown> {
    const responseId = opts.id || generateResponseId()
    const createdAt = opts.createdAt ?? Math.floor(Date.now() / 1000)
    let sequenceNumber = 0

    const formatSse = (eventName: string, payload: Record<string, unknown>): string => {
        const data = {
            ...payload,
            sequence_number: sequenceNumber++,
        }
        return `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`
    }

    const completedOutput: ResponseOutputItem[] = []
    const allTextChunks: string[] = []
    let started = false

    const makeSnapshot = (
        status: ResponseObject["status"],
        output: ResponseOutputItem[],
        usage: ResponseUsage | null = null,
        incompleteDetails: ResponseObject["incomplete_details"] = null
    ): ResponseObject =>
        buildBaseResponseObject({
            id: responseId,
            model: opts.model,
            createdAt,
            payload: opts.payload,
            status,
            output,
            outputText: allTextChunks.join(""),
            usage,
            incompleteDetails,
        })

    const ensureStarted = function* () {
        if (started) return
        started = true
        yield formatSse("response.created", {
            type: "response.created",
            response: makeSnapshot("in_progress", [], null, null),
        })
        yield formatSse("response.in_progress", {
            type: "response.in_progress",
            response: makeSnapshot("in_progress", [], null, null),
        })
    }

    type ActiveReasoning = {
        kind: "reasoning"
        outputIndex: number
        itemId: string
        summaryIndex: number
        text: string
    }

    type ActiveMessage = {
        kind: "message"
        outputIndex: number
        itemId: string
        contentIndex: number
        text: string
    }

    let activeItem: ActiveReasoning | ActiveMessage | null = null
    let nextOutputIndex = 0

    const closeActiveItem = function* (itemStatus: "completed" | "incomplete" = "completed"): Generator<string, void, unknown> {
        if (!activeItem) return
        if (activeItem.kind === "reasoning") {
            const { outputIndex, itemId, summaryIndex, text } = activeItem
            const part = { type: "summary_text" as const, text }
            yield formatSse("response.reasoning_summary_text.done", {
                type: "response.reasoning_summary_text.done",
                item_id: itemId,
                output_index: outputIndex,
                summary_index: summaryIndex,
                text,
            })
            yield formatSse("response.reasoning_summary_part.done", {
                type: "response.reasoning_summary_part.done",
                item_id: itemId,
                output_index: outputIndex,
                summary_index: summaryIndex,
                part,
            })
            const doneItem: ResponseOutputReasoningItem = {
                id: itemId,
                type: "reasoning",
                status: "completed",
                summary: [part],
            }
            completedOutput.push(doneItem)
            yield formatSse("response.output_item.done", {
                type: "response.output_item.done",
                output_index: outputIndex,
                item: doneItem,
            })
            activeItem = null
            return
        }

        if (activeItem.kind === "message") {
            const { outputIndex, itemId, contentIndex, text } = activeItem
            const part = { type: "output_text" as const, text, annotations: [] }
            yield formatSse("response.output_text.done", {
                type: "response.output_text.done",
                item_id: itemId,
                output_index: outputIndex,
                content_index: contentIndex,
                text,
            })
            yield formatSse("response.content_part.done", {
                type: "response.content_part.done",
                item_id: itemId,
                output_index: outputIndex,
                content_index: contentIndex,
                part,
            })
            const doneItem: ResponseOutputMessageItem = {
                id: itemId,
                type: "message",
                status: itemStatus,
                role: "assistant",
                content: [part],
            }
            completedOutput.push(doneItem)
            yield formatSse("response.output_item.done", {
                type: "response.output_item.done",
                output_index: outputIndex,
                item: doneItem,
            })
            activeItem = null
        }
    }

    for await (const event of events) {
        if (event.type === "start") {
            yield* ensureStarted()
            continue
        }

        yield* ensureStarted()

        if (event.type === "thinking_delta") {
            if (!event.text) continue
            if (!activeItem || activeItem.kind !== "reasoning") {
                yield* closeActiveItem("completed")
                const outputIndex = nextOutputIndex++
                const itemId = generateItemId("rs")
                const summaryIndex = 0
                activeItem = {
                    kind: "reasoning",
                    outputIndex,
                    itemId,
                    summaryIndex,
                    text: "",
                }
                yield formatSse("response.output_item.added", {
                    type: "response.output_item.added",
                    output_index: outputIndex,
                    item: {
                        id: itemId,
                        type: "reasoning",
                        status: "in_progress",
                        summary: [],
                    },
                })
                yield formatSse("response.reasoning_summary_part.added", {
                    type: "response.reasoning_summary_part.added",
                    item_id: itemId,
                    output_index: outputIndex,
                    summary_index: summaryIndex,
                    part: {
                        type: "summary_text",
                        text: "",
                    },
                })
            }

            activeItem.text += event.text
            yield formatSse("response.reasoning_summary_text.delta", {
                type: "response.reasoning_summary_text.delta",
                item_id: activeItem.itemId,
                output_index: activeItem.outputIndex,
                summary_index: activeItem.summaryIndex,
                delta: event.text,
            })
            continue
        }

        if (event.type === "text_delta") {
            if (!activeItem || activeItem.kind !== "message") {
                yield* closeActiveItem("completed")
                const outputIndex = nextOutputIndex++
                const itemId = generateItemId("msg")
                const contentIndex = 0
                activeItem = {
                    kind: "message",
                    outputIndex,
                    itemId,
                    contentIndex,
                    text: "",
                }
                yield formatSse("response.output_item.added", {
                    type: "response.output_item.added",
                    output_index: outputIndex,
                    item: {
                        id: itemId,
                        type: "message",
                        status: "in_progress",
                        role: "assistant",
                        content: [],
                    },
                })
                yield formatSse("response.content_part.added", {
                    type: "response.content_part.added",
                    item_id: itemId,
                    output_index: outputIndex,
                    content_index: contentIndex,
                    part: {
                        type: "output_text",
                        text: "",
                        annotations: [],
                    },
                })
            }

            if (event.text) {
                activeItem.text += event.text
                allTextChunks.push(event.text)
                yield formatSse("response.output_text.delta", {
                    type: "response.output_text.delta",
                    item_id: activeItem.itemId,
                    output_index: activeItem.outputIndex,
                    content_index: activeItem.contentIndex,
                    delta: event.text,
                })
            }
            continue
        }

        if (event.type === "tool_call") {
            yield* closeActiveItem("completed")
            const outputIndex = nextOutputIndex++
            const itemId = generateItemId("fc")
            const callId = event.id || itemId
            const argsString = event.rawArguments ?? (JSON.stringify(event.input ?? {}) || "{}")
            const sig = event.thoughtSignature

            yield formatSse("response.output_item.added", {
                type: "response.output_item.added",
                output_index: outputIndex,
                item: {
                    id: itemId,
                    type: "function_call",
                    status: "in_progress",
                    call_id: callId,
                    name: event.name,
                    arguments: "",
                    ...(sig ? { thought_signature: sig } : {}),
                },
            })

            if (argsString) {
                yield formatSse("response.function_call_arguments.delta", {
                    type: "response.function_call_arguments.delta",
                    item_id: itemId,
                    output_index: outputIndex,
                    delta: argsString,
                })
            }

            yield formatSse("response.function_call_arguments.done", {
                type: "response.function_call_arguments.done",
                item_id: itemId,
                output_index: outputIndex,
                name: event.name,
                arguments: argsString,
            })

            const doneFcItem: ResponseOutputFunctionCallItem = {
                id: itemId,
                type: "function_call",
                status: "completed",
                call_id: callId,
                name: event.name,
                arguments: argsString,
                ...(sig ? { thought_signature: sig } : {}),
            }
            completedOutput.push(doneFcItem)

            yield formatSse("response.output_item.done", {
                type: "response.output_item.done",
                output_index: outputIndex,
                item: doneFcItem,
            })
            continue
        }

        if (event.type === "finish") {
            const isMaxTokens = event.stopReason === "max_tokens"
            const itemStatus = isMaxTokens ? "incomplete" : "completed"
            yield* closeActiveItem(itemStatus)

            const finalStatus: ResponseObject["status"] = isMaxTokens ? "incomplete" : "completed"
            const incompleteDetails = isMaxTokens ? { reason: "max_output_tokens" } : null
            const usage = buildResponseUsage(event.usage)
            const finalResponse = makeSnapshot(finalStatus, completedOutput, usage, incompleteDetails)
            const terminalEvent = isMaxTokens ? "response.incomplete" : "response.completed"

            yield formatSse(terminalEvent, {
                type: terminalEvent,
                response: finalResponse,
            })
        }
    }
}
