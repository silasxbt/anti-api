/**
 * /v1/messages 端点处理器
 * 将Anthropic格式请求转换为Antigravity调用
 * 
 * 🆕 在 HTTP 层获取全局锁，确保所有请求串行化（模拟 proj-1 单进程）
 */

import type { Context } from "hono"
import { streamSSE } from "hono/streaming"
import consola from "consola"

import { createRoutedCompletion, createRoutedCompletionStream, RoutingError } from "~/services/routing/router"
import type { ClaudeMessage, ClaudeTool } from "~/lib/translator"
import { validateAnthropicRequest } from "~/lib/validation"
import { UpstreamError } from "~/lib/error"
import { state } from "~/lib/state"
import type {
    AnthropicMessagesPayload,
    AnthropicResponse,
} from "./types"

/**
 * 将Anthropic消息转换为 Claude 格式（保留完整结构）
 */
function translateMessages(payload: AnthropicMessagesPayload): ClaudeMessage[] {
    return payload.messages as unknown as ClaudeMessage[]
}

/**
 * 提取工具定义
 */
function extractTools(payload: AnthropicMessagesPayload): ClaudeTool[] | undefined {
    if (!payload.tools || payload.tools.length === 0) {
        return undefined
    }

    return payload.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema
    }))
}

function collectToolResultIds(messages: ClaudeMessage[]): string[] {
    const ids: string[] = []
    for (const message of messages) {
        if (typeof message.content === "string") continue
        for (const block of message.content) {
            if (block.type === "tool_result") {
                ids.push(block.tool_use_id || "unknown")
            }
        }
    }
    return ids
}

/**
 * 生成响应ID
 */
function generateMessageId(): string {
    return `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`
}

/**
 * 处理请求入口
 * 🆕 在 HTTP 层获取全局锁，确保所有请求串行化
 */
export async function handleCompletion(c: Context): Promise<Response> {
    try {
        const payload = await c.req.json<AnthropicMessagesPayload>()

        // Input validation
        const validation = validateAnthropicRequest(payload)
        if (!validation.valid) {
            return c.json({ error: { type: "invalid_request_error", message: validation.error } }, 400)
        }

        const messages = translateMessages(payload)
        const tools = extractTools(payload)
        const toolChoice = payload.tool_choice
        if (state.verbose) {
            if (toolChoice) {
                const choiceName = toolChoice.type === "tool" && toolChoice.name ? `(${toolChoice.name})` : ""
                consola.debug(`Debug: tool_choice=${toolChoice.type}${choiceName}`)
            }
            if (tools && tools.length > 0) {
                const toolNames = tools.map(tool => tool.name).slice(0, 8).join(", ")
                const suffix = tools.length > 8 ? ", ..." : ""
                consola.debug(`Debug: tools=${tools.length} [${toolNames}${suffix}]`)
            }
            const toolResultIds = collectToolResultIds(messages)
            if (toolResultIds.length > 0) {
                const preview = toolResultIds.slice(0, 4).join(", ")
                const suffix = toolResultIds.length > 4 ? ", ..." : ""
                consola.debug(`Debug: tool_result blocks=${toolResultIds.length} ids=${preview}${suffix}`)
            }
        }

        // 检查是否流式
        if (payload.stream) {
            return handleStreamCompletion(c, payload, messages, tools, toolChoice)
        }

        // 非流式请求
            let result
        try {
            result = await createRoutedCompletion({
                model: payload.model,
                messages,
                tools,
                toolChoice,
                maxTokens: payload.max_tokens,
            })
        } catch (error) {
            if (error instanceof RoutingError) {
                return c.json({ error: { type: "invalid_request_error", message: error.message } }, error.status as any)
            }
            throw error
        }

        // 构建响应内容
        const content = result.contentBlocks.map(block => {
            if (block.type === "tool_use") {
                return {
                    type: "tool_use" as const,
                    id: block.id!,
                    name: block.name!,
                    input: block.input,
                    ...((block as any).extra_content ? { extra_content: (block as any).extra_content } : {}),
                }
            }
            return {
                type: "text" as const,
                text: block.text || ""
            }
        })

        const response: AnthropicResponse = {
            id: generateMessageId(),
            type: "message",
            role: "assistant",
            content,
            model: payload.model,
            stop_reason: result.stopReason as "end_turn" | "tool_use" | "max_tokens",
            stop_sequence: null,
            usage: {
                input_tokens: result.usage?.inputTokens || 0,
                output_tokens: result.usage?.outputTokens || 0,
            },
        }


        // Note: Usage recording is handled in chat.ts with the actual native model ID

        return c.json(response)
    } finally {
        // no-op
    }
}

/**
 * 处理流式请求
 * 🆕 接收 releaseLock 参数，在流结束时释放锁
 */
async function handleStreamCompletion(
    c: Context,
    payload: AnthropicMessagesPayload,
    messages: ClaudeMessage[],
    tools: ClaudeTool[] | undefined,
    toolChoice: AnthropicMessagesPayload["tool_choice"] | undefined
): Promise<Response> {
    return streamSSE(c, async (stream) => {
        const pingInterval = setInterval(() => {
            stream.write(": ping\n\n").catch(() => { })
        }, 15000)
        try {
            const chatStream = createRoutedCompletionStream({
                model: payload.model,
                messages,
                tools,
                toolChoice,
                maxTokens: payload.max_tokens,
            })

            // 直接写入来自翻译器的 SSE 事件
            for await (const event of chatStream) {
                await stream.write(event)
            }

        } catch (error) {
            if (error instanceof UpstreamError && error.provider === "antigravity" && error.status === 429) {
                consola.warn("Stream error: Antigravity 429 rate limit (auto-rotation may continue)")
            } else {
                consola.error("Stream error:", error)
            }
            await stream.writeSSE({
                event: "error",
                data: JSON.stringify({
                    type: "error",
                    error: { type: "api_error", message: (error as Error).message },
                }),
            })
        } finally {
            clearInterval(pingInterval)
        }
    })
}
