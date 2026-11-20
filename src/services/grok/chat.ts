/**
 * Grok (xAI) 推理接入
 *
 * 通过 Grok CLI 的反向代理 https://cli-chat-proxy.grok.com/v1 调用 xAI 模型，
 * 使用 OpenAI Responses API 格式（POST /v1/responses）。
 *
 * 线上实际暴露两个模型（GET /v1/models）：
 *   - grok-build              标准 ModelName，对应实际模型 Grok 4.3（Grok CLI 内可见），对外标签 Xbuild
 *   - grok-composer-2.5-fast  Composer 2.5 Fast（Cursor 编码模型）
 *
 * 必需请求头（缺失会返回 426）：
 *   x-grok-client-version、x-grok-client-identifier
 */

import consola from "consola"
import { authStore } from "~/services/auth/store"
import { UpstreamError } from "~/lib/error"
import { importGrokAuthSources, refreshGrokAccountIfNeeded, refreshGrokAccessToken, getGrokClientId, GROK_PROVIDER } from "~/services/grok/oauth"
import type { ProviderAccount } from "~/services/auth/types"
import type { ClaudeMessage, ClaudeTool } from "~/lib/translator"
import { toOpenAIMessages, toOpenAIResponsesContent, toOpenAITools } from "~/services/providers/openai-adapter"
import { createAbortError, isAbortError, sleepWithAbort, throwIfAborted } from "~/lib/stream-cancellation"
import { safeErrorMessage } from "~/lib/redaction"
import {
    chatPayloadToResponses,
    claudeMessagesToResponsesInput,
    claudeToolsToResponsesTools,
    extractResponsesUsage,
    normalizeResponsesInput,
    readResponseText,
    reportUsage,
    responseObjectToChatCompletion,
    responseObjectToSseEvents,
    responsesObjectToCompletion,
    responsesSseToOpenAIChatSse,
    yieldAll,
    type DirectOptions,
    type DirectResult,
} from "~/lib/direct-stream"

const GROK_API_BASE = process.env.ANTI_API_GROK_BASE_URL || "https://cli-chat-proxy.grok.com/v1"
const RESPONSES_PATH = "/responses"
const MODELS_PATH = "/models"
const GROK_CLIENT_VERSION = process.env.ANTI_API_GROK_CLIENT_VERSION || "0.2.59"
const GROK_CLIENT_IDENTIFIER = process.env.ANTI_API_GROK_CLIENT_IDENTIFIER || "grok-shell"
const GROK_MAX_RETRIES = 2
const GROK_RETRY_BASE_MS = 600
const GROK_RETRY_JITTER_MS = 300
const GROK_RETRY_STATUSES = new Set([429, 500, 502, 503, 504, 521, 522, 524])
const GROK_MODEL_CACHE_TTL_MS = 5 * 60 * 1000
const GROK_UNSUPPORTED_MODEL_TTL_MS = 30 * 60 * 1000

export interface GrokModelSummary {
    id: string
    label: string
}

type GrokModelCacheEntry = {
    fetchedAt: number
    models: GrokModelSummary[]
    ids: Set<string>
}

type GrokModelsResponse = {
    data?: Array<{
        id?: string
        model?: string
        name?: string
        description?: string
    }>
}

// 对外标签：grok-build 以 "Xbuild" 表示（对应实际模型 Grok 4.3）
const GROK_MODEL_LABELS: Record<string, string> = {
    "grok-build": "Xbuild",
    "grok-composer-2.5-fast": "Composer 2.5",
}

const grokModelCache = new Map<string, GrokModelCacheEntry>()
const grokModelInFlight = new Map<string, Promise<GrokModelSummary[]>>()
const grokUnsupportedModels = new Map<string, Map<string, number>>()

function normalizeModelId(value: string): string {
    return value.trim()
}

function labelFor(id: string, fallbackName?: string): string {
    return GROK_MODEL_LABELS[id] || (fallbackName ? fallbackName : `Grok - ${id}`)
}

function cleanupUnsupportedCache(accountId: string): Map<string, number> {
    const now = Date.now()
    const existing = grokUnsupportedModels.get(accountId) || new Map<string, number>()
    for (const [modelId, expiresAt] of existing.entries()) {
        if (!expiresAt || expiresAt <= now) existing.delete(modelId)
    }
    if (existing.size === 0) {
        grokUnsupportedModels.delete(accountId)
        return new Map<string, number>()
    }
    grokUnsupportedModels.set(accountId, existing)
    return existing
}

