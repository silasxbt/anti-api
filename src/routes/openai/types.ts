/**
 * OpenAI API 类型定义
 */

export interface OpenAIChatCompletionRequest {
    model: string
    messages: OpenAIMessage[]
    stream?: boolean
    max_tokens?: number
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
    content: string | null
    tool_calls?: OpenAIToolCall[]
    tool_call_id?: string
}

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
    extra_content?: Record<string, any>
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
    finish_reason: "stop" | "length" | "tool_calls" | null
}

export interface OpenAIUsage {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
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
    finish_reason: "stop" | "length" | "tool_calls" | null
}
