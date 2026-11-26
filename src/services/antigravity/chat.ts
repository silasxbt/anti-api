/**
 * Antigravity Chat Service - Cloud API Version
 * v2.1.0
 */

import consola from "consola"
import { getAccessToken } from "./oauth"
import { accountManager } from "./account-manager"
import { state } from "~/lib/state"
import { type ClaudeMessage, type ClaudeTool } from "~/lib/translator"
import { determineRetryStrategy, applyRetryDelay } from "~/lib/retry"
import { UpstreamError } from "~/lib/error"
import { cleanJsonSchemaForGemini } from "~/lib/json-schema-cleaner"
import { formatSuccessLine, setRequestLogContext } from "~/lib/logger"
import { getAntigravityUserAgent } from "~/lib/antigravity-client"

accountManager.load()

const ANTIGRAVITY_BASE_URLS = [
    "https://daily-cloudcode-pa.googleapis.com",       // v2.0.1: 优先使用 daily 端点（更稳定）
    "https://daily-cloudcode-pa.sandbox.googleapis.com",
    "https://cloudcode-pa.googleapis.com",
]
const STREAM_ENDPOINT = "/v1internal:streamGenerateContent"
const DEFAULT_USER_AGENT = getAntigravityUserAgent()
const MAX_RETRY_ATTEMPTS = 1  // v2.0.1 恢复：简化重试，避免级联 429
const MAX_NON_QUOTA_429_RETRIES = 2  // Non-quota 429 retries before switching accounts
const MAX_NON_QUOTA_429_WAIT_MS = 4000  // Upper bound for non-quota 429 wait time
const NON_QUOTA_429_COOLDOWN_MS = 8000  // Cooldown before retrying a rate-limited account
const FETCH_TIMEOUT_MS = 30000  // 防止上游请求长期卡住

/**
 * 从 429 错误中解析重试延迟时间（毫秒）
 * 支持格式：quotaResetDelay "42s", "2m30s", "1h", 或 Retry-After header
 */
function parseRetryDelay(errorText: string, retryAfterHeader?: string): number | null {
    // 1. 优先尝试从 Retry-After header 解析
    if (retryAfterHeader) {
        const seconds = parseInt(retryAfterHeader, 10)
        if (!isNaN(seconds) && seconds > 0) {
            return seconds * 1000
        }
    }

    // 2. 尝试从 JSON 中解析 quotaResetDelay
    const trimmed = errorText.trim()
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
            const json = JSON.parse(trimmed)
            const delay = json?.error?.details?.[0]?.metadata?.quotaResetDelay
            if (typeof delay === "string") {
                return parseDurationString(delay)
            }
        } catch {
            // ignore parse errors
        }
    }

    // 3. 正则匹配常见模式
    const patterns = [
        /try again in (\d+)m\s*(\d+)s/i,
        /try again in (\d+)s/i,
        /backoff for (\d+)s/i,
        /wait (\d+)s/i,
        /retry after (\d+) second/i,
    ]

    for (const pattern of patterns) {
        const match = errorText.match(pattern)
        if (match) {
            if (match[2]) {
                // "Xm Ys" format
                return (parseInt(match[1]) * 60 + parseInt(match[2])) * 1000
            }
            return parseInt(match[1]) * 1000
        }
    }

    return null
}

function isQuotaExhaustedErrorText(errorText: string): boolean {
    const body = (errorText || "").trim()
    if (!body) return false

    if (body.startsWith("{") || body.startsWith("[")) {
        try {
            const json = JSON.parse(body)
            const details = json?.error?.details
            if (Array.isArray(details)) {
                for (const detail of details) {
                    if (detail?.reason === "QUOTA_EXHAUSTED") return true
                }
            }
            const message = json?.error?.message
            if (typeof message === "string") {
                const lower = message.toLowerCase()
                if (lower.includes("quota") && lower.includes("reset")) return true
            }
        } catch {
            // ignore parse errors
        }
    }

    const lower = body.toLowerCase()
    if (lower.includes("quota_exhausted")) return true
    if (lower.includes("quota") && lower.includes("reset")) return true
    return false
}

/**
 * 解析时长字符串，如 "42s", "2m30s", "1h30m", "500ms"
 */
function parseDurationString(s: string): number | null {
    const hourMatch = s.match(/(\d+)h/)
    const minMatch = s.match(/(\d+)m(?!s)/)
    const secMatch = s.match(/(\d+(?:\.\d+)?)s(?!$|[a-z])/i) || s.match(/(\d+(?:\.\d+)?)s$/)
    const msMatch = s.match(/(\d+)ms/)

    const hours = hourMatch ? parseInt(hourMatch[1]) : 0
    const minutes = minMatch ? parseInt(minMatch[1]) : 0
    const seconds = secMatch ? parseFloat(secMatch[1]) : 0
    const ms = msMatch ? parseInt(msMatch[1]) : 0

    const totalMs = (hours * 3600 + minutes * 60 + Math.ceil(seconds)) * 1000 + ms

    return totalMs > 0 ? totalMs : null
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
    if (options.signal) {
        if (options.signal.aborted) {
            controller.abort()
        } else {
            options.signal.addEventListener("abort", () => controller.abort(), { once: true })
        }
    }
    try {
        return await fetch(url, { ...options, signal: controller.signal })
    } finally {
        clearTimeout(timeoutId)
    }
}

