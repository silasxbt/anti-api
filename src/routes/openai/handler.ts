import { getCacheReadTokens } from "~/lib/translator"
/**
 * OpenAI /v1/chat/completions 端点处理器
 */

import type { Context } from "hono"
import { streamSSE } from "hono/streaming"
import consola from "consola"

import { createRoutedCompletion, createRoutedCompletionStream, RoutingError } from "~/services/routing/router"
import type { OpenAIChatCompletionRequest } from "./types"
import {
    mapModel,
    translateMessages,
    translateTools,
    generateChatId,
    buildStreamChunk,
    mapStopReason,
} from "./translator"
import { validateChatRequest } from "~/lib/validation"
import { rateLimiter } from "~/lib/rate-limiter"
import { forwardError, RequestValidationError, summarizeUpstreamError, UpstreamError } from "~/lib/error"
import { parseBoundedJson } from "~/lib/request-body"
import { isStreamCancellation, onRequestAbort, returnStream } from "~/lib/stream-cancellation"
import { createImageInputBudget } from "~/lib/image-input"
import { safeErrorMessage } from "~/lib/redaction"

type ReasoningEffort = "low" | "medium" | "high"

function normalizeChatPayload(payload: OpenAIChatCompletionRequest): void {
    if (payload.max_tokens !== undefined && (payload.max_tokens === null || payload.max_tokens <= 0)) {
        delete (payload as { max_tokens?: number | null }).max_tokens
    }
    if (payload.temperature !== undefined && payload.temperature === null) {
        delete (payload as { temperature?: number | null }).temperature
    }
    if (payload.stream !== undefined && payload.stream === null) {
        delete (payload as { stream?: boolean | null }).stream
    }
    if (payload.tools !== undefined && payload.tools === null) {
        delete (payload as { tools?: any[] | null }).tools
    }
}

function extractReasoningEffort(payload: OpenAIChatCompletionRequest): ReasoningEffort | undefined {
    const candidate = payload.reasoning_effort ?? payload.reasoning?.effort
    if (candidate === "low" || candidate === "medium" || candidate === "high") {
        return candidate
    }
    return undefined
}

function buildValidationReason(message?: string): string {
    const raw = (message || "invalid_request").replace(/[\r\n]+/g, " ").trim()
    if (!raw) return "invalid_request"
    return raw.length > 160 ? `${raw.slice(0, 157)}...` : raw
}

