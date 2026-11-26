import type { ContentBlock, ClaudeMessage, ClaudeTool } from "~/lib/translator"
import { UpstreamError } from "~/lib/error"
import type { ProviderAccount } from "~/services/auth/types"
import { toOpenAIMessages, toOpenAIResponsesContent, toOpenAITools } from "~/services/providers/openai-adapter"
import { cleanJsonSchemaForGemini } from "~/lib/json-schema-cleaner"
import { authStore } from "~/services/auth/store"
import { createAbortError, raceWithAbort, throwIfAborted } from "~/lib/stream-cancellation"

const ZED_DEFAULT_SERVER_URL = "https://zed.dev"
const ZED_CLOUD_BASE_URL = "https://cloud.zed.dev"
const ZED_MODELS_TTL_MS = 5 * 60 * 1000
const ZED_LLM_TOKEN_TTL_MS = 15 * 60 * 1000
const ZED_REQUEST_TIMEOUT_MS = 8_000
const ZED_MODELS_TIMEOUT_MS = 8_000
const ZED_COMPLETION_TIMEOUT_MS = 90_000

type ZedCloudProvider = "anthropic" | "open_ai" | "google" | "x_ai"
type ReasoningEffort = "low" | "medium" | "high"

type ZedModelInfo = {
    id: string
    display_name?: string
    provider: ZedCloudProvider
    supports_tools?: boolean
    supports_thinking?: boolean
    supports_parallel_tool_calls?: boolean
    max_output_tokens?: number
}

type ZedModelsResponse = {
    models?: ZedModelInfo[]
    default_model?: string | null
    default_fast_model?: string | null
    recommended_models?: string[]
}

type ZedAuthenticatedUserResponse = {
    user: {
        id: number
        github_login: string
        name?: string | null
    }
    organizations?: Array<{
        id: string
        name: string
    }>
    plan?: {
        plan_v3?: string
        usage?: {
            edit_predictions?: {
                used?: number
                limit?: number | string
            }
        }
        subscription_period?: {
            started_at?: string
            ended_at?: string
        } | null
    }
}

type ZedCompletionBody = {
    thread_id?: string
    prompt_id?: string
    provider: ZedCloudProvider
    model: string
    provider_request: unknown
}

type ZedCompletionResult = {
    contentBlocks: ContentBlock[]
    stopReason: "end_turn" | "tool_use" | "max_tokens"
    usage: { inputTokens: number; outputTokens: number }
}

type ZedLlmTokenResponse = {
    token?: string
}

type ZedModelCacheEntry = {
    fetchedAt: number
    models: ZedModelInfo[]
}

type ZedTokenCacheEntry = {
    fetchedAt: number
    token: string
}

const zedModelCache = new Map<string, ZedModelCacheEntry>()
const zedModelInFlight = new Map<string, Promise<ZedModelInfo[]>>()
const zedTokenCache = new Map<string, ZedTokenCacheEntry>()

function getAccountKey(account: ProviderAccount): string {
    return `${ZED_DEFAULT_SERVER_URL}:${account.id}`
}

function buildZedCloudBase(): string {
    return ZED_CLOUD_BASE_URL
}

function buildZedCloudUrl(_account: ProviderAccount, path: string): string {
    return `${buildZedCloudBase()}${path}`
}

function getAccountAuthHeader(account: ProviderAccount): string {
    return `${account.id} ${account.accessToken}`
}