const MODEL_MAPPING: Record<string, string> = {
    "gemini-4-argon": "gemini-4-argon-medium",
    "gemini-4-argon-low": "gemini-4-argon-low",
    "gemini-4-argon-medium": "gemini-4-argon-medium",
    "gemini-4-argon-high": "gemini-4-argon-high",
    "gemini-3.8-flash-tiered": "gemini-3.8-flash-medium",
    "gemini-3.8-flash-low": "gemini-3.8-flash-low",
    "gemini-3.8-flash-medium": "gemini-3.8-flash-medium",
    "gemini-3.8-flash-high": "gemini-3.8-flash-high",
    "claude-sonnet-4-5": "claude-sonnet-4-5",
    "claude-sonnet-4-5-thinking": "claude-sonnet-4-5-thinking",
    "claude-opus-4-5-thinking": "claude-opus-4-5-thinking",
    "claude-opus-4-6": "claude-opus-4-6-thinking",
    "claude-opus-4-6-thinking": "claude-opus-4-6-thinking",
    "claude-sonnet-4.5": "claude-sonnet-4-5",
    "claude-sonnet-4.5-thinking": "claude-sonnet-4-5-thinking",
    "claude-opus-4.5-thinking": "claude-opus-4-5-thinking",
    "claude-opus-4.6": "claude-opus-4-6-thinking",
    "claude-opus-4.6-thinking": "claude-opus-4-6-thinking",
    "claude-sonnet-4-5-20251001": "claude-sonnet-4-5",
    "gemini-3-pro-high": "gemini-3-pro-high",
    "gemini-3-pro-low": "gemini-3-pro-low",
    "gemini-3-flash": "gemini-3-flash",
    "gpt-oss-120b": "gpt-oss-120b-medium",
}

function getAntigravityModelName(userModel: string): string {
    return MODEL_MAPPING[userModel] || userModel
}

export interface ChatRequest {
    model: string
    messages: ClaudeMessage[]
    tools?: ClaudeTool[]
    toolChoice?: {
        type: "auto" | "any" | "tool" | "none"
        name?: string
    }
    maxTokens?: number
}

export interface ContentBlock {
    type: "text" | "tool_use"
    text?: string
    id?: string
    name?: string
    input?: any
}

export interface ChatResponse {
    contentBlocks: ContentBlock[]
    stopReason: string | null
    usage?: { inputTokens: number; outputTokens: number }
}

function generateStableSessionId(messages: ClaudeMessage[]): string {
    const userMsg = messages.find(m => m.role === "user")
    if (userMsg && typeof userMsg.content === "string") {
        let hash = 0
        for (let i = 0; i < userMsg.content.length; i++) {
            hash = ((hash << 5) - hash) + userMsg.content.charCodeAt(i)
            hash = hash & hash
        }
        return "-" + (Math.abs(hash) * 1000000000000).toString()
    }
    return "-" + Math.floor(Math.random() * 9e18).toString()
}

function extractTextContent(content: any): string {
    if (typeof content === "string") return content
    if (Array.isArray(content)) {
        const parts: string[] = []
        for (const block of content) {
            if (block.type === "text" && block.text) parts.push(block.text)
            else if (block.type === "tool_use") parts.push("[Tool: " + block.name + "]")
            else if (block.type === "tool_result" && typeof block.content === "string") parts.push(block.content)
        }
        return parts.join("\n") || "[No text]"
    }
    if (content?.text) return content.text
    return JSON.stringify(content)
}

function mergeToolResultContent(content: unknown, isError?: boolean): string {
    if (typeof content === "string") return content
    if (Array.isArray(content)) {
        const merged = content
            .map((block) => {
                if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
                    return block.text
                }
                if (block && typeof block === "object" && typeof block.text === "string") {
                    return block.text
                }
                return ""
            })
            .filter(Boolean)
            .join("\n")
        if (merged.trim()) return merged
    }
    if (content != null) return JSON.stringify(content)
    return isError ? "Tool execution failed with no output." : "Command executed successfully."
}

function generateToolUseId(): string {
    return `toolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`
}

// Gemini 3 rejects replayed functionCall parts that lack a thought_signature.
// The signature only exists at the part level of the model's original response,
// so keep a per-request id→signature map and re-emit it on the next turn.
const DUMMY_THOUGHT_SIGNATURE = "skip_thought_signature_validator"
const thoughtSignatureCache = new Map<string, string>()

function needsThoughtSignature(toolName: string, modelName: string): boolean {
    if (/^gemini-[34]/i.test(modelName)) return true
    return /^(default_api:|google:|system:)?(terminal|execute_code|bash|shell|exec|run_command|write_file|read_file|edit_file|apply_patch|codebase_search|search|list_dir|search_web|search_code)/.test(toolName)
}

function extractThoughtSignature(part: any): string | null {
    const sig = part?.thoughtSignature || part?.thought_signature
    return typeof sig === "string" && sig.length > 0 ? sig : null
}

function rememberThoughtSignature(toolCallId: string, signature: string): void {
    if (!toolCallId || !signature) return
    if (thoughtSignatureCache.has(toolCallId)) return
    if (thoughtSignatureCache.size > 4096) {
        const firstKey = thoughtSignatureCache.keys().next().value
        if (firstKey) thoughtSignatureCache.delete(firstKey)
    }
    thoughtSignatureCache.set(toolCallId, signature)
}

function getThoughtSignatureForId(toolCallId: string): string | undefined {
    return thoughtSignatureCache.get(toolCallId)
}

function parseFunctionCallArgs(args: unknown): any {
    if (args == null) return {}
    if (typeof args === "string") {
        try {
            return JSON.parse(args)
        } catch {
            return { value: args }
        }
    }
    return args
}

function buildAntigravityParts(content: ClaudeMessage["content"], toolIdToName: Map<string, string>, modelName: string): any[] {
    if (typeof content === "string") {
        return [{ text: content }]
    }

    if (!Array.isArray(content)) {
        return [{ text: extractTextContent(content) }]
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
            const toolId = block.id || generateToolUseId()
            const toolName = block.name || toolId
            toolIdToName.set(toolId, toolName)
            const functionCall: any = {
                name: toolName,
                args: block.input || {},
                id: toolId,
            }
            // Gemini 3 requires thought_signature on replayed functionCall parts.
            // In Gemini 3 the signature is a SIBLING of functionCall on the Part
            // (in 2.5 it was nested inside functionCall; the 3.x endpoint rejects the nested form).
            const blockExtra = (block as any).extra_content?.google
            const signature = (typeof blockExtra?.thought_signature === "string" && blockExtra.thought_signature) || getThoughtSignatureForId(toolId)
            const part: any = { functionCall }
            if (needsThoughtSignature(toolName, modelName) && signature) {
                part.thoughtSignature = signature
            }
            parts.push(part)
            continue
        }

        if (block.type === "tool_result") {
            const toolUseId = block.tool_use_id || ""
            const toolName = toolIdToName.get(toolUseId) || toolUseId || "tool"
            const merged = mergeToolResultContent(block.content, (block as any).is_error)
            const functionResponse: any = {
                name: toolName,
                response: { result: merged },
            }
            if (toolUseId) functionResponse.id = toolUseId
            const functionResponsePart: any = { functionResponse }
            // Gemini 3 also validates functionResponse parts that carry an id.
            if (toolUseId && needsThoughtSignature(toolName, modelName)) {
                const signature = getThoughtSignatureForId(toolUseId) || DUMMY_THOUGHT_SIGNATURE
                functionResponsePart.thoughtSignature = signature
            }
            parts.push(functionResponsePart)
            continue
        }
    }

    return parts.length > 0 ? parts : [{ text: "[No text]" }]
}

