/**
 * Antigravity Chat Service - Cloud API Version
 * v2.1.0
 */

import consola from "consola"
import { existsSync, readFileSync, writeFileSync, rmSync } from "fs"
import { join } from "path"
import { getDataDir, ensureDataDir } from "~/lib/data-dir"
import { getAccessToken } from "./oauth"
import { accountManager } from "./account-manager"
import { state } from "~/lib/state"
import {
    type ClaudeMessage,
    type ClaudeTool,
    buildMessageStart,
    buildContentBlockStart,
    buildTextDelta,
    buildInputJsonDelta,
    buildContentBlockStop,
    buildMessageDelta,
    buildMessageStop,
} from "~/lib/translator"
import { determineRetryStrategy, applyRetryDelay, parseRetryDelay } from "~/lib/retry"
import { RequestValidationError, UpstreamError } from "~/lib/error"
import { cleanJsonSchemaForGemini } from "~/lib/json-schema-cleaner"
import { formatSuccessLine, setRequestLogContext } from "~/lib/logger"
import { getAntigravityUserAgent } from "~/lib/antigravity-client"
import { fetchRemoteImageAsBase64, fetchRemoteAudioAsBase64 } from "~/lib/remote-image"
import { createImageInputBudget, decodedBase64ImageBytes, type ImageInputBudget } from "~/lib/image-input"
import { safeErrorMessage } from "~/lib/redaction"
import { resolveAntigravityAlias, parseModelId, compareVersions } from "~/lib/model-catalog"
import { getCachedAntigravityModelsForAccount } from "~/services/quota-aggregator"
import { getDynamicAntigravityModelIdsForAccount } from "~/services/routing/models"

accountManager.load()

const ANTIGRAVITY_BASE_URLS = [
    "https://daily-cloudcode-pa.googleapis.com",       // v2.0.1: 优先使用 daily 端点（更稳定）
    "https://daily-cloudcode-pa.sandbox.googleapis.com",
    "https://cloudcode-pa.googleapis.com",
]
const STREAM_ENDPOINT = "/v1internal:streamGenerateContent"
const MAX_RETRY_ATTEMPTS = 1  // v2.0.1 恢复：简化重试，避免级联 429
const MAX_NON_QUOTA_429_RETRIES = 2  // Non-quota 429 retries before switching accounts
const MAX_NON_QUOTA_429_WAIT_MS = 4000  // Upper bound for non-quota 429 wait time
const NON_QUOTA_429_COOLDOWN_MS = 8000  // Cooldown before retrying a rate-limited account
const FETCH_TIMEOUT_MS = 30000  // 防止上游请求长期卡住

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

async function fetchWithTimeout(
    url: string,
    options: RequestInit & { proxy?: string },
    timeoutMs: number
): Promise<Response> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
    const requestSignal = options.signal
    const abortFromRequest = () => controller.abort()
    if (requestSignal) {
        if (requestSignal.aborted) {
            controller.abort()
        } else {
            requestSignal.addEventListener("abort", abortFromRequest, { once: true })
        }
    }
    try {
        const fetchInit: any = { ...options, signal: controller.signal }
        if (options.proxy) {
            fetchInit.proxy = options.proxy
        }
        return await fetch(url, fetchInit)
    } finally {
        clearTimeout(timeoutId)
        requestSignal?.removeEventListener("abort", abortFromRequest)
    }
}

/** Maps every alias to `target`. */
function aliasesTo(target: string, ...aliases: string[]): Array<[string, string]> {
    return aliases.map(alias => [alias, target])
}

/** Native IDs that map to themselves. */
function identity(...ids: string[]): Array<[string, string]> {
    return ids.map(id => [id, id])
}