export async function handleChatCompletion(c: Context): Promise<Response> {
    try {
        const payload = await parseBoundedJson<OpenAIChatCompletionRequest>(c.req.raw)
        if (payload && typeof payload === "object") {
            normalizeChatPayload(payload)
        }

        // Input validation
        const validation = validateChatRequest(payload)
        if (!validation.valid) {
            c.header("X-Log-Reason", buildValidationReason(validation.error))
            return c.json({ error: { type: "invalid_request_error", message: validation.error } }, 400)
        }

        await rateLimiter.wait()

        const reasoningEffort = extractReasoningEffort(payload)
        const anthropicModel = mapModel(payload.model, reasoningEffort)
        const messages = translateMessages(payload.messages)
        // Validate image count and inline byte budgets before routing to any provider.
        createImageInputBudget(messages)
        const tools = translateTools(payload.tools)


        if (payload.stream) {
            return handleStreamCompletion(c, payload, anthropicModel, messages, tools, reasoningEffort)
        }

        let result
        try {
            result = await createRoutedCompletion({
                model: anthropicModel,
                messages,
                tools,
                maxTokens: payload.max_tokens || 4096,
                reasoningEffort,
                signal: c.req.raw.signal,
            })
        } catch (error) {
            if (error instanceof RoutingError) {
                c.header("X-Log-Reason", buildValidationReason(error.message))
                return c.json({ error: { type: "invalid_request_error", message: error.message } }, error.status as any)
            }
            throw error
        }

        let textContent = ""
        let reasoningContent = ""
        const toolCalls: any[] = []

        for (const block of result.contentBlocks) {
            if (block.type === "text") {
                textContent += block.text || ""
            } else if (block.type === "thinking") {
                reasoningContent += block.thinking || block.text || ""
            } else if (block.type === "tool_use") {
                toolCalls.push({
                    id: block.id,
                    name: block.name,
                    input: block.input,
                    thought_signature: (block as any).thought_signature || (block as any).thoughtSignature,
                })
            }
        }

        const message: any = { role: "assistant", content: toolCalls.length > 0 ? null : textContent }
        if (reasoningContent) {
            message.reasoning_content = reasoningContent
        }
        if (toolCalls.length > 0) {
            message.tool_calls = toolCalls.map((tc) => ({
                id: tc.id,
                type: "function",
                function: { name: tc.name, arguments: JSON.stringify(tc.input) },
                ...(tc.thought_signature ? { thought_signature: tc.thought_signature } : {}),
            }))
        }

        // Token counts for response (Usage recording is handled in chat.ts with actual native model ID)
        const cacheReadTokens = getCacheReadTokens(result.usage)
        const inputTokens = (result.usage?.inputTokens || 0) + cacheReadTokens
        const outputTokens = result.usage?.outputTokens || 0

        return c.json({
            id: generateChatId(),
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: payload.model,
            choices: [{ index: 0, message, finish_reason: mapStopReason(result.stopReason || "end_turn") }],
            usage: {
                prompt_tokens: inputTokens,
                completion_tokens: outputTokens,
                total_tokens: inputTokens + outputTokens,
                prompt_tokens_details: { cached_tokens: cacheReadTokens },
            },
        })
    } catch (error) {
        if (error instanceof RequestValidationError) {
            c.header("X-Log-Reason", buildValidationReason(error.message))
            return c.json({ error: { type: "invalid_request_error", message: error.message } }, 400)
        }
        if (error instanceof UpstreamError) {
            return await forwardError(c, error)
        }
        consola.error("OpenAI completion error:", safeErrorMessage(error))
        return c.json({ error: { message: "Internal server error", type: "api_error" } }, 500)
    } finally {
        // no-op
    }
}

