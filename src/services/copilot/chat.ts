import consola from "consola"
import https from "https"
import { authStore } from "~/services/auth/store"
import { UpstreamError } from "~/lib/error"
import type { ProviderAccount } from "~/services/auth/types"
import type { ClaudeMessage, ClaudeTool } from "~/lib/translator"
import { toOpenAIMessages, toOpenAITools } from "~/services/providers/openai-adapter"
import { createAbortError, isAbortError, throwIfAborted } from "~/lib/stream-cancellation"
import { safeErrorMessage } from "~/lib/redaction"
import {
    chatCompletionToResponsesObject,
    chatPayloadToResponses,
    chatSseToEvents,
    claudeMessagesToResponsesInput,
    claudeToolsToResponsesTools,
    extractChatUsage,
    extractResponsesPromptText,
    extractResponsesUsage,
    readTextStream,
    reportUsage,
    responseObjectToChatCompletion,
    responsesObjectToCompletion,
    responsesPayloadToChat,
    responsesSseToEvents,
    responsesSseToOpenAIChatSse,
    sseEventBlocks,
    tapSseUsage,
    yieldAll,
    type DirectOptions,
    type DirectResult,
} from "~/lib/direct-stream"
import type { RoutedStreamEvent } from "~/lib/stream-events"
import { eventsToResponsesSse, generateResponseId } from "~/routes/responses/translator"
import type { ResponsesCreateRequest } from "~/routes/responses/types"

const COPILOT_INSECURE_TLS = process.env.ANTI_API_COPILOT_INSECURE_TLS === "1"
const COPILOT_INSECURE_AGENT = COPILOT_INSECURE_TLS ? new https.Agent({ rejectUnauthorized: false }) : undefined

export function isCopilotInsecureTlsEnabled(): boolean {
    return COPILOT_INSECURE_TLS
}

export const COPILOT_AUTO_MODEL_ID = "copilot-auto"
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token"
const DEFAULT_CAPI_BASE_URL = "https://api.individual.githubcopilot.com"

interface CopilotTokenResponse {
    token: string
    expires_at?: number
    endpoints?: {
        api?: string
    }
}

/** Copilot advertises low/medium/high and, per model, none/xhigh/max. */
export type CopilotReasoningEffort = string

export interface CopilotModelLimits {
    max_context_window_tokens?: number
    max_prompt_tokens?: number
    max_output_tokens?: number
    max_non_streaming_output_tokens?: number
}

export interface CopilotModelInfo {
    id: string
    name?: string
    model_picker_enabled?: boolean
    vendor?: string
    policy?: { state?: string }
    supported_endpoints?: string[]
    capabilities?: {
        type?: string
        limits?: CopilotModelLimits
        supports?: {
            reasoning_effort?: string[] | boolean
            tool_calls?: boolean
            streaming?: boolean
            vision?: boolean
        }
    }
}

interface CachedCopilotToken {
    token: string
    expiresAt: number
    capiBaseUrl: string
}

const tokenCache = new Map<string, CachedCopilotToken>()
const modelsCache = new Map<string, { models: CopilotModelInfo[]; expiresAt: number }>()

function isInternalCopilotModel(id: string): boolean {
    const lower = id.toLowerCase()
    return lower.startsWith("text-embedding") ||
        lower.startsWith("copilot-search") ||
        lower.startsWith("exec-agent") ||
        lower.endsWith("-nano") ||
        lower.startsWith("mai-code") ||
        lower.includes("trajectory")
}

function getPositiveLimit(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : undefined
}

function sanitizeCopilotLimits(limits?: CopilotModelLimits): CopilotModelLimits | undefined {
    if (!limits) return undefined
    const maxContextWindow = getPositiveLimit(limits.max_context_window_tokens)
    const maxPrompt = getPositiveLimit(limits.max_prompt_tokens)
    const maxOutput = getPositiveLimit(limits.max_output_tokens)
    const maxNonStreamingOutput = getPositiveLimit(limits.max_non_streaming_output_tokens)
    if (!maxContextWindow && !maxPrompt && !maxOutput && !maxNonStreamingOutput) {
        return undefined
    }
    return {
        ...(maxContextWindow ? { max_context_window_tokens: maxContextWindow } : {}),
        ...(maxPrompt ? { max_prompt_tokens: maxPrompt } : {}),
        ...(maxOutput ? { max_output_tokens: maxOutput } : {}),
        ...(maxNonStreamingOutput ? { max_non_streaming_output_tokens: maxNonStreamingOutput } : {}),
    }
}

const COPILOT_AUTO_PREFERRED_BACKING_ID = "gpt-5.6-luna"

function resolveCopilotAutoLimits(models: CopilotModelInfo[]): CopilotModelLimits | undefined {
    const candidates = models
        .map(model => ({ model, limits: sanitizeCopilotLimits(model.capabilities?.limits) }))
        .filter((entry): entry is { model: CopilotModelInfo; limits: CopilotModelLimits } => {
            const id = entry.model?.id?.trim()
            if (!id || id === COPILOT_AUTO_MODEL_ID || id === "auto") return false
            if (entry.model.capabilities?.type && entry.model.capabilities.type !== "chat") return false
            if (isInternalCopilotModel(id)) return false
            if (entry.model.policy?.state === "disabled") return false
            return Boolean(entry.limits?.max_context_window_tokens || entry.limits?.max_prompt_tokens)
        })

    if (candidates.length === 0) return undefined

    const score = (m: CopilotModelInfo): number => {
        const isEnabled = m.policy?.state === "enabled" || m.model_picker_enabled === true
        const isGpt = m.id.toLowerCase().startsWith("gpt-")
        const usesResponses = m.supported_endpoints?.includes("/responses") ?? false
        if (m.id === COPILOT_AUTO_PREFERRED_BACKING_ID) return 4
        if (isEnabled && isGpt && usesResponses) return 3
        if (isEnabled && isGpt) return 2
        if (isEnabled) return 1
        return 0
    }

    candidates.sort((a, b) => {
        const tierDiff = score(b.model) - score(a.model)
        if (tierDiff !== 0) return tierDiff
        const ctxA = a.limits.max_context_window_tokens ?? a.limits.max_prompt_tokens ?? 0
        const ctxB = b.limits.max_context_window_tokens ?? b.limits.max_prompt_tokens ?? 0
        return ctxB - ctxA
    })

    return candidates[0].limits
}