const MODEL_MAPPING: Record<string, string> = Object.fromEntries([
    // Gemini 4 Argon
    ...aliasesTo("gemini-4-argon-medium", "gemini-4-argon", "gemini-argon", "argon"),
    ...aliasesTo("gemini-4-argon-high", "gemini-4-argon-thinking", "gemini-argon-thinking"),
    ...["high", "medium", "low"].flatMap(v => [
        ...identity(`gemini-4-argon-${v}`),
        ...aliasesTo(`gemini-4-argon-${v}`, `gemini-argon-${v}`),
    ]),

    // Gemini 3.8 Flash
    ...aliasesTo("gemini-3.8-flash-medium", "gemini-3.8-flash", "gemini-flash"),
    ...identity("gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low"),

    // Claude 5.5
    ...aliasesTo("claude-opus-5-5-medium", "claude-opus-5-5", "claude-opus-5.5", "claude-opus-5-5-thinking", "claude-opus", "claude-3-opus", "claude-3.0-opus", "claude-3-opus-latest", "claude-3-opus-20240229", "claude-opus-3"),
    ...identity("claude-opus-5-5-low", "claude-opus-5-5-medium", "claude-opus-5-5-high"),
    ...aliasesTo("claude-sonnet-5-5-medium", "claude-sonnet-5-5", "claude-sonnet-5.5", "claude-sonnet-5-5-thinking", "claude-sonnet", "claude-3-7-sonnet", "claude-3.7-sonnet", "claude-3-7-sonnet-latest", "claude-3-7-sonnet-20250219", "claude-sonnet-3-7", "claude-sonnet-3.7"),
    ...identity("claude-sonnet-5-5-low", "claude-sonnet-5-5-medium", "claude-sonnet-5-5-high"),

    // GPT-OSS
    ...aliasesTo("gpt-oss-120b-medium", "gpt-oss-120b", "gpt-oss"),
    ...identity("gpt-oss-120b-medium"),

    // Legacy fallbacks (kept for compatibility)
    ...aliasesTo("claude-opus-4-6-thinking", "claude-opus-4-6", "claude-opus-4.6"),
    ...identity("claude-opus-4-6-thinking", "claude-sonnet-4-6"),
    ...aliasesTo("claude-sonnet-4-6", "claude-sonnet-4.6"),
    ...aliasesTo("claude-opus-4-5-thinking", "claude-opus-4-5", "claude-opus-4.5"),
    ...identity("claude-opus-4-5-thinking", "claude-sonnet-4-5"),
    ...aliasesTo("claude-sonnet-4-5", "claude-sonnet-4.5", "claude-sonnet-4-5-20251001", "claude-3-5-sonnet", "claude-3.5-sonnet", "claude-3-5-sonnet-latest", "claude-3-5-sonnet-20241022", "claude-3-5-sonnet-20240620", "claude-sonnet-3-5", "claude-sonnet-3.5", "claude-3-5-haiku", "claude-3.5-haiku"),
    ...identity("claude-sonnet-4-5-thinking"),
    ...aliasesTo("gemini-pro-agent", "gemini-3.1-pro", "gemini-3.1-pro-preview", "gemini-3.1-pro-high"),
    ...identity(
        "gemini-3.1-pro-low",
        "gemini-3.1-flash",
        "gemini-3.1-flash-lite",
        "gemini-3.1-flash-lite-preview",
        "gemini-3.1-flash-image",
        "gemini-3.1-flash-image-preview",
    ),
    ...["3.7", "3.6"].flatMap(v => [
        ...aliasesTo(`gemini-${v}-flash-medium`, `gemini-${v}-flash`),
        ...identity(`gemini-${v}-flash-high`, `gemini-${v}-flash-medium`, `gemini-${v}-flash-low`),
    ]),
    ...identity("gemini-3.5-flash-lite"),
    ...aliasesTo("gemini-3-pro-high", "gemini-3-pro"),
    ...identity(
        "gemini-3-pro-high",
        "gemini-3-pro-low",
        "gemini-3-flash",
        "gemini-2.5-pro",
        "gemini-2.5-flash",
        "gemini-2.5-flash-thinking",
    ),
    ...aliasesTo("gemini-flash", "gemini-transcribe", "whisper-1", "whisper"),
])

export function getAntigravityModelName(userModel: string): string {
    return MODEL_MAPPING[userModel] || resolveAntigravityAlias(userModel) || userModel
}

const antigravityUnsupportedModels = new Map<string, Map<string, number>>()
const ANTIGRAVITY_UNSUPPORTED_MODEL_TTL_MS = 30 * 60 * 1000

function cleanupAntigravityUnsupportedCache(accountId: string): Map<string, number> {
    const now = Date.now()
    const existing = antigravityUnsupportedModels.get(accountId) || new Map<string, number>()
    for (const [modelId, expiresAt] of existing.entries()) {
        if (!expiresAt || expiresAt <= now) {
            existing.delete(modelId)
        }
    }
    if (existing.size === 0) {
        antigravityUnsupportedModels.delete(accountId)
        return new Map<string, number>()
    }
    antigravityUnsupportedModels.set(accountId, existing)
    return existing
}

export function markAntigravityModelUnsupported(accountId: string, modelId: string): void {
    const normalized = modelId?.trim()
    if (!normalized) return
    const existing = cleanupAntigravityUnsupportedCache(accountId)
    const next = existing.size > 0 ? existing : new Map<string, number>()
    next.set(normalized, Date.now() + ANTIGRAVITY_UNSUPPORTED_MODEL_TTL_MS)
    antigravityUnsupportedModels.set(accountId, next)
}

export function isAntigravityModelSupportedForAccount(accountId: string, modelId: string): boolean | undefined {
    const normalized = modelId?.trim()
    if (!normalized) return undefined

    const unsupported = cleanupAntigravityUnsupportedCache(accountId)
    if (unsupported.has(normalized)) {
        return false
    }

    const mapped = getAntigravityModelName(normalized)
    if (unsupported.has(mapped)) {
        return false
    }

    const cachedModels = getCachedAntigravityModelsForAccount(accountId) || getDynamicAntigravityModelIdsForAccount(accountId)
    if (!cachedModels || cachedModels.length === 0) {
        return undefined
    }

    const cleanCached = cachedModels.filter(m => !m.endsWith("-disabled"))
    if (cleanCached.length === 0) {
        return false
    }

    if (cleanCached.includes(normalized) || cleanCached.includes(mapped)) {
        return true
    }

    const targetParsed = parseModelId(normalized) || parseModelId(mapped)
    if (targetParsed) {
        const hasFamilyMatch = cleanCached.some(m => {
            const p = parseModelId(m)
            if (!p) return false
            return p.family === targetParsed.family && compareVersions(p.version, targetParsed.version) === 0
        })
        return hasFamilyMatch
    }

    return false
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
    /** Optional downstream cancellation signal for streaming requests. */
    signal?: AbortSignal
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
    // inputTokens = uncached input (Anthropic semantics); cacheReadTokens = tokens served from prompt cache
    usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number }
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

