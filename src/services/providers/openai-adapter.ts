import type { ClaudeMessage, ClaudeTool, ClaudeContentBlock } from "~/lib/translator"
import { cleanJsonSchemaForGemini } from "~/lib/json-schema-cleaner"

export interface OpenAIChatMessage {
    role: "user" | "assistant" | "system" | "tool"
    content?: string | OpenAIContentPart[] | null
    tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>
    tool_call_id?: string
}

export type OpenAIResponsesContentPart =
    | { type: "input_text" | "output_text"; text: string }
    | { type: "input_image"; image_url: string }

export type OpenAIContentPart =
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }

export interface OpenAIToolDefinition {
    type: "function"
    function: {
        name: string
        description?: string
        parameters: any
    }
}

function normalizeToolParameters(schema: unknown): any {
    if (!schema) {
        return { type: "object", properties: {} }
    }

    let normalized: any = schema
    if (typeof schema === "string") {
        const trimmed = schema.trim()
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
            try {
                normalized = JSON.parse(trimmed)
            } catch {
                return { type: "object", properties: {} }
            }
        } else {
            return { type: "object", properties: {} }
        }
    }

    if (typeof normalized !== "object" || normalized === null || Array.isArray(normalized)) {
        return { type: "object", properties: {} }
    }

    normalized = cleanJsonSchemaForGemini(normalized)
    if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
        return { type: "object", properties: {} }
    }

    if (normalized.type !== "object") {
        normalized.type = "object"
    }
    if (!normalized.properties || typeof normalized.properties !== "object" || Array.isArray(normalized.properties)) {
        normalized.properties = {}
    }
    if (normalized.required && !Array.isArray(normalized.required)) {
        delete normalized.required
    }

    return normalized
}

export function toOpenAITools(tools?: ClaudeTool[]): OpenAIToolDefinition[] | undefined {
    if (!tools || tools.length === 0) return undefined
    return tools.map(tool => ({
        type: "function",
        function: {
            name: tool.name,
            description: tool.description,
            parameters: normalizeToolParameters(tool.input_schema),
        },
    }))
}

function collectText(blocks: ClaudeContentBlock[]): string {
    return blocks
        .filter(block => block.type === "text" && block.text)
        .map(block => block.text)
        .join("")
}

function toOpenAIContent(blocks: ClaudeContentBlock[]): string | OpenAIContentPart[] {
    const parts: OpenAIContentPart[] = []
    let hasImage = false

    for (const block of blocks) {
        if (block.type === "text" && block.text) {
            parts.push({ type: "text", text: block.text })
            continue
        }
        if (block.type === "image" && block.source?.type === "base64") {
            hasImage = true
            parts.push({
                type: "image_url",
                image_url: {
                    url: `data:${block.source.media_type};base64,${block.source.data}`,
                },
            })
            continue
        }
        if (block.type === "image" && block.source?.type === "url") {
            hasImage = true
            parts.push({ type: "image_url", image_url: { url: block.source.url } })
        }
    }

    if (!hasImage) return collectText(blocks)
    return parts
}

export function toOpenAIMessages(messages: ClaudeMessage[]): OpenAIChatMessage[] {
    const result: OpenAIChatMessage[] = []

    for (const message of messages) {
        if (typeof message.content === "string") {
            result.push({ role: message.role, content: message.content })
            continue
        }

        const blocks = message.content as ClaudeContentBlock[]

        if (message.role === "assistant") {
            const text = collectText(blocks)
            const toolCalls = blocks
                .filter(block => block.type === "tool_use")
                .map(block => ({
                    id: block.id || `tool_${crypto.randomUUID().slice(0, 8)}`,
                    type: "function" as const,
                    function: {
                        name: block.name || "tool",
                        arguments: JSON.stringify(block.input || {}),
                    },
                }))

            result.push({
                role: "assistant",
                content: text || "",  // ChatGPT Responses API requires string/array, not null
                tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
            })
            continue
        }

        if (message.role === "user") {
            // First, add tool_result messages (must come immediately after assistant's tool_calls)
            for (const block of blocks) {
                if (block.type === "tool_result") {
                    result.push({
                        role: "tool",
                        tool_call_id: block.tool_use_id || "tool",
                        content: typeof block.content === "string" ? block.content : JSON.stringify(block.content || {}),
                    })
                }
            }

            // Then add text and image input together as one multimodal user message.
            const inputBlocks = blocks.filter(block => block.type === "text" || block.type === "image")
            if (inputBlocks.length > 0) {
                result.push({ role: "user", content: toOpenAIContent(inputBlocks) })
            }
        }
    }

    return result
}

/** Convert Chat Completions content parts to the Responses API content shape. */
export function toOpenAIResponsesContent(
    content: OpenAIChatMessage["content"],
    role: "user" | "assistant"
): OpenAIResponsesContentPart[] {
    const textType = role === "user" ? "input_text" : "output_text"
    if (typeof content === "string") {
        return [{ type: textType, text: content }]
    }

    const converted: OpenAIResponsesContentPart[] = []
    if (Array.isArray(content)) {
        for (const part of content) {
            if (part?.type === "text" && typeof part.text === "string") {
                converted.push({ type: textType, text: part.text })
                continue
            }
            if (
                role === "user" &&
                part?.type === "image_url" &&
                typeof part.image_url?.url === "string"
            ) {
                converted.push({ type: "input_image", image_url: part.image_url.url })
            }
        }
    }

    return converted.length > 0 ? converted : [{ type: textType, text: "" }]
}
