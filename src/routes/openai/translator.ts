/**
 * OpenAI ↔ Anthropic 格式转换器
 */

import { RequestValidationError } from "~/lib/error"
import type { ClaudeContentBlock, ClaudeMessage, ClaudeTool } from "~/lib/translator"
import type { OpenAIContentPart, OpenAIMessage, OpenAITool } from "./types"

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value)
}

const MODEL_MAPPING: Record<string, string> = {
    // GPT → Claude 映射 (使用 Antigravity 正确的模型名称)
    "gpt-4": "claude-sonnet-4-5",
    "gpt-4o": "claude-sonnet-4-5",
    "gpt-4-turbo": "claude-sonnet-4-5",
    "gpt-3.5-turbo": "gemini-2.0-flash-exp",  // 使用 Gemini 作为轻量模型
    "o1": "claude-sonnet-4-5-thinking",
    "o1-mini": "gemini-2.0-flash-exp",
}

export function mapModel(openaiModel: string): string {
    return MODEL_MAPPING[openaiModel] || openaiModel
}

const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_INLINE_IMAGE_BASE64_CHARS = Math.ceil(MAX_INLINE_IMAGE_BYTES / 3) * 4
const MAX_INLINE_IMAGE_WHITESPACE_CHARS = 16 * 1024

function toContentBlocks(content: string | ClaudeContentBlock[]): ClaudeContentBlock[] {
    if (typeof content === "string") {
        return content ? [{ type: "text", text: content }] : []
    }
    return content
}

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

/** Validate standard Base64 in linear time to support image payloads near the configured limit. */
function validateBase64ImageData(data: string): void {
    if (data.length % 4 !== 0) {
        throw new RequestValidationError("image_url data URI must contain valid base64 image data")
    }

    let firstPadding = -1
    for (let index = 0; index < data.length; index++) {
        const charCode = data.charCodeAt(index)
        if (charCode === 0x3d) {
            if (firstPadding === -1) firstPadding = index
            continue
        }
        if (firstPadding !== -1 || !isBase64Character(charCode)) {
            throw new RequestValidationError("image_url data URI must contain valid base64 image data")
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
        throw new RequestValidationError("image_url data URI must contain valid base64 image data")
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
        throw new RequestValidationError("image_url data URI must include base64 image data")
    }
    if (rawData.length > MAX_INLINE_IMAGE_BASE64_CHARS + MAX_INLINE_IMAGE_WHITESPACE_CHARS) {
        throw new RequestValidationError("image_url data URI exceeds the 10 MiB image limit")
    }

    for (let index = 0; index < rawData.length; index++) {
        const charCode = rawData.charCodeAt(index)
        if (charCode === 0x3d || isBase64Character(charCode) || isAsciiWhitespace(charCode)) continue
        throw new RequestValidationError("image_url data URI must contain valid base64 image data")
    }

    const data = rawData.replace(/[\t\n\f\r ]/g, "")
    if (!data) {
        throw new RequestValidationError("image_url data URI must include base64 image data")
    }
    if (data.length > MAX_INLINE_IMAGE_BASE64_CHARS) {
        throw new RequestValidationError("image_url data URI exceeds the 10 MiB image limit")
    }
    validateBase64ImageData(data)

    const decoded = Buffer.from(data, "base64")
    if (decoded.byteLength > MAX_INLINE_IMAGE_BYTES) {
        throw new RequestValidationError("image_url data URI exceeds the 10 MiB image limit")
    }

    return {
        type: "base64",
        media_type: match[1].toLowerCase(),
        data,
    }
}

function parseToolCallArguments(value: unknown, index: number): Record<string, unknown> {
    const raw = value === undefined || value === null || value === "" ? "{}" : value
    if (typeof raw !== "string") {
        throw new RequestValidationError(`tool call at index ${index} must include JSON string arguments`)
    }

    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        throw new RequestValidationError(`tool call at index ${index} has invalid JSON arguments`)
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new RequestValidationError(`tool call at index ${index} arguments must be a JSON object`)
    }
    return parsed as Record<string, unknown>
}

function translateContentPart(part: OpenAIContentPart, index: number): ClaudeContentBlock {
    if (!isRecord(part)) {
        throw new RequestValidationError(`content part at index ${index} must be an object`)
    }

    if (part.type === "text" || part.type === "input_text") {
        if (typeof part.text !== "string") {
            throw new RequestValidationError(`content part at index ${index} must include text`)
        }
        return { type: "text", text: part.text }
    }

    if (part.type === "image_url") {
        if (!isRecord(part.image_url) || typeof part.image_url.url !== "string") {
            throw new RequestValidationError(`image_url part at index ${index} must include image_url.url`)
        }
        const url = part.image_url.url.trim()
        if (!url) {
            throw new RequestValidationError(`image_url part at index ${index} must include image_url.url`)
        }

        const inlineSource = parseDataImageUrl(url)
        if (inlineSource) {
            return { type: "image", source: inlineSource }
        }

        let parsed: URL
        try {
            parsed = new URL(url)
        } catch {
            throw new RequestValidationError(`image_url part at index ${index} must be a data URI or an http(s) URL`)
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw new RequestValidationError(`image_url part at index ${index} must use http(s) or a base64 data URI`)
        }
        return { type: "image", source: { type: "url", url: parsed.toString() } }
    }

    throw new RequestValidationError(`Unsupported OpenAI content part type at index ${index}`)
}