function cleanJsonSchema(schema: any): any {
    if (!schema || typeof schema !== "object") return schema
    const result: any = {}
    for (const [key, value] of Object.entries(schema)) {
        if (key.startsWith("\$") || key === "additionalProperties") continue
        if (typeof value === "object") result[key] = cleanJsonSchema(value)
        else result[key] = value
    }
    return result
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

function buildSafetySettings(): any[] {
    return [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
        { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "OFF" },
    ]
}

function buildSystemInstruction(): any {
    const antigravityIdentity = `You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.
You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.
**Absolute paths only**
**Proactiveness**`

    return {
        role: "user",
        parts: [
            { text: antigravityIdentity },
            { text: "\n--- [SYSTEM_PROMPT_END] ---" }
        ]
    }
}

function buildFunctionCallingConfig(toolChoice?: ChatRequest["toolChoice"]): any {
    if (!toolChoice) {
        return { mode: "VALIDATED" }
    }

    switch (toolChoice.type) {
        case "none":
            return { mode: "NONE" }
        case "any":
            return { mode: "ANY" }
        case "tool":
            return {
                mode: "ANY",
                ...(toolChoice.name ? { allowedFunctionNames: [toolChoice.name] } : {})
            }
        case "auto":
        default:
            return { mode: "VALIDATED" }
    }
}

function claudeToAntigravity(
    model: string,
    messages: ClaudeMessage[],
    tools?: ClaudeTool[],
    toolChoice?: ChatRequest["toolChoice"]
): any {
    const toolIdToName = new Map<string, string>()
    const contents = messages.map((msg) => ({
        role: msg.role === "assistant" ? "model" : msg.role,
        parts: buildAntigravityParts(msg.content, toolIdToName, model),
    }))

    const sessionId = generateStableSessionId(messages)
    const projectId = state.cloudaicompanionProject || "unknown"

    const innerRequest: any = {
        contents,
        sessionId,
        safetySettings: buildSafetySettings(),
        systemInstruction: buildSystemInstruction(),
        generationConfig: {
            maxOutputTokens: 64000,
            stopSequences: ["\n\nHuman:", "[DONE]"],
        },
    }

    if (model.includes("claude") || model.includes("gemini")) {
        innerRequest.toolConfig = { functionCallingConfig: buildFunctionCallingConfig(toolChoice) }
    }

    if (tools && tools.length > 0 && (model.includes("claude") || model.includes("gemini"))) {
        innerRequest.tools = tools.map(tool => ({
            functionDeclarations: [{
                name: tool.name,
                description: tool.description,
                parameters: normalizeToolParameters(tool.input_schema)
            }]
        }))
    }

    return {
        model,
        userAgent: DEFAULT_USER_AGENT,
        requestType: "agent",
        project: projectId,
        requestId: "agent-" + crypto.randomUUID(),
        request: innerRequest,
    }
}

function parseApiResponse(rawResponse: string): ChatResponse {
    let chunks: any[] = []
    const trimmed = rawResponse.trim()
    if (trimmed.startsWith("[")) chunks = JSON.parse(trimmed)
    else if (trimmed.startsWith("{")) chunks = [JSON.parse(trimmed)]
    if (chunks.length === 0) throw new Error("Empty response")

    const lastChunk = chunks[chunks.length - 1]
    if (!lastChunk?.response) throw new Error("No valid response")

    const contentBlocks: ContentBlock[] = []
    let hasToolUse = false

    for (const chunk of chunks) {
        const parts = chunk.response?.candidates?.[0]?.content?.parts || []
        for (const part of parts) {
            if (part.text) {
                const last = contentBlocks[contentBlocks.length - 1]
                if (last?.type === "text") last.text = (last.text || "") + part.text
                else contentBlocks.push({ type: "text", text: part.text })
            }
            if (part.functionCall) {
                hasToolUse = true
                const input = parseFunctionCallArgs(part.functionCall.args)
                const toolCallId = part.functionCall.id || generateToolUseId()
                const signature = extractThoughtSignature(part)
                if (signature) rememberThoughtSignature(toolCallId, signature)
                contentBlocks.push({
                    type: "tool_use",
                    id: toolCallId,
                    name: part.functionCall.name,
                    input,
                    ...(signature ? { extra_content: { google: { thought_signature: signature } } } : {}),
                })
            }
        }
    }

    if (contentBlocks.length === 0) contentBlocks.push({ type: "text", text: "" })

    const usage = lastChunk.response.usageMetadata || lastChunk.usageMetadata
    return {
        contentBlocks,
        stopReason: hasToolUse ? "tool_use" : "end_turn",
        usage: { inputTokens: usage?.promptTokenCount || 0, outputTokens: (usage?.candidatesTokenCount || 0) + (usage?.thoughtsTokenCount || 0) },
    }
}

// 429 is handled separately - it's account-specific, not endpoint-specific
function shouldTryNextEndpoint(statusCode: number): boolean {
    return statusCode === 403 || statusCode === 408 || statusCode === 404 || statusCode >= 500
}

function getRetryableErrorPriority(statusCode: number): number {
    if (statusCode === 529) return 70
    if (statusCode >= 500) return 60
    if (statusCode === 429) return 50
    if (statusCode === 403) return 45
    if (statusCode === 408) return 40
    if (statusCode === 404) return 10
    return 0
}

function shouldPreferRetryableError(nextStatus: number, currentStatus: number): boolean {
    return getRetryableErrorPriority(nextStatus) > getRetryableErrorPriority(currentStatus)
}

function extractMissingProjectId(errorText: string): string | null {
    const body = (errorText || "").trim()
    if (!body) return null
    if (!(body.startsWith("{") || body.startsWith("["))) return null
    try {
        const json = JSON.parse(body)
        const details = json?.error?.details
        if (!Array.isArray(details)) return null
        for (const detail of details) {
            const resourceName = String(detail?.resourceName || "")
            const match = resourceName.match(/^projects\/([^/]+)$/)
            if (match?.[1]) return match[1]
        }
    } catch {
        return null
    }
    return null
}

async function refreshProjectFrom404(
    accountId: string | undefined,
    currentAccessToken: string,
    antigravityRequest: any,
    errorText: string
): Promise<boolean> {
    if (!accountId) return false
    const missingProjectId = extractMissingProjectId(errorText)
    if (!missingProjectId) return false

    try {
        const refreshedProjectId = await accountManager.refreshProjectId(accountId, currentAccessToken)
        if (!refreshedProjectId) return false
        antigravityRequest.project = refreshedProjectId
        consola.warn(`[Antigravity] Refreshed project for ${accountId}: ${missingProjectId} -> ${refreshedProjectId}`)
        return true
    } catch {
        return false
    }
}

async function sendRequestSse(
    endpoint: string,
    antigravityRequest: any,
    accessToken: string,
    accountId?: string,
    allowRotation: boolean = true,
    modelName?: string,
    routeTag?: string
): Promise<string> {
    const startTime = Date.now()
    let lastError: Error | null = null
    let lastStatusCode = 0
    let lastErrorText = ""
    let lastRetryAfterHeader: string | undefined
    let preferredRetryStatusCode = 0
    let preferredRetryErrorText = ""
    let preferredRetryAfterHeader: string | undefined
    let currentAccessToken = accessToken
    let currentAccountId = accountId
    let nonQuota429Count = 0
    const projectRefreshAttempts = new Set<string>()

    const rotationBudget = allowRotation ? Math.max(0, accountManager.count() - 1) : 0
    const maxAttempts = Math.max(MAX_RETRY_ATTEMPTS, MAX_NON_QUOTA_429_RETRIES + 1 + rotationBudget)
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // 锁已在 handler.ts HTTP 层获取，这里不需要
        for (const baseUrl of ANTIGRAVITY_BASE_URLS) {
            const url = baseUrl + endpoint + "?alt=sse"
            try {
                const response = await fetchWithTimeout(url, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": "Bearer " + currentAccessToken,
                        "User-Agent": DEFAULT_USER_AGENT,
                        "Accept": "text/event-stream",
                    },
                    body: JSON.stringify(antigravityRequest),
                }, FETCH_TIMEOUT_MS)

                if (response.ok) {
                    if (currentAccountId) {
                        accountManager.markSuccess(currentAccountId, modelName)
                        if (antigravityRequest?.model && antigravityRequest.model !== modelName) {
                            accountManager.markSuccess(currentAccountId, antigravityRequest.model)
                        }
                    }

                    // Log 200 success with actual account used and elapsed time (green)
                    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
                    const account = currentAccountId ? await accountManager.getAccountById(currentAccountId) : null
                    const accountDisplay = account?.email || currentAccountId || "-"
                    console.log(formatSuccessLine({
                        elapsed,
                        model: modelName || "unknown",
                        provider: "antigravity",
                        account: accountDisplay,
                        routeTag,
                    }))

                    return await response.text()
                }

                lastStatusCode = response.status
                lastRetryAfterHeader = response.headers.get("retry-after") || undefined
                lastErrorText = await response.text()
                consola.warn("SSE error " + response.status, lastErrorText.substring(0, 200))

                if (response.status === 404 && currentAccountId && !projectRefreshAttempts.has(currentAccountId)) {
                    projectRefreshAttempts.add(currentAccountId)
                    const refreshed = await refreshProjectFrom404(currentAccountId, currentAccessToken, antigravityRequest, lastErrorText)
                    if (refreshed) {
                        lastError = new Error("404 - project refreshed")
                        break
                    }
                }

                if (lastStatusCode === 429 && currentAccountId) {
                    const quotaExhausted = isQuotaExhaustedErrorText(lastErrorText)
                    // 🆕 解析等待时间，如果无法解析则使用默认 2 秒
                    const parsedDelay = parseRetryDelay(lastErrorText, lastRetryAfterHeader)
                    const retryDelayMs = parsedDelay ?? 2000  // 默认 2 秒
                    const boundedDelayMs = Math.min(retryDelayMs, MAX_NON_QUOTA_429_WAIT_MS)

                    // 🆕 非配额 429：始终重试同一账号，不切换
                    if (!quotaExhausted && nonQuota429Count < MAX_NON_QUOTA_429_RETRIES) {
                        await new Promise(resolve => setTimeout(resolve, boundedDelayMs + 200)) // 加 200ms 缓冲

                        nonQuota429Count += 1
                        lastError = new Error("429 - waited and retry")
                        break // 跳出 endpoint 循环，进入下一轮 attempt
                    }

                    // 仅在配额耗尽时才切换账号
                    if (quotaExhausted) {
                        const perModelCooldownMs = Math.min(Math.max(retryDelayMs, 15_000), 60_000)
                        accountManager.markModelRateLimited(currentAccountId, modelName, perModelCooldownMs)
                        accountManager.markModelRateLimited(currentAccountId, antigravityRequest?.model, perModelCooldownMs)

                        if (allowRotation && accountManager.count() > 1) {
                            const limitResult = await accountManager.markRateLimitedFromError(
                                currentAccountId,
                                lastStatusCode,
                                lastErrorText,
                                lastRetryAfterHeader,
                                undefined,
                                // 明確的配額耗盡是帳號級事件，值得封禁整個帳號
                                { maxDurationMs: 60_000, forceAccountScope: true }
                            )

                            if (limitResult?.reason === "quota_exhausted") {
                                accountManager.moveToEndOfQueue(currentAccountId)
                            }

                            const next = await accountManager.getNextAvailableAccount(true)
                            if (next && next.accountId !== currentAccountId) {
                                currentAccessToken = next.accessToken
                                currentAccountId = next.accountId
                                antigravityRequest.project = next.projectId
                                // Break out of endpoint loop to retry with new account
                                lastError = new Error("429 - switched account")
                                break
                            }
                        }
                        throw new UpstreamError("antigravity", 429, lastErrorText, lastRetryAfterHeader)
                    }
                    if (!quotaExhausted) {
                        const cooldownMs = Math.max(boundedDelayMs, NON_QUOTA_429_COOLDOWN_MS)
                        accountManager.markModelRateLimited(currentAccountId, modelName, cooldownMs)
                        accountManager.markModelRateLimited(currentAccountId, antigravityRequest?.model, cooldownMs)
                        // 🆕 2026-10-02: 同 chat.ts 內另一處 SSE 分支的處理。
                        // 只有真的有其他帳號可輪替時才標記；單帳號時標記只會讓
                        // 同一帳號下所有其他模型一起回 400 "No account routing
                        // entries"（實測 gemini-3.8-flash-high 的 429 會拖死
                        // claude-sonnet-4-6 與 gemini-3-flash）。
                        if (allowRotation && accountManager.count() > 1) {
                            accountManager.markRateLimited(currentAccountId, cooldownMs)
                            const next = await accountManager.getNextAvailableAccount(true)
                            if (next && next.accountId !== currentAccountId) {
                                currentAccessToken = next.accessToken
                                currentAccountId = next.accountId
                                antigravityRequest.project = next.projectId
                                nonQuota429Count = 0
                                lastError = new Error("429 - switched account")
                                break
                            }
                        }
                        const upstream = new UpstreamError("antigravity", 429, lastErrorText, lastRetryAfterHeader)
                        ;(upstream as any).retryable = true
                        throw upstream
                    }
                    // Non-quota 429 with no rotation path
                    throw new UpstreamError("antigravity", 429, lastErrorText, lastRetryAfterHeader)
                }

                // 🆕 401 处理：刷新 token 并重试
                if (lastStatusCode === 401 && currentAccountId) {
                    try {
                        const refreshed = await accountManager.getAccountById(currentAccountId)
                        if (refreshed) {
                            currentAccessToken = refreshed.accessToken
                            // Break endpoint loop to retry with new token
                            lastError = new Error("401 - token refreshed")
                            break
                        }
                    } catch (e) {
                        consola.warn(`Failed to refresh token for ${currentAccountId}:`, e)
                    }
                    // If refresh failed, try next account
                    if (allowRotation && accountManager.count() > 1) {
                        const next = await accountManager.getNextAvailableAccount(true)
                        if (next && next.accountId !== currentAccountId) {
                            currentAccessToken = next.accessToken
                            currentAccountId = next.accountId
                            antigravityRequest.project = next.projectId
                            lastError = new Error("401 - switched account")
                            break
                        }
                    }
                    throw new UpstreamError("antigravity", 401, lastErrorText, lastRetryAfterHeader)
                }

                if (shouldTryNextEndpoint(lastStatusCode)) {
                    if (shouldPreferRetryableError(lastStatusCode, preferredRetryStatusCode)) {
                        preferredRetryStatusCode = lastStatusCode
                        preferredRetryErrorText = lastErrorText
                        preferredRetryAfterHeader = lastRetryAfterHeader
                    }
                    lastError = new Error("SSE API error: " + response.status)
                    continue
                }

                throw new UpstreamError("antigravity", response.status, lastErrorText, lastRetryAfterHeader)
            } catch (e) {
                // 🆕 UpstreamError (包括 429) 立即重新抛出，不继续尝试
                if (e instanceof UpstreamError) throw e
                lastError = e as Error
                continue
            }
        }

        // 🆕 如果是账户切换、token 刷新或已等待重试，直接继续下一轮 attempt（不等待 delay）
        if (lastError?.message === "429 - switched account" ||
            lastError?.message === "429 - waited and retry" ||
            lastError?.message === "401 - token refreshed" ||
            lastError?.message === "401 - switched account" ||
            lastError?.message === "404 - project refreshed") {
            continue
        }

        if (lastStatusCode > 0) {
            const strategy = determineRetryStrategy(lastStatusCode, lastErrorText, lastRetryAfterHeader)
            await applyRetryDelay(strategy, attempt)
            if (attempt < MAX_RETRY_ATTEMPTS - 1) continue
        }
        break
    }
    if (preferredRetryStatusCode > 0) {
        throw new UpstreamError("antigravity", preferredRetryStatusCode, preferredRetryErrorText, preferredRetryAfterHeader)
    }
    if (lastStatusCode > 0) {
        throw new UpstreamError("antigravity", lastStatusCode, lastErrorText, lastRetryAfterHeader)
    }
    throw lastError || new Error("All endpoints failed")
}

