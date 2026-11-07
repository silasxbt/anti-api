/**
 * Anthropic API 类型定义
 * 用于/v1/messages端点兼容
 */

// 请求类型

export interface AnthropicMessagesPayload {
    model: string
    messages: AnthropicMessage[]
    max_tokens: number
    system?: string | AnthropicTextBlock[]
    stream?: boolean
    temperature?: number
    top_p?: number
    stop_sequences?: string[]
    tools?: AnthropicTool[]
    tool_choice?: {
        type: "auto" | "any" | "tool" | "none"
        name?: string
    }
}

export interface AnthropicMessage {
    role: "user" | "assistant"
    content: string | AnthropicContentBlock[]
}

export interface AnthropicTextBlock {
    type: "text"
    text: string
}

export interface AnthropicImageBlock {
    type: "image"
    source: {
        type: "base64"
        media_type: string
        data: string
    }
}

export interface AnthropicToolResultBlock {
    type: "tool_result"
    tool_use_id: string
    content: string
    is_error?: boolean
}

export interface AnthropicToolUseBlock {
    type: "tool_use"
    id: string
    name: string
    input: Record<string, unknown>
}

export interface AnthropicAudioBlock {
    type: "audio"
    source: {
        type: "base64" | "url"
        media_type: string
        data?: string
        url?: string
    }
}

export interface AnthropicDocumentBlock {
    type: "document"
    source: {
        type: "base64" | "url"
        media_type: string
        data?: string
        url?: string
    }
}

export type AnthropicContentBlock =
    | AnthropicTextBlock
    | AnthropicImageBlock
    | AnthropicAudioBlock
    | AnthropicDocumentBlock
    | AnthropicToolResultBlock
    | AnthropicToolUseBlock

export interface AnthropicTool {
    name: string
    description?: string
    input_schema: Record<string, unknown>
}

// 响应类型

export interface AnthropicResponse {
    id: string
    type: "message"
    role: "assistant"
    content: AnthropicResponseContentBlock[]
    model: string
    stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null
    stop_sequence: string | null
    usage: {
        input_tokens: number
        output_tokens: number
        cache_read_input_tokens?: number
        cache_creation_input_tokens?: number
    }
}

export type AnthropicResponseContentBlock = AnthropicTextBlock | AnthropicToolUseBlock

// 流式事件类型

export interface AnthropicMessageStartEvent {
    type: "message_start"
    message: Omit<AnthropicResponse, "content" | "stop_reason" | "stop_sequence"> & {
        content: []
        stop_reason: null
        stop_sequence: null
    }
}

export interface AnthropicContentBlockStartEvent {
    type: "content_block_start"
    index: number
    content_block: { type: "text"; text: string }
}

export interface AnthropicContentBlockDeltaEvent {
    type: "content_block_delta"
    index: number
    delta: { type: "text_delta"; text: string }
}

export interface AnthropicContentBlockStopEvent {
    type: "content_block_stop"
    index: number
}

export interface AnthropicMessageDeltaEvent {
    type: "message_delta"
    delta: {
        stop_reason?: AnthropicResponse["stop_reason"]
        stop_sequence?: string | null
    }
    usage?: {
        input_tokens?: number
        cache_read_input_tokens?: number
        output_tokens: number
    }
}

export interface AnthropicMessageStopEvent {
    type: "message_stop"
}

export type AnthropicStreamEvent =
    | AnthropicMessageStartEvent
    | AnthropicContentBlockStartEvent
    | AnthropicContentBlockDeltaEvent
    | AnthropicContentBlockStopEvent
    | AnthropicMessageDeltaEvent
    | AnthropicMessageStopEvent