function readLocalSystemId(): string | undefined {
    const value = process.env.ANTI_API_ZED_SYSTEM_ID?.trim()
    if (!value || value.length > 256 || !/^[A-Za-z0-9._:-]+$/.test(value)) return undefined
    return value
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, label: string): Promise<Response> {
    const controller = new AbortController()
    let timedOut = false
    let callerAborted = false
    const onCallerAbort = () => {
        callerAborted = true
        controller.abort()
    }
    if (init.signal) {
        if (init.signal.aborted) throw createAbortError()
        init.signal.addEventListener("abort", onCallerAbort, { once: true })
    }
    const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
    }, timeoutMs)

    try {
        return await fetch(url, {
            ...init,
            signal: controller.signal,
        })
    } catch (error) {
        if (callerAborted || init.signal?.aborted) {
            throw createAbortError()
        }
        if (timedOut || error instanceof Error && error.name === "AbortError") {
            throw new Error(`${label} timed out after ${timeoutMs}ms`)
        }
        if (typeof error === "string" && error.includes("timed out")) {
            throw new Error(error)
        }
        throw error
    } finally {
        clearTimeout(timer)
        init.signal?.removeEventListener("abort", onCallerAbort)
    }
}

async function requestJson(
    url: string,
    init: RequestInit,
    timeoutMs = ZED_REQUEST_TIMEOUT_MS,
    label = "Zed request"
): Promise<{ response: Response; text: string; data: any }> {
    const response = await fetchWithTimeout(url, init, timeoutMs, label)
    const text = await response.text()
    let data: any = null
    try {
        data = text ? JSON.parse(text) : null
    } catch {
        data = null
    }
    return { response, text, data }
}

function maybeRefreshableLlmToken(response: Response): boolean {
    return response.headers.has("x-zed-expired-token") || response.headers.has("x-zed-outdated-token")
}

function normalizeModels(models: ZedModelInfo[]): ZedModelInfo[] {
    const deduped = new Map<string, ZedModelInfo>()
    for (const model of models || []) {
        const id = model?.id?.trim()
        if (!id) continue
        if (deduped.has(id)) continue
        deduped.set(id, { ...model, id })
    }
    return Array.from(deduped.values())
}

async function getZedLlmToken(account: ProviderAccount, forceRefresh = false, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal)
    const cacheKey = getAccountKey(account)
    const cached = zedTokenCache.get(cacheKey)
    if (!forceRefresh && cached && Date.now() - cached.fetchedAt < ZED_LLM_TOKEN_TTL_MS) {
        return cached.token
    }

    const headers: Record<string, string> = {
        "Authorization": getAccountAuthHeader(account),
        "Content-Type": "application/json",
    }
    const systemId = readLocalSystemId()
    if (systemId) {
        headers["x-zed-system-id"] = systemId
    }

    const { response, text, data } = await requestJson(buildZedCloudUrl(account, "/client/llm_tokens"), {
        method: "POST",
        headers,
        body: JSON.stringify({
            organization_id: account.organizationId || undefined,
        }),
        signal,
    }, ZED_REQUEST_TIMEOUT_MS, "Zed LLM token request")

    if (!response.ok || !data?.token) {
        throw buildZedUpstreamError(response.status, text, response.headers)
    }

    zedTokenCache.set(cacheKey, { fetchedAt: Date.now(), token: data.token })
    return data.token
}

export async function fetchZedAuthenticatedUser(
    userId: string | number,
    accessToken: string
): Promise<ZedAuthenticatedUserResponse> {
    const base = buildZedCloudBase()
    const { response, text, data } = await requestJson(`${base}/client/users/me`, {
        method: "GET",
        headers: {
            "Authorization": `${userId} ${accessToken}`,
        },
    }, ZED_REQUEST_TIMEOUT_MS, "Zed user request")

    if (!response.ok || !data?.user) {
        throw buildZedUpstreamError(response.status, text, response.headers)
    }

    return data as ZedAuthenticatedUserResponse
}

export async function fetchZedAccountOverview(account: ProviderAccount): Promise<ZedAuthenticatedUserResponse> {
    return fetchZedAuthenticatedUser(account.id, account.accessToken)
}