/**
 * 🆕 真正的流式 SSE 请求 - 边读边 yield
 * 参考 proj-1 的 create_claude_sse_stream 实现
 * 增加了超时保护和错误恢复
 */
async function* sendRequestSseStreaming(
    endpoint: string,
    antigravityRequest: any,
    accessToken: string,
    accountId?: string,
    allowRotation: boolean = true,
    modelName?: string,
    routeTag?: string
): AsyncGenerator<string, void, unknown> {
    const startTime = Date.now()
    const IDLE_TIMEOUT_MS = 900000  // 超过 15 分钟无数据则中断
    const IDLE_CHECK_MS = 5000
    let lastError: UpstreamError | null = null
    let currentAccessToken = accessToken
    let currentAccountId = accountId
    let nonQuota429Count = 0
    const projectRefreshAttempts = new Set<string>()
    let preferredRetryStatusCode = 0
    let preferredRetryErrorText = ""
    let preferredRetryAfterHeader: string | undefined
    const rotationBudget = allowRotation ? Math.max(0, accountManager.count() - 1) : 0
    const maxAttempts = MAX_NON_QUOTA_429_RETRIES + 1 + rotationBudget

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        let retryAttempt = false
        for (const baseUrl of ANTIGRAVITY_BASE_URLS) {
            const url = baseUrl + endpoint + "?alt=sse"

            let hasYielded = false
            let lastChunkAt = Date.now()
            let idleTimedOut = false
            const idleController = new AbortController()

            try {
                const response = await fetchWithTimeout(url, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": "Bearer " + currentAccessToken,
                        "User-Agent": DEFAULT_USER_AGENT,
                        "Accept": "text/event-stream",
                    },
                    body: JSON.stringify(antigravityRequest),
                    signal: idleController.signal,
                }, FETCH_TIMEOUT_MS)

                if (!response.ok) {
                    const errorText = await response.text()
                    if (response.status === 404 && currentAccountId && !projectRefreshAttempts.has(currentAccountId)) {
                        projectRefreshAttempts.add(currentAccountId)
                        const refreshed = await refreshProjectFrom404(currentAccountId, currentAccessToken, antigravityRequest, errorText)
                        if (refreshed) {
                            retryAttempt = true
                            break
                        }
                    }
                    if (response.status === 429 && currentAccountId) {
                        const quotaExhausted = isQuotaExhaustedErrorText(errorText)
                        const retryAfter = response.headers.get("retry-after") || undefined
                        const parsedDelay = parseRetryDelay(errorText, retryAfter)
                        if (quotaExhausted) {
                            const perModelCooldownMs = Math.min(Math.max(parsedDelay ?? 15_000, 15_000), 60_000)
                            accountManager.markModelRateLimited(currentAccountId, modelName, perModelCooldownMs)
                            accountManager.markModelRateLimited(currentAccountId, antigravityRequest?.model, perModelCooldownMs)
                            if (allowRotation && accountManager.count() > 1) {
                                const limitResult = await accountManager.markRateLimitedFromError(currentAccountId, response.status, errorText, undefined, undefined, { maxDurationMs: 60_000, forceAccountScope: true })
                                if (limitResult?.reason === "quota_exhausted") {
                                    accountManager.moveToEndOfQueue(currentAccountId)
                                }
                            }
                            lastError = new UpstreamError("antigravity", response.status, errorText, retryAfter)
                            throw lastError
                        }

                        const waitMs = Math.min(parsedDelay ?? 2000, MAX_NON_QUOTA_429_WAIT_MS)
                        if (nonQuota429Count < MAX_NON_QUOTA_429_RETRIES) {
                            await new Promise(resolve => setTimeout(resolve, waitMs))
                            nonQuota429Count += 1
                            lastError = new UpstreamError("antigravity", response.status, errorText, retryAfter)
                            retryAttempt = true
                            break
                        }
                        const cooldownMs = Math.max(waitMs, NON_QUOTA_429_COOLDOWN_MS)
                        accountManager.markModelRateLimited(currentAccountId, modelName, cooldownMs)
                        accountManager.markModelRateLimited(currentAccountId, antigravityRequest?.model, cooldownMs)
                        // 🆕 2026-10-02: 只有在真的有其他帳號可切換時才標記限流。
                        // 標記是「這個帳號暫時別用」的意思，會讓該帳號下所有模型
                        // 一起回 400 "No account routing entries"。單帳號設定下沒有
                        // 可輪替的目標，標記純粹是有害的副作用——實測
                        // gemini-3.8-flash-high 一次 429 就讓當下完全正常的
                        // claude-sonnet-4-6 與 gemini-3-flash 跟著掛掉。
                        if (allowRotation && accountManager.count() > 1) {
                            accountManager.markRateLimited(currentAccountId, cooldownMs)
                            const next = await accountManager.getNextAvailableAccount(true)
                            if (next && next.accountId !== currentAccountId) {
                                currentAccessToken = next.accessToken
                                currentAccountId = next.accountId
                                antigravityRequest.project = next.projectId
                                nonQuota429Count = 0
                                retryAttempt = true
                                break
                            }
                        }
                        const upstream = new UpstreamError("antigravity", response.status, errorText, retryAfter)
                        ;(upstream as any).retryable = true
                        throw upstream
                    }
                    if (shouldTryNextEndpoint(response.status)) {
                        if (shouldPreferRetryableError(response.status, preferredRetryStatusCode)) {
                            preferredRetryStatusCode = response.status
                            preferredRetryErrorText = errorText
                            preferredRetryAfterHeader = response.headers.get("retry-after") || undefined
                        }
                        lastError = new UpstreamError("antigravity", response.status, errorText, response.headers.get("retry-after") || undefined)
                        continue
                    }
                    throw new UpstreamError("antigravity", response.status, errorText, response.headers.get("retry-after") || undefined)
                }

                if (currentAccountId) {
                    accountManager.markSuccess(currentAccountId, modelName)
                    if (antigravityRequest?.model && antigravityRequest.model !== modelName) {
                        accountManager.markSuccess(currentAccountId, antigravityRequest.model)
                    }
                }

                const reader = response.body?.getReader()
                if (!reader) {
                    throw new Error("Response body is not readable")
                }

                const decoder = new TextDecoder()
                let buffer = ""
                const idleTimer = setInterval(() => {
                    if (Date.now() - lastChunkAt > IDLE_TIMEOUT_MS) {
                        idleTimedOut = true
                        idleController.abort()
                    }
                }, IDLE_CHECK_MS)

                try {
                    while (true) {
                        let result: any
                        try {
                            result = await reader.read()
                        } catch (readError) {
                            if (idleTimedOut) {
                                throw new Error("Stream idle timeout")
                            }
                            consola.warn("[SSE Streaming] Read error:", readError)
                            throw readError
                        }

                        const { done, value } = result
                        if (done) break

                        if (value && value.length > 0) {
                            lastChunkAt = Date.now()
                        }
                        buffer += decoder.decode(value, { stream: true })

                        // Parse SSE by event blocks to handle multi-line data payloads
                        const events = buffer.split(/\r?\n\r?\n/)
                        buffer = events.pop() || ""  // Keep incomplete tail

                        for (const event of events) {
                            const data = extractSseEventData(event)
                            if (!data) continue

                            const trimmed = data.trim()
                            if (!trimmed || trimmed === "[DONE]") continue

                            try {
                                const parsed = JSON.parse(trimmed)
                                yield JSON.stringify(parsed)
                                hasYielded = true
                            } catch {
                                // Ignore non-JSON payloads
                            }
                        }
                    }

                    // Handle any leftover event data
                    const tailData = extractSseEventData(buffer)
                    if (tailData) {
                        const trimmed = tailData.trim()
                        if (trimmed && trimmed !== "[DONE]") {
                            try {
                                const parsed = JSON.parse(trimmed)
                                yield JSON.stringify(parsed)
                                hasYielded = true
                            } catch {
                                // ignore
                            }
                        }
                    }

                    // 如果没有产出任何数据，抛出错误
                    if (!hasYielded) {
                        throw new Error("Stream completed without yielding any data")
                    }

                } finally {
                    clearInterval(idleTimer)
                    try {
                        reader.releaseLock()
                    } catch {
                        // 忽略 releaseLock 错误
                    }
                }

                // 成功完成 - 在 return 之前记录日志
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
                const account = currentAccountId ? await accountManager.getAccountById(currentAccountId) : null
                const accountDisplay = account?.email || currentAccountId || "-"
                console.log(formatSuccessLine({
                    elapsed,
                    model: modelName || "unknown",
                    provider: "antigravity",
                    account: accountDisplay,
                    routeTag,
                }))
                return

            } catch (error) {
                if (error instanceof UpstreamError) {
                    if (hasYielded) {
                        ;(error as any).streamingStarted = true
                    }
                    throw error
                }
                if (hasYielded) throw error
                consola.warn("[SSE Streaming] Error on", baseUrl, error)
                continue
            }
        }
        if (!retryAttempt) {
            break
        }
    }

    if (preferredRetryStatusCode > 0) {
        throw new UpstreamError("antigravity", preferredRetryStatusCode, preferredRetryErrorText, preferredRetryAfterHeader)
    }
    if (lastError) {
        throw lastError
    }
    throw new Error("All endpoints failed")
}

