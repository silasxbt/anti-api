/**
 * OpenAI /v1/chat/completions Endpoint Handler
 */

import type { Context } from "hono"
import { streamSSE } from "hono/streaming"
import consola from "consola"

import { createRoutedOpenAIChat, RoutingError } from "~/services/routing/router"
import type { OpenAIChatCompletionRequest } from "./types"
import { validateChatRequest } from "~/lib/validation"
import { rateLimiter } from "~/lib/rate-limiter"
import { forwardError, RequestValidationError, summarizeUpstreamError, UpstreamError } from "~/lib/error"
import { parseBoundedJson } from "~/lib/request-body"
import { isStreamCancellation, onRequestAbort, returnStream } from "~/lib/stream-cancellation"
import { safeErrorMessage } from "~/lib/redaction"

function normalizeChatPayload(payload: OpenAIChatCompletionRequest): void {
    if (payload.max_tokens === undefined && typeof payload.max_completion_tokens === "number" && payload.max_completion_tokens > 0) {
        payload.max_tokens = payload.max_completion_tokens
    }
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

        const validation = validateChatRequest(payload)
        if (!validation.valid) {
            c.header("X-Log-Reason", buildValidationReason(validation.error))
            return c.json({ error: { type: "invalid_request_error", message: validation.error } }, 400)
        }

        await rateLimiter.wait()

        let result
        try {
            result = await createRoutedOpenAIChat(payload, c.req.raw.signal)
        } catch (error) {
            if (error instanceof RoutingError) {
                c.header("X-Log-Reason", buildValidationReason(error.message))
                return c.json({ error: { type: "invalid_request_error", message: error.message } }, error.status as any)
            }
            throw error
        }

        if (result.kind === "json") {
            return c.json(result.data, result.status as any)
        }

        const sseStream = result.stream
        return streamSSE(c, async (stream) => {
            const requestSignal = c.req.raw.signal
            let cancelled = requestSignal.aborted
            const markCancelled = () => {
                cancelled = true
                void returnStream(sseStream)
            }
            const removeRequestAbort = onRequestAbort(requestSignal, () => {
                markCancelled()
                stream.abort()
            })
            stream.onAbort(markCancelled)

            try {
                for await (const frame of sseStream) {
                    if (cancelled || isStreamCancellation(undefined, requestSignal, stream)) return
                    await stream.write(frame)
                }
            } catch (error) {
                if (isStreamCancellation(error, requestSignal, stream)) return
                if (error instanceof UpstreamError) {
                    const summary = summarizeUpstreamError(error)
                    consola.error("OpenAI stream error:", summary.message)
                    await stream.write(`data: ${JSON.stringify({
                        error: {
                            type: "upstream_error",
                            message: summary.message,
                            provider: error.provider,
                            ...(summary.reason ? { reason: summary.reason } : {}),
                        },
                    })}\n\n`).catch(() => {})
                } else {
                    consola.error("OpenAI stream error:", safeErrorMessage(error))
                    await stream.write(`data: ${JSON.stringify({
                        error: { message: "Internal server error", type: "api_error" },
                    })}\n\n`).catch(() => {})
                }
            } finally {
                removeRequestAbort()
                await returnStream(sseStream)
            }
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
    }
}