/**
 * Normalizes live models discovered from GitHub Copilot.
 * - Always includes copilot-auto (with low/medium/high reasoning effort variants).
 * - For user accounts, only models with model_picker_enabled: true (Pro/Enterprise) are exposed individually.
 * - Free / Edu accounts have model_picker_enabled: false on all models, leaving copilot-auto as their only option (matching VS Code).
 */
export function normalizeCopilotModels(models: CopilotModelInfo[]): CopilotModelInfo[] {
    const deduped = new Map<string, CopilotModelInfo>()
    const autoLimits = resolveCopilotAutoLimits(models)

    // Always include the Auto model
    deduped.set(COPILOT_AUTO_MODEL_ID, {
        id: COPILOT_AUTO_MODEL_ID,
        name: "Auto",
        model_picker_enabled: true,
        capabilities: {
            type: "chat",
            ...(autoLimits ? { limits: autoLimits } : {}),
            supports: {
                reasoning_effort: ["low", "medium", "high"],
                tool_calls: true,
                streaming: true,
                vision: true,
            },
        },
    })

    for (const model of models) {
        const id = model?.id?.trim()
        if (!id) continue
        if (id === COPILOT_AUTO_MODEL_ID || id === "auto") continue

        // Non-chat models (e.g. embeddings) are excluded
        if (model.capabilities?.type && model.capabilities.type !== "chat") continue

        // Internal subagents / utilities
        if (isInternalCopilotModel(id)) continue

        // Only include user-selectable models enabled for this account's plan:
        // Pro / Enterprise users have model_picker_enabled: true and policy !== "disabled".
        if (model.model_picker_enabled !== true) continue
        if (model.policy?.state === "disabled") continue

        if (deduped.has(id)) continue
        deduped.set(id, {
            ...model,
            id,
        })
    }

    return Array.from(deduped.values())
}

/** Reasoning efforts advertised by Copilot for a model (empty when it has no effort control). */
export function getCopilotReasoningEfforts(model: CopilotModelInfo): CopilotReasoningEffort[] {
    const raw = model.capabilities?.supports?.reasoning_effort
    if (!Array.isArray(raw)) return []
    return raw.filter((e): e is string => typeof e === "string" && e !== "none")
}

const EFFORT_SUFFIX = /-(low|medium|high)$/

function modelKey(id: string): string {
    return id.trim().toLowerCase().replace(/[._]/g, "-")
}

/**
 * Resolves a requested id (e.g. `copilot-auto`, `copilot-auto-high`, `claude-sonnet-4-5`) to a model the account really has,
 * plus the reasoning effort and Auto tier encoded in the id.
 */
export function resolveCopilotModel(
    available: CopilotModelInfo[],
    requested: string
): { id: string; effort?: CopilotReasoningEffort; isAuto?: boolean; tier?: "efficiency" | "balance" | "intelligence" } {
    const lower = requested.trim().toLowerCase()

    // Auto matching:
    // "copilot-auto", "auto", "copilot-auto-low", "auto-low", etc.
    if (lower === "copilot-auto" || lower === "auto") {
        return { id: COPILOT_AUTO_MODEL_ID, isAuto: true }
    }
    if (lower === "copilot-auto-low" || lower === "auto-low") {
        return { id: COPILOT_AUTO_MODEL_ID, effort: "low", isAuto: true, tier: "efficiency" }
    }
    if (lower === "copilot-auto-medium" || lower === "auto-medium") {
        return { id: COPILOT_AUTO_MODEL_ID, effort: "medium", isAuto: true, tier: "balance" }
    }
    if (lower === "copilot-auto-high" || lower === "auto-high" || lower === "copilot-auto-thinking" || lower === "auto-thinking") {
        return { id: COPILOT_AUTO_MODEL_ID, effort: "high", isAuto: true, tier: "intelligence" }
    }

    const lookup = (id: string) => {
        const exact = available.find(m => m.id === id)
        if (exact) return exact
        const key = modelKey(id)
        return available.find(m => modelKey(m.id) === key)
    }

    const direct = lookup(requested)
    if (direct) return { id: direct.id }

    const effortMatch = requested.match(EFFORT_SUFFIX)
    if (effortMatch) {
        const base = lookup(requested.replace(EFFORT_SUFFIX, ""))
        if (base) return { id: base.id, effort: effortMatch[1] }
    }

    // "-thinking" variants have no separate Copilot id: use the base model
    if (requested.endsWith("-thinking")) {
        const base = lookup(requested.slice(0, -"-thinking".length))
        if (base) return { id: base.id, effort: "high" }
    }

    return { id: requested }
}

interface OpenAIResponse {
    choices: Array<{
        message?: { content?: string | null; tool_calls?: any[] }
        finish_reason?: string | null
    }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
}

