/**
 * OpenAI API 类型定义
 */

export interface OpenAIChatCompletionRequest {
    model: string
    messages: OpenAIMessage[]
    stream?: boolean
    max_tokens?: number
    stream_options?: { include_usage?: boolean }
    temperature?: number
    top_p?: number
    tools?: OpenAITool[]
    reasoning_effort?: "low" | "medium" | "high"
    reasoning?: {
        effort?: "low" | "medium" | "high"
    }
}

export interface OpenAIMessage {
    role: "system" | "user" | "assistant" | "tool" | "developer"
    content: string | OpenAIContentPart[] | null
    tool_calls?: OpenAIToolCall[]
    tool_call_id?: string
}

export interface OpenAITextContentPart {
    type: "text" | "input_text"
    text: string
}

export interface OpenAIImageUrlContentPart {
    type: "image_url"
    image_url: {
        url: string
        detail?: "auto" | "low" | "high"
    }
}

export interface OpenAIAudioUrlContentPart {
    type: "audio_url"
    audio_url: {
        url: string
    }
}

export interface OpenAIInputAudioContentPart {
    type: "input_audio"
    input_audio: {
        data: string
        format: "wav" | "mp3" | string
    }
}

export interface OpenAIAudioBlockContentPart {
    type: "audio"
    source?: {
        type: "base64" | "url"
        media_type?: string
        data?: string
        url?: string
    }
    input_audio?: {
        data: string
        format?: string
    }
}

export interface OpenAIDocumentContentPart {
    type: "document"
    source?: {
        type: "base64" | "url"
        media_type?: string
        data?: string
        url?: string
    }
}

export type OpenAIContentPart =
    | OpenAITextContentPart
    | OpenAIImageUrlContentPart
    | OpenAIAudioUrlContentPart
    | OpenAIInputAudioContentPart
    | OpenAIAudioBlockContentPart
    | OpenAIDocumentContentPart

export interface OpenAITool {
    type: "function"
    function: {
        name: string
        description?: string
        parameters?: Record<string, any>
    }
}

export interface OpenAIToolCall {
    id: string
    type: "function"
    function: {
        name: string
        arguments: string
    }
}

export interface OpenAIChatCompletionResponse {
    id: string
    object: "chat.completion"
    created: number
    model: string
    choices: OpenAIChoice[]
    usage?: OpenAIUsage
}

export interface OpenAIChoice {
    index: number
    message: OpenAIMessage
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
}

export interface OpenAIUsage {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: { cached_tokens: number }
}

export interface OpenAIStreamChunk {
    id: string
    object: "chat.completion.chunk"
    created: number
    model: string
    choices: OpenAIStreamChoice[]
}

export interface OpenAIStreamChoice {
    index: number
    delta: Partial<OpenAIMessage>
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
}
