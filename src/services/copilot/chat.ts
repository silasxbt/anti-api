import consola from "consola"
import https from "https"
import { authStore } from "~/services/auth/store"
import { UpstreamError } from "~/lib/error"
import type { ProviderAccount } from "~/services/auth/types"
import type { ClaudeMessage, ClaudeTool } from "~/lib/translator"
import { toOpenAIMessages, toOpenAITools } from "~/services/providers/openai-adapter"
import { createAbortError, isAbortError, throwIfAborted } from "~/lib/stream-cancellation"
import { safeErrorMessage } from "~/lib/redaction"

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

export interface CopilotModelInfo {
    id: string
    name?: string
    model_picker_enabled?: boolean
    vendor?: string
    policy?: { state?: string }
    supported_endpoints?: string[]
    capabilities?: {
        type?: string
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

/**
 * Normalizes live models discovered from GitHub Copilot.
 * - Always includes copilot-auto (with low/medium/high reasoning effort variants).
 * - For user accounts, only models with model_picker_enabled: true (Pro/Enterprise) are exposed individually.
 * - Free / Edu accounts have model_picker_enabled: false on all models, leaving copilot-auto as their only option (matching VS Code).
 */
export function normalizeCopilotModels(models: CopilotModelInfo[]): CopilotModelInfo[] {
    const deduped = new Map<string, CopilotModelInfo>()

    // Always include the Auto model
    deduped.set(COPILOT_AUTO_MODEL_ID, {
        id: COPILOT_AUTO_MODEL_ID,
        name: "Auto",
        model_picker_enabled: true,
        capabilities: {
            type: "chat",
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

    // Handle Copilot Auto mode (via POST /auto + /responses)
    if (resolved.isAuto) {
        let tier: "efficiency" | "balance" | "intelligence" = "balance"
        let effectiveEffort: CopilotReasoningEffort = "medium"

        if (resolved.tier) {
            tier = resolved.tier
            effectiveEffort = resolved.effort || (tier === "efficiency" ? "low" : tier === "intelligence" ? "high" : "medium")
        } else if (reasoningEffort === "low") {
            tier = "efficiency"
            effectiveEffort = "low"
        } else if (reasoningEffort === "high" || reasoningEffort === "xhigh" || reasoningEffort === "max") {
            tier = "intelligence"
            effectiveEffort = "high"
        } else if (reasoningEffort === "medium") {
            tier = "balance"
            effectiveEffort = "medium"
        }

        // Get user prompt text for /auto negotiation
        const lastUser = [...messages].reverse().find(m => m.role === "user")
        let promptText = ""
        if (typeof lastUser?.content === "string") {
            promptText = lastUser.content
        } else if (Array.isArray(lastUser?.content)) {
            promptText = lastUser.content.filter(p => p.type === "text").map(p => (p as any).text).join(" ")
        }
        if (!promptText.trim()) promptText = "Hello"

        // 1. Negotiate model and session token with Copilot /auto
        const autoResponse = await fetchInsecureJson(`${capiBaseUrl}/auto`, {
            method: "POST",
            headers: getCopilotChatHeaders(apiToken),
            body: JSON.stringify({
                prompt: promptText.slice(0, 1000),
                tier,
            }),
            signal,
        })

        if (autoResponse.status >= 200 && autoResponse.status < 300 && autoResponse.data?.session_token) {
            const sessionToken = autoResponse.data.session_token
            const selectedModel = autoResponse.data.selected_model
            const selectedModelId = selectedModel?.id || "gpt-5.6-luna"
            const supportsResponses = selectedModel?.supported_endpoints?.includes("/responses") ?? true

            if (supportsResponses) {
                // 2. Call modern /responses endpoint with Copilot-Session-Token
                const openAiMessages = toOpenAIMessages(messages)
                const openAiTools = toOpenAITools(tools)
                const responsesTools = openAiTools?.map(t => ({
                    type: "function",
                    name: t.function.name,
                    description: t.function.description,
                    parameters: t.function.parameters,
                }))

                const requestBody = {
                    model: selectedModelId,
                    input: toResponsesInput(openAiMessages),
                    ...(responsesTools && responsesTools.length > 0 ? { tools: responsesTools } : {}),
                    ...(maxTokens ? { max_output_tokens: maxTokens } : {}),
                    reasoning: { effort: effectiveEffort, summary: "auto" },
                }

                const response = await fetchInsecureJson(`${capiBaseUrl}/responses`, {
                    method: "POST",
                    headers: {
                        ...getCopilotChatHeaders(apiToken, sessionToken),
                        "Openai-Intent": "conversation-panel",
                    },
                    body: JSON.stringify(requestBody),
                    signal,
                })

                if (response.status < 200 || response.status >= 300) {
                    consola.error(`Copilot /responses error ${response.status} for ${selectedModelId}`)
                    throw new UpstreamError("copilot", response.status, response.text, undefined)
                }

                const openAiResp = buildCompletionFromResponses(response.data)
                return toProviderCompletion(openAiResp, account.id)
            }
        }
    }

    // Standard completion (for specific user-selected Pro models or fallback)
    const mappedModel = resolved.id === COPILOT_AUTO_MODEL_ID ? "gpt-4o" : resolved.id
    const info = available.find(m => m.id === mappedModel)
    const supported = info ? getCopilotReasoningEfforts(info) : []
    const effort = resolved.effort ?? reasoningEffort
    const effectiveEffort = effort && supported.includes(effort) ? effort : undefined

    const requestBody = {
        model: mappedModel,
        messages: toOpenAIMessages(messages),
        tools: toOpenAITools(tools),
        max_tokens: maxTokens,
        ...(effectiveEffort ? { reasoning_effort: effectiveEffort } : {}),
    }

    const response = await fetchInsecureJson(`${capiBaseUrl}/chat/completions`, {
        method: "POST",
        headers: getCopilotChatHeaders(apiToken),
        body: JSON.stringify(requestBody),
        signal,
    })

    if (response.status < 200 || response.status >= 300) {
        consola.error(`Copilot error ${response.status} for model ${mappedModel}`)
        throw new UpstreamError("copilot", response.status, response.text, undefined)
    }

    const data = response.data as OpenAIResponse
    return toProviderCompletion(data, account.id)
}

const COPILOT_MODEL_SYNC_TIMEOUT_MS = 8_000
const DEFAULT_INSECURE_FETCH_TIMEOUT_MS = 120_000

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