function collectSseChunks(rawSse: string): any[] {
    const chunks: any[] = []

    // Parse SSE by event blocks to handle multi-line data payloads
    const events = rawSse.split(/\r?\n\r?\n/)
    for (const event of events) {
        const data = extractSseEventData(event)
        if (!data) continue
        const trimmed = data.trim()
        if (!trimmed || trimmed === "[DONE]") continue
        try {
            const parsed = JSON.parse(trimmed)
            chunks.push(parsed)
        } catch {
            // ignore parse errors
        }
    }

    return chunks
}

function extractSseEventData(event: string): string | null {
    const dataLines: string[] = []
    const lines = event.split(/\r?\n/)
    for (const line of lines) {
        if (!line.startsWith("data:")) continue
        let value = line.slice(5)
        if (value.startsWith(" ")) value = value.slice(1)
        dataLines.push(value)
    }
    if (dataLines.length === 0) return null
    return dataLines.join("\n")
}

/** Fail fast before acquiring the per-account lock when a model is already in cooldown. */
function throwIfModelRateLimited(
    accountId: string | undefined,
    requestModel: string,
    targetModel: string,
    allowRotation: boolean | undefined
): void {
    if (!accountId) return
    if (allowRotation && accountManager.count() > 1) return
    if (!accountManager.isModelRateLimited(accountId, requestModel) && !accountManager.isModelRateLimited(accountId, targetModel)) {
        return
    }
    const waitMs = Math.max(
        accountManager.getModelRateLimitWait(accountId, requestModel),
        accountManager.getModelRateLimitWait(accountId, targetModel)
    )
    const waitSec = Math.max(1, Math.ceil(waitMs / 1000))
    throw new UpstreamError(
        "antigravity",
        429,
        JSON.stringify({
            error: {
                code: 429,
                status: "RESOURCE_EXHAUSTED",
                details: [{ reason: "RATE_LIMIT_EXCEEDED" }],
                message: `Model ${requestModel} is in cooldown for ${waitSec}s.`,
            },
        })
    )
}