export async function listZedModelsForAccount(account: ProviderAccount, signal?: AbortSignal): Promise<ZedModelInfo[]> {
    throwIfAborted(signal)
    const cacheKey = getAccountKey(account)
    const cached = zedModelCache.get(cacheKey)
    if (cached && Date.now() - cached.fetchedAt < ZED_MODELS_TTL_MS) {
        return cached.models
    }
    const inFlight = zedModelInFlight.get(cacheKey)
    if (inFlight) {
        return raceWithAbort(inFlight, signal)
    }

    const task = (async () => {
        let llmToken = await getZedLlmToken(account, false, signal)
        let refreshed = false

        while (true) {
            const response = await fetchWithTimeout(buildZedCloudUrl(account, "/models"), {
                method: "GET",
                headers: {
                    "Authorization": `Bearer ${llmToken}`,
                    "x-zed-client-supports-x-ai": "true",
                },
                signal,
            }, ZED_MODELS_TIMEOUT_MS, "Zed models request")
            const text = await response.text()
            let data: ZedModelsResponse | null = null
            try {
                data = text ? JSON.parse(text) as ZedModelsResponse : null
            } catch {
                data = null
            }

            if (response.ok) {
                const models = normalizeModels(data?.models || [])
                zedModelCache.set(cacheKey, { fetchedAt: Date.now(), models })
                return models
            }

            if (!refreshed && maybeRefreshableLlmToken(response)) {
                llmToken = await getZedLlmToken(account, true, signal)
                refreshed = true
                continue
            }

            throw buildZedUpstreamError(response.status, text, response.headers)
        }
    })()

    zedModelInFlight.set(cacheKey, task)
    try {
        return await task
    } finally {
        zedModelInFlight.delete(cacheKey)
    }
}

function appendText(contentBlocks: ContentBlock[], text: string): void {
    if (!text) return
    const last = contentBlocks[contentBlocks.length - 1]
    if (last?.type === "text") {
        last.text = `${last.text || ""}${text}`
        return
    }
    contentBlocks.push({ type: "text", text })
}

function mergeToolResultContent(content: unknown): string {
    if (typeof content === "string") return content
    if (Array.isArray(content)) {
        const merged = content
            .map((block) => block && typeof block === "object" && typeof (block as { text?: string }).text === "string"
                ? (block as { text: string }).text
                : "")
            .filter(Boolean)
            .join("\n")
        if (merged.trim()) return merged
    }
    if (content != null) return JSON.stringify(content)
    return ""
}

function normalizeToolParameters(schema: unknown): any {
    if (!schema) {
        return { type: "object", properties: {} }
    }

    let normalized: any = schema
    if (typeof schema === "string") {
        const trimmed = schema.trim()
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
            try {
                normalized = JSON.parse(trimmed)
            } catch {
                return { type: "object", properties: {} }
            }
        } else {
            return { type: "object", properties: {} }
        }
    }

    if (typeof normalized !== "object" || normalized === null || Array.isArray(normalized)) {
        return { type: "object", properties: {} }
    }

    normalized = cleanJsonSchemaForGemini(normalized)
    if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
        return { type: "object", properties: {} }
    }

    if (normalized.type !== "object") {
        normalized.type = "object"
    }
    if (!normalized.properties || typeof normalized.properties !== "object" || Array.isArray(normalized.properties)) {
        normalized.properties = {}
    }
    if (normalized.required && !Array.isArray(normalized.required)) {
        delete normalized.required
    }

    return normalized
}

