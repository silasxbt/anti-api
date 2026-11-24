/**
 * Anti-API 错误处理
 */

import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { safeErrorMessage } from "./redaction"

export class HTTPError extends Error {
    response: Response

    constructor(message: string, response: Response) {
        super(message)
        this.response = response
    }
}

export class AntigravityError extends Error {
    code: string

    constructor(message: string, code: string = "antigravity_error") {
        super(message)
        this.code = code
    }
}

/**
 * A request is structurally valid JSON but contains an unsupported or unsafe
 * value for a provider conversion. Handlers return these as HTTP 400 rather
 * than treating them as upstream failures.
 */
export class RequestValidationError extends Error {
    status: number

    constructor(message: string) {
        super(message)
        this.name = "RequestValidationError"
        this.status = 400
    }
}

export class UpstreamError extends Error {
    status: number
    provider: string
    body: string
    retryAfter?: string

    constructor(provider: string, status: number, body: string, retryAfter?: string) {
        super(`${provider} upstream error (${status})`)
        this.status = status
        this.provider = provider
        this.body = body
        this.retryAfter = retryAfter
    }
}

export type Upstream429Reason =
    | "quota_exhausted"
    | "rate_limit_exceeded"
    | "model_capacity_exhausted"
    | "resource_exhausted"
    | "unknown"

type ParsedUpstreamError = {
    reason?: string
    message?: string
    status?: string
    type?: string
}

function parseUpstreamErrorBody(body: string): ParsedUpstreamError {
    const trimmed = (body || "").trim()
    if (!trimmed) return {}
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
            const json = JSON.parse(trimmed)
            const err = json?.error || json
            const details = err?.details
            let reason: string | undefined
            if (Array.isArray(details)) {
                for (const detail of details) {
                    if (typeof detail?.reason === "string") {
                        reason = detail.reason
                        break
                    }
                }
            }
            return {
                reason,
                type: typeof err?.type === "string" ? err.type : undefined,
                message: typeof err?.message === "string" ? err.message : undefined,
                status: typeof err?.status === "string" ? err.status : undefined,
            }
        } catch {
            return { message: trimmed }
        }
    }
    return { message: trimmed }
}

export function summarizeUpstream429(error: UpstreamError): { reason: Upstream429Reason; message: string } {
    const providerName = error.provider === "antigravity" ? "Antigravity" : error.provider
    const parsed = parseUpstreamErrorBody(error.body || "")
    const rawReason = parsed.reason || ""
    const rawType = parsed.type || ""
    const messageText = parsed.message || ""
    const lower = messageText.toLowerCase()

    let reason: Upstream429Reason = "unknown"
    if (
        rawReason === "QUOTA_EXHAUSTED" ||
        rawType === "usage_limit_reached" ||
        lower.includes("usage limit") ||
        (lower.includes("quota") && lower.includes("reset"))
    ) {
        reason = "quota_exhausted"
    } else if (rawReason === "MODEL_CAPACITY_EXHAUSTED" || lower.includes("no capacity") || lower.includes("capacity")) {
        reason = "model_capacity_exhausted"
    } else if (rawReason === "RATE_LIMIT_EXCEEDED" || lower.includes("rate limit") || lower.includes("per minute") || lower.includes("too many requests")) {
        reason = "rate_limit_exceeded"
    } else if (parsed.status === "RESOURCE_EXHAUSTED") {
        reason = "resource_exhausted"
    }

    switch (reason) {
        case "quota_exhausted":
            return { reason, message: `${providerName} quota exhausted for this account or model.` }
        case "model_capacity_exhausted":
            return { reason, message: `${providerName} model capacity exhausted (temporary). Quota may still be available.` }
        case "rate_limit_exceeded":
            return { reason, message: `${providerName} rate limit exceeded (requests too fast). Quota may still be available.` }
        case "resource_exhausted":
            return { reason, message: `${providerName} resource exhausted (temporary). Quota may still be available.` }
        default:
            return { reason: "unknown", message: `${providerName} upstream error (429).` }
    }
}

export function summarizeUpstreamError(error: UpstreamError): { message: string; reason?: string } {
    if (error.status === 429) {
        const summary = summarizeUpstream429(error)
        return { message: summary.message, reason: summary.reason }
    }
    if (error.provider === "zed" && (error.status === 401 || error.status === 403)) {
        return {
            message: "Zed authorization is no longer valid for this account. Update the configured credentials file, then re-import the account.",
        }
    }
    const parsed = parseUpstreamErrorBody(error.body || "")
    if (parsed.message) {
        return { message: `${error.provider} upstream error (${error.status}): ${parsed.message}` }
    }
    return { message: `${error.provider} upstream error (${error.status}).` }
}

function buildLogReason(error: unknown): string {
    if (error instanceof UpstreamError) {
        if (error.status === 429) {
            const summary = summarizeUpstream429(error)
            if (summary.reason === "quota_exhausted") return "quota exhausted"
            if (summary.reason === "model_capacity_exhausted") return "model capacity exhausted"
            if (summary.reason === "resource_exhausted") return "resource exhausted"
            return "rate limited"
        }
        if (error.status === 401) return "unauthorized"
        if (error.status === 403) return "forbidden"
        if (error.status === 404) return "not found"
        if (error.status >= 500) return "upstream error"
        return "upstream error"
    }

    if (error instanceof HTTPError) {
        return "http error"
    }

    if (error instanceof AntigravityError) {
        return error.code || "antigravity error"
    }

    return "internal error"
}

/**
 * 转发错误到客户端
 */
export async function forwardError(c: Context, error: unknown) {
    if (error instanceof HTTPError) {
        c.header("X-Log-Reason", buildLogReason(error))
        return c.json(
            {
                error: {
                    type: "http_error",
                    message: `Upstream HTTP error (${error.response.status}).`,
                },
            },
            error.response.status as ContentfulStatusCode,
        )
    }

    if (error instanceof AntigravityError) {
        c.header("X-Log-Reason", buildLogReason(error))
        return c.json(
            {
                error: {
                    type: error.code,
                    message: error.message,
                },
            },
            500,
        )
    }

    if (error instanceof UpstreamError) {
        const summary = summarizeUpstreamError(error)
        c.header("X-Log-Reason", buildLogReason(error))
        return c.json(
            {
                error: {
                    type: "upstream_error",
                    message: summary.message,
                    provider: error.provider,
                    ...(summary.reason ? { reason: summary.reason } : {}),
                },
            },
            error.status as ContentfulStatusCode,
        )
    }

    c.header("X-Log-Reason", buildLogReason(error))
    return c.json(
        {
            error: {
                type: "error",
                message: safeErrorMessage(error),
            },
        },
        500,
    )
}
