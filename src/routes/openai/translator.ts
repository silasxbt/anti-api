/**
 * OpenAI ↔ Anthropic 格式转换器
 */

import type { ClaudeMessage, ClaudeTool } from "~/lib/translator"
import type { OpenAIMessage, OpenAITool } from "./types"

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

export function translateMessages(messages: OpenAIMessage[]): ClaudeMessage[] {
    return messages.map((msg) => {
        if (msg.role === "assistant" && msg.tool_calls) {
            return {
                role: "assistant" as const,
                content: msg.tool_calls.map((tc) => ({
                    type: "tool_use" as const,
                    id: tc.id,
                    name: tc.function.name,
                    input: JSON.parse(tc.function.arguments || "{}"),
                    ...(tc.extra_content ? { extra_content: tc.extra_content } : {}),
                })),
            }
        }

        if (msg.role === "tool") {
            return {
                role: "user" as const,
                content: [{
                    type: "tool_result" as const,
                    tool_use_id: msg.tool_call_id!,
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
            content: msg.content || "",
        } as ClaudeMessage
    })
}

export function translateTools(tools?: OpenAITool[]): ClaudeTool[] | undefined {
    if (!tools || tools.length === 0) return undefined
    return tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        input_schema: tool.function.parameters || { type: "object", properties: {} },
    }))
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