export function computeSessionKey(messages: ClaudeMessage[]): string {
    for (const msg of messages) {
        const text = extractTextContent(msg.content)?.trim()
        if (text && text.length > 3) {
            let hash = 5381
            const len = Math.min(text.length, 300)
            for (let i = 0; i < len; i++) {
                hash = ((hash << 5) + hash) + text.charCodeAt(i)
            }
            return `ag_sess_${Math.abs(hash)}`
        }
    }
    return `ag_sess_${Date.now()}`
}

/**
 * 🆕 Prompt Cache Estimator:
 * Re-uses the existing computeSessionKey to track conversational prefixes.
 * Google Cloud Code (Antigravity) uses Gemini/Claude infrastructure with:
 *   - Minimum threshold: 1024 tokens
 *   - Cache TTL: 5 minutes (300_000 ms)
 * When upstream reports 0 cached tokens, we estimate the cached prefix if within TTL and >= 1024 tokens.
 */
interface CacheSessionRecord {
    lastSeen: number
    promptTokens: number
    model: string
}

const CACHE_MIN_TOKENS = 1024
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes (TTL matching official Gemini/Anthropic caching)
const CACHE_MAX_ENTRIES = 500 // Bound memory usage strictly

const sessionCacheMap = new Map<string, CacheSessionRecord>()

function cleanupExpiredCacheSessions(now: number = Date.now()): void {
    for (const [key, record] of sessionCacheMap.entries()) {
        if (now - record.lastSeen > CACHE_TTL_MS) {
            sessionCacheMap.delete(key)
        }
    }
}

// Periodic cleanup every 2 minutes unref'd so it doesn't block process exit
const cacheCleanupTimer = setInterval(() => {
    cleanupExpiredCacheSessions()
}, 2 * 60 * 1000)
if (cacheCleanupTimer && typeof cacheCleanupTimer.unref === "function") {
    cacheCleanupTimer.unref()
}

export function estimatePromptCache(sessionKey: string, promptTokens: number, model: string): number {
    if (!sessionKey || promptTokens < CACHE_MIN_TOKENS) {
        return 0
    }

    const now = Date.now()
    cleanupExpiredCacheSessions(now)

    const existing = sessionCacheMap.get(sessionKey)
    let estimatedCached = 0

    if (existing && existing.model === model && (now - existing.lastSeen) <= CACHE_TTL_MS) {
        if (existing.promptTokens >= CACHE_MIN_TOKENS && promptTokens >= existing.promptTokens) {
            // The previous turn's entire prompt was cached and forms the prefix of the current prompt
            estimatedCached = existing.promptTokens
        }
    }

    // Strict capacity enforcement (LRU eviction if at capacity)
    if (sessionCacheMap.size >= CACHE_MAX_ENTRIES && !sessionCacheMap.has(sessionKey)) {
        const oldestKey = sessionCacheMap.keys().next().value
        if (oldestKey) sessionCacheMap.delete(oldestKey)
    }

    // Refresh record with current timestamp (re-insert for LRU order)
    sessionCacheMap.delete(sessionKey)
    sessionCacheMap.set(sessionKey, {
        lastSeen: now,
        promptTokens,
        model,
    })

    return estimatedCached
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

interface ThoughtSignatureEntry {
    signature: string
    timestamp: number
}

const THOUGHT_SIGNATURE_CACHE_MAX = 2000
const THOUGHT_SIGNATURE_CACHE_TTL_MS = 2 * 60 * 60 * 1000 // 2 hours

class ThoughtSignatureCache {
    private cache = new Map<string, ThoughtSignatureEntry>()
    private loaded = false
    private saveTimeout: ReturnType<typeof setTimeout> | null = null

    private getCacheFile(): string {
        return join(getDataDir(), "thought-signatures.json")
    }

    private loadFromDisk() {
        if (this.loaded) return
        this.loaded = true
        try {
            const file = this.getCacheFile()
            if (existsSync(file)) {
                const data = JSON.parse(readFileSync(file, "utf-8"))
                if (data && typeof data === "object") {
                    const now = Date.now()
                    for (const [key, entry] of Object.entries(data)) {
                        if (
                            entry &&
                            typeof entry === "object" &&
                            typeof (entry as any).signature === "string" &&
                            typeof (entry as any).timestamp === "number" &&
                            now - (entry as any).timestamp <= THOUGHT_SIGNATURE_CACHE_TTL_MS
                        ) {
                            this.cache.set(key, entry as ThoughtSignatureEntry)
                        }
                    }
                }
            }
        } catch {
            // Ignore cache read failures
        }
    }

    private scheduleSave() {
        if (this.saveTimeout) return
        this.saveTimeout = setTimeout(() => {
            this.saveTimeout = null
            this.saveToDisk()
        }, 1000)
        this.saveTimeout.unref?.()
    }

    private saveToDisk() {
        try {
            ensureDataDir()
            const file = this.getCacheFile()
            const obj: Record<string, ThoughtSignatureEntry> = {}
            const now = Date.now()
            for (const [k, v] of this.cache.entries()) {
                if (now - v.timestamp <= THOUGHT_SIGNATURE_CACHE_TTL_MS) {
                    obj[k] = v
                }
            }
            writeFileSync(file, JSON.stringify(obj))
        } catch {
            // Non-critical persistence failure
        }
    }

    set(key: string, signature: string) {
        if (!key || !signature) return
        this.loadFromDisk()
        if (this.cache.size >= THOUGHT_SIGNATURE_CACHE_MAX) {
            const firstKey = this.cache.keys().next().value
            if (firstKey) this.cache.delete(firstKey)
        }
        this.cache.set(key, { signature, timestamp: Date.now() })
        this.scheduleSave()
    }

    get(key: string): string | undefined {
        if (!key) return undefined
        this.loadFromDisk()
        const entry = this.cache.get(key)
        if (!entry) return undefined
        if (Date.now() - entry.timestamp > THOUGHT_SIGNATURE_CACHE_TTL_MS) {
            this.cache.delete(key)
            return undefined
        }
        return entry.signature
    }

    clear() {
        this.cache.clear()
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout)
            this.saveTimeout = null
        }
        try {
            const file = this.getCacheFile()
            if (existsSync(file)) {
                rmSync(file, { force: true })
            }
        } catch {}
    }
}

