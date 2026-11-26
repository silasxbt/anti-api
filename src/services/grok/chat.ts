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
): Promise<OpenAIResponse> {
    throwIfAborted(signal)
    const systemMessage = messages.find(m => (m.role as string) === "system")
    const instructions = systemMessage && typeof systemMessage.content === "string"
        ? systemMessage.content
        : "You are a helpful assistant. Please respond to the user's query."

    const openAITools = toOpenAITools(tools)
    const responsesTools = openAITools?.map(t => ({
        type: "function" as const,
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
    }))

    const requestBody: Record<string, unknown> = {
        model,
        input: toGrokResponsesInput(toOpenAIMessages(messages)),
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
            return buildCompletionFromResponses(data)
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

    let completion: OpenAIResponse | undefined
    let refreshedOnce = false
    let lastError: unknown

    const attempt = async (): Promise<OpenAIResponse> => {
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

    const choice = completion.choices?.[0]
    const content = choice?.message?.content || ""
    const toolCalls = choice?.message?.tool_calls || []

    const contentBlocks: Array<
        { type: "tool_use"; id: string; name: string; input: any } | { type: "text"; text: string }
    > = []
    if (toolCalls.length > 0) {
        for (const call of toolCalls) {
            contentBlocks.push({
                type: "tool_use",
                id: call.id || `tool_${crypto.randomUUID().slice(0, 8)}`,
                name: call.function?.name || "tool",
                input: safeParse(call.function?.arguments),
            })
        }
    }
    if (content) {
        contentBlocks.push({ type: "text", text: content })
    }

    authStore.markSuccess(GROK_PROVIDER, effectiveAccount.id)

    return {
        contentBlocks,
        stopReason: toolCalls.length > 0 ? "tool_use" : mapFinishReason(choice?.finish_reason),
        usage: {
            inputTokens: completion.usage?.prompt_tokens || 0,
            outputTokens: completion.usage?.completion_tokens || 0,
        },
        resolvedModel: model,
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