function markGrokModelUnsupported(accountId: string, modelId: string): void {
    const normalized = normalizeModelId(modelId)
    if (!normalized) return
    const existing = cleanupUnsupportedCache(accountId)
    existing.set(normalized, Date.now() + GROK_UNSUPPORTED_MODEL_TTL_MS)
    grokUnsupportedModels.set(accountId, existing)
}

function markGrokModelSupported(accountId: string, modelId: string): void {
    const normalized = normalizeModelId(modelId)
    if (!normalized) return
    const existing = cleanupUnsupportedCache(accountId)
    if (existing.has(normalized)) {
        existing.delete(normalized)
        if (existing.size > 0) grokUnsupportedModels.set(accountId, existing)
        else grokUnsupportedModels.delete(accountId)
    }
}

function getCachedGrokModels(accountId: string): GrokModelCacheEntry | null {
    const cached = grokModelCache.get(accountId)
    if (!cached) return null
    if (Date.now() - cached.fetchedAt > GROK_MODEL_CACHE_TTL_MS) {
        grokModelCache.delete(accountId)
        return null
    }
    return cached
}

function normalizeGrokModels(response: GrokModelsResponse): GrokModelSummary[] {
    const deduped = new Map<string, GrokModelSummary>()
    for (const model of response.data || []) {
        const id = typeof model?.id === "string" ? normalizeModelId(model.id) : ""
        if (!id || deduped.has(id)) continue
        const name = typeof model?.name === "string" ? model.name.trim() : ""
        deduped.set(id, { id, label: labelFor(id, name) })
    }
    return Array.from(deduped.values())
}

