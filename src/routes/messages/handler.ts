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
import { generateMessageId, getCacheReadTokens } from "~/lib/translator"
import { rateLimiter } from "~/lib/rate-limiter"
import { validateAnthropicRequest } from "~/lib/validation"
import { forwardError, RequestValidationError, UpstreamError } from "~/lib/error"
import { parseBoundedJson } from "~/lib/request-body"
import { isStreamCancellation, onRequestAbort, returnStream } from "~/lib/stream-cancellation"
import { createImageInputBudget } from "~/lib/image-input"
import { safeErrorMessage } from "~/lib/redaction"
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
 * 处理请求入口
 * 🆕 在 HTTP 层获取全局锁，确保所有请求串行化
 */
export async function handleCompletion(c: Context): Promise<Response> {
    try {
        const payload = await parseBoundedJson<AnthropicMessagesPayload>(c.req.raw)

        // Input validation
        const validation = validateAnthropicRequest(payload)
        if (!validation.valid) {
            return c.json({ error: { type: "invalid_request_error", message: validation.error } }, 400)
        }

        await rateLimiter.wait()

        const messages = translateMessages(payload)
        // Validate image count and inline byte budgets before routing to any provider.
        createImageInputBudget(messages)
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
                signal: c.req.raw.signal,
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
                    input: block.input
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
                cache_read_input_tokens: getCacheReadTokens(result.usage),
                cache_creation_input_tokens: 0,
            },
        }


        // Note: Usage recording is handled in chat.ts with the actual native model ID

        return c.json(response)
    } catch (error) {
        if (error instanceof RequestValidationError) {
            return c.json({ error: { type: "invalid_request_error", message: error.message } }, 400)
        }
        if (error instanceof RoutingError) {
            return c.json({ error: { type: "invalid_request_error", message: error.message } }, error.status as any)
        }
        if (error instanceof UpstreamError) {
            return await forwardError(c, error)
        }
        consola.error("Messages completion error:", safeErrorMessage(error))
        return c.json({ error: { type: "api_error", message: "Internal server error" } }, 500)
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
        const requestSignal = c.req.raw.signal
        let cancelled = requestSignal.aborted
        let chatStream: AsyncGenerator<string, void, unknown> | null = null
        const markCancelled = () => {
            cancelled = true
            void returnStream(chatStream)
        }
        const removeRequestAbort = onRequestAbort(requestSignal, () => {
            markCancelled()
            stream.abort()
        })
        stream.onAbort(markCancelled)

        const writeEvent = async (event: string, data: string): Promise<boolean> => {
            if (cancelled || isStreamCancellation(undefined, requestSignal, stream)) return false
            await stream.writeSSE({ event, data })
            return !(cancelled || isStreamCancellation(undefined, requestSignal, stream))
        }

        const pingInterval = setInterval(() => {
            if (cancelled || isStreamCancellation(undefined, requestSignal, stream)) return
            stream.write(": ping\n\n").catch(() => { })
        }, 15000)
        try {
            if (cancelled) return
            chatStream = createRoutedCompletionStream({
                model: payload.model,
                messages,
                tools,
                toolChoice,
                maxTokens: payload.max_tokens,
                signal: requestSignal,
            })

            // 直接写入来自翻译器的 SSE 事件
            for await (const event of chatStream) {
                if (cancelled) return
                await stream.write(event)
            }

        } catch (error) {
            if (isStreamCancellation(error, requestSignal, stream)) return
            if (error instanceof UpstreamError && error.provider === "antigravity" && error.status === 429) {
                consola.warn("Stream error: Antigravity 429 rate limit (auto-rotation may continue)")
            } else {
                consola.error("Stream error:", safeErrorMessage(error))
            }
            const isRequestError = error instanceof RequestValidationError
            await writeEvent("error", JSON.stringify({
                    type: "error",
                    error: {
                        type: isRequestError ? "invalid_request_error" : "api_error",
                        message: isRequestError ? error.message : "Upstream request failed",
                    },
                }))
        } finally {
            clearInterval(pingInterval)
            removeRequestAbort()
            await returnStream(chatStream)
        }
    })
}