export const thoughtSignatureCache = new ThoughtSignatureCache()

function sortKeysDeep(obj: any): any {
    if (Array.isArray(obj)) return obj.map(sortKeysDeep)
    if (obj !== null && typeof obj === "object") {
        return Object.keys(obj)
            .sort()
            .reduce((acc: any, key) => {
                acc[key] = sortKeysDeep(obj[key])
                return acc
            }, {})
    }
    return obj
}

export function getToolSignatureKey(name: string, args: unknown): string {
    let parsed = args
    if (typeof args === "string") {
        try {
            parsed = JSON.parse(args)
        } catch {
            parsed = args
        }
    }
    const normalized = parsed != null && typeof parsed === "object" ? JSON.stringify(sortKeysDeep(parsed)) : String(parsed ?? "")
    return `${name}:${normalized}`
}

function isGeminiModel(model?: string): boolean {
    if (!model) return true
    return /gemini|argon/i.test(model)
}

export async function buildAntigravityParts(
    content: ClaudeMessage["content"],
    toolIdToName: Map<string, string>,
    options: { signal?: AbortSignal; imageBudget?: ImageInputBudget; model?: string } = {},
): Promise<any[]> {
    const imageBudget = options.imageBudget ?? createImageInputBudget([{ role: "user", content }])
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

        if (block.type === "image" && block.source?.type === "url") {
            if (imageBudget.remainingBytes <= 0) {
                throw new RequestValidationError("image inputs exceed the 16 MiB per-request limit")
            }
            const image = await fetchRemoteImageAsBase64(block.source.url, {
                signal: options.signal,
                maxBytes: imageBudget.remainingBytes,
            })
            imageBudget.addFetchedBytes(decodedBase64ImageBytes(image.data, true))
            parts.push({
                inlineData: {
                    mimeType: image.media_type,
                    data: image.data,
                },
            })
            continue
        }

        if (block.source?.type === "base64" && (block.type === "audio" || (block.type === "document" && block.source.media_type.startsWith("audio/")))) {
            parts.push({
                inlineData: {
                    mimeType: block.source.media_type,
                    data: block.source.data,
                },
            })
            continue
        }

        if (block.type === "audio" && block.source?.type === "url") {
            const audio = await fetchRemoteAudioAsBase64(block.source.url, {
                signal: options.signal,
            })
            parts.push({
                inlineData: {
                    mimeType: audio.media_type,
                    data: audio.data,
                },
            })
            continue
        }

        if (block.type === "tool_use") {
            const toolId = block.id || generateToolUseId()
            const toolName = block.name || toolId
            toolIdToName.set(toolId, toolName)

            let signature = (block as any).thoughtSignature
                || (block as any).thought_signature
                || thoughtSignatureCache.get(toolId)
                || thoughtSignatureCache.get(getToolSignatureKey(toolName, block.input))
                || thoughtSignatureCache.get(`latest:${toolName}`)

            // For Antigravity models, Google strictly requires a thought_signature in functionCall parts.
            // If the client or cache dropped the signature (e.g. restart, new session, or standard OpenAI/VS Code client),
            // use Google's official bypass sentinel to prevent a 400 rejection.
            if (!signature) {
                signature = "skip_thought_signature_validator"
            }

            const part: any = {
                functionCall: {
                    name: toolName,
                    args: block.input || {},
                    id: toolId,
                },
            }
            if (signature) {
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
            parts.push({ functionResponse })
            continue
        }
    }

    return parts.length > 0 ? parts : [{ text: "[No text]" }]
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
        return { mode: "AUTO" }
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
            return { mode: "AUTO" }
    }
}


function isGemini31Model(model: string): boolean {
    return /^gemini-3\./i.test(model) ||
           model === "gemini-pro-agent" ||
           /^gemini-3-/i.test(model) ||
           /^gemini-4/i.test(model) ||
           model.includes("argon")
}

/** Keep generation settings within the limits accepted by each native model family. */
export function buildGenerationConfig(model: string, maxTokens?: number): Record<string, unknown> {
    const modelLimit = isGemini31Model(model) ? 65536 : 64000
    const requested = Number.isFinite(maxTokens) ? Math.floor(maxTokens as number) : modelLimit
    const maxOutputTokens = Math.max(1, Math.min(requested, modelLimit))
    return { maxOutputTokens }
}