function getGrokHeaders(accessToken: string, accept: string): Record<string, string> {
    return {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`,
        "Accept": accept,
        "x-grok-client-version": GROK_CLIENT_VERSION,
        "x-grok-client-identifier": GROK_CLIENT_IDENTIFIER,
    }
}

export async function listGrokModelsForAccount(account: ProviderAccount): Promise<GrokModelSummary[]> {
    const cached = getCachedGrokModels(account.id)
    if (cached) return cached.models
    const inFlight = grokModelInFlight.get(account.id)
    if (inFlight) return inFlight

    const task = (async () => {
        const effectiveAccount = await refreshGrokAccountIfNeeded(account)
        const url = `${GROK_API_BASE}${MODELS_PATH}`
        const headers = getGrokHeaders(effectiveAccount.accessToken, "application/json")
        const response = await fetch(url, { method: "GET", headers })
        const text = await response.text()
        if (!response.ok) {
            throw new UpstreamError(GROK_PROVIDER, response.status, text, response.headers.get("retry-after") || undefined)
        }
        const parsed = (text ? JSON.parse(text) : {}) as GrokModelsResponse
        const models = normalizeGrokModels(parsed)
        const ids = new Set(models.map(m => m.id))
        grokModelCache.set(account.id, { fetchedAt: Date.now(), models, ids })
        return models
    })()

    grokModelInFlight.set(account.id, task)
    try {
        return await task
    } finally {
        grokModelInFlight.delete(account.id)
    }
}

export function isGrokModelSupportedForAccount(accountId: string, modelId: string): boolean | undefined {
    const normalized = normalizeModelId(modelId)
    if (!normalized) return undefined
    const unsupported = cleanupUnsupportedCache(accountId)
    if (unsupported.has(normalized)) return false
    const cached = getCachedGrokModels(accountId)
    if (!cached) return undefined
    return cached.ids.has(normalized)
}

export function isGrokUnsupportedModelError(error: UpstreamError): boolean {
    if (error.status !== 400 && error.status !== 404) return false
    const body = (error.body || "").toLowerCase()
    if (!body) return false
    return (
        body.includes("model is not supported") ||
        body.includes("you do not have access") ||
        body.includes("does not exist") ||
        body.includes("unsupported model") ||
        body.includes("not available") ||
        body.includes("unknown model")
    )
}

function getRetryDelay(attempt: number): number {
    const jitter = Math.floor(Math.random() * GROK_RETRY_JITTER_MS)
    return GROK_RETRY_BASE_MS * Math.pow(2, attempt) + jitter
}

function isRetryableStatus(status: number): boolean {
    return GROK_RETRY_STATUSES.has(status)
}

function isAuthStatus(error: UpstreamError): boolean {
    return error.status === 401 || error.status === 403
}

interface OpenAIResponse {
    choices: Array<{
        message?: { content?: string | null; tool_calls?: any[] }
        finish_reason?: string | null
    }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
}

// Responses API 输出 → OpenAI Chat 风格中间结构
function buildCompletionFromResponses(payload: any): OpenAIResponse {
    const output = Array.isArray(payload?.output) ? payload.output : []
    const textParts: string[] = []
    const toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = []

    for (const item of output) {
        if (item?.type === "message" && Array.isArray(item.content)) {
            for (const content of item.content) {
                if ((content?.type === "output_text" || content?.type === "text") && typeof content.text === "string") {
                    textParts.push(content.text)
                }
                if (content?.type === "tool_call") {
                    toolCalls.push({
                        id: content.id || `tool_${crypto.randomUUID().slice(0, 8)}`,
                        type: "function",
                        function: {
                            name: content.name || "tool",
                            arguments: typeof content.arguments === "string" ? content.arguments : JSON.stringify(content.arguments || {}),
                        },
                    })
                }
            }
        } else if (item?.type === "function_call") {
            toolCalls.push({
                id: item.call_id || item.id || `tool_${crypto.randomUUID().slice(0, 8)}`,
                type: "function",
                function: {
                    name: item.name || "tool",
                    arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}),
                },
            })
        } else if (item?.type === "tool_call") {
            toolCalls.push({
                id: item.id || `tool_${crypto.randomUUID().slice(0, 8)}`,
                type: "function",
                function: {
                    name: item.name || "tool",
                    arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}),
                },
            })
        } else if (item?.type === "output_text" && typeof item.text === "string") {
            textParts.push(item.text)
        }
    }

    if (textParts.length === 0 && typeof payload?.output_text === "string") {
        textParts.push(payload.output_text)
    }

    return {
        choices: [
            {
                message: {
                    content: textParts.join(""),
                    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
                },
                finish_reason: payload?.status === "completed" ? "stop" : (payload?.stop_reason || null),
            },
        ],
        usage: {
            prompt_tokens: payload?.usage?.input_tokens || 0,
            completion_tokens: payload?.usage?.output_tokens || 0,
        },
    }
}

// Claude/OpenAI 消息 → Responses API input 格式
function toGrokResponsesInput(messages: ReturnType<typeof toOpenAIMessages>): any[] {
    const input: any[] = []
    for (const msg of messages) {
        if (msg.role === "user") {
            input.push({ type: "message", role: "user", content: toOpenAIResponsesContent(msg.content, "user") })
        } else if (msg.role === "assistant") {
            input.push({ type: "message", role: "assistant", content: toOpenAIResponsesContent(msg.content, "assistant") })
            if (msg.tool_calls && msg.tool_calls.length > 0) {
                for (const tc of msg.tool_calls) {
                    input.push({ type: "function_call", call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments })
                }
            }
        } else if (msg.role === "tool") {
            input.push({ type: "function_call_output", call_id: msg.tool_call_id, output: msg.content || "" })
        }
    }
    return input
}

async function requestResponsesCompletion(
    account: ProviderAccount,
    model: string,
    messages: ClaudeMessage[],
    tools?: ClaudeTool[],
    signal?: AbortSignal
): Promise<{
    contentBlocks: Array<{ type: "tool_use"; id: string; name: string; input: any } | { type: "text"; text: string } | { type: "thinking"; thinking: string }>
    stopReason: string
    usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number }
}> {
    throwIfAborted(signal)
    const { instructions: extractedInstructions, input } = claudeMessagesToResponsesInput(messages)
    const instructions = extractedInstructions || "You are a helpful assistant. Please respond to the user's query."
    const responsesTools = claudeToolsToResponsesTools(tools)

    const requestBody: Record<string, unknown> = {
        model,
        input,
        instructions,
        stream: false,
        store: false,
        parallel_tool_calls: true,
    }
    if (responsesTools && responsesTools.length > 0) {
        requestBody.tools = responsesTools
    }

    const url = `${GROK_API_BASE}${RESPONSES_PATH}`
    const headers = getGrokHeaders(account.accessToken, "application/json")

    let lastError: unknown
    for (let attempt = 0; attempt <= GROK_MAX_RETRIES; attempt++) {
        throwIfAborted(signal)
        try {
            const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(requestBody), signal })
            const text = await response.text()
            throwIfAborted(signal)
            if (!response.ok) {
                lastError = new UpstreamError(GROK_PROVIDER, response.status, text, response.headers.get("retry-after") || undefined)
                if (isRetryableStatus(response.status) && attempt < GROK_MAX_RETRIES) {
                    await sleepWithAbort(getRetryDelay(attempt), signal)
                    continue
                }
                consola.error(`Grok error ${response.status}`)
                throw lastError
            }
            const data = text ? JSON.parse(text) : {}
            const completion = responsesObjectToCompletion(data)
            return {
                contentBlocks: completion.contentBlocks as any[],
                stopReason: completion.stopReason || "end_turn",
                usage: {
                    inputTokens: completion.usage?.inputTokens ?? 0,
                    outputTokens: completion.usage?.outputTokens ?? 0,
                    cacheReadTokens: completion.usage?.cacheReadTokens ?? 0,
                },
            }
        } catch (error) {
            lastError = error
            if (signal?.aborted || isAbortError(error)) {
                throw createAbortError()
            }
            if (error instanceof UpstreamError) throw error
            if (attempt < GROK_MAX_RETRIES) {
                await sleepWithAbort(getRetryDelay(attempt), signal)
                continue
            }
            throw error
        }
    }
    throw lastError || new UpstreamError(GROK_PROVIDER, 500, "Grok request failed")
}

export async function createGrokCompletion(
    account: ProviderAccount,
    model: string,
    messages: ClaudeMessage[],
    tools?: ClaudeTool[],
    _maxTokens?: number,
    _reasoningEffort?: "low" | "medium" | "high",
    signal?: AbortSignal
) {
    throwIfAborted(signal)
    const effectiveAccount = await refreshGrokAccountIfNeeded(account)
    throwIfAborted(signal)

    type GrokCompletion = Awaited<ReturnType<typeof requestResponsesCompletion>>
    let completion: GrokCompletion | undefined
    let refreshedOnce = false
    let lastError: unknown

    const attempt = async (): Promise<GrokCompletion> => {
        try {
            const result = await requestResponsesCompletion(effectiveAccount, model, messages, tools, signal)
            markGrokModelSupported(effectiveAccount.id, model)
            return result
        } catch (error) {
            if (error instanceof UpstreamError && isGrokUnsupportedModelError(error)) {
                markGrokModelUnsupported(effectiveAccount.id, model)
            }
            throw error
        }
    }

    try {
        completion = await attempt()
    } catch (error) {
        lastError = error
        if (signal?.aborted || isAbortError(error)) {
            throw createAbortError()
        }
        if (error instanceof UpstreamError && isAuthStatus(error) && !refreshedOnce) {
            refreshedOnce = true
            // Re-reading another CLI credential store is opt-in.
            if (process.env.ANTI_API_IMPORT_GROK_ON_AUTH_FAILURE === "1") {
                // 先从 ~/.grok/auth.json 重新导入（Grok CLI 已续期）
                try {
                    const imported = await importGrokAuthSources()
                    const updated = imported.accounts.find(acc => acc.id === effectiveAccount.id || (acc.email && acc.email === effectiveAccount.email))
                    if (updated?.accessToken && updated.accessToken !== effectiveAccount.accessToken) {
                        effectiveAccount.accessToken = updated.accessToken
                        if (updated.refreshToken) effectiveAccount.refreshToken = updated.refreshToken
                        if (updated.expiresAt) effectiveAccount.expiresAt = updated.expiresAt
                        completion = await attempt()
                        lastError = null
                    }
                } catch {
                    // ignore import failures
                    throwIfAborted(signal)
                }
            }
            // 仍失败则用 refresh_token 兜底
            if (!completion && effectiveAccount.refreshToken) {
                try {
                    const refreshed = await refreshGrokAccessToken(effectiveAccount.refreshToken, getGrokClientId(effectiveAccount))
                    effectiveAccount.accessToken = refreshed.accessToken
                    if (refreshed.refreshToken) effectiveAccount.refreshToken = refreshed.refreshToken
                    if (refreshed.expiresIn) effectiveAccount.expiresAt = Date.now() + refreshed.expiresIn * 1000
                    authStore.saveAccount(effectiveAccount)
                    completion = await attempt()
                    lastError = null
                } catch (retryError) {
                    if (signal?.aborted || isAbortError(retryError)) {
                        throw createAbortError()
                    }
                    lastError = retryError
                }
            }
        }
        if (!completion && lastError) {
            throw lastError
        }
    }

    if (!completion) {
        throw new UpstreamError(GROK_PROVIDER, 500, "Empty completion")
    }

    authStore.markSuccess(GROK_PROVIDER, effectiveAccount.id)

    return {
        contentBlocks: completion.contentBlocks,
        stopReason: completion.stopReason,
        usage: completion.usage,
        resolvedModel: model,
    }
}

// ---------------------------------------------------------------------------
// Native Responses pass-through
// ---------------------------------------------------------------------------

const GROK_DEFAULT_INSTRUCTIONS = "You are a helpful assistant. Please respond to the user's query."

function buildGrokResponsesBody(model: string, payload: Record<string, any>): Record<string, any> {
    const body: Record<string, any> = { ...payload }
    body.model = model
    body.input = normalizeResponsesInput(payload.input)
    if (!(typeof body.instructions === "string" && body.instructions.trim())) {
        body.instructions = GROK_DEFAULT_INSTRUCTIONS
    }
    // The upstream is called non-streaming; streaming callers get a clean SSE replay of the result.
    body.stream = false
    body.store = false
    return body
}

async function requestGrokResponsesJson(
    account: ProviderAccount,
    requestBody: Record<string, any>,
    signal?: AbortSignal
): Promise<{ status: number; data: any }> {
    throwIfAborted(signal)
    const url = `${GROK_API_BASE}${RESPONSES_PATH}`
    const headers = getGrokHeaders(account.accessToken, "application/json")
    const bodyText = JSON.stringify(requestBody)

    let lastError: unknown
    for (let attempt = 0; attempt <= GROK_MAX_RETRIES; attempt++) {
        throwIfAborted(signal)
        try {
            const response = await fetch(url, { method: "POST", headers, body: bodyText, signal })
            const text = await readResponseText(response)
            throwIfAborted(signal)
            if (!response.ok) {
                lastError = new UpstreamError(GROK_PROVIDER, response.status, text, response.headers.get("retry-after") || undefined)
                if (isRetryableStatus(response.status) && attempt < GROK_MAX_RETRIES) {
                    await sleepWithAbort(getRetryDelay(attempt), signal)
                    continue
                }
                consola.error(`Grok error ${response.status}`)
                throw lastError
            }
            let data: any
            try {
                data = text ? JSON.parse(text) : {}
            } catch {
                throw new UpstreamError(GROK_PROVIDER, 502, "Grok returned a non-JSON response")
            }
            return { status: response.status, data }
        } catch (error) {
            lastError = error
            if (signal?.aborted || isAbortError(error)) throw createAbortError()
            if (error instanceof UpstreamError) throw error
            if (attempt < GROK_MAX_RETRIES) {
                await sleepWithAbort(getRetryDelay(attempt), signal)
                continue
            }
            throw error
        }
    }
    throw lastError || new UpstreamError(GROK_PROVIDER, 500, "Grok request failed")
}

/**
 * Native OpenAI Responses pass-through to Grok (xAI CLI proxy).
 * The upstream is always called non-streaming; with `payload.stream` the finished response is replayed
 * as a well-formed Responses SSE event sequence.
 */
export async function createGrokResponsesDirect(
    account: ProviderAccount,
    model: string,
    payload: Record<string, any>,
    signal?: AbortSignal,
    options?: DirectOptions
): Promise<DirectResult> {
    throwIfAborted(signal)
    const effectiveAccount = await refreshGrokAccountIfNeeded(account)
    throwIfAborted(signal)

    const requestBody = buildGrokResponsesBody(model, payload)

    const attempt = async () => {
        try {
            const result = await requestGrokResponsesJson(effectiveAccount, requestBody, signal)
            markGrokModelSupported(effectiveAccount.id, model)
            return result
        } catch (error) {
            if (error instanceof UpstreamError && isGrokUnsupportedModelError(error)) {
                markGrokModelUnsupported(effectiveAccount.id, model)
            }
            throw error
        }
    }

    let result: { status: number; data: any }
    try {
        result = await attempt()
    } catch (error) {
        if (signal?.aborted || isAbortError(error)) throw createAbortError()
        if (!(error instanceof UpstreamError && isAuthStatus(error))) throw error

        let recovered: { status: number; data: any } | undefined
        let lastError: unknown = error
        // Re-reading another CLI credential store is opt-in.
        if (process.env.ANTI_API_IMPORT_GROK_ON_AUTH_FAILURE === "1") {
            try {
                const imported = await importGrokAuthSources()
                const updated = imported.accounts.find(acc => acc.id === effectiveAccount.id || (acc.email && acc.email === effectiveAccount.email))
                if (updated?.accessToken && updated.accessToken !== effectiveAccount.accessToken) {
                    effectiveAccount.accessToken = updated.accessToken
                    if (updated.refreshToken) effectiveAccount.refreshToken = updated.refreshToken
                    if (updated.expiresAt) effectiveAccount.expiresAt = updated.expiresAt
                    recovered = await attempt()
                }
            } catch (importError) {
                throwIfAborted(signal)
                lastError = importError
            }
        }
        if (!recovered && effectiveAccount.refreshToken) {
            try {
                const refreshed = await refreshGrokAccessToken(effectiveAccount.refreshToken, getGrokClientId(effectiveAccount))
                effectiveAccount.accessToken = refreshed.accessToken
                if (refreshed.refreshToken) effectiveAccount.refreshToken = refreshed.refreshToken
                if (refreshed.expiresIn) effectiveAccount.expiresAt = Date.now() + refreshed.expiresIn * 1000
                authStore.saveAccount(effectiveAccount)
                recovered = await attempt()
            } catch (retryError) {
                if (signal?.aborted || isAbortError(retryError)) throw createAbortError()
                lastError = retryError
            }
        }
        if (!recovered) throw lastError
        result = recovered
    }

    authStore.markSuccess(GROK_PROVIDER, effectiveAccount.id)
    const usage = extractResponsesUsage(result.data)
    reportUsage(usage, options?.onUsage)

    if (payload.stream === true) {
        return {
            kind: "sse",
            status: result.status,
            resolvedModel: model,
            stream: yieldAll(responseObjectToSseEvents(result.data)),
        }
    }
    return { kind: "json", status: result.status, data: result.data, resolvedModel: model, usage }
}

/**
 * 1-hop OpenAI Chat Completions adapter over Grok's `/responses` endpoint.
 */
export async function createGrokChatDirect(
    account: ProviderAccount,
    model: string,
    payload: Record<string, any>,
    signal?: AbortSignal,
    options?: DirectOptions
): Promise<DirectResult> {
    const respPayload = chatPayloadToResponses(payload, model)
    const direct = await createGrokResponsesDirect(account, model, respPayload, signal, options)
    if (direct.kind === "sse") {
        return {
            kind: "sse",
            status: direct.status,
            resolvedModel: direct.resolvedModel,
            stream: responsesSseToOpenAIChatSse(direct.stream, payload.model || model, {
                includeUsage: payload.stream_options?.include_usage === true,
                provider: "grok",
            }),
        }
    }
    return {
        kind: "json",
        status: direct.status,
        resolvedModel: direct.resolvedModel,
        data: responseObjectToChatCompletion(direct.data, payload.model || model),
        usage: direct.usage,
    }
}

function safeParse(value: string | undefined): any {
    if (!value) return {}
    try {
        return JSON.parse(value)
    } catch (error) {
        consola.warn("Grok tool args parse failed:", safeErrorMessage(error))
        return {}
    }
}

function mapFinishReason(reason?: string | null): string {
    if (!reason || reason === "stop") return "end_turn"
    if (reason === "length") return "max_tokens"
    if (reason === "tool_calls") return "tool_use"
    return reason
}