/** Convert an OpenAI string or content-part array to Claude-compatible content. */
export function translateOpenAIContent(content: OpenAIMessage["content"]): string | ClaudeContentBlock[] {
    if (content === null || content === undefined) return ""
    if (typeof content === "string") return content
    if (!Array.isArray(content)) {
        throw new RequestValidationError("message content must be a string, null, or an array of content parts")
    }

    return content.map((part, index) => translateContentPart(part, index))
}

export function translateMessages(messages: OpenAIMessage[]): ClaudeMessage[] {
    if (!Array.isArray(messages)) {
        throw new RequestValidationError("messages must be an array")
    }
    return messages.map((msg) => {
        if (!isRecord(msg) || typeof msg.role !== "string") {
            throw new RequestValidationError("each message must be an object with a role")
        }

        if (msg.role === "assistant" && msg.tool_calls !== undefined) {
            if (!Array.isArray(msg.tool_calls)) {
                throw new RequestValidationError("assistant tool_calls must be an array")
            }
            const content = toContentBlocks(translateOpenAIContent(msg.content))
            return {
                role: "assistant" as const,
                content: [
                    ...content,
                    ...msg.tool_calls.map((tc, index) => {
                        if (!isRecord(tc) || !isRecord(tc.function)) {
                            throw new RequestValidationError(`tool call at index ${index} must include a function object`)
                        }
                        if (typeof tc.id !== "string" || !tc.id) {
                            throw new RequestValidationError(`tool call at index ${index} must include an id`)
                        }
                        if (typeof tc.function.name !== "string" || !tc.function.name) {
                            throw new RequestValidationError(`tool call at index ${index} must include a function name`)
                        }
                        return {
                            type: "tool_use" as const,
                            id: tc.id,
                            name: tc.function.name,
                            input: parseToolCallArguments(tc.function.arguments, index),
                            ...(tc.extra_content ? { extra_content: tc.extra_content } : {}),
                        }
                    }),
                ],
            }
        }

        if (msg.role === "tool") {
            if (typeof msg.tool_call_id !== "string" || !msg.tool_call_id) {
                throw new RequestValidationError("tool message must include tool_call_id")
            }
            if (msg.content !== null && typeof msg.content !== "string") {
                throw new RequestValidationError("tool message content must be a string or null")
            }
            return {
                role: "user" as const,
                content: [{
                    type: "tool_result" as const,
                    tool_use_id: msg.tool_call_id,
                    content: msg.content || "",
                }],
            }
        }

        // Map OpenAI roles to Claude roles
        // Claude only supports: user, assistant
        // OpenAI system and developer roles → Claude user role
        let claudeRole: "user" | "assistant" = "user"
        if (msg.role === "assistant") {
            claudeRole = "assistant"
        }

        return {
            role: claudeRole,
            content: translateOpenAIContent(msg.content),
        } as ClaudeMessage
    })
}

export function translateTools(tools?: OpenAITool[]): ClaudeTool[] | undefined {
    if (!tools || tools.length === 0) return undefined
    if (!Array.isArray(tools)) {
        throw new RequestValidationError("tools must be an array")
    }
    return tools.map((tool, index) => {
        if (!isRecord(tool) || !isRecord(tool.function)) {
            throw new RequestValidationError(`tool at index ${index} must include a function object`)
        }
        if (typeof tool.function.name !== "string" || !tool.function.name) {
            throw new RequestValidationError(`tool at index ${index} must include a function name`)
        }
        if (tool.function.description !== undefined && typeof tool.function.description !== "string") {
            throw new RequestValidationError(`tool at index ${index} description must be a string`)
        }
        const parameters = tool.function.parameters
        if (parameters !== undefined && !isRecord(parameters)) {
            throw new RequestValidationError(`tool at index ${index} parameters must be an object`)
        }
        return {
            name: tool.function.name,
            description: tool.function.description,
            input_schema: parameters || { type: "object", properties: {} },
        }
    })
}

export function mapStopReason(anthropicReason: string): "stop" | "length" | "tool_calls" | null {
    switch (anthropicReason) {
        case "end_turn": return "stop"
        case "tool_use": return "tool_calls"
        case "max_tokens": return "length"
        default: return "stop"
    }
}

export function generateChatId(): string {
    return `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`
}

export function buildStreamChunk(
    id: string,
    model: string,
    content?: string,
    role?: string,
    finishReason?: string,
    toolCalls?: any[]
): string {
    const chunk: any = {
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
            index: 0,
            delta: {},
            finish_reason: finishReason ? mapStopReason(finishReason) : null,
        }],
    }

    if (role) chunk.choices[0].delta.role = role
    if (content !== undefined) chunk.choices[0].delta.content = content
    if (toolCalls) {
        chunk.choices[0].delta.tool_calls = toolCalls.map((tc, idx) => ({
            index: idx,
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.input) },
            ...(tc.extra_content ? { extra_content: tc.extra_content } : {}),
        }))
    }

    return JSON.stringify(chunk)
}