export async function claudeToAntigravity(
    model: string,
    messages: ClaudeMessage[],
    tools?: ClaudeTool[],
    toolChoice?: ChatRequest["toolChoice"],
    maxTokens?: number,
    signal?: AbortSignal,
): Promise<any> {
    const toolIdToName = new Map<string, string>()
    const imageBudget = createImageInputBudget(messages)
    const contents = []
    for (const msg of messages) {
        contents.push({
            role: msg.role === "assistant" ? "model" : msg.role,
            parts: await buildAntigravityParts(msg.content, toolIdToName, { signal, imageBudget, model }),
        })
    }

    const sessionId = generateStableSessionId(messages)
    const projectId = state.cloudaicompanionProject || "unknown"

    const innerRequest: any = {
        contents,
        sessionId,
        systemInstruction: buildSystemInstruction(),
        generationConfig: buildGenerationConfig(model, maxTokens),
    }

    if (tools && tools.length > 0) {
        innerRequest.toolConfig = { functionCallingConfig: buildFunctionCallingConfig(toolChoice) }
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
        userAgent: getAntigravityUserAgent(),
        requestType: "agent",
        project: projectId,
        requestId: "agent-" + crypto.randomUUID(),
        request: innerRequest,
    }
}

function mapGoogleFinishReason(reason?: string, hasToolUse = false): string {
    if (hasToolUse) return "tool_use"
    if (!reason) return "end_turn"
    const upper = reason.toUpperCase()
    if (upper === "STOP") return "end_turn"
    if (upper === "MAX_TOKENS") return "max_tokens"
    if (upper === "SAFETY" || upper === "BLOCKLIST" || upper === "PROHIBITED_CONTENT" || upper === "SPII" || upper === "RECITATION") {
        return "content_filter"
    }
    return "end_turn"
}

