/**
 * Claude 消息翻译器
 * 将 Antigravity 格式转换为 Anthropic SSE 格式
 */

// Claude 消息类型
export interface ClaudeMessage {
    role: "user" | "assistant"
    content: string | ClaudeContentBlock[]
}

export interface ClaudeContentBlock {
    type: "text" | "tool_use" | "tool_result" | "image" | "audio" | "document"
    text?: string
    id?: string
    name?: string
    input?: any
    tool_use_id?: string
    content?: string
    source?: {
        type: "base64"
        media_type: string
        data: string
    } | {
        type: "url"
        url: string
    }
}

export interface ClaudeTool {
    name: string
    description?: string
    input_schema: any
}

// 响应内容块
/** Token usage reported by a provider. `inputTokens` excludes prompt-cache hits (Anthropic semantics). */
export interface CompletionUsage {
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
}

/** Prompt-cache hits for providers that report them (0 otherwise). */
export function getCacheReadTokens(usage: Partial<CompletionUsage> | undefined): number {
    return usage?.cacheReadTokens || 0
}

export interface ContentBlock {
    type: "text" | "tool_use"
    text?: string
    id?: string
    name?: string
    input?: any
}

// 流式事件类型
export type StreamEvent =
    | { type: "message_start"; message: any }
    | { type: "content_block_start"; index: number; content_block: any }
    | { type: "content_block_delta"; index: number; delta: any }
    | { type: "content_block_stop"; index: number }
    | { type: "message_delta"; delta: any; usage?: any }
    | { type: "message_stop" }
    | { type: "ping" }

/**
 * 生成消息 ID
 */
export function generateMessageId(): string {
    return `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`
}

/**
 * 构建 message_start 事件
 */
export function buildMessageStart(model: string): string {
    const event = {
        type: "message_start",
        message: {
            id: generateMessageId(),
            type: "message",
            role: "assistant",
            content: [],
            model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
        },
    }
    return `event: message_start\ndata: ${JSON.stringify(event)}\n\n`
}

/**
 * 构建 content_block_start 事件
 */
export function buildContentBlockStart(
    index: number,
    type: "text" | "tool_use",
    toolInfo?: { id: string; name: string; thoughtSignature?: string }
): string {
    let contentBlock: any = { type }
    if (type === "tool_use" && toolInfo) {
        contentBlock = {
            type: "tool_use",
            id: toolInfo.id,
            name: toolInfo.name,
            input: {},
            ...(toolInfo.thoughtSignature
                ? { thought_signature: toolInfo.thoughtSignature, thoughtSignature: toolInfo.thoughtSignature }
                : {}),
        }
    } else {
        contentBlock = { type: "text", text: "" }
    }

    const event = {
        type: "content_block_start",
        index,
        content_block: contentBlock,
    }
    return `event: content_block_start\ndata: ${JSON.stringify(event)}\n\n`
}

/**
 * 构建 content_block_delta 事件 (文本)
 */
export function buildTextDelta(index: number, text: string): string {
    const event = {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text },
    }
    return `event: content_block_delta\ndata: ${JSON.stringify(event)}\n\n`
}

/**
 * 构建 content_block_delta 事件 (工具输入)
 */
export function buildInputJsonDelta(index: number, partialJson: string): string {
    const event = {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: partialJson },
    }
    return `event: content_block_delta\ndata: ${JSON.stringify(event)}\n\n`
}

/**
 * 构建 content_block_stop 事件
 */
export function buildContentBlockStop(index: number): string {
    const event = { type: "content_block_stop", index }
    return `event: content_block_stop\ndata: ${JSON.stringify(event)}\n\n`
}

/**
 * 构建 message_delta 事件
 */
export function buildMessageDelta(
    stopReason: string,
    usage?: { inputTokens?: number; outputTokens: number; cacheReadTokens?: number }
): string {
    const event = {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: usage
            ? {
                ...(usage.inputTokens !== undefined ? { input_tokens: usage.inputTokens } : {}),
                ...(usage.cacheReadTokens !== undefined ? { cache_read_input_tokens: usage.cacheReadTokens } : {}),
                output_tokens: usage.outputTokens,
            }
            : undefined,
    }
    return `event: message_delta\ndata: ${JSON.stringify(event)}\n\n`
}

/**
 * 构建 message_stop 事件
 */
export function buildMessageStop(): string {
    return `event: message_stop\ndata: {"type":"message_stop"}\n\n`
}

/**
 * 构建 ping 事件
 */
export function buildPing(): string {
    return `event: ping\ndata: {"type":"ping"}\n\n`
}