export async function createChatCompletion(request: ChatRequest): Promise<ChatResponse> {
    return createChatCompletionWithOptions(request)
}

export async function createChatCompletionWithOptions(
    request: ChatRequest,
    options: { accountId?: string; allowRotation?: boolean; routeTag?: string } = {}
): Promise<ChatResponse> {
    let accessToken: string
    let accountId: string | undefined
    let projectId: string | undefined
    let accountEmail: string | undefined
    let releaseAccountLock: (() => void) | null = null

    if (options.accountId) {
        const account = await accountManager.getAccountById(options.accountId)
        if (!account) {
            throw new UpstreamError("antigravity", 429, `Account unavailable: ${options.accountId}`)
        }
        accessToken = account.accessToken
        accountId = account.accountId
        projectId = account.projectId
        accountEmail = account.email
    } else {
        const account = await accountManager.getNextAvailableAccount()
        if (account) {
            accessToken = account.accessToken
            accountId = account.accountId
            projectId = account.projectId
            accountEmail = account.email
        } else {
            accessToken = await getAccessToken()
            projectId = state.cloudaicompanionProject || undefined
            accountEmail = state.userEmail || undefined
        }
    }

    setRequestLogContext({ model: request.model, provider: "antigravity", account: accountEmail, routeTag: options.routeTag })

    const targetModel = getAntigravityModelName(request.model)
    throwIfModelRateLimited(accountId, request.model, targetModel, options.allowRotation ?? true)

    if (accountId) {
        releaseAccountLock = await accountManager.acquireAccountLock(accountId)
    }

    try {
    const antigravityRequest = claudeToAntigravity(
        targetModel,
        request.messages,
        request.tools,
        request.toolChoice
    )

        if (projectId) antigravityRequest.project = projectId

        const rawSse = await sendRequestSse(
            STREAM_ENDPOINT,
            antigravityRequest,
            accessToken,
            accountId,
            options.allowRotation ?? true,
            request.model,
            options.routeTag
        )
        const sseChunks = collectSseChunks(rawSse)
        const rawResponse = sseChunks.length > 0 ? JSON.stringify(sseChunks) : rawSse

        const result = parseApiResponse(rawResponse)

        // Record usage (fire-and-forget) - use actual native model ID
        const inputTokens = result.usage?.inputTokens || 0
        const outputTokens = result.usage?.outputTokens || 0
        const actualModelId = targetModel
        if (inputTokens > 0 || outputTokens > 0) {
            import("~/services/usage-tracker").then(({ recordUsage }) => {
                recordUsage(actualModelId, inputTokens, outputTokens)
            }).catch(() => { })
        }

        return result
    } finally {
        if (releaseAccountLock) releaseAccountLock()
    }
}

