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
    type: "text" | "tool_use" | "tool_result" | "image"
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
export function buildContentBlockStart(index: number, type: "text" | "tool_use", toolInfo?: { id: string; name: string }): string {
    let contentBlock: any = { type }
    if (type === "tool_use" && toolInfo) {
        contentBlock = { type: "tool_use", id: toolInfo.id, name: toolInfo.name, input: {} }
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
export function buildMessageDelta(stopReason: string, usage?: { inputTokens: number; outputTokens: number }): string {
    const event = {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: usage ? { output_tokens: usage.outputTokens } : undefined,
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

/**
 * 转换状态
 */
export interface ConversionState {
    messageId: string
    currentBlockIndex: number
    toolCallsAccumulator: Map<number, { id: string; name: string; input: string }>
}

export function createConversionState(): ConversionState {
    return {
        messageId: generateMessageId(),
        currentBlockIndex: 0,
        toolCallsAccumulator: new Map(),
    }
}

/**
 * Claude 到 Antigravity 格式转换
 */
export function claudeToAntigravity(messages: ClaudeMessage[], tools?: ClaudeTool[]): any {
    return {
        messages: messages.map(msg => ({
            role: msg.role,
            content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        })),
        tools: tools?.map(t => ({
            name: t.name,
            description: t.description,
            parameters: t.input_schema
        }))
    }
}

/**
 * Antigravity SSE 到 Claude SSE 格式转换
 */
export function* antigravityToClaudeSSE(chunk: any, state: ConversionState): Generator<string> {
    // 确保 chunk 是字符串
    const chunkStr = typeof chunk === 'string' ? chunk : JSON.stringify(chunk)

    // 简化实现 - 直接透传文本内容
    if (chunkStr.includes('"text"')) {
        try {
            const match = chunkStr.match(/"text":"([^"]+)"/)
            if (match) {
                yield buildTextDelta(state.currentBlockIndex, match[1])
            }
        } catch (e) { }
    }
}