function buildAnthropicMessages(messages: ClaudeMessage[]): { system?: string; messages: any[] } {
    const result: any[] = []
    let system = ""

    for (const message of messages) {
        const role = message.role === "assistant" ? "assistant" : "user"
        const content: any[] = typeof message.content === "string"
            ? [{ type: "text", text: message.content }]
            : (Array.from(message.content || []) as any[]).flatMap<any>((block: any) => {
                if (!block || typeof block !== "object") return []
                if (block.type === "text") {
                    return [{ type: "text", text: block.text || "" }]
                }
                if (block.type === "image" && block.source?.type === "base64") {
                    return [{
                        type: "image",
                        source: {
                            type: "base64",
                            media_type: block.source.media_type,
                            data: block.source.data,
                        },
                    }]
                }
                if (block.type === "tool_use") {
                    return [{
                        type: "tool_use",
                        id: block.id || `toolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
                        name: block.name || "tool",
                        input: block.input || {},
                    }]
                }
                if (block.type === "tool_result") {
                    return [{
                        type: "tool_result",
                        tool_use_id: block.tool_use_id || "tool",
                        content: mergeToolResultContent(block.content),
                    }]
                }
                return []
            })

        if (content.length === 0) continue

        if (result.length > 0 && result[result.length - 1].role === role) {
            result[result.length - 1].content.push(...content)
            continue
        }

        result.push({ role, content })
    }

    if (system.trim()) {
        return { system, messages: result }
    }
    return { messages: result }
}

function buildGoogleParts(content: ClaudeMessage["content"], toolIdToName: Map<string, string>): any[] {
    if (typeof content === "string") {
        return [{ text: content }]
    }
    if (!Array.isArray(content)) {
        return [{ text: "" }]
    }

    const parts: any[] = []
    for (const block of content) {
        if (!block || typeof block !== "object") continue
        if (block.type === "text") {
            parts.push({ text: block.text || "" })
            continue
        }
        if (block.type === "image" && block.source?.type === "base64") {
            parts.push({
                inlineData: {
                    mimeType: block.source.media_type,
                    data: block.source.data,
                },
            })
            continue
        }
        if (block.type === "tool_use") {
            const toolId = block.id || `tool_${crypto.randomUUID().slice(0, 8)}`
            const toolName = block.name || "tool"
            toolIdToName.set(toolId, toolName)
            parts.push({
                functionCall: {
                    id: toolId,
                    name: toolName,
                    args: block.input || {},
                },
            })
            continue
        }
        if (block.type === "tool_result") {
            const toolUseId = block.tool_use_id || ""
            const toolName = toolIdToName.get(toolUseId) || toolUseId || "tool"
            parts.push({
                functionResponse: {
                    name: toolName,
                    response: { output: mergeToolResultContent(block.content) },
                },
            })
        }
    }

    return parts.length > 0 ? parts : [{ text: "" }]
}

function toResponsesInput(messages: ReturnType<typeof toOpenAIMessages>): any[] {
    const input: any[] = []

    for (const msg of messages) {
        if (msg.role === "user") {
            input.push({
                type: "message",
                role: "user",
                content: toOpenAIResponsesContent(msg.content, "user"),
            })
            continue
        }

        if (msg.role === "assistant") {
            input.push({
                type: "message",
                role: "assistant",
                content: toOpenAIResponsesContent(msg.content, "assistant"),
            })
            for (const toolCall of msg.tool_calls || []) {
                input.push({
                    type: "function_call",
                    call_id: toolCall.id,
                    name: toolCall.function.name,
                    arguments: toolCall.function.arguments,
                })
            }
            continue
        }

        if (msg.role === "tool") {
            input.push({
                type: "function_call_output",
                call_id: msg.tool_call_id,
                output: msg.content || "",
            })
        }
    }

    return input
}

function buildOpenAiResponsesRequest(
    model: ZedModelInfo,
    messages: ClaudeMessage[],
    tools?: ClaudeTool[],
    maxTokens?: number,
    reasoningEffort?: ReasoningEffort
): any {
    const openAiMessages = toOpenAIMessages(messages)
    const openAiTools = toOpenAITools(tools)
    const responsesTools = openAiTools?.map((tool) => ({
        type: "function",
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
    }))

    return {
        model: model.id,
        input: toResponsesInput(openAiMessages),
        tools: responsesTools,
        stream: true,
        store: false,
        max_output_tokens: maxTokens || undefined,
        parallel_tool_calls: model.supports_parallel_tool_calls === true,
        reasoning: reasoningEffort ? { effort: reasoningEffort, summary: "auto" } : undefined,
    }
}

function buildOpenAiChatRequest(
    model: ZedModelInfo,
    messages: ClaudeMessage[],
    tools?: ClaudeTool[],
    maxTokens?: number
): any {
    return {
        model: model.id,
        stream: true,
        max_tokens: maxTokens || undefined,
        parallel_tool_calls: model.supports_parallel_tool_calls === true,
        messages: toOpenAIMessages(messages),
        tools: toOpenAITools(tools),
    }
}

function buildAnthropicRequest(
    model: ZedModelInfo,
    messages: ClaudeMessage[],
    tools?: ClaudeTool[],
    maxTokens?: number,
    reasoningEffort?: ReasoningEffort
): any {
    const converted = buildAnthropicMessages(messages)
    return {
        model: model.id,
        messages: converted.messages,
        system: converted.system || undefined,
        max_tokens: maxTokens || model.max_output_tokens || 4096,
        tools: (tools || []).map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: normalizeToolParameters(tool.input_schema),
        })),
        tool_choice: tools && tools.length > 0 ? { type: "auto" } : undefined,
        thinking: reasoningEffort ? { type: "enabled", budget_tokens: 4096 } : undefined,
        output_config: reasoningEffort ? { effort: reasoningEffort } : undefined,
    }
}

function buildGoogleRequest(
    model: ZedModelInfo,
    messages: ClaudeMessage[],
    tools?: ClaudeTool[],
    maxTokens?: number
): any {
    const toolIdToName = new Map<string, string>()
    return {
        model: { model_id: model.id },
        contents: messages.map((message) => ({
            role: message.role === "assistant" ? "model" : "user",
            parts: buildGoogleParts(message.content, toolIdToName),
        })),
        generation_config: {
            candidate_count: 1,
            max_output_tokens: maxTokens || model.max_output_tokens || undefined,
            temperature: 1,
        },
        tools: tools && tools.length > 0 ? [{
            function_declarations: tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parameters: normalizeToolParameters(tool.input_schema),
            })),
        }] : undefined,
    }
}

function buildProviderRequest(
    model: ZedModelInfo,
    messages: ClaudeMessage[],
    tools?: ClaudeTool[],
    maxTokens?: number,
    reasoningEffort?: ReasoningEffort
): any {
    if (model.provider === "anthropic") {
        return buildAnthropicRequest(model, messages, tools, maxTokens, reasoningEffort)
    }
    if (model.provider === "google") {
        return buildGoogleRequest(model, messages, tools, maxTokens)
    }
    if (model.provider === "open_ai") {
        return buildOpenAiResponsesRequest(model, messages, tools, maxTokens, reasoningEffort)
    }
    return buildOpenAiChatRequest(model, messages, tools, maxTokens)
}

function parseJsonSafe(value: string): any {
    try {
        return JSON.parse(value)
    } catch {
        return {}
    }
}

function finalizeToolBlocks(map: Map<number | string, { id: string; name: string; input: string }>, contentBlocks: ContentBlock[]): void {
    for (const entry of map.values()) {
        if (!entry.id || !entry.name) continue
        contentBlocks.push({
            type: "tool_use",
            id: entry.id,
            name: entry.name,
            input: parseJsonSafe(entry.input || "{}"),
        })
    }
    map.clear()
}

function parseAnthropicEvents(lines: any[]): ZedCompletionResult {
    const contentBlocks: ContentBlock[] = []
    const tools = new Map<number, { id: string; name: string; input: string }>()
    let stopReason: ZedCompletionResult["stopReason"] = "end_turn"
    let inputTokens = 0
    let outputTokens = 0

    for (const event of lines) {
        const type = String(event?.type || "")
        if (type === "message_start") {
            inputTokens = event?.message?.usage?.input_tokens || inputTokens
            outputTokens = event?.message?.usage?.output_tokens || outputTokens
            continue
        }
        if (type === "content_block_start") {
            const block = event?.content_block
            if (block?.type === "text" && typeof block.text === "string") {
                appendText(contentBlocks, block.text)
            } else if (block?.type === "tool_use") {
                tools.set(Number(event.index), {
                    id: block.id || `tool_${crypto.randomUUID().slice(0, 8)}`,
                    name: block.name || "tool",
                    input: "",
                })
            }
            continue
        }
        if (type === "content_block_delta") {
            const delta = event?.delta || {}
            if (delta.type === "text_delta" && typeof delta.text === "string") {
                appendText(contentBlocks, delta.text)
            } else if (delta.type === "input_json_delta") {
                const tool = tools.get(Number(event.index))
                if (tool && typeof delta.partial_json === "string") {
                    tool.input += delta.partial_json
                }
            }
            continue
        }
        if (type === "content_block_stop") {
            const tool = tools.get(Number(event.index))
            if (tool) {
                contentBlocks.push({
                    type: "tool_use",
                    id: tool.id,
                    name: tool.name,
                    input: parseJsonSafe(tool.input || "{}"),
                })
                tools.delete(Number(event.index))
            }
            continue
        }
        if (type === "message_delta") {
            const reason = event?.delta?.stop_reason
            if (reason === "tool_use") stopReason = "tool_use"
            else if (reason === "max_tokens") stopReason = "max_tokens"
            outputTokens = event?.usage?.output_tokens || outputTokens
            continue
        }
    }

    if (contentBlocks.length === 0) {
        contentBlocks.push({ type: "text", text: "" })
    }

    return { contentBlocks, stopReason, usage: { inputTokens, outputTokens } }
}

function parseOpenAiChatEvents(lines: any[]): ZedCompletionResult {
    const contentBlocks: ContentBlock[] = []
    const toolCalls = new Map<number, { id: string; name: string; input: string }>()
    let stopReason: ZedCompletionResult["stopReason"] = "end_turn"
    let inputTokens = 0
    let outputTokens = 0

    for (const event of lines) {
        const usage = event?.usage
        if (usage) {
            inputTokens = usage.prompt_tokens || inputTokens
            outputTokens = usage.completion_tokens || outputTokens
        }

        const choice = event?.choices?.[0]
        const delta = choice?.delta || {}
        if (typeof delta.content === "string") {
            appendText(contentBlocks, delta.content)
        }
        for (const toolCall of delta.tool_calls || []) {
            const index = Number(toolCall.index || 0)
            const entry = toolCalls.get(index) || { id: "", name: "", input: "" }
            if (toolCall.id) entry.id = toolCall.id
            if (toolCall.function?.name) entry.name = toolCall.function.name
            if (toolCall.function?.arguments) entry.input += toolCall.function.arguments
            toolCalls.set(index, entry)
        }

        if (choice?.finish_reason === "tool_calls") {
            finalizeToolBlocks(toolCalls, contentBlocks)
            stopReason = "tool_use"
        } else if (choice?.finish_reason === "length") {
            stopReason = "max_tokens"
        } else if (choice?.finish_reason === "stop") {
            stopReason = "end_turn"
        }
    }

    if (contentBlocks.length === 0) {
        contentBlocks.push({ type: "text", text: "" })
    }

    return { contentBlocks, stopReason, usage: { inputTokens, outputTokens } }
}

function parseOpenAiResponsesEvents(lines: any[]): ZedCompletionResult {
    const contentBlocks: ContentBlock[] = []
    const functionCalls = new Map<string, { id: string; name: string; input: string }>()
    let stopReason: ZedCompletionResult["stopReason"] = "end_turn"
    let inputTokens = 0
    let outputTokens = 0

    for (const event of lines) {
        const type = String(event?.type || "")
        if (type === "response.output_item.added") {
            const item = event?.item || {}
            if (item.type === "function_call" && item.id) {
                functionCalls.set(String(item.id), {
                    id: item.call_id || item.id,
                    name: item.name || "tool",
                    input: item.arguments || "",
                })
            }
            continue
        }

        if (type === "response.output_text.delta" && typeof event?.delta === "string") {
            appendText(contentBlocks, event.delta)
            continue
        }

        if (type === "response.function_call_arguments.delta") {
            const itemId = String(event?.item_id || "")
            const entry = functionCalls.get(itemId)
            if (entry && typeof event?.delta === "string") {
                entry.input += event.delta
            }
            continue
        }

        if (type === "response.function_call_arguments.done") {
            const itemId = String(event?.item_id || "")
            const entry = functionCalls.get(itemId)
            if (entry) {
                if (typeof event.arguments === "string" && event.arguments) {
                    entry.input = event.arguments
                }
                contentBlocks.push({
                    type: "tool_use",
                    id: entry.id,
                    name: entry.name,
                    input: parseJsonSafe(entry.input || "{}"),
                })
                functionCalls.delete(itemId)
                stopReason = "tool_use"
            }
            continue
        }

        if (type === "response.completed" || type === "response.incomplete") {
            const response = event?.response || {}
            const usage = response?.usage || {}
            inputTokens = usage.input_tokens || inputTokens
            outputTokens = usage.output_tokens || outputTokens

            for (const item of response?.output || []) {
                if (item?.type === "function_call") {
                    contentBlocks.push({
                        type: "tool_use",
                        id: item.call_id || item.id || `tool_${crypto.randomUUID().slice(0, 8)}`,
                        name: item.name || "tool",
                        input: parseJsonSafe(item.arguments || "{}"),
                    })
                    stopReason = "tool_use"
                }
            }

            const reason = response?.status_details?.reason
            if (reason === "max_output_tokens") {
                stopReason = "max_tokens"
            }
            continue
        }
    }

    if (contentBlocks.length === 0) {
        contentBlocks.push({ type: "text", text: "" })
    }

    return { contentBlocks, stopReason, usage: { inputTokens, outputTokens } }
}

function parseGoogleEvents(lines: any[]): ZedCompletionResult {
    const contentBlocks: ContentBlock[] = []
    let stopReason: ZedCompletionResult["stopReason"] = "end_turn"
    let inputTokens = 0
    let outputTokens = 0

    for (const event of lines) {
        const usage = event?.usageMetadata || event?.usage_metadata
        if (usage) {
            inputTokens = usage.promptTokenCount || usage.prompt_token_count || inputTokens
            outputTokens = usage.candidatesTokenCount || usage.candidates_token_count || outputTokens
        }

        const candidates = event?.candidates || []
        for (const candidate of candidates) {
            const reason = candidate?.finishReason || candidate?.finish_reason
            if (reason === "MAX_TOKENS") {
                stopReason = "max_tokens"
            }
            for (const part of candidate?.content?.parts || []) {
                if (typeof part?.text === "string") {
                    appendText(contentBlocks, part.text)
                } else if (part?.functionCall || part?.function_call) {
                    const call = part.functionCall || part.function_call
                    contentBlocks.push({
                        type: "tool_use",
                        id: call.id || `tool_${crypto.randomUUID().slice(0, 8)}`,
                        name: call.name || "tool",
                        input: call.args || {},
                    })
                    stopReason = "tool_use"
                }
            }
        }
    }

    if (contentBlocks.length === 0) {
        contentBlocks.push({ type: "text", text: "" })
    }

    return { contentBlocks, stopReason, usage: { inputTokens, outputTokens } }
}

function unwrapCompletionLines(text: string, includesStatusMessages: boolean): any[] {
    const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)

    const events: any[] = []
    for (const line of lines) {
        let parsed: any
        try {
            parsed = JSON.parse(line)
        } catch {
            continue
        }

        if (!includesStatusMessages) {
            events.push(parsed)
            continue
        }

        if ("event" in parsed) {
            events.push(parsed.event)
            continue
        }

        if ("status" in parsed) {
            const status = parsed.status || {}
            if (status.failed) {
                const retryAfter = typeof status.failed.retry_after === "number" ? String(status.failed.retry_after) : undefined
                throw new UpstreamError("zed", 502, status.failed.message || "Zed completion failed", retryAfter)
            }
            continue
        }
    }

    return events
}

function buildZedUpstreamError(status: number, text: string, headers?: Headers): UpstreamError {
    const trimmed = (text || "").trim()
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
            const parsed = JSON.parse(trimmed)
            const code = String(parsed?.code || "")
            const message = typeof parsed?.message === "string"
                ? parsed.message
                : typeof parsed?.error?.message === "string"
                    ? parsed.error.message
                    : trimmed
            const upstreamStatus = Number(parsed?.upstream_status || 0)
            const effectiveStatus = code.startsWith("upstream_http_") && upstreamStatus > 0 ? upstreamStatus : status
            const retryAfter = headers?.get("retry-after") || (typeof parsed?.retry_after === "number" ? String(parsed.retry_after) : undefined)
            return new UpstreamError("zed", effectiveStatus, message, retryAfter)
        } catch {
            return new UpstreamError("zed", status, trimmed, headers?.get("retry-after") || undefined)
        }
    }
    return new UpstreamError("zed", status, trimmed || `zed upstream error (${status})`, headers?.get("retry-after") || undefined)
}

function parseCompletionText(provider: ZedCloudProvider, text: string, includesStatusMessages: boolean): ZedCompletionResult {
    const lines = unwrapCompletionLines(text, includesStatusMessages)
    if (provider === "anthropic") {
        return parseAnthropicEvents(lines)
    }
    if (provider === "google") {
        return parseGoogleEvents(lines)
    }
    if (provider === "open_ai") {
        return parseOpenAiResponsesEvents(lines)
    }
    return parseOpenAiChatEvents(lines)
}

export async function createZedCompletion(
    account: ProviderAccount,
    modelId: string,
    messages: ClaudeMessage[],
    tools?: ClaudeTool[],
    maxTokens?: number,
    reasoningEffort?: ReasoningEffort,
    signal?: AbortSignal
): Promise<ZedCompletionResult> {
    throwIfAborted(signal)
    const remoteModels = await listZedModelsForAccount(account, signal)
    const model = remoteModels.find((entry) => entry.id === modelId)
    if (!model) {
        throw new UpstreamError("zed", 404, `Model not available for this Zed account: ${modelId}`)
    }

    let llmToken = await getZedLlmToken(account, false, signal)
    let refreshed = false

    const body: ZedCompletionBody = {
        provider: model.provider,
        model: model.id,
        provider_request: buildProviderRequest(model, messages, tools, maxTokens, reasoningEffort),
    }

    while (true) {
        const response = await fetchWithTimeout(buildZedCloudUrl(account, "/completions"), {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${llmToken}`,
                "Content-Type": "application/json",
                "x-zed-client-supports-status-messages": "true",
                "x-zed-client-supports-stream-ended-request-completion-status": "true",
            },
            body: JSON.stringify(body),
            signal,
        }, ZED_COMPLETION_TIMEOUT_MS, "Zed completion request")

        const text = await response.text()
        if (response.ok) {
            const includesStatusMessages = response.headers.has("x-zed-server-supports-status-messages")
            authStore.markSuccess("zed", account.id)
            return parseCompletionText(model.provider, text, includesStatusMessages)
        }

        if (!refreshed && maybeRefreshableLlmToken(response)) {
            llmToken = await getZedLlmToken(account, true, signal)
            refreshed = true
            continue
        }

        throw buildZedUpstreamError(response.status, text, response.headers)
    }
}