function getCopilotChatHeaders(apiToken: string, sessionToken?: string): Record<string, string> {
    return {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiToken}`,
        "X-GitHub-Api-Version": "2026-08-01",
        "Editor-Plugin-Version": "copilot-chat/0.71.0",
        "Editor-Version": "vscode/1.143.1",
        "Copilot-Integration-Id": "vscode-chat",
        "User-Agent": "anti-api/1.0",
        ...(sessionToken ? { "Copilot-Session-Token": sessionToken } : {}),
    }
}

function toResponsesInput(messages: ReturnType<typeof toOpenAIMessages>): any[] {
    const input: any[] = []

    for (const msg of messages) {
        if (msg.role === "system") {
            const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)
            input.push({
                type: "message",
                role: "system",
                content: [{ type: "input_text", text }],
            })
            continue
        }

        if (msg.role === "user") {
            const contentParts: any[] = []
            if (typeof msg.content === "string") {
                contentParts.push({ type: "input_text", text: msg.content })
            } else if (Array.isArray(msg.content)) {
                for (const part of msg.content) {
                    if (part.type === "text") {
                        contentParts.push({ type: "input_text", text: part.text || "" })
                    } else if (part.type === "image_url") {
                        contentParts.push({ type: "input_image", image_url: part.image_url?.url || "" })
                    }
                }
            }
            input.push({
                type: "message",
                role: "user",
                content: contentParts.length > 0 ? contentParts : [{ type: "input_text", text: "" }],
            })
            continue
        }

        if (msg.role === "assistant") {
            const textParts: any[] = []
            if (typeof msg.content === "string" && msg.content) {
                textParts.push({ type: "output_text", text: msg.content })
            } else if (Array.isArray(msg.content)) {
                for (const part of msg.content) {
                    if (part.type === "text" && part.text) {
                        textParts.push({ type: "output_text", text: part.text })
                    }
                }
            }
            input.push({
                type: "message",
                role: "assistant",
                content: textParts,
            })
            for (const toolCall of msg.tool_calls || []) {
                input.push({
                    type: "function_call",
                    call_id: toolCall.id,
                    name: toolCall.function?.name || "tool",
                    arguments: typeof toolCall.function?.arguments === "string"
                        ? toolCall.function.arguments
                        : JSON.stringify(toolCall.function?.arguments || {}),
                })
            }
            continue
        }

        if (msg.role === "tool") {
            input.push({
                type: "function_call_output",
                call_id: msg.tool_call_id,
                output: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || ""),
            })
        }
    }

    return input
}

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
            }
        } else if (item?.type === "function_call") {
            toolCalls.push({
                id: item.call_id || item.id || `tool_${crypto.randomUUID().slice(0, 8)}`,
                type: "function",
                function: {
                    name: item.name || "tool",
                    arguments: typeof item.arguments === "string"
                        ? item.arguments
                        : JSON.stringify(item.arguments || {}),
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

function toProviderCompletion(data: OpenAIResponse, accountId: string) {
    authStore.markSuccess("copilot", accountId)
    const choice = data?.choices?.[0]
    const content = choice?.message?.content || ""
    const toolCalls = choice?.message?.tool_calls || []

    const contentBlocks = []
    if (toolCalls.length > 0) {
        for (const call of toolCalls) {
            contentBlocks.push({
                type: "tool_use" as const,
                id: call.id || `tool_${crypto.randomUUID().slice(0, 8)}`,
                name: call.function?.name || "tool",
                input: safeParse(call.function?.arguments),
            })
        }
    }
    if (content) {
        contentBlocks.push({ type: "text" as const, text: content })
    }

    return {
        contentBlocks,
        stopReason: toolCalls.length > 0 ? "tool_use" : mapFinishReason(choice?.finish_reason),
        usage: {
            inputTokens: data.usage?.prompt_tokens || 0,
            outputTokens: data.usage?.completion_tokens || 0,
        },
    }
}

function extractClaudePromptText(messages: ClaudeMessage[]): string {
    const lastUser = [...messages].reverse().find(m => m.role === "user")
    let promptText = ""
    if (typeof lastUser?.content === "string") {
        promptText = lastUser.content
    } else if (Array.isArray(lastUser?.content)) {
        promptText = lastUser.content.filter(p => p.type === "text").map(p => (p as any).text).join(" ")
    }
    return promptText.trim() || "Hello"
}

function buildCopilotResponsesBodyFromClaude(
    model: string,
    messages: ClaudeMessage[],
    tools?: ClaudeTool[],
    maxTokens?: number,
    effort?: string
): Record<string, any> {
    const { instructions, input } = claudeMessagesToResponsesInput(messages)
    const responsesTools = claudeToolsToResponsesTools(tools)
    return {
        model,
        input,
        ...(instructions ? { instructions } : {}),
        ...(responsesTools && responsesTools.length > 0 ? { tools: responsesTools } : {}),
        ...(maxTokens ? { max_output_tokens: maxTokens } : {}),
        ...(effort ? { reasoning: { effort, summary: "auto" } } : {}),
    }
}

export async function createCopilotCompletion(
    account: ProviderAccount,
    model: string,
    messages: ClaudeMessage[],
    tools?: ClaudeTool[],
    maxTokens?: number,
    reasoningEffort?: CopilotReasoningEffort,
    signal?: AbortSignal
) {
    throwIfAborted(signal)
    const { token: apiToken, capiBaseUrl } = await getCopilotApiTokenInfo(account, signal)
    const available = await fetchCopilotModels(apiToken, capiBaseUrl, signal)
    throwIfAborted(signal)

    const resolved = resolveCopilotModel(available, model)

    let targetModel = resolved.id
    let sessionToken: string | undefined
    let useResponses = false
    let autoEffort: string | undefined

    if (resolved.isAuto) {
        const { tier, effort } = resolveAutoTier(resolved, reasoningEffort)
        autoEffort = effort
        const negotiated = await negotiateCopilotAuto(
            capiBaseUrl,
            apiToken,
            extractClaudePromptText(messages),
            tier,
            signal
        )
        if (negotiated) {
            targetModel = negotiated.modelId
            sessionToken = negotiated.sessionToken
            useResponses = negotiated.supportsResponses
        } else {
            targetModel = "gpt-4o"
            useResponses = false
        }
    } else {
        const info = available.find(m => m.id === resolved.id)
        const endpoints = info?.supported_endpoints
        useResponses = Array.isArray(endpoints) && endpoints.includes("/responses") && !endpoints.includes("/chat/completions")
    }

    if (useResponses) {
        const info = available.find(m => m.id === targetModel)
        const supported = info ? getCopilotReasoningEfforts(info) : []
        const rawEffort = autoEffort ?? resolved.effort ?? reasoningEffort
        const effectiveEffort = autoEffort || (rawEffort && supported.includes(rawEffort) ? rawEffort : undefined)
        const requestBody = buildCopilotResponsesBodyFromClaude(targetModel, messages, tools, maxTokens, effectiveEffort)
        const response = await postCopilotJson(
            `${capiBaseUrl}/responses`,
            { ...getCopilotChatHeaders(apiToken, sessionToken), "Openai-Intent": "conversation-panel" },
            requestBody,
            signal
        )
        authStore.markSuccess("copilot", account.id)
        const completion = responsesObjectToCompletion(response.data)
        return {
            contentBlocks: completion.contentBlocks as any[],
            stopReason: completion.stopReason || "end_turn",
            usage: {
                inputTokens: completion.usage?.inputTokens ?? 0,
                outputTokens: completion.usage?.outputTokens ?? 0,
                cacheReadTokens: completion.usage?.cacheReadTokens ?? 0,
            },
        }
    }

    const info = available.find(m => m.id === targetModel)
    const supported = info ? getCopilotReasoningEfforts(info) : []
    const effort = resolved.effort ?? reasoningEffort
    const effectiveEffort = effort && supported.includes(effort) ? effort : undefined

    const requestBody = {
        model: targetModel,
        messages: toOpenAIMessages(messages),
        tools: toOpenAITools(tools),
        max_tokens: maxTokens,
        ...(effectiveEffort ? { reasoning_effort: effectiveEffort } : {}),
    }

    const response = await postCopilotJson(
        `${capiBaseUrl}/chat/completions`,
        getCopilotChatHeaders(apiToken, sessionToken),
        requestBody,
        signal
    )

    const data = response.data as OpenAIResponse
    return toProviderCompletion(data, account.id)
}

/**
 * Live 1-hop event stream for `/v1/messages` (and non-direct paths) on Copilot.
 */
export async function* createCopilotEventStream(
    account: ProviderAccount,
    model: string,
    messages: ClaudeMessage[],
    tools?: ClaudeTool[],
    maxTokens?: number,
    reasoningEffort?: CopilotReasoningEffort,
    signal?: AbortSignal,
    options?: DirectOptions
): AsyncGenerator<RoutedStreamEvent, void, unknown> {
    throwIfAborted(signal)
    const { token: apiToken, capiBaseUrl } = await getCopilotApiTokenInfo(account, signal)
    const available = await fetchCopilotModels(apiToken, capiBaseUrl, signal)
    throwIfAborted(signal)

    const resolved = resolveCopilotModel(available, model)

    let targetModel = resolved.id
    let sessionToken: string | undefined
    let useResponses = false
    let autoEffort: string | undefined

    if (resolved.isAuto) {
        const { tier, effort } = resolveAutoTier(resolved, reasoningEffort)
        autoEffort = effort
        const negotiated = await negotiateCopilotAuto(
            capiBaseUrl,
            apiToken,
            extractClaudePromptText(messages),
            tier,
            signal
        )
        if (negotiated) {
            targetModel = negotiated.modelId
            sessionToken = negotiated.sessionToken
            useResponses = negotiated.supportsResponses
        } else {
            targetModel = "gpt-4o"
            useResponses = false
        }
    } else {
        const info = available.find(m => m.id === resolved.id)
        const endpoints = info?.supported_endpoints
        useResponses = Array.isArray(endpoints) && endpoints.includes("/responses") && !endpoints.includes("/chat/completions")
    }

    if (useResponses) {
        const info = available.find(m => m.id === targetModel)
        const supported = info ? getCopilotReasoningEfforts(info) : []
        const rawEffort = autoEffort ?? resolved.effort ?? reasoningEffort
        const effectiveEffort = autoEffort || (rawEffort && supported.includes(rawEffort) ? rawEffort : undefined)
        const requestBody = {
            ...buildCopilotResponsesBodyFromClaude(targetModel, messages, tools, maxTokens, effectiveEffort),
            stream: true,
        }
        const response = await postCopilotStream(
            `${capiBaseUrl}/responses`,
            { ...getCopilotChatHeaders(apiToken, sessionToken), "Openai-Intent": "conversation-panel" },
            requestBody,
            signal
        )
        authStore.markSuccess("copilot", account.id)
        const blocks = tapSseUsage(sseEventBlocks(response.stream), extractResponsesUsage, options?.onUsage)
        yield* responsesSseToEvents(blocks, model, "copilot")
        return
    }

    const info = available.find(m => m.id === targetModel)
    const supported = info ? getCopilotReasoningEfforts(info) : []
    const effort = resolved.effort ?? reasoningEffort
    const effectiveEffort = effort && supported.includes(effort) ? effort : undefined

    const requestBody = {
        model: targetModel,
        messages: toOpenAIMessages(messages),
        tools: toOpenAITools(tools),
        max_tokens: maxTokens,
        stream: true,
        stream_options: { include_usage: true },
        ...(effectiveEffort ? { reasoning_effort: effectiveEffort } : {}),
    }

    const response = await postCopilotStream(
        `${capiBaseUrl}/chat/completions`,
        getCopilotChatHeaders(apiToken, sessionToken),
        requestBody,
        signal
    )
    authStore.markSuccess("copilot", account.id)
    const blocks = tapSseUsage(sseEventBlocks(response.stream), extractChatUsage, options?.onUsage)
    yield* chatSseToEvents(blocks, model)
}

const COPILOT_MODEL_SYNC_TIMEOUT_MS = 8_000
const DEFAULT_INSECURE_FETCH_TIMEOUT_MS = 120_000
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

// ---------------------------------------------------------------------------
// Native "direct" pass-throughs (no Anthropic/OpenAI re-translation)
// ---------------------------------------------------------------------------

type AutoTier = "efficiency" | "balance" | "intelligence"

function resolveAutoTier(
    resolved: { effort?: CopilotReasoningEffort; tier?: AutoTier },
    requestedEffort?: unknown
): { tier: AutoTier; effort: CopilotReasoningEffort } {
    if (resolved.tier) {
        return {
            tier: resolved.tier,
            effort: resolved.effort || (resolved.tier === "efficiency" ? "low" : resolved.tier === "intelligence" ? "high" : "medium"),
        }
    }
    if (requestedEffort === "low") return { tier: "efficiency", effort: "low" }
    if (requestedEffort === "high" || requestedEffort === "xhigh" || requestedEffort === "max") {
        return { tier: "intelligence", effort: "high" }
    }
    return { tier: "balance", effort: "medium" }
}

function throwCopilotUpstream(status: number, body: string, headers?: Record<string, string | string[] | undefined>): never {
    const retryAfter = headers?.["retry-after"]
    throw new UpstreamError("copilot", status, body, Array.isArray(retryAfter) ? retryAfter[0] : retryAfter)
}

async function postCopilotJson(
    url: string,
    headers: Record<string, string>,
    body: unknown,
    signal?: AbortSignal
): Promise<{ status: number; data: any }> {
    const response = await fetchInsecureJson(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
    })
    if (response.status < 200 || response.status >= 300) {
        consola.error(`Copilot error ${response.status} for ${url.replace(/^https?:\/\/[^/]+/, "")}`)
        throwCopilotUpstream(response.status, response.text)
    }
    return { status: response.status, data: response.data }
}

async function postCopilotStream(
    url: string,
    headers: Record<string, string>,
    body: unknown,
    signal?: AbortSignal
): Promise<{ status: number; stream: AsyncGenerator<string, void, unknown> }> {
    const response = await fetchInsecureStream(url, {
        method: "POST",
        headers: { ...headers, Accept: "text/event-stream" },
        body: JSON.stringify(body),
        signal,
    })
    if (response.status < 200 || response.status >= 300) {
        const text = await readTextStream(response.stream)
        throwIfAborted(signal)
        consola.error(`Copilot stream error ${response.status} for ${url.replace(/^https?:\/\/[^/]+/, "")}`)
        throwCopilotUpstream(response.status, text, response.headers)
    }
    return response
}

async function negotiateCopilotAuto(
    capiBaseUrl: string,
    apiToken: string,
    promptText: string,
    tier: AutoTier,
    signal?: AbortSignal
): Promise<{ sessionToken: string; modelId: string; supportsResponses: boolean } | null> {
    const response = await fetchInsecureJson(`${capiBaseUrl}/auto`, {
        method: "POST",
        headers: getCopilotChatHeaders(apiToken),
        body: JSON.stringify({ prompt: (promptText.trim() ? promptText : "Hello").slice(0, 1000), tier }),
        signal,
    })
    const sessionToken = response.data?.session_token
    if (response.status < 200 || response.status >= 300 || !sessionToken) return null
    const selected = response.data?.selected_model
    return {
        sessionToken,
        modelId: selected?.id || "gpt-5.6-luna",
        supportsResponses: selected?.supported_endpoints?.includes("/responses") ?? true,
    }
}

/**
 * POST a Responses payload to a Copilot `/responses` endpoint, streaming SSE through untouched when `payload.stream`.
 */
async function forwardCopilotResponses(
    capiBaseUrl: string,
    headers: Record<string, string>,
    body: Record<string, any>,
    resolvedModel: string,
    accountId: string,
    signal: AbortSignal | undefined,
    options?: DirectOptions
): Promise<DirectResult> {
    const url = `${capiBaseUrl}/responses`
    if (body.stream) {
        const response = await postCopilotStream(url, headers, body, signal)
        authStore.markSuccess("copilot", accountId)
        return {
            kind: "sse",
            status: response.status,
            resolvedModel,
            stream: tapSseUsage(sseEventBlocks(response.stream), extractResponsesUsage, options?.onUsage),
        }
    }
    const response = await postCopilotJson(url, headers, body, signal)
    authStore.markSuccess("copilot", accountId)
    const usage = extractResponsesUsage(response.data)
    reportUsage(usage, options?.onUsage)
    return { kind: "json", status: response.status, data: response.data, resolvedModel, usage }
}

/** Adapt a Responses payload onto `/chat/completions` in one hop (live streaming when requested). */
async function adaptResponsesToCopilotChat(
    capiBaseUrl: string,
    headers: Record<string, string>,
    payload: Record<string, any>,
    chatModel: string,
    effort: string | undefined,
    accountId: string,
    signal: AbortSignal | undefined,
    options?: DirectOptions
): Promise<DirectResult> {
    const chatBody = responsesPayloadToChat(payload, chatModel)
    if (effort && !chatBody.reasoning_effort) chatBody.reasoning_effort = effort

    if (payload.stream === true) {
        chatBody.stream = true
        chatBody.stream_options = { include_usage: true }
        const response = await postCopilotStream(`${capiBaseUrl}/chat/completions`, headers, chatBody, signal)
        authStore.markSuccess("copilot", accountId)
        const blocks = tapSseUsage(sseEventBlocks(response.stream), extractChatUsage, options?.onUsage)
        const events = chatSseToEvents(blocks, payload.model || chatModel)
        return {
            kind: "sse",
            status: response.status,
            resolvedModel: chatModel,
            stream: eventsToResponsesSse(events, {
                id: generateResponseId(),
                model: payload.model || chatModel,
                payload: payload as ResponsesCreateRequest,
            }),
        }
    }

    const response = await postCopilotJson(`${capiBaseUrl}/chat/completions`, headers, chatBody, signal)
    authStore.markSuccess("copilot", accountId)
    const usage = extractChatUsage(response.data)
    reportUsage(usage, options?.onUsage)
    const data = chatCompletionToResponsesObject(response.data, chatModel)
    return { kind: "json", status: response.status, data, resolvedModel: chatModel, usage }
}

/**
 * Native OpenAI Responses pass-through to Copilot.
 * - `copilot-auto*`: negotiate `/auto`, then forward to `/responses` with the session token
 *   (or adapt onto `/chat/completions` if the selected model lacks `/responses`).
 * - Other models: forward to `/responses` when supported, otherwise adapt to `/chat/completions`.
 */
export async function createCopilotResponsesDirect(
    account: ProviderAccount,
    model: string,
    payload: Record<string, any>,
    signal?: AbortSignal,
    options?: DirectOptions
): Promise<DirectResult> {
    throwIfAborted(signal)
    const { token: apiToken, capiBaseUrl } = await getCopilotApiTokenInfo(account, signal)
    const available = await fetchCopilotModels(apiToken, capiBaseUrl, signal)
    throwIfAborted(signal)

    const resolved = resolveCopilotModel(available, model)
    const requestedEffort = payload.reasoning?.effort

    if (resolved.isAuto) {
        const { tier, effort } = resolveAutoTier(resolved, requestedEffort)
        const negotiated = await negotiateCopilotAuto(
            capiBaseUrl,
            apiToken,
            extractResponsesPromptText(payload.input),
            tier,
            signal
        )

        if (negotiated) {
            const headers = {
                ...getCopilotChatHeaders(apiToken, negotiated.sessionToken),
                "Openai-Intent": "conversation-panel",
            }
            if (negotiated.supportsResponses) {
                const body = {
                    ...payload,
                    model: negotiated.modelId,
                    reasoning: { effort, summary: "auto", ...(payload.reasoning || {}) },
                }
                return forwardCopilotResponses(capiBaseUrl, headers, body, negotiated.modelId, account.id, signal, options)
            }
            return adaptResponsesToCopilotChat(capiBaseUrl, headers, payload, negotiated.modelId, effort, account.id, signal, options)
        }

        // /auto unavailable: same fallback as createCopilotCompletion.
        return adaptResponsesToCopilotChat(capiBaseUrl, getCopilotChatHeaders(apiToken), payload, "gpt-4o", undefined, account.id, signal, options)
    }

    const info = available.find(m => m.id === resolved.id)
    const endpoints = info?.supported_endpoints
    const supportsResponses = Array.isArray(endpoints) && endpoints.includes("/responses")
    const supportedEfforts = info ? getCopilotReasoningEfforts(info) : []
    const effort = typeof requestedEffort === "string" ? requestedEffort : resolved.effort
    const effectiveEffort = effort && supportedEfforts.includes(effort) ? effort : undefined

    if (supportsResponses) {
        const body: Record<string, any> = { ...payload, model: resolved.id }
        if (effectiveEffort && !payload.reasoning?.effort) {
            body.reasoning = { ...(payload.reasoning || {}), effort: effectiveEffort }
        }
        return forwardCopilotResponses(
            capiBaseUrl,
            { ...getCopilotChatHeaders(apiToken), "Openai-Intent": "conversation-panel" },
            body,
            resolved.id,
            account.id,
            signal,
            options
        )
    }
    return adaptResponsesToCopilotChat(
        capiBaseUrl,
        getCopilotChatHeaders(apiToken),
        payload,
        resolved.id,
        effectiveEffort,
        account.id,
        signal,
        options
    )
}

function extractChatPromptText(messages: unknown): string {
    if (!Array.isArray(messages)) return ""
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (!msg || typeof msg !== "object" || msg.role !== "user") continue
        if (typeof msg.content === "string" && msg.content.trim()) return msg.content
        if (Array.isArray(msg.content)) {
            const text = msg.content
                .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
                .filter(Boolean)
                .join(" ")
                .trim()
            if (text) return text
        }
    }
    return ""
}

async function adaptChatToCopilotResponses(
    capiBaseUrl: string,
    headers: Record<string, string>,
    payload: Record<string, any>,
    responsesModel: string,
    effort: string | undefined,
    accountId: string,
    signal: AbortSignal | undefined,
    options?: DirectOptions
): Promise<DirectResult> {
    const respBody = chatPayloadToResponses(payload, responsesModel)
    if (effort && !respBody.reasoning?.effort) {
        respBody.reasoning = { effort, summary: "auto", ...(respBody.reasoning || {}) }
    }
    const direct = await forwardCopilotResponses(
        capiBaseUrl,
        { ...headers, "Openai-Intent": "conversation-panel" },
        respBody,
        responsesModel,
        accountId,
        signal,
        options
    )
    if (direct.kind === "sse") {
        return {
            kind: "sse",
            status: direct.status,
            resolvedModel: direct.resolvedModel,
            stream: responsesSseToOpenAIChatSse(direct.stream, payload.model || responsesModel, {
                includeUsage: payload.stream_options?.include_usage === true,
                provider: "copilot",
            }),
        }
    }
    return {
        kind: "json",
        status: direct.status,
        resolvedModel: direct.resolvedModel,
        data: responseObjectToChatCompletion(direct.data, payload.model || responsesModel),
        usage: direct.usage,
    }
}

/**
 * Direct-first OpenAI Chat Completions pass-through to Copilot:
 * - Native `/chat/completions` models (and `/auto` when it picks one): 0 conversions, raw pass-through.
 * - `copilot-auto` (when `/auto` picks a `/responses` model) or `/responses`-only models: 1-hop Chat <-> Responses with live SSE.
 */
export async function createCopilotChatDirect(
    account: ProviderAccount,
    model: string,
    payload: Record<string, any>,
    signal?: AbortSignal,
    options?: DirectOptions
): Promise<DirectResult | null> {
    throwIfAborted(signal)
    const { token: apiToken, capiBaseUrl } = await getCopilotApiTokenInfo(account, signal)
    const available = await fetchCopilotModels(apiToken, capiBaseUrl, signal)
    throwIfAborted(signal)

    const resolved = resolveCopilotModel(available, model)
    if (resolved.isAuto) {
        const requestedEffort = payload.reasoning_effort ?? payload.reasoning?.effort
        const { tier, effort } = resolveAutoTier(resolved, requestedEffort)
        const negotiated = await negotiateCopilotAuto(
            capiBaseUrl,
            apiToken,
            extractChatPromptText(payload.messages),
            tier,
            signal
        )
        if (negotiated) {
            const headers = getCopilotChatHeaders(apiToken, negotiated.sessionToken)
            if (negotiated.supportsResponses) {
                return adaptChatToCopilotResponses(capiBaseUrl, headers, payload, negotiated.modelId, effort, account.id, signal, options)
            }
            const body: Record<string, any> = { ...payload, model: negotiated.modelId }
            if (body.stream) {
                body.stream_options = { include_usage: true, ...(payload.stream_options || {}) }
                const response = await postCopilotStream(`${capiBaseUrl}/chat/completions`, headers, body, signal)
                authStore.markSuccess("copilot", account.id)
                return {
                    kind: "sse",
                    status: response.status,
                    resolvedModel: negotiated.modelId,
                    stream: tapSseUsage(sseEventBlocks(response.stream), extractChatUsage, options?.onUsage),
                }
            }
            const response = await postCopilotJson(`${capiBaseUrl}/chat/completions`, headers, body, signal)
            authStore.markSuccess("copilot", account.id)
            const usage = extractChatUsage(response.data)
            reportUsage(usage, options?.onUsage)
            return { kind: "json", status: response.status, data: response.data, resolvedModel: negotiated.modelId, usage }
        }
        // /auto unavailable: fall back to gpt-4o directly on /chat/completions
        const fallbackBody: Record<string, any> = { ...payload, model: "gpt-4o" }
        const fallbackHeaders = getCopilotChatHeaders(apiToken)
        if (fallbackBody.stream) {
            fallbackBody.stream_options = { include_usage: true, ...(payload.stream_options || {}) }
            const response = await postCopilotStream(`${capiBaseUrl}/chat/completions`, fallbackHeaders, fallbackBody, signal)
            authStore.markSuccess("copilot", account.id)
            return {
                kind: "sse",
                status: response.status,
                resolvedModel: "gpt-4o",
                stream: tapSseUsage(sseEventBlocks(response.stream), extractChatUsage, options?.onUsage),
            }
        }
        const response = await postCopilotJson(`${capiBaseUrl}/chat/completions`, fallbackHeaders, fallbackBody, signal)
        authStore.markSuccess("copilot", account.id)
        const usage = extractChatUsage(response.data)
        reportUsage(usage, options?.onUsage)
        return { kind: "json", status: response.status, data: response.data, resolvedModel: "gpt-4o", usage }
    }

    const info = available.find(m => m.id === resolved.id)
    const endpoints = info?.supported_endpoints
    const supportedEfforts = info ? getCopilotReasoningEfforts(info) : []
    const requestedEffort = payload.reasoning_effort ?? payload.reasoning?.effort
    const effort = typeof requestedEffort === "string" ? requestedEffort : resolved.effort
    const effectiveEffort = effort && supportedEfforts.includes(effort) ? effort : undefined

    if (Array.isArray(endpoints) && endpoints.includes("/responses") && !endpoints.includes("/chat/completions")) {
        return adaptChatToCopilotResponses(
            capiBaseUrl,
            getCopilotChatHeaders(apiToken),
            payload,
            resolved.id,
            effectiveEffort,
            account.id,
            signal,
            options
        )
    }

    const body: Record<string, any> = { ...payload, model: resolved.id }
    if (effectiveEffort) {
        body.reasoning_effort = effectiveEffort
    } else {
        delete body.reasoning_effort
    }

    const url = `${capiBaseUrl}/chat/completions`
    const headers = getCopilotChatHeaders(apiToken)

    if (body.stream) {
        // Ask for the final usage chunk so usage can be recorded; callers' own stream_options win.
        body.stream_options = { include_usage: true, ...(payload.stream_options || {}) }
        const response = await postCopilotStream(url, headers, body, signal)
        authStore.markSuccess("copilot", account.id)
        return {
            kind: "sse",
            status: response.status,
            resolvedModel: resolved.id,
            stream: tapSseUsage(sseEventBlocks(response.stream), extractChatUsage, options?.onUsage),
        }
    }

    const response = await postCopilotJson(url, headers, body, signal)
    authStore.markSuccess("copilot", account.id)
    const usage = extractChatUsage(response.data)
    reportUsage(usage, options?.onUsage)
    return { kind: "json", status: response.status, data: response.data, resolvedModel: resolved.id, usage }
}

export async function listCopilotModelsForAccount(account: ProviderAccount, signal?: AbortSignal): Promise<CopilotModelInfo[]> {
    const { token: apiToken, capiBaseUrl } = await getCopilotApiTokenInfo(account, signal, COPILOT_MODEL_SYNC_TIMEOUT_MS)
    return fetchCopilotModels(apiToken, capiBaseUrl, signal, COPILOT_MODEL_SYNC_TIMEOUT_MS)
}

export async function getCopilotApiToken(account: ProviderAccount, signal?: AbortSignal): Promise<string> {
    const info = await getCopilotApiTokenInfo(account, signal)
    return info.token
}

async function getCopilotApiTokenInfo(
    account: ProviderAccount,
    signal?: AbortSignal,
    timeoutMs?: number
): Promise<{ token: string; capiBaseUrl: string }> {
    throwIfAborted(signal)
    const cached = tokenCache.get(account.id)
    if (cached && cached.expiresAt > Date.now()) {
        return { token: cached.token, capiBaseUrl: cached.capiBaseUrl }
    }

    const response = await fetchInsecureJson(COPILOT_TOKEN_URL, {
        method: "GET",
        headers: {
            Authorization: `Bearer ${account.accessToken}`,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        signal,
        timeoutMs,
    })

    const data = response.data as CopilotTokenResponse
    if (response.status < 200 || response.status >= 300 || !data?.token) {
        throw new Error(`copilot:token:${response.status}`)
    }

    const expiresAt = data.expires_at ? data.expires_at * 1000 : Date.now() + 10 * 60 * 1000
    const capiBaseUrl = data.endpoints?.api?.replace(/\/$/, "") || DEFAULT_CAPI_BASE_URL
    tokenCache.set(account.id, { token: data.token, expiresAt, capiBaseUrl })
    return { token: data.token, capiBaseUrl }
}

function safeParse(value: string | undefined): any {
    if (!value) return {}
    try {
        return JSON.parse(value)
    } catch (error) {
        consola.warn("Copilot tool args parse failed:", safeErrorMessage(error))
        return {}
    }
}

function mapFinishReason(reason?: string | null): string {
    if (!reason || reason === "stop") return "end_turn"
    if (reason === "length") return "max_tokens"
    if (reason === "tool_calls") return "tool_use"
    return reason
}

async function fetchCopilotModels(
    apiToken: string,
    capiBaseUrl: string = DEFAULT_CAPI_BASE_URL,
    signal?: AbortSignal,
    timeoutMs?: number
): Promise<CopilotModelInfo[]> {
    throwIfAborted(signal)
    const cached = modelsCache.get(apiToken)
    if (cached && cached.expiresAt > Date.now()) {
        return cached.models
    }

    try {
        const response = await fetchInsecureJson(`${capiBaseUrl}/models`, {
            method: "GET",
            headers: getCopilotChatHeaders(apiToken),
            signal,
            timeoutMs,
        })

        if (response.status < 200 || response.status >= 300) {
            consola.warn("Failed to fetch Copilot models:", response.status)
            return normalizeCopilotModels([])
        }

        const data = response.data as { data: CopilotModelInfo[] }
        const models = normalizeCopilotModels(data?.data || [])

        modelsCache.set(apiToken, { models, expiresAt: Date.now() + 5 * 60 * 1000 })
        return models
    } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
            throw createAbortError()
        }
        consola.warn("Error fetching Copilot models:", safeErrorMessage(error))
        return normalizeCopilotModels([])
    }
}

// Insecure JSON fetch using Node.js https module to bypass TLS certificate errors
type InsecureResponse = { status: number; data: any; text: string }

async function fetchInsecureJson(
    url: string,
    options: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal; timeoutMs?: number }
): Promise<InsecureResponse> {
    throwIfAborted(options.signal)
    const target = new URL(url)
    const method = options.method || "GET"
    const headers = {
        "User-Agent": "anti-api/1.0",
        ...(options.headers || {}),
    }
    const agent = COPILOT_INSECURE_AGENT
    const timeoutMs = options.timeoutMs ?? DEFAULT_INSECURE_FETCH_TIMEOUT_MS

    return new Promise((resolve, reject) => {
        let settled = false
        let req: ReturnType<typeof https.request>
        let timer: ReturnType<typeof setTimeout> | null = null
        const cleanup = () => {
            options.signal?.removeEventListener("abort", onAbort)
            if (timer) {
                clearTimeout(timer)
                timer = null
            }
        }
        const resolveOnce = (value: InsecureResponse) => {
            if (settled) return
            settled = true
            cleanup()
            resolve(value)
        }
        const rejectOnce = (error: unknown) => {
            if (settled) return
            settled = true
            cleanup()
            reject(error)
        }
        const onAbort = () => {
            try { req.destroy(createAbortError()) } catch { }
            rejectOnce(createAbortError())
        }

        if (options.signal) {
            options.signal.addEventListener("abort", onAbort, { once: true })
        }

        req = https.request(
            {
                hostname: target.hostname,
                port: target.port || 443,
                path: `${target.pathname}${target.search}`,
                method,
                headers,
                agent,
            },
            (res) => {
                const chunks: Buffer[] = []
                res.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
                res.on("end", () => {
                    const text = Buffer.concat(chunks).toString("utf-8")
                    let data: any = null
                    try { data = JSON.parse(text) } catch { }
                    resolveOnce({ status: res.statusCode || 0, data, text })
                })
                res.on("error", (err) => rejectOnce(err))
            }
        )

        if (timeoutMs > 0) {
            timer = setTimeout(() => {
                const timeoutErr = new Error(`Request timeout after ${timeoutMs}ms: ${url}`)
                try { req.destroy(timeoutErr) } catch { }
                rejectOnce(timeoutErr)
            }, timeoutMs)
            req.setTimeout(timeoutMs, () => {
                const timeoutErr = new Error(`Socket timeout after ${timeoutMs}ms: ${url}`)
                try { req.destroy(timeoutErr) } catch { }
                rejectOnce(timeoutErr)
            })
        }

        req.on("error", (err) => {
            if (options.signal?.aborted || isAbortError(err)) {
                rejectOnce(createAbortError())
            } else {
                rejectOnce(err)
            }
        })

        if (options.body) {
            req.write(options.body)
        }
        req.end()
    })
}

type InsecureStreamResponse = {
    status: number
    headers: Record<string, string | string[] | undefined>
    /** Decoded UTF-8 text chunks as they arrive. Throws an abort error if `signal` fires. */
    stream: AsyncGenerator<string, void, unknown>
}

/**
 * Streaming counterpart of fetchInsecureJson (Node https, honours COPILOT_INSECURE_AGENT).
 * Resolves as soon as response headers arrive. `timeoutMs` bounds connect + time-to-headers;
 * `idleTimeoutMs` bounds silence between body chunks.
 */
async function fetchInsecureStream(
    url: string,
    options: {
        method?: string
        headers?: Record<string, string>
        body?: string
        signal?: AbortSignal
        timeoutMs?: number
        idleTimeoutMs?: number
    }
): Promise<InsecureStreamResponse> {
    throwIfAborted(options.signal)
    const target = new URL(url)
    const headers = {
        "User-Agent": "anti-api/1.0",
        ...(options.headers || {}),
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_INSECURE_FETCH_TIMEOUT_MS
    const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
    const signal = options.signal

    return new Promise<InsecureStreamResponse>((resolve, reject) => {
        let settled = false
        let req: ReturnType<typeof https.request>
        let responseRef: import("http").IncomingMessage | null = null
        let headerTimer: ReturnType<typeof setTimeout> | null = null
        let idleTimer: ReturnType<typeof setTimeout> | null = null

        const clearTimers = () => {
            if (headerTimer) { clearTimeout(headerTimer); headerTimer = null }
            if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
        }
        const cleanup = () => {
            signal?.removeEventListener("abort", onAbort)
            clearTimers()
        }
        const fail = (error: unknown) => {
            try { responseRef?.destroy() } catch { }
            try { req.destroy() } catch { }
            if (!settled) {
                settled = true
                cleanup()
                reject(error)
            }
        }
        const armIdle = () => {
            if (idleTimeoutMs <= 0) return
            if (idleTimer) clearTimeout(idleTimer)
            idleTimer = setTimeout(() => {
                const err = new Error(`Stream idle timeout after ${idleTimeoutMs}ms: ${url}`)
                try { responseRef?.destroy(err) } catch { }
                try { req.destroy(err) } catch { }
            }, idleTimeoutMs)
        }
        const onAbort = () => {
            const err = createAbortError()
            try { responseRef?.destroy(err) } catch { }
            try { req.destroy(err) } catch { }
            if (!settled) {
                settled = true
                cleanup()
                reject(err)
            }
        }

        signal?.addEventListener("abort", onAbort, { once: true })

        req = https.request(
            {
                hostname: target.hostname,
                port: target.port || 443,
                path: `${target.pathname}${target.search}`,
                method: options.method || "POST",
                headers,
                agent: COPILOT_INSECURE_AGENT,
            },
            (res) => {
                if (settled) {
                    res.destroy()
                    return
                }
                settled = true
                responseRef = res
                if (headerTimer) { clearTimeout(headerTimer); headerTimer = null }
                res.setEncoding("utf8")
                res.once("close", cleanup)
                armIdle()

                async function* body(): AsyncGenerator<string, void, unknown> {
                    try {
                        for await (const chunk of res) {
                            armIdle()
                            yield chunk as string
                        }
                    } catch (error) {
                        if (signal?.aborted || isAbortError(error)) throw createAbortError()
                        throw error
                    } finally {
                        cleanup()
                        if (!res.destroyed) res.destroy()
                    }
                }

                resolve({ status: res.statusCode || 0, headers: res.headers, stream: body() })
            }
        )

        if (timeoutMs > 0) {
            headerTimer = setTimeout(() => {
                fail(new Error(`Request timeout after ${timeoutMs}ms: ${url}`))
            }, timeoutMs)
        }

        req.on("error", (err) => {
            if (signal?.aborted || isAbortError(err)) {
                fail(createAbortError())
            } else {
                fail(err)
            }
        })

        if (options.body) {
            req.write(options.body)
        }
        req.end()
    })
}