export function parseApiResponse(rawResponse: string, sessionKey?: string, model?: string): ChatResponse {
    let chunks: any[] = []
    const trimmed = rawResponse.trim()
    if (trimmed.startsWith("[")) chunks = JSON.parse(trimmed)
    else if (trimmed.startsWith("{")) chunks = [JSON.parse(trimmed)]
    if (chunks.length === 0) throw new Error("Empty response")

    const lastChunk = chunks[chunks.length - 1]
    if (!lastChunk?.response) throw new Error("No valid response")

    const contentBlocks: ContentBlock[] = []
    let hasToolUse = false
    let latestThoughtSignature: string | undefined
    let latestFinishReason: string | undefined
    let blockReason: string | undefined

    for (const chunk of chunks) {
        const resp = chunk.response || chunk
        if (resp?.promptFeedback?.blockReason) {
            blockReason = resp.promptFeedback.blockReason
        }
        const candidate = resp?.candidates?.[0]
        const candSig = candidate?.thoughtSignature || candidate?.thought_signature
        if (candSig) latestThoughtSignature = candSig
        if (candidate?.finishReason || candidate?.finish_reason) {
            latestFinishReason = candidate.finishReason || candidate.finish_reason
        }

        const parts = candidate?.content?.parts || []
        for (const part of parts) {
            const partSig = part.thoughtSignature || part.thought_signature || part.functionCall?.thoughtSignature || part.functionCall?.thought_signature
            if (partSig) latestThoughtSignature = partSig

            if (part.text) {
                const last = contentBlocks[contentBlocks.length - 1]
                if (last?.type === "text") last.text = (last.text || "") + part.text
                else contentBlocks.push({ type: "text", text: part.text })
            }
            if (part.functionCall) {
                hasToolUse = true
                const input = parseFunctionCallArgs(part.functionCall.args)
                const toolId = part.functionCall.id || generateToolUseId()
                const signature = partSig || latestThoughtSignature
                if (signature) {
                    thoughtSignatureCache.set(toolId, signature)
                    thoughtSignatureCache.set(getToolSignatureKey(part.functionCall.name, input), signature)
                    thoughtSignatureCache.set(`latest:${part.functionCall.name}`, signature)
                    thoughtSignatureCache.set("latest", signature)
                }
                const block: any = {
                    type: "tool_use",
                    id: toolId,
                    name: part.functionCall.name,
                    input,
                }
                if (signature) {
                    block.thought_signature = signature
                    block.thoughtSignature = signature
                }
                contentBlocks.push(block)
            }
        }
    }

    if (blockReason) {
        throw new UpstreamError(
            "antigravity",
            400,
            `Prompt blocked by upstream safety policy: ${blockReason}`
        )
    }

    const stopReason = mapGoogleFinishReason(latestFinishReason, hasToolUse)

    if (contentBlocks.length === 0 && !hasToolUse) {
        if (stopReason === "content_filter") {
            contentBlocks.push({ type: "text", text: "Response filtered by upstream content policy." })
        } else if (stopReason === "max_tokens") {
            contentBlocks.push({ type: "text", text: "" })
        } else {
            throw new UpstreamError(
                "antigravity",
                502,
                latestFinishReason
                    ? `Upstream model ended with finishReason: ${latestFinishReason} without generating content`
                    : "Upstream model returned empty response without content"
            )
        }
    }

    const usage = lastChunk.response.usageMetadata || lastChunk.usageMetadata
    const promptTokens = usage?.promptTokenCount || 0
    let cachedTokens = Math.min(usage?.cachedContentTokenCount || 0, promptTokens)
    if (cachedTokens === 0 && sessionKey && model) {
        cachedTokens = estimatePromptCache(sessionKey, promptTokens, model)
    }
    return {
        contentBlocks,
        stopReason,
        usage: {
            inputTokens: promptTokens - cachedTokens,
            outputTokens: (usage?.candidatesTokenCount || 0) + (usage?.thoughtsTokenCount || 0),
            cacheReadTokens: cachedTokens,
        },
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
    routeTag?: string,
    sessionKey?: string
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
            const currentAccount = currentAccountId ? accountManager.getAccount(currentAccountId) : undefined
            const accountProxy = currentAccount?.proxy
            try {
                const response = await fetchWithTimeout(url, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": "Bearer " + currentAccessToken,
                        "User-Agent": getAntigravityUserAgent(),
                        "Accept": "text/event-stream",
                    },
                    body: JSON.stringify(antigravityRequest),
                    proxy: accountProxy,
                }, FETCH_TIMEOUT_MS)

                if (response.ok) {
                    if (currentAccountId) accountManager.markSuccess(currentAccountId)

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
                consola.warn("SSE error " + response.status)

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
                        // 🆕 关键修复：在等待期间临时标记账号为限流，防止其他并发请求选择它
                        const account = await accountManager.getAccountById(currentAccountId)
                        if (account) {
                            (account as any).rateLimitedUntil = Date.now() + boundedDelayMs + 500
                        }

                        await new Promise(resolve => setTimeout(resolve, boundedDelayMs + 200)) // 加 200ms 缓冲

                        // 🆕 等待结束后清除临时限流标记
                        if (account) {
                            (account as any).rateLimitedUntil = null
                        }

                        nonQuota429Count += 1
                        lastError = new Error("429 - waited and retry")
                        break // 跳出 endpoint 循环，进入下一轮 attempt
                    }

                    // 仅在配额耗尽时才切换账号
                    if (quotaExhausted) {
                        const limitResult = await accountManager.markRateLimitedFromError(
                            currentAccountId,
                            lastStatusCode,
                            lastErrorText,
                            lastRetryAfterHeader
                        )

                        if (limitResult?.reason === "quota_exhausted") {
                            accountManager.moveToEndOfQueue(currentAccountId)
                        }

                        if (allowRotation && accountManager.count() > 1) {
                            const isEligible = modelName ? (id: string) => isAntigravityModelSupportedForAccount(id, modelName) !== false : undefined
                            const next = await accountManager.getNextAvailableAccount(true, sessionKey, isEligible, modelName)
                            if (next && next.accountId !== currentAccountId) {
                                currentAccessToken = next.accessToken
                                currentAccountId = next.accountId
                                antigravityRequest.project = next.projectId
                                // Break out of endpoint loop to retry with new account
                                lastError = new Error("429 - switched account")
                                break
                            }
                        }
                    }
                    if (!quotaExhausted) {
                        const cooldownMs = Math.max(boundedDelayMs, NON_QUOTA_429_COOLDOWN_MS)
                        accountManager.markRateLimited(currentAccountId, cooldownMs)
                        if (allowRotation && accountManager.count() > 1) {
                            const isEligible = modelName ? (id: string) => isAntigravityModelSupportedForAccount(id, modelName) !== false : undefined
                            const next = await accountManager.getNextAvailableAccount(true, sessionKey, isEligible, modelName)
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
                        consola.warn(`Failed to refresh token for ${currentAccountId}:`, safeErrorMessage(e))
                    }
                    // If refresh failed, try next account
                    if (allowRotation && accountManager.count() > 1) {
                        const isEligible = modelName ? (id: string) => isAntigravityModelSupportedForAccount(id, modelName) !== false : undefined
                        const next = await accountManager.getNextAvailableAccount(true, sessionKey, isEligible, modelName)
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

function waitWithAbort(delayMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
        return Promise.reject(new DOMException("The upstream stream was aborted", "AbortError"))
    }
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort)
            resolve()
        }, delayMs)
        const onAbort = () => {
            clearTimeout(timer)
            signal?.removeEventListener("abort", onAbort)
            reject(new DOMException("The upstream stream was aborted", "AbortError"))
        }
        signal?.addEventListener("abort", onAbort, { once: true })
    })
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
    routeTag?: string,
    signal?: AbortSignal,
    sessionKey?: string
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

    const abortError = () => new DOMException("The upstream stream was aborted", "AbortError")
    const throwIfAborted = () => {
        if (signal?.aborted) throw abortError()
    }

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        throwIfAborted()
        let retryAttempt = false
        for (const baseUrl of ANTIGRAVITY_BASE_URLS) {
            throwIfAborted()
            const url = baseUrl + endpoint + "?alt=sse"

            let hasYielded = false
            let lastChunkAt = Date.now()
            let idleTimedOut = false
            const idleController = new AbortController()
            const abortListener = () => idleController.abort()
            if (signal) {
                if (signal.aborted) idleController.abort()
                else signal.addEventListener("abort", abortListener, { once: true })
            }

            const currentAccount = currentAccountId ? accountManager.getAccount(currentAccountId) : undefined
            const accountProxy = currentAccount?.proxy

            try {
                const response = await fetchWithTimeout(url, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": "Bearer " + currentAccessToken,
                        "User-Agent": getAntigravityUserAgent(),
                        "Accept": "text/event-stream",
                    },
                    body: JSON.stringify(antigravityRequest),
                    signal: idleController.signal,
                    proxy: accountProxy,
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
                        if (quotaExhausted) {
                            const limitResult = await accountManager.markRateLimitedFromError(currentAccountId, response.status, errorText)
                            if (limitResult?.reason === "quota_exhausted") {
                                accountManager.moveToEndOfQueue(currentAccountId)
                            }
                            lastError = new UpstreamError("antigravity", response.status, errorText, response.headers.get("retry-after") || undefined)
                            throw lastError
                        }

                        const parsedDelay = parseRetryDelay(errorText, response.headers.get("retry-after") || undefined)
                        const waitMs = Math.min(parsedDelay ?? 2000, MAX_NON_QUOTA_429_WAIT_MS)
                        if (nonQuota429Count < MAX_NON_QUOTA_429_RETRIES) {
                            await waitWithAbort(waitMs, signal)
                            nonQuota429Count += 1
                            lastError = new UpstreamError("antigravity", response.status, errorText, response.headers.get("retry-after") || undefined)
                            retryAttempt = true
                            break
                        }
                        const cooldownMs = Math.max(waitMs, NON_QUOTA_429_COOLDOWN_MS)
                        accountManager.markRateLimited(currentAccountId, cooldownMs)
                        if (allowRotation && accountManager.count() > 1) {
                            const isEligible = modelName ? (id: string) => isAntigravityModelSupportedForAccount(id, modelName) !== false : undefined
                            const next = await accountManager.getNextAvailableAccount(true, sessionKey, isEligible, modelName)
                            if (next && next.accountId !== currentAccountId) {
                                currentAccessToken = next.accessToken
                                currentAccountId = next.accountId
                                antigravityRequest.project = next.projectId
                                nonQuota429Count = 0
                                retryAttempt = true
                                break
                            }
                        }
                        const upstream = new UpstreamError("antigravity", response.status, errorText, response.headers.get("retry-after") || undefined)
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

                if (currentAccountId) accountManager.markSuccess(currentAccountId)

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
                        throwIfAborted()
                        let result: any
                        try {
                            result = await reader.read()
                        } catch (readError) {
                            if (idleTimedOut) {
                                throw new Error("Stream idle timeout")
                            }
                            consola.warn("[SSE Streaming] Read error:", safeErrorMessage(readError))
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
                            throwIfAborted()
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
                    throwIfAborted()
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
                    signal?.removeEventListener("abort", abortListener)
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
                signal?.removeEventListener("abort", abortListener)
                if (signal?.aborted) throw abortError()
                if (error instanceof UpstreamError) {
                    if (hasYielded) {
                        ;(error as any).streamingStarted = true
                    }
                    throw error
                }
                if (hasYielded) throw error
                consola.warn("[SSE Streaming] Upstream request failed:", safeErrorMessage(error))
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

async function resolveAntigravityAccount(
    modelName: string,
    sessionKey: string,
    options: { accountId?: string; routeTag?: string },
    messages?: unknown
): Promise<{
    accessToken: string
    accountId?: string
    projectId?: string
    accountEmail?: string
    releaseAccountLock: (() => void) | null
}> {
    let accessToken: string
    let accountId: string | undefined
    let projectId: string | undefined
    let accountEmail: string | undefined

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
        const isEligible = (id: string) => isAntigravityModelSupportedForAccount(id, modelName) !== false
        const account = await accountManager.getNextAvailableAccount(false, sessionKey, isEligible, modelName, messages)
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

    const releaseAccountLock = accountId ? await accountManager.acquireAccountLock(accountId) : null
    return { accessToken, accountId, projectId, accountEmail, releaseAccountLock }
}

function recordAntigravityUsage(
    accountId: string | undefined,
    modelName: string,
    uncachedInputTokens: number,
    outputTokens: number,
    cacheReadTokens: number = 0
): void {
    if (uncachedInputTokens <= 0 && outputTokens <= 0 && cacheReadTokens <= 0) return
    const actualModelId = getAntigravityModelName(modelName)
    if (accountId) {
        accountManager.recordAccountUsage(accountId, uncachedInputTokens, outputTokens, cacheReadTokens, actualModelId)
    }
    import("~/services/usage-tracker").then(({ recordUsage }) => {
        recordUsage(actualModelId, uncachedInputTokens, outputTokens, cacheReadTokens)
    }).catch(() => { })
}

export async function createChatCompletion(request: ChatRequest): Promise<ChatResponse> {
    return createChatCompletionWithOptions(request)
}

export async function createChatCompletionWithOptions(
    request: ChatRequest,
    options: { accountId?: string; allowRotation?: boolean; routeTag?: string } = {}
): Promise<ChatResponse> {
    const sessionKey = computeSessionKey(request.messages)
    const { accessToken, accountId, projectId, accountEmail, releaseAccountLock } = await resolveAntigravityAccount(
        request.model,
        sessionKey,
        options,
        request.messages
    )

    setRequestLogContext({ model: request.model, provider: "antigravity", account: accountEmail, routeTag: options.routeTag })

    try {
        const antigravityRequest = await claudeToAntigravity(
            getAntigravityModelName(request.model),
            request.messages,
            request.tools,
            request.toolChoice,
            request.maxTokens,
            request.signal,
        )

        if (projectId) antigravityRequest.project = projectId

        const rawSse = await sendRequestSse(
            STREAM_ENDPOINT,
            antigravityRequest,
            accessToken,
            accountId,
            options.allowRotation ?? true,
            request.model,
            options.routeTag,
            sessionKey
        )
        const sseChunks = collectSseChunks(rawSse)
        const rawResponse = sseChunks.length > 0 ? JSON.stringify(sseChunks) : rawSse

        const result = parseApiResponse(rawResponse, sessionKey, request.model)
        const uncachedInputTokens = result.usage?.inputTokens || 0
        const cacheReadTokens = result.usage?.cacheReadTokens || 0
        const outputTokens = result.usage?.outputTokens || 0
        recordAntigravityUsage(accountId, request.model, uncachedInputTokens, outputTokens, cacheReadTokens)

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
    const sessionKey = computeSessionKey(request.messages)
    const { accessToken, accountId, projectId, releaseAccountLock } = await resolveAntigravityAccount(
        request.model,
        sessionKey,
        options,
        request.messages
    )

    try {
        const antigravityRequest = await claudeToAntigravity(
            getAntigravityModelName(request.model),
            request.messages,
            request.tools,
            request.toolChoice,
            request.maxTokens,
            request.signal,
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
            options.routeTag,
            request.signal,
            sessionKey
        )

        let blockIndex = 0
        let hasToolUse = false
        let outputTokens = 0
        let streamInputTokens = 0
        let streamCacheReadTokens = 0
        let textBlockStarted = false
        let latestThoughtSignature: string | undefined

        yield buildMessageStart(request.model)

        let latestFinishReason: string | undefined

        for await (const chunkStr of sseStream) {
            let chunk: any
            try {
                chunk = JSON.parse(chunkStr)
            } catch {
                continue
            }

            const responseData = chunk.response || chunk
            if (responseData?.promptFeedback?.blockReason) {
                throw new UpstreamError(
                    "antigravity",
                    400,
                    `Prompt blocked by upstream safety policy: ${responseData.promptFeedback.blockReason}`
                )
            }
            const candidate = responseData?.candidates?.[0]
            const candSig = candidate?.thoughtSignature || candidate?.thought_signature
            if (candSig) latestThoughtSignature = candSig
            if (candidate?.finishReason || candidate?.finish_reason) {
                latestFinishReason = candidate.finishReason || candidate.finish_reason
            }

            const parts = candidate?.content?.parts || []

            for (const part of parts) {
                const partSig = part.thoughtSignature || part.thought_signature || part.functionCall?.thoughtSignature || part.functionCall?.thought_signature
                if (partSig) latestThoughtSignature = partSig

                if (part.text) {
                    if (!textBlockStarted) {
                        yield buildContentBlockStart(blockIndex, "text")
                        textBlockStarted = true
                    }
                    yield buildTextDelta(blockIndex, part.text)
                }
                if (part.functionCall) {
                    if (textBlockStarted) {
                        yield buildContentBlockStop(blockIndex)
                        blockIndex++
                        textBlockStarted = false
                    }

                    hasToolUse = true
                    const toolId = part.functionCall.id || generateToolUseId()
                    const rawArgs = part.functionCall.args
                    const parsedArgs = parseFunctionCallArgs(rawArgs)
                    const signature = partSig || latestThoughtSignature

                    if (signature) {
                        thoughtSignatureCache.set(toolId, signature)
                        thoughtSignatureCache.set(getToolSignatureKey(part.functionCall.name, parsedArgs), signature)
                        thoughtSignatureCache.set(`latest:${part.functionCall.name}`, signature)
                        thoughtSignatureCache.set("latest", signature)
                    }

                    yield buildContentBlockStart(blockIndex, "tool_use", {
                        id: toolId,
                        name: part.functionCall.name,
                        thoughtSignature: signature,
                    })
                    if (rawArgs) {
                        const partialJson = typeof rawArgs === "string" ? rawArgs : (JSON.stringify(rawArgs) || "{}")
                        yield buildInputJsonDelta(blockIndex, partialJson)
                    }
                    yield buildContentBlockStop(blockIndex)
                    blockIndex++
                }
            }

            const usage = responseData?.usageMetadata
            if (usage) {
                outputTokens = (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0)
                const promptTokens = usage.promptTokenCount || 0
                let cached = Math.min(usage.cachedContentTokenCount || 0, promptTokens)
                if (cached === 0 && sessionKey && request.model) {
                    cached = estimatePromptCache(sessionKey, promptTokens, request.model)
                }
                streamCacheReadTokens = cached
                streamInputTokens = promptTokens - cached
            }
        }

        if (textBlockStarted) {
            yield buildContentBlockStop(blockIndex)
        }

        if (!hasToolUse && request.toolChoice?.type === "tool") {
            consola.warn(`Tool choice "${request.toolChoice.name || "unknown"}" requested but no tool_use returned`)
        }
        const stopReason = mapGoogleFinishReason(latestFinishReason, hasToolUse)
        if (!textBlockStarted && !hasToolUse) {
            if (stopReason === "content_filter") {
                yield buildContentBlockStart(blockIndex, "text")
                yield buildTextDelta(blockIndex, "Response filtered by upstream content policy.")
                yield buildContentBlockStop(blockIndex)
            } else if (stopReason === "max_tokens") {
                yield buildContentBlockStart(blockIndex, "text")
                yield buildContentBlockStop(blockIndex)
            } else {
                throw new UpstreamError(
                    "antigravity",
                    502,
                    latestFinishReason
                        ? `Upstream model ended with finishReason: ${latestFinishReason} without generating content`
                        : "Upstream model returned empty response without content"
                )
            }
        }
        yield buildMessageDelta(stopReason, {
            inputTokens: streamInputTokens,
            cacheReadTokens: streamCacheReadTokens,
            outputTokens,
        })
        yield buildMessageStop()

        recordAntigravityUsage(accountId, request.model, streamInputTokens, outputTokens, streamCacheReadTokens)
    } finally {
        if (releaseAccountLock) releaseAccountLock()
    }
}