async function handleStreamCompletion(
    c: Context,
    payload: OpenAIChatCompletionRequest,
    anthropicModel: string,
    messages: any[],
    tools: any[] | undefined,
    reasoningEffort?: ReasoningEffort
): Promise<Response> {
    const chatId = generateChatId()

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

        const writeData = async (data: string): Promise<boolean> => {
            if (cancelled || isStreamCancellation(undefined, requestSignal, stream)) return false
            await stream.writeSSE({ data })
            return !(cancelled || isStreamCancellation(undefined, requestSignal, stream))
        }

        try {
            if (cancelled) return
            chatStream = createRoutedCompletionStream({
                model: anthropicModel,
                messages,
                tools,
                maxTokens: payload.max_tokens || 4096,
                reasoningEffort,
                signal: requestSignal,
            })

            let sentRole = false
            let accumulatedToolCalls: any[] = []
            let currentToolCall: any = null
            let streamInputTokens = 0
            let streamCacheReadTokens = 0
            let streamOutputTokens = 0

            for await (const event of chatStream) {
                if (cancelled) return
                const lines = event.split("\n")
                for (const line of lines) {
                    if (cancelled) return
                    if (!line.startsWith("data: ")) continue
                    const data = line.slice(6)
                    if (data === "[DONE]") continue

                    let parsed: any
                    try {
                        parsed = JSON.parse(data)
                    } catch {
                        // Do not turn a truncated or malformed upstream event into a
                        // successful-looking stream. The outer handler will emit a
                        // sanitized error and close the SSE response.
                        throw new UpstreamError("antigravity", 502, "Malformed streaming event")
                    }
                    if (!parsed || typeof parsed !== "object") {
                        throw new UpstreamError("antigravity", 502, "Malformed streaming event")
                    }
                    const eventType = parsed.type

                    switch (eventType) {
                            case "message_start":
                                if (!sentRole) {
                                    if (!await writeData(buildStreamChunk(chatId, payload.model, undefined, "assistant"))) return
                                    sentRole = true
                                }
                                // Capture input tokens from message_start
                                if (parsed.message?.usage?.input_tokens) {
                                    streamInputTokens = parsed.message.usage.input_tokens
                                }
                                if (parsed.message?.usage?.cache_read_input_tokens) {
                                    streamCacheReadTokens = parsed.message.usage.cache_read_input_tokens
                                }
                                break

                            case "content_block_start":
                                if (parsed.content_block?.type === "tool_use") {
                                    currentToolCall = {
                                        id: parsed.content_block.id,
                                        name: parsed.content_block.name,
                                        input: {},
                                        arguments: "",
                                        thought_signature: parsed.content_block.thought_signature || parsed.content_block.thoughtSignature,
                                    }
                                }
                                break

                            case "content_block_delta":
                                if (parsed.delta?.type === "text_delta" && parsed.delta?.text) {
                                    if (!await writeData(buildStreamChunk(chatId, payload.model, parsed.delta.text))) return
                                } else if (parsed.delta?.type === "thinking_delta" && parsed.delta?.thinking) {
                                    if (!await writeData(buildStreamChunk(chatId, payload.model, undefined, undefined, undefined, undefined, parsed.delta.thinking))) return
                                } else if (parsed.delta?.type === "input_json_delta" && currentToolCall) {
                                    currentToolCall.arguments += parsed.delta.partial_json || ""
                                }
                                break

                            case "content_block_stop":
                                if (currentToolCall) {
                                    try {
                                        currentToolCall.input = JSON.parse(currentToolCall.arguments || "{}")
                                    } catch {
                                        // A partial tool argument stream is not a valid function
                                        // call. Surface it as an upstream failure instead of
                                        // silently invoking the caller's tool with an empty object.
                                        throw new UpstreamError("antigravity", 502, "Malformed streaming tool arguments")
                                    }
                                    accumulatedToolCalls.push(currentToolCall)
                                    currentToolCall = null
                                }
                                break

                            case "message_delta":
                                const stopReason = parsed.delta?.stop_reason || "end_turn"
                                // Capture output tokens from message_delta
                                if (parsed.usage?.output_tokens) {
                                    streamOutputTokens = parsed.usage.output_tokens
                                }
                                if (parsed.usage?.input_tokens) {
                                    streamInputTokens = parsed.usage.input_tokens
                                }
                                if (parsed.usage?.cache_read_input_tokens) {
                                    streamCacheReadTokens = parsed.usage.cache_read_input_tokens
                                }
                                if (accumulatedToolCalls.length > 0) {
                                    if (!await writeData(buildStreamChunk(chatId, payload.model, undefined, undefined, "tool_use", accumulatedToolCalls))) return
                                }
                                if (!await writeData(buildStreamChunk(chatId, payload.model, undefined, undefined, stopReason))) return
                                break
                    }
                }
            }


            // Note: Usage recording is handled in chat.ts with the actual native model ID

            if (!cancelled && payload.stream_options?.include_usage) {
                const promptTokens = streamInputTokens + streamCacheReadTokens
                await writeData(JSON.stringify({
                    id: chatId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: payload.model,
                    choices: [],
                    usage: {
                        prompt_tokens: promptTokens,
                        completion_tokens: streamOutputTokens,
                        total_tokens: promptTokens + streamOutputTokens,
                        prompt_tokens_details: { cached_tokens: streamCacheReadTokens },
                    },
                }))
            }

            if (!cancelled) {
                await writeData("[DONE]")
            }
        } catch (error) {
            if (isStreamCancellation(error, requestSignal, stream)) return
            if (error instanceof UpstreamError) {
                const summary = summarizeUpstreamError(error)
                consola.error("OpenAI stream error:", summary.message)
                await writeData(JSON.stringify({
                        error: {
                            type: "upstream_error",
                            message: summary.message,
                            provider: error.provider,
                            ...(summary.reason ? { reason: summary.reason } : {}),
                        },
                    }))
            } else {
                consola.error("OpenAI stream error:", safeErrorMessage(error))
                await writeData(JSON.stringify({ error: { message: "Internal server error", type: "api_error" } }))
            }
        } finally {
            removeRequestAbort()
            await returnStream(chatStream)
        }
    })
}