export async function* createChatCompletionStream(request: ChatRequest): AsyncGenerator<string, void, unknown> {
    yield* createChatCompletionStreamWithOptions(request)
}

export async function* createChatCompletionStreamWithOptions(
    request: ChatRequest,
    options: { accountId?: string; allowRotation?: boolean; routeTag?: string } = {}
): AsyncGenerator<string, void, unknown> {
    let accessToken: string
    let accountId: string | undefined
    let projectId: string | undefined
    let accountEmail: string | undefined
    let releaseAccountLock: (() => void) | null = null

    if (options.accountId) {
        const account = await accountManager.getAccountById(options.accountId)
        if (!account) {
            throw new UpstreamError("antigravity", 429, `Account unavailable: ${options.accountId}`)
        }
        accessToken = account.accessToken
        accountId = account.accountId
        projectId = account.projectId
        accountEmail = account.email
    } else {
        const account = await accountManager.getNextAvailableAccount()
        if (account) {
            accessToken = account.accessToken
            accountId = account.accountId
            projectId = account.projectId
            accountEmail = account.email
        } else {
            accessToken = await getAccessToken()
            projectId = state.cloudaicompanionProject || undefined
            accountEmail = state.userEmail || undefined
        }
    }

    const targetModel = getAntigravityModelName(request.model)
    throwIfModelRateLimited(accountId, request.model, targetModel, options.allowRotation ?? true)

    if (accountId) {
        releaseAccountLock = await accountManager.acquireAccountLock(accountId)
    }

    try {
        const antigravityRequest = claudeToAntigravity(
            targetModel,
            request.messages,
            request.tools,
            request.toolChoice
        )

        if (projectId) antigravityRequest.project = projectId

        // 🆕 使用真正的流式读取，边读边处理边 yield
        const sseStream = sendRequestSseStreaming(
            STREAM_ENDPOINT,
            antigravityRequest,
            accessToken,
            accountId,
            options.allowRotation ?? true,
            request.model,
            options.routeTag
        )

        let blockIndex = 0
        let hasToolUse = false
        let outputTokens = 0
        let textBlockStarted = false

    const messageStart = {
        type: "message_start",
        message: {
            id: "msg_" + crypto.randomUUID().replace(/-/g, "").slice(0, 24),
            type: "message",
            role: "assistant",
            content: [],
            model: request.model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 }
        }
    }
    yield "event: message_start\ndata: " + JSON.stringify(messageStart) + "\n\n"

    for await (const chunkStr of sseStream) {
        // 解析 JSON 字符串
        let chunk: any
        try {
            chunk = JSON.parse(chunkStr)
        } catch {
            continue
        }

        // chunk 可能直接是响应，也可能包含 response 字段
        const responseData = chunk.response || chunk
        const parts = responseData?.candidates?.[0]?.content?.parts || []

        for (const part of parts) {
            if (part.text) {
                // 只在第一次遇到文本时发送 block_start
                if (!textBlockStarted) {
                    yield "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":" + blockIndex + ",\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n"
                    textBlockStarted = true
                }
                // 每个 text chunk 只发送 delta
                const textDelta = { type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text: part.text } }
                yield "event: content_block_delta\ndata: " + JSON.stringify(textDelta) + "\n\n"
            }
            if (part.functionCall) {
                // 先关闭文本块（如果有）
                if (textBlockStarted) {
                    yield "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":" + blockIndex + "}\n\n"
                    blockIndex++
                    textBlockStarted = false
                }

                hasToolUse = true
                const toolCallId = part.functionCall.id || generateToolUseId()
                const signature = extractThoughtSignature(part)
                if (signature) rememberThoughtSignature(toolCallId, signature)
                const toolStart = { type: "content_block_start", index: blockIndex, content_block: { type: "tool_use", id: toolCallId, name: part.functionCall.name, input: {}, ...(signature ? { extra_content: { google: { thought_signature: signature } } } : {}) } }
                yield "event: content_block_start\ndata: " + JSON.stringify(toolStart) + "\n\n"
                if (part.functionCall.args) {
                    const rawArgs = part.functionCall.args
                    const partialJson = typeof rawArgs === "string" ? rawArgs : (JSON.stringify(rawArgs) || "{}")
                    const inputDelta = { type: "content_block_delta", index: blockIndex, delta: { type: "input_json_delta", partial_json: partialJson } }
                    yield "event: content_block_delta\ndata: " + JSON.stringify(inputDelta) + "\n\n"
                }
                yield "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":" + blockIndex + "}\n\n"
                blockIndex++
            }
        }

            const usage = responseData?.usageMetadata
            if (usage) outputTokens = (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0)
        }

        // 关闭最后的文本块（如果有）
        if (textBlockStarted) {
            yield "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":" + blockIndex + "}\n\n"
        }

    if (!hasToolUse && request.toolChoice?.type === "tool") {
        consola.warn(`Tool choice "${request.toolChoice.name || "unknown"}" requested but no tool_use returned`)
    }
    const stopReason = hasToolUse ? "tool_use" : "end_turn"
        const messageDelta = { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } }
        yield "event: message_delta\ndata: " + JSON.stringify(messageDelta) + "\n\n"
        yield "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"

        // Record usage (fire-and-forget) - use actual native model ID
        const actualModelId = getAntigravityModelName(request.model)
        if (outputTokens > 0) {
            import("~/services/usage-tracker").then(({ recordUsage }) => {
                recordUsage(actualModelId, 0, outputTokens)
            }).catch(() => { })
        }
    } finally {
        if (releaseAccountLock) releaseAccountLock()
    }
}
