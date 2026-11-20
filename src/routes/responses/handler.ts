/**
 * OpenAI /v1/responses Endpoint Handler
 */

import type { Context } from "hono"
import { streamSSE } from "hono/streaming"
import consola from "consola"

import { createRoutedResponses, RoutingError } from "~/services/routing/router"
import { validateResponsesRequest } from "~/lib/validation"
import { rateLimiter } from "~/lib/rate-limiter"
import { forwardError, RequestValidationError, summarizeUpstreamError, UpstreamError } from "~/lib/error"
import { parseBoundedJson } from "~/lib/request-body"
import { isStreamCancellation, onRequestAbort, returnStream } from "~/lib/stream-cancellation"
import { safeErrorMessage } from "~/lib/redaction"
import { formatResponsesEvent } from "~/lib/direct-stream"
import type { ResponsesCreateRequest } from "./types"

function normalizeResponsesPayload(payload: ResponsesCreateRequest): void {
    if (payload.max_output_tokens !== undefined && (payload.max_output_tokens === null || payload.max_output_tokens <= 0)) {
        delete payload.max_output_tokens
    }
    if (payload.temperature !== undefined && payload.temperature === null) {
        delete payload.temperature
    }
    if (payload.top_p !== undefined && payload.top_p === null) {
        delete payload.top_p
    }
    if (payload.stream !== undefined && payload.stream === null) {
        delete payload.stream
    }
    if (payload.tools !== undefined && payload.tools === null) {
        delete payload.tools
    }
}

function buildValidationReason(message?: string): string {
    const raw = (message || "invalid_request").replace(/[\r\n]+/g, " ").trim()
    if (!raw) return "invalid_request"
    return raw.length > 160 ? `${raw.slice(0, 157)}...` : raw
}

export async function handleResponses(c: Context): Promise<Response> {
    try {
        const payload = await parseBoundedJson<ResponsesCreateRequest>(c.req.raw)
        if (payload && typeof payload === "object" && !Array.isArray(payload)) {
            normalizeResponsesPayload(payload)
        }

        const validation = validateResponsesRequest(payload)
        if (!validation.valid) {
            c.header("X-Log-Reason", buildValidationReason(validation.error))
            return c.json({ error: { type: "invalid_request_error", message: validation.error } }, 400)
        }

        await rateLimiter.wait()

        let result
        try {
            result = await createRoutedResponses(payload, c.req.raw.signal)
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
                let message = "Internal server error"
                let type = "api_error"
                if (error instanceof UpstreamError) {
                    const summary = summarizeUpstreamError(error)
                    consola.error("Responses stream error:", summary.message)
                    message = summary.message
                    type = "upstream_error"
                } else {
                    consola.error("Responses stream error:", safeErrorMessage(error))
                }
                await stream.write(formatResponsesEvent("response.failed", {
                    response: {
                        object: "response",
                        status: "failed",
                        error: { type, message },
                    },
                })).catch(() => {})
                await stream.write(formatResponsesEvent("error", {
                    error: { type, message },
                })).catch(() => {})
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
        consola.error("Responses completion error:", safeErrorMessage(error))
        return c.json({ error: { message: "Internal server error", type: "api_error" } }, 500)
    }
}
