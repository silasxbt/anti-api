import type { ClaudeMessage, ClaudeTool, CompletionUsage, ContentBlock } from "~/lib/translator"
import { UpstreamError } from "~/lib/error"
import {
    createChatCompletionWithOptions,
    createChatCompletionStreamWithOptions,
    isAntigravityModelSupportedForAccount,
    markAntigravityModelUnsupported,
    computeSessionKey,
} from "~/services/antigravity/chat"
import { accountManager } from "~/services/antigravity/account-manager"
import { createCodexCompletion, isCodexModelSupportedForAccount, isCodexUnsupportedModelError } from "~/services/codex/chat"
import { createCopilotCompletion } from "~/services/copilot/chat"
import { createZedCompletion } from "~/services/zed/chat"
import { createKiroCompletion } from "~/services/kiro/chat"
import { createGrokCompletion } from "~/services/grok/chat"
import { authStore } from "~/services/auth/store"
import { AUTH_PROVIDERS, type ProviderAccount, type AuthProvider } from "~/services/auth/types"
import { loadRoutingConfig, type RoutingEntry, type RoutingConfig, type AccountRoutingEntry } from "./config"
import { ensureProviderModelsSynced, getProviderModels, isHiddenCodexModel } from "./models"
import { isCacheAwareRoutingEnabled } from "~/services/settings"
import {
    rankAccountCandidates,
    recordIntelligentDispatch,
    recordIntelligentTokenUsage,
} from "./intelligent-scorer"
import {
    buildMessageStart,
    buildContentBlockStart,
    buildTextDelta,
    buildInputJsonDelta,
    buildContentBlockStop,
    buildMessageDelta,
    buildMessageStop,
} from "~/lib/translator"
import { baseModelIdFor, getAntigravityCatalog } from "~/lib/model-catalog"
import { formatSuccessLine, setRequestLogContext } from "~/lib/logger"
import { recordUsage } from "~/services/usage-tracker"

export class RoutingError extends Error {
    status: number
    constructor(message: string, status: number = 400) {
        super(message)
        this.name = "RoutingError"
        this.status = status
    }
}

interface RoutedRequest {
    model: string
    messages: ClaudeMessage[]
    tools?: ClaudeTool[]
    toolChoice?: {
        type: "auto" | "any" | "tool" | "none"
        name?: string
    }
    maxTokens?: number
    reasoningEffort?: "low" | "medium" | "high"
    /** Abort upstream work when the downstream HTTP client disconnects. */
    signal?: AbortSignal
}

type StickyCursorState = {
    cursor: number
}

type ProviderCompletion = {
    contentBlocks: ContentBlock[]
    stopReason: string | null
    usage?: Partial<CompletionUsage>
}

/** Canonical official model IDs for known aliases (keys are lower-case). */
const OFFICIAL_MODEL_ALIASES: Record<string, string> = {
    "gpt-oss": "gpt-oss-120b",
    "gpt-oss-120b": "gpt-oss-120b",
    "claude-opus": "claude-opus-5-5-thinking",
    "claude-sonnet": "claude-sonnet-5-5",
    "gemini-pro": "gemini-3.1-pro-high",
    "gemini-flash": "gemini-3.8-flash-medium",
    "gemini-flash-lite": "gemini-3.8-flash-lite",
    "claude-opus-4-7": "claude-opus-4.7",
    "claude-opus-5-5": "claude-opus-5-5-thinking",
    "claude-opus-5.5": "claude-opus-5-5-thinking",
    "claude-opus-5-5-thinking": "claude-opus-5-5-thinking",
    "claude-sonnet-5-5": "claude-sonnet-5-5",
    "claude-sonnet-5.5": "claude-sonnet-5-5",
    "claude-sonnet-5-5-thinking": "claude-sonnet-5-5-thinking",
    "claude-opus-4-6": "claude-opus-4-6-thinking",
    "claude-opus-4.6": "claude-opus-4-6-thinking",
    "claude-opus-4-6-thinking": "claude-opus-4-6-thinking",
    "claude-sonnet-4-6": "claude-sonnet-4-6",
    "claude-sonnet-4.6": "claude-sonnet-4-6",
    "claude-opus-4-5": "claude-opus-4-5-thinking",
    "claude-opus-4.5": "claude-opus-4-5-thinking",
    "claude-opus-4-5-thinking": "claude-opus-4-5-thinking",
    "claude-sonnet-4.5": "claude-sonnet-4-5",
    "claude-sonnet-4.5-thinking": "claude-sonnet-4-5-thinking",
    "claude-3-7-sonnet": "claude-sonnet-5-5",
    "claude-3.7-sonnet": "claude-sonnet-5-5",
    "claude-3-7-sonnet-latest": "claude-sonnet-5-5",
    "claude-3-7-sonnet-20250219": "claude-sonnet-5-5",
    "claude-3-5-sonnet": "claude-sonnet-4-5",
    "claude-3.5-sonnet": "claude-sonnet-4-5",
    "claude-3-5-sonnet-latest": "claude-sonnet-4-5",
    "claude-3-5-sonnet-20241022": "claude-sonnet-4-5",
    "claude-3-5-sonnet-20240620": "claude-sonnet-4-5",
    "claude-3-5-haiku": "claude-sonnet-4-5",
    "claude-3.5-haiku": "claude-sonnet-4-5",
    "claude-3-opus": "claude-opus-5-5-thinking",
    "claude-3.0-opus": "claude-opus-5-5-thinking",
    "claude-3-opus-20240229": "claude-opus-5-5-thinking",
    "gemini-3.8-flash": "gemini-3.8-flash-medium",
    "gemini-3.8-flash-high": "gemini-3.8-flash-high",
    "gemini-3.8-flash-medium": "gemini-3.8-flash-medium",
    "gemini-3.8-flash-low": "gemini-3.8-flash-low",
    "gemini-3.5-flash-lite": "gemini-3.5-flash-lite",
    "gemini-3.1-pro": "gemini-3.1-pro-high",
    "gemini-3.1-pro-preview": "gemini-3.1-pro-high",
    "gemini-3-pro": "gemini-3-pro-high",
    "gemini-2.5-pro": "gemini-2.5-pro",
    "gemini-2.5-flash": "gemini-2.5-flash",
    "gemini-transcribe": "gemini-flash",
    "whisper-1": "gemini-flash",
    "whisper": "gemini-flash",
    "gemini-4-argon": "gemini-4-argon",
    "gemini-argon": "gemini-4-argon",
    "argon": "gemini-4-argon",
    "gemini-argon-high": "gemini-4-argon-high",
    "gemini-argon-medium": "gemini-4-argon-medium",
    "gemini-argon-low": "gemini-4-argon-low",
    "gemini-argon-thinking": "gemini-4-argon-thinking",
}

export function normalizeOfficialModelId(model: string): string {
    const normalized = model?.trim()
    if (!normalized) return model
    const lookupKey = normalized.toLowerCase()
    if (OFFICIAL_MODEL_ALIASES[lookupKey]) {
        return OFFICIAL_MODEL_ALIASES[lookupKey]
    }
    const catalogAlias = getAntigravityCatalog().aliases.get(lookupKey)
    if (catalogAlias) {
        return catalogAlias
    }
    return normalized
}

/**
 * Return a stable comparison key for provider model IDs.
 *
 * Providers do not agree on punctuation (for example, `claude-sonnet-4.5`
 * versus `claude-sonnet-4-5`). Keep the public/request model untouched, but
 * use the same key while deciding which provider or account route applies.
 */
const officialModelKeyCache = new Map<string, string>()

function officialModelKey(model: string): string {
    const raw = model || ""
    const cached = officialModelKeyCache.get(raw)
    if (cached !== undefined) return cached
    const computed = normalizeOfficialModelId(raw)
        .trim()
        .toLowerCase()
        .replace(/[._]/g, "-")
        .replace(/-+/g, "-")
    if (officialModelKeyCache.size > 1000) {
        officialModelKeyCache.clear()
    }
    officialModelKeyCache.set(raw, computed)
    return computed
}

export function modelIdsMatch(left: string, right: string): boolean {
    return officialModelKey(left) === officialModelKey(right)
}

function isEntryUsable(entry: RoutingEntry | AccountRoutingEntry): boolean {
    if (entry.provider === "antigravity") {
        return true
    }
    return !!authStore.getAccount(entry.provider, entry.accountId)
}

// Router 级 rate-limit 兜底（仅 antigravity）：独立于 accountManager，
// 因此能在请求期 accountManager.load() 重置 rateLimitedUntil 后仍保住限流状态。
// 其它 provider 的限流仅依赖 authStore.isRateLimited。
const routerRateLimits = new Map<string, number>()  // "antigravity:accountId" -> expiry timestamp
const PROVIDER_ORDER: readonly AuthProvider[] = AUTH_PROVIDERS
const flowStickyStates = new Map<string, StickyCursorState>()
const accountStickyStates = new Map<string, StickyCursorState>()

function getRouterRateLimitKey(provider: string, accountId: string): string {
    return `${provider}:${accountId}`
}

function isRouterRateLimited(provider: string, accountId: string): boolean {
    const key = getRouterRateLimitKey(provider, accountId)
    const expiry = routerRateLimits.get(key)
    if (!expiry) return false
    if (Date.now() > expiry) {
        routerRateLimits.delete(key)
        return false
    }
    return true
}

function markRouterRateLimited(provider: string, accountId: string, durationMs: number = 30000): void {
    const key = getRouterRateLimitKey(provider, accountId)
    routerRateLimits.set(key, Date.now() + durationMs)
}

function getStickyCursorState(map: Map<string, StickyCursorState>, key: string, entriesLength: number): StickyCursorState {
    const existing = map.get(key)
    if (!existing) {
        const state = { cursor: 0 }
        map.set(key, state)
        return state
    }
    if (existing.cursor < 0 || existing.cursor >= entriesLength) {
        existing.cursor = 0
    }
    return existing
}

function advanceAccountCursor(state: StickyCursorState | null, entriesLength: number, currentIndex: number): void {
    if (!state || entriesLength <= 1) return
    state.cursor = (currentIndex + 1) % entriesLength
}

function buildOfficialModelIndex(): Map<string, Set<AuthProvider>> {
    const index = new Map<string, Set<AuthProvider>>()
    for (const provider of PROVIDER_ORDER) {
        const models = getProviderModels(provider, { includeAllVariants: true })
        for (const model of models) {
            const key = officialModelKey(model.id)
            if (!index.has(key)) {
                index.set(key, new Set<AuthProvider>())
            }
            index.get(key)!.add(provider)
        }
    }
    return index
}

function getOfficialModelProviders(model: string): AuthProvider[] {
    const officialModelIndex = buildOfficialModelIndex()
    return Array.from(officialModelIndex.get(officialModelKey(model)) || [])
}

function isOfficialModel(model: string): boolean {
    return getOfficialModelProviders(model).length > 0
}

function normalizeEntries(entries: RoutingEntry[]): RoutingEntry[] {
    return entries.filter(entry => {
        if (entry.provider === "codex" && isHiddenCodexModel(entry.modelId)) {
            return false
        }
        if (!isEntryUsable(entry)) return false
        if (entry.provider === "antigravity" && entry.accountId !== "auto") {
            if (!accountManager.hasAccount(entry.accountId)) {
                return false
            }
        }
        return true
    })
}

function listProviderAccountsInOrder(provider: AuthProvider): ProviderAccount[] {
    const accounts = authStore.listAccounts(provider)
    return accounts.sort((a, b) => {
        const aTime = a.createdAt || ""
        const bTime = b.createdAt || ""
        if (aTime && bTime) {
            return aTime.localeCompare(bTime)
        }
        if (aTime) return -1
        if (bTime) return 1
        return 0
    })
}

function buildAutoEntriesForProvider(provider: AuthProvider): AccountRoutingEntry[] {
    const accounts = listProviderAccountsInOrder(provider)
    return accounts.map(account => ({
        id: crypto.randomUUID(),
        provider,
        accountId: account.id,
        accountLabel: account.label || account.email || account.login || account.id,
    }))
}

function isAccountRoutingEntryValid(entry: AccountRoutingEntry, model: string): boolean {
    if (!isEntryUsable(entry)) return false
    if (entry.provider === "antigravity" && entry.accountId !== "auto") {
        if (!accountManager.hasAccount(entry.accountId)) {
            return false
        }
        if (isAntigravityModelSupportedForAccount(entry.accountId, model) === false) {
            return false
        }
    }
    return true
}

export function resolveAccountRoutingEntries(config: RoutingConfig, model: string): AccountRoutingEntry[] {
    const providers = getOfficialModelProviders(model)
    if (providers.length === 0) {
        throw new RoutingError(`Model "${model}" is not an official model`, 400)
    }

    const accountRouting = config.accountRouting
    const smartSwitch = accountRouting?.smartSwitch ?? false
    const baseModelId = baseModelIdFor(model)
    const route = accountRouting?.routes.find(r => modelIdsMatch(r.modelId, model))
        || (baseModelId ? accountRouting?.routes.find(r => modelIdsMatch(r.modelId, baseModelId)) : undefined)

    let entries: AccountRoutingEntry[] = route?.entries ? [...route.entries] : []

    if (entries.length === 0) {
        if (!smartSwitch) {
            throw new RoutingError(`No account routing configured for model "${model}"`, 400)
        }
        entries = providers.flatMap(provider => buildAutoEntriesForProvider(provider))
    } else {
        const expanded: AccountRoutingEntry[] = []
        for (const entry of entries) {
            if (entry.accountId === "auto") {
                if (!smartSwitch) {
                    throw new RoutingError(`Account routing for "${model}" includes auto entries but smart switch is disabled`, 400)
                }
                expanded.push(...buildAutoEntriesForProvider(entry.provider))
                continue
            }
            expanded.push(entry)
        }
        entries = expanded
    }

    const filterValid = (candidates: AccountRoutingEntry[]) =>
        candidates
            .filter(entry => providers.includes(entry.provider))
            .filter(entry => isAccountRoutingEntryValid(entry, model))

    let valid = filterValid(entries)
    if (valid.length === 0 && smartSwitch) {
        valid = filterValid(providers.flatMap(provider => buildAutoEntriesForProvider(provider)))
    }

    if (valid.length === 0) {
        throw new RoutingError(`No valid account routing entries for model "${model}"`, 400)
    }

    return valid
}

function getAccountDisplay(provider: AuthProvider, accountId: string): string {
    const account = authStore.getAccount(provider, accountId)
    return account?.login || account?.email || account?.label || accountId
}

const FALLBACK_STATUSES = new Set([401, 403, 408, 429, 500, 503, 529])
const DEFAULT_ROUTER_COOLDOWN_MS = 60_000
const ANTIGRAVITY_SERVER_ERROR_COOLDOWN_MS = 20_000

function isAccountUnavailableError(error: unknown): boolean {
    if (error instanceof UpstreamError) {
        if (error.status !== 429) return false
        const body = (error.body || "").trim()
        if (body.startsWith("Account unavailable:")) return true
    }
    if (!(error instanceof Error)) return false
    if (error.message.startsWith("Account not found:")) return true
    if (error.message.startsWith("Account unavailable:")) return true
    return false
}

function isTransientTransportError(error: unknown): boolean {
    if (!(error instanceof Error)) return false
    return /certificate|fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timed out/i.test(error.message)
}

function shouldFallbackOnUpstream(entry: RoutingEntry | AccountRoutingEntry, error: UpstreamError): boolean {
    if ((error as any).streamingStarted) return false
    if (error.status === 429) {
        return isQuotaExhausted(error) || (error as any).retryable === true
    }
    if (entry.provider === "codex" && isCodexUnsupportedModelError(error)) {
        return true
    }
    // Antigravity may return 404 for model-account mismatch; fallback to the next account.
    if (entry.provider === "antigravity" && error.status === 404) {
        return true
    }
    return FALLBACK_STATUSES.has(error.status)
}

function shouldAdvanceCursorOnError(entry: RoutingEntry | AccountRoutingEntry, error: UpstreamError): boolean {
    if (entry.provider !== "antigravity") return true
    if (isAccountUnavailableError(error)) return true
    if (error.status === 401 || error.status === 403) return true
    if (error.status === 404) return true
    if (error.status >= 500) return true
    if (error.status === 429 && isQuotaExhausted(error)) return true
    return false
}

function isQuotaExhausted(error: UpstreamError): boolean {
    if (error.status !== 429) return false
    const body = (error.body || "").trim()
    if (!body) return false

    if (body.startsWith("{") || body.startsWith("[")) {
        try {
            const json = JSON.parse(body)
            const err = json?.error || json
            const errType = String(err?.type || "")
            const errMessage = String(err?.message || "")
            if (errType === "usage_limit_reached" || /usage limit/i.test(errMessage)) {
                return true
            }
            const details = err?.details
            if (Array.isArray(details)) {
                for (const detail of details) {
                    if (detail?.reason === "QUOTA_EXHAUSTED") return true
                }
            }
        } catch {
            // ignore parse errors
        }
    }

    const lower = body.toLowerCase()
    if (lower.includes("usage_limit_reached") || lower.includes("usage limit")) return true
    if (lower.includes("quota_exhausted")) return true
    if (lower.includes("quota") && lower.includes("reset")) return true
    return false
}

function getFlowKey(model: string): string {
    const raw = model?.trim() || ""
    if (raw.toLowerCase().startsWith("route:")) {
        return raw.slice("route:".length).trim()
    }
    return raw
}

function findFlow(config: RoutingConfig, model: string): RoutingConfig["flows"][number] | undefined {
    const raw = model?.trim() || ""
    const flowKey = getFlowKey(model)
    const exact = config.flows.find(flow => flow.name === flowKey)
    if (exact) {
        return exact
    }

    // `route:` names are explicit and must remain exact. For ordinary model
    // requests, allow a configured flow to use either dotted or hyphenated
    // spelling of the same official model ID.
    if (raw.toLowerCase().startsWith("route:")) {
        return undefined
    }
    return config.flows.find(flow => modelIdsMatch(flow.name, flowKey))
}

function resolveFlowSelection(config: RoutingConfig, model: string): { flowKey: string; entries: RoutingEntry[] } {
    const flow = findFlow(config, model)
    const flowKey = flow?.name || getFlowKey(model)
    const entries = normalizeEntries(flow?.entries || [])
    if (entries.length === 0) {
        throw new RoutingError(`No flow routing entries configured for model "${model}"`, 400)
    }
    return { flowKey, entries }
}

function resolveActiveFlowSelection(config: RoutingConfig): { flowKey: string; entries: RoutingEntry[] } | null {
    if (!config.activeFlowId) return null
    const flow = config.flows.find(candidate => candidate.id === config.activeFlowId)
    if (!flow) return null
    const entries = normalizeEntries(flow.entries)
    if (entries.length === 0) return null
    return { flowKey: flow.name || "active", entries }
}

function shouldSkipFlowEntry(
    entry: RoutingEntry,
    entriesLength: number,
    options: { ignoreRateLimit?: boolean } = {}
): boolean {
    const ignoreRateLimit = options.ignoreRateLimit ?? false
    if (entry.provider === "antigravity") {
        const accountId = entry.accountId === "auto" ? undefined : entry.accountId
        if (accountId && isAntigravityModelSupportedForAccount(accountId, entry.modelId) === false) {
            return true
        }
        if (!ignoreRateLimit && accountId && entriesLength > 1) {
            const isLimited = accountManager.isAccountRateLimited(accountId) || isRouterRateLimited("antigravity", accountId)
            if (isLimited) return true
            if (accountManager.isAccountInFlight(accountId)) return true
        }
        return false
    }

    if (!ignoreRateLimit && authStore.isRateLimited(entry.provider, entry.accountId)) {
        return true
    }

    if (entry.provider === "codex") {
        const support = isCodexModelSupportedForAccount(entry.accountId, entry.modelId)
        if (support === false) {
            return true
        }
    }

    const account = authStore.getAccount(entry.provider, entry.accountId)
    return !account
}

function applyEntryRateLimit(
    entry: RoutingEntry | AccountRoutingEntry,
    error: UpstreamError,
    requestModel: string,
    defaultAntigravityCooldownMs: number
): void {
    if (entry.provider === "antigravity" && entry.accountId !== "auto") {
        // 404 is usually a model-account mismatch or transient upstream routing miss,
        // not an account quota/rate-limit signal. Avoid cooling down the account.
        // 401/403 are auth/permission class errors and should not poison account
        // availability with synthetic 429 "account unavailable" on subsequent requests.
        if (error.status === 404 || error.status === 401 || error.status === 403) {
            return
        }
        const cooldownMs = error.status >= 500 ? ANTIGRAVITY_SERVER_ERROR_COOLDOWN_MS : defaultAntigravityCooldownMs
        if (defaultAntigravityCooldownMs === DEFAULT_ROUTER_COOLDOWN_MS) {
            accountManager.markRateLimitedFromError(
                entry.accountId,
                error.status,
                error.body,
                error.retryAfter,
                requestModel,
                { maxDurationMs: cooldownMs }
            )
            markRouterRateLimited("antigravity", entry.accountId, cooldownMs)
        } else {
            accountManager
                .markRateLimitedFromError(entry.accountId, error.status, error.body, error.retryAfter, requestModel, { maxDurationMs: cooldownMs })
                .then((limit) => {
                    const duration = limit?.durationMs ?? cooldownMs
                    markRouterRateLimited("antigravity", entry.accountId, duration)
                })
                .catch(() => {
                    markRouterRateLimited("antigravity", entry.accountId, cooldownMs)
                })
        }
        return
    }

    if (entry.provider !== "antigravity") {
        authStore.markRateLimited(entry.provider, entry.accountId, error.status, error.body, error.retryAfter)
    }
}

function advanceFlowCursor(flowState: StickyCursorState | null, entries: RoutingEntry[], startIndex: number): void {
    if (!flowState || entries.length <= 1) return
    for (let offset = 1; offset < entries.length; offset++) {
        const nextIndex = (startIndex + offset) % entries.length
        const candidate = entries[nextIndex]
        if (!shouldSkipFlowEntry(candidate, entries.length)) {
            flowState.cursor = nextIndex
            return
        }
    }
}

function recordProviderUsage(
    modelId: string,
    completion: ProviderCompletion | null | undefined,
    provider?: string,
    accountId?: string
): void {
    if (!completion?.usage) return
    const inputTokens = completion.usage.inputTokens ?? 0
    const cacheReadTokens = completion.usage.cacheReadTokens ?? 0
    const outputTokens = completion.usage.outputTokens ?? 0
    if (inputTokens > 0 || outputTokens > 0 || cacheReadTokens > 0) {
        recordUsage(modelId, inputTokens, outputTokens, cacheReadTokens)
        if (provider && accountId) {
            recordIntelligentTokenUsage(provider, accountId, {
                uncachedInputTokens: inputTokens,
                outputTokens,
                cacheReadTokens,
                model: modelId,
            })
        }
    }
}

async function createHostedProviderCompletion(
    provider: Exclude<AuthProvider, "antigravity">,
    account: ProviderAccount,
    model: string,
    request: RoutedRequest
): Promise<ProviderCompletion> {
    if (provider === "codex") {
        return createCodexCompletion(account, model, request.messages, request.tools, request.maxTokens, request.reasoningEffort, request.signal)
    }
    if (provider === "copilot") {
        return createCopilotCompletion(account, model, request.messages, request.tools, request.maxTokens, request.reasoningEffort, request.signal)
    }
    if (provider === "zed") {
        return createZedCompletion(account, model, request.messages, request.tools, request.maxTokens, request.reasoningEffort, request.signal)
    }
    if (provider === "kiro") {
        return createKiroCompletion(account, model, request.messages, request.tools, request.maxTokens, request.signal)
    }
    if (provider === "grok") {
        return createGrokCompletion(account, model, request.messages, request.tools, request.maxTokens, request.reasoningEffort, request.signal)
    }
    throw new Error("Unsupported provider")
}

function* emitHostedCompletionAsSse(model: string, completion: ProviderCompletion): Generator<string, void, unknown> {
    yield buildMessageStart(model)
    let blockIndex = 0
    for (const block of completion.contentBlocks) {
        if (block.type === "tool_use") {
            yield buildContentBlockStart(blockIndex, "tool_use", { id: block.id!, name: block.name! })
            const inputText = JSON.stringify(block.input || {})
            yield buildInputJsonDelta(blockIndex, inputText)
            yield buildContentBlockStop(blockIndex)
            blockIndex++
            continue
        }

        yield buildContentBlockStart(blockIndex, "text")
        yield buildTextDelta(blockIndex, block.text || "")
        yield buildContentBlockStop(blockIndex)
        blockIndex++
    }
    yield buildMessageDelta(
        completion.stopReason || "end_turn",
        completion.usage ? { inputTokens: completion.usage.inputTokens ?? 0, outputTokens: completion.usage.outputTokens ?? 0 } : undefined
    )
    yield buildMessageStop()
}

function handleFlowEntryError(
    entry: RoutingEntry,
    error: unknown,
    requestModel: string,
    flowState: StickyCursorState | null,
    entries: RoutingEntry[],
    index: number,
    startIndex: number
): boolean {
    if (entry.provider === "antigravity" && isAccountUnavailableError(error)) {
        return true
    }
    if (error instanceof UpstreamError && shouldFallbackOnUpstream(entry, error)) {
        if (entry.provider === "antigravity" && error.status === 404 && entry.accountId !== "auto") {
            markAntigravityModelUnsupported(entry.accountId, requestModel)
        }
        if (shouldAdvanceCursorOnError(entry, error)) {
            applyEntryRateLimit(entry, error, requestModel, 30_000)
            if (flowState && index === startIndex) {
                advanceFlowCursor(flowState, entries, startIndex)
            }
        }
        return true
    }
    if (isTransientTransportError(error)) {
        if (entry.provider !== "antigravity") {
            authStore.markRateLimited(entry.provider, entry.accountId, 500, (error as Error).message)
        }
        return true
    }
    return false
}

function selectFallbackFlowEntry(entries: RoutingEntry[], fallbackIndex: number): RoutingEntry {
    for (let offset = 0; offset < entries.length; offset++) {
        const index = (fallbackIndex + offset) % entries.length
        const candidate = entries[index]
        if (!shouldSkipFlowEntry(candidate, entries.length)) {
            return candidate
        }
    }
    const cursorEntry = entries[fallbackIndex]
    if (cursorEntry.provider === "codex") {
        const support = isCodexModelSupportedForAccount(cursorEntry.accountId, cursorEntry.modelId)
        if (support === false) {
            throw new RoutingError("No routing entries available", 400)
        }
    }
    return cursorEntry
}

function handleAccountEntryError(
    entry: AccountRoutingEntry,
    error: unknown,
    requestModel: string,
    accountState: StickyCursorState,
    entriesLength: number,
    index: number
): boolean {
    if (entry.provider === "antigravity" && isAccountUnavailableError(error)) {
        advanceAccountCursor(accountState, entriesLength, index)
        return true
    }
    if (error instanceof UpstreamError && shouldFallbackOnUpstream(entry, error)) {
        if (entry.provider === "antigravity" && error.status === 404 && entry.accountId !== "auto") {
            markAntigravityModelUnsupported(entry.accountId, requestModel)
        }
        if (shouldAdvanceCursorOnError(entry, error)) {
            applyEntryRateLimit(entry, error, requestModel, DEFAULT_ROUTER_COOLDOWN_MS)
            advanceAccountCursor(accountState, entriesLength, index)
        }
        return true
    }
    if (isTransientTransportError(error)) {
        if (entry.provider !== "antigravity") {
            authStore.markRateLimited(entry.provider, entry.accountId, 500, (error as Error).message)
            advanceAccountCursor(accountState, entriesLength, index)
        }
        return true
    }
    return false
}

async function createFlowCompletionWithEntries(request: RoutedRequest, entries: RoutingEntry[], flowKey?: string) {
    let lastError: Error | null = null
    const flowState = flowKey ? getStickyCursorState(flowStickyStates, flowKey, entries.length) : null
    const startIndex = flowState?.cursor ?? 0

    const attemptEntry = async (entry: RoutingEntry) => {
        if (entry.provider === "antigravity") {
            const accountId = entry.accountId === "auto" ? undefined : entry.accountId
            setRequestLogContext({ model: entry.modelId, provider: "antigravity", account: entry.accountId, routeTag: "fr" })
            return await createChatCompletionWithOptions({ ...request, model: entry.modelId }, {
                accountId,
                allowRotation: !accountId,
                routeTag: "fr",
            })
        }

        const account = authStore.getAccount(entry.provider, entry.accountId)
        if (!account) {
            throw new Error("Account not found")
        }
        const accountDisplay = account.login || account.email || entry.accountId
        setRequestLogContext({ model: entry.modelId, provider: entry.provider, account: accountDisplay, routeTag: "fr" })

        const startTime = Date.now()
        const result = await createHostedProviderCompletion(entry.provider, account, entry.modelId, request)
        recordProviderUsage(entry.modelId, result)
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
        console.log(formatSuccessLine({ elapsed, model: request.model, provider: entry.provider, account: accountDisplay, routeTag: "fr" }))
        return result
    }

    for (let offset = 0; offset < entries.length; offset++) {
        const index = (startIndex + offset) % entries.length
        const entry = entries[index]
        if (shouldSkipFlowEntry(entry, entries.length)) {
            continue
        }
        try {
            const result = await attemptEntry(entry)
            if (flowState) {
                flowState.cursor = index
            }
            return result
        } catch (error) {
            lastError = error as Error
            if (handleFlowEntryError(entry, error, request.model, flowState, entries, index, startIndex)) {
                continue
            }
            throw error
        }
    }

    if (!lastError && entries.length > 0) {
        const entry = selectFallbackFlowEntry(entries, flowState?.cursor ?? 0)
        return await attemptEntry(entry)
    }

    if (lastError) {
        throw lastError
    }

    throw new RoutingError("No routing entries available", 400)
}

function orderAccountEntriesForRequest(
    entries: AccountRoutingEntry[],
    request: RoutedRequest,
    useIntelligentRouting: boolean
): {
    orderedEntries: Array<{ entry: AccountRoutingEntry; originalIndex: number }>
    sessionKey?: string
    accountState: StickyCursorState
} {
    const accountState = getStickyCursorState(accountStickyStates, request.model || "", entries.length)
    const startIndex = accountState.cursor
    const sessionKey =
        typeof computeSessionKey === "function" && Array.isArray(request.messages) && request.messages.length > 0
            ? computeSessionKey(request.messages)
            : undefined

    if (useIntelligentRouting && entries.length > 1) {
        const ranked = rankAccountCandidates(entries, {
            model: request.model,
            sessionKey,
            isInFlight: (id) => accountManager.isAccountInFlight?.(id) ?? false,
            getConsecutiveFailures: (id) => accountManager.getAccount?.(id)?.consecutiveFailures ?? 0,
            getTotalTokens: (id) => accountManager.getAccountUsage?.(id) ?? 0,
            messages: request.messages,
        })
        return {
            orderedEntries: ranked.map((r) => ({ entry: r.entry, originalIndex: r.originalIndex })),
            sessionKey,
            accountState,
        }
    }

    const orderedEntries: Array<{ entry: AccountRoutingEntry; originalIndex: number }> = []
    for (let offset = 0; offset < entries.length; offset++) {
        const index = (startIndex + offset) % entries.length
        orderedEntries.push({ entry: entries[index], originalIndex: index })
    }
    return { orderedEntries, sessionKey, accountState }
}

async function createAccountCompletionWithEntries(
    request: RoutedRequest,
    entries: AccountRoutingEntry[],
    useIntelligentRouting: boolean = false
) {
    let lastError: Error | null = null
    const { orderedEntries, sessionKey, accountState } = orderAccountEntriesForRequest(
        entries,
        request,
        useIntelligentRouting
    )
    let inFlightEntry: { entry: AccountRoutingEntry; index: number } | null = null
    let hasRateLimited = false

    for (const { entry, originalIndex: index } of orderedEntries) {
        try {
            if (entry.provider === "antigravity") {
                if (entry.accountId === "auto") {
                    throw new RoutingError(`Account routing entry for "${request.model}" cannot use auto without smart switch expansion`, 400)
                }
                if (isAntigravityModelSupportedForAccount(entry.accountId, request.model) === false) {
                    advanceAccountCursor(accountState, entries.length, index)
                    continue
                }
                const isLimited = accountManager.isAccountRateLimited(entry.accountId) || isRouterRateLimited("antigravity", entry.accountId)
                if (isLimited) {
                    hasRateLimited = true
                    continue
                }
                if (entries.length > 1 && accountManager.isAccountInFlight(entry.accountId)) {
                    if (!inFlightEntry) inFlightEntry = { entry, index }
                    continue
                }
                const accountDisplay = getAccountDisplay("antigravity", entry.accountId)
                setRequestLogContext({ model: request.model, provider: "antigravity", account: accountDisplay, routeTag: "ar" })
                const result = await createChatCompletionWithOptions({ ...request, model: request.model }, {
                    accountId: entry.accountId,
                    allowRotation: false,
                    routeTag: "ar",
                })
                if (useIntelligentRouting) {
                    recordIntelligentDispatch("antigravity", entry.accountId, sessionKey, request.model)
                }
                accountState.cursor = index
                return result
            }

            if (authStore.isRateLimited(entry.provider, entry.accountId)) {
                hasRateLimited = true
                continue
            }

            if (entry.provider === "codex") {
                const support = isCodexModelSupportedForAccount(entry.accountId, request.model)
                if (support === false) {
                    advanceAccountCursor(accountState, entries.length, index)
                    continue
                }
            }

            const account = authStore.getAccount(entry.provider, entry.accountId)
            if (!account) {
                continue
            }
            const accountDisplay = account.login || account.email || entry.accountId
            setRequestLogContext({ model: request.model, provider: entry.provider, account: accountDisplay, routeTag: "ar" })

            const startTime = Date.now()
            const result = await createHostedProviderCompletion(entry.provider, account, request.model, request)
            recordProviderUsage(request.model, result, entry.provider, entry.accountId)
            if (useIntelligentRouting) {
                recordIntelligentDispatch(entry.provider, entry.accountId, sessionKey, request.model)
            }
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
            console.log(formatSuccessLine({ elapsed, model: request.model, provider: entry.provider, account: accountDisplay, routeTag: "ar" }))
            accountState.cursor = index
            return result
        } catch (error) {
            lastError = error as Error
            if (handleAccountEntryError(entry, error, request.model, accountState, entries.length, index)) {
                continue
            }
            throw error
        }
    }

    if (inFlightEntry && inFlightEntry.entry.provider === "antigravity") {
        const { entry, index } = inFlightEntry
        const accountDisplay = getAccountDisplay("antigravity", entry.accountId)
        setRequestLogContext({ model: request.model, provider: "antigravity", account: accountDisplay, routeTag: "ar" })
        const result = await createChatCompletionWithOptions({ ...request, model: request.model }, {
            accountId: entry.accountId,
            allowRotation: false,
            routeTag: "ar",
        })
        if (useIntelligentRouting) {
            recordIntelligentDispatch("antigravity", entry.accountId, sessionKey, request.model)
        }
        accountState.cursor = index
        return result
    }

    if (lastError) {
        throw lastError
    }

    if (hasRateLimited) {
        throw new UpstreamError("antigravity", 429, `All accounts for model "${request.model}" are currently rate-limited.`)
    }

    throw new RoutingError(`No account routing entries available for model "${request.model}"`, 400)
}

function prepareRoutedRequest(request: RoutedRequest): { normalizedModel: string; normalizedRequest: RoutedRequest; config: RoutingConfig } {
    const normalizedModel = normalizeOfficialModelId(request.model)
    if (isHiddenCodexModel(normalizedModel)) {
        throw new RoutingError("Model is not available", 400)
    }
    const normalizedRequest = normalizedModel === request.model ? request : { ...request, model: normalizedModel }
    const config = loadRoutingConfig()
    return { normalizedModel, normalizedRequest, config }
}

export async function createRoutedCompletion(request: RoutedRequest) {
    const { normalizedModel, normalizedRequest, config } = prepareRoutedRequest(request)
    const activeFlow = resolveActiveFlowSelection(config)
    if (activeFlow) {
        return createFlowCompletionWithEntries(normalizedRequest, activeFlow.entries, activeFlow.flowKey)
    }
    if (!isOfficialModel(normalizedModel)) await ensureProviderModelsSynced()
    if (isOfficialModel(normalizedModel)) {
        const accountEntries = resolveAccountRoutingEntries(config, normalizedModel)
        const useIntelligent = isCacheAwareRoutingEnabled() || (config.accountRouting?.smartSwitch ?? false)
        return createAccountCompletionWithEntries(normalizedRequest, accountEntries, useIntelligent)
    }

    const flowSelection = resolveFlowSelection(config, normalizedRequest.model)
    return createFlowCompletionWithEntries(normalizedRequest, flowSelection.entries, flowSelection.flowKey)
}

async function* createFlowCompletionStreamWithEntries(request: RoutedRequest, entries: RoutingEntry[], flowKey?: string): AsyncGenerator<string, void, unknown> {
    let lastError: Error | null = null
    const flowState = flowKey ? getStickyCursorState(flowStickyStates, flowKey, entries.length) : null
    const startIndex = flowState?.cursor ?? 0

    async function* streamEntry(entry: RoutingEntry): AsyncGenerator<string, void, unknown> {
        if (entry.provider === "antigravity") {
            const accountId = entry.accountId === "auto" ? undefined : entry.accountId
            setRequestLogContext({ model: entry.modelId, provider: "antigravity", account: entry.accountId, routeTag: "fr" })
            yield* createChatCompletionStreamWithOptions({ ...request, model: entry.modelId }, {
                accountId,
                allowRotation: !accountId,
                routeTag: "fr",
            })
            return
        }

        const account = authStore.getAccount(entry.provider, entry.accountId)
        if (!account) {
            throw new Error("Account not found")
        }
        const accountDisplay = account.login || account.email || entry.accountId
        setRequestLogContext({ model: entry.modelId, provider: entry.provider, account: accountDisplay, routeTag: "fr" })

        const startTime = Date.now()
        const completion = await createHostedProviderCompletion(entry.provider, account, entry.modelId, request)
        if (!completion) {
            throw new Error("Empty completion")
        }

        yield* emitHostedCompletionAsSse(request.model, completion)
        recordProviderUsage(entry.modelId, completion)

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
        console.log(formatSuccessLine({ elapsed, model: request.model, provider: entry.provider, account: accountDisplay, routeTag: "fr" }))
    }

    for (let offset = 0; offset < entries.length; offset++) {
        const index = (startIndex + offset) % entries.length
        const entry = entries[index]
        if (shouldSkipFlowEntry(entry, entries.length)) {
            continue
        }
        try {
            yield* streamEntry(entry)
            if (flowState) {
                flowState.cursor = index
            }
            return
        } catch (error) {
            lastError = error as Error
            if (handleFlowEntryError(entry, error, request.model, flowState, entries, index, startIndex)) {
                continue
            }
            throw error
        }
    }

    if (!lastError && entries.length > 0) {
        const entry = selectFallbackFlowEntry(entries, flowState?.cursor ?? 0)
        yield* streamEntry(entry)
        return
    }

    if (lastError) {
        throw lastError
    }

    throw new RoutingError("No routing entries available", 400)
}

async function* createAccountCompletionStreamWithEntries(
    request: RoutedRequest,
    entries: AccountRoutingEntry[],
    useIntelligentRouting: boolean = false
): AsyncGenerator<string, void, unknown> {
    let lastError: Error | null = null
    const { orderedEntries, sessionKey, accountState } = orderAccountEntriesForRequest(
        entries,
        request,
        useIntelligentRouting
    )
    let inFlightEntry: { entry: AccountRoutingEntry; index: number } | null = null
    let hasRateLimited = false

    for (const { entry, originalIndex: index } of orderedEntries) {
        try {
            if (entry.provider === "antigravity") {
                if (entry.accountId === "auto") {
                    throw new RoutingError(`Account routing entry for "${request.model}" cannot use auto without smart switch expansion`, 400)
                }
                if (isAntigravityModelSupportedForAccount(entry.accountId, request.model) === false) {
                    advanceAccountCursor(accountState, entries.length, index)
                    continue
                }
                const isLimited = accountManager.isAccountRateLimited(entry.accountId) || isRouterRateLimited("antigravity", entry.accountId)
                if (isLimited) {
                    hasRateLimited = true
                    continue
                }
                if (entries.length > 1 && accountManager.isAccountInFlight(entry.accountId)) {
                    if (!inFlightEntry) inFlightEntry = { entry, index }
                    continue
                }
                const accountDisplay = getAccountDisplay("antigravity", entry.accountId)
                setRequestLogContext({ model: request.model, provider: "antigravity", account: accountDisplay, routeTag: "ar" })
                yield* createChatCompletionStreamWithOptions({ ...request, model: request.model }, {
                    accountId: entry.accountId,
                    allowRotation: false,
                    routeTag: "ar",
                })
                if (useIntelligentRouting) {
                    recordIntelligentDispatch("antigravity", entry.accountId, sessionKey, request.model)
                }
                accountState.cursor = index
                return
            }

            if (authStore.isRateLimited(entry.provider, entry.accountId)) {
                hasRateLimited = true
                continue
            }

            if (entry.provider === "codex") {
                const support = isCodexModelSupportedForAccount(entry.accountId, request.model)
                if (support === false) {
                    advanceAccountCursor(accountState, entries.length, index)
                    continue
                }
            }

            const account = authStore.getAccount(entry.provider, entry.accountId)
            if (!account) {
                continue
            }
            const accountDisplay = account.login || account.email || entry.accountId
            setRequestLogContext({ model: request.model, provider: entry.provider, account: accountDisplay, routeTag: "ar" })

            const startTime = Date.now()
            const completion = await createHostedProviderCompletion(entry.provider, account, request.model, request)
            if (!completion) {
                throw new Error("Empty completion")
            }

            yield* emitHostedCompletionAsSse(request.model, completion)
            recordProviderUsage(request.model, completion, entry.provider, entry.accountId)
            if (useIntelligentRouting) {
                recordIntelligentDispatch(entry.provider, entry.accountId, sessionKey, request.model)
            }

            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
            console.log(formatSuccessLine({ elapsed, model: request.model, provider: entry.provider, account: accountDisplay, routeTag: "ar" }))
            accountState.cursor = index
            return
        } catch (error) {
            lastError = error as Error
            if (handleAccountEntryError(entry, error, request.model, accountState, entries.length, index)) {
                continue
            }
            throw error
        }
    }

    if (inFlightEntry && inFlightEntry.entry.provider === "antigravity") {
        const { entry, index } = inFlightEntry
        const accountDisplay = getAccountDisplay("antigravity", entry.accountId)
        setRequestLogContext({ model: request.model, provider: "antigravity", account: accountDisplay, routeTag: "ar" })
        yield* createChatCompletionStreamWithOptions({ ...request, model: request.model }, {
            accountId: entry.accountId,
            allowRotation: false,
            routeTag: "ar",
        })
        if (useIntelligentRouting) {
            recordIntelligentDispatch("antigravity", entry.accountId, sessionKey, request.model)
        }
        accountState.cursor = index
        return
    }

    if (lastError) {
        throw lastError
    }

    if (hasRateLimited) {
        throw new UpstreamError("antigravity", 429, `All accounts for model "${request.model}" are currently rate-limited.`)
    }

    throw new RoutingError(`No account routing entries available for model "${request.model}"`, 400)
}

export async function* createRoutedCompletionStream(request: RoutedRequest): AsyncGenerator<string, void, unknown> {
    const { normalizedModel, normalizedRequest, config } = prepareRoutedRequest(request)
    const activeFlow = resolveActiveFlowSelection(config)
    if (activeFlow) {
        yield* createFlowCompletionStreamWithEntries(normalizedRequest, activeFlow.entries, activeFlow.flowKey)
        return
    }

    if (!isOfficialModel(normalizedModel)) await ensureProviderModelsSynced()
    if (isOfficialModel(normalizedModel)) {
        const accountEntries = resolveAccountRoutingEntries(config, normalizedModel)
        const useIntelligent = isCacheAwareRoutingEnabled() || (config.accountRouting?.smartSwitch ?? false)
        yield* createAccountCompletionStreamWithEntries(normalizedRequest, accountEntries, useIntelligent)
        return
    }

    const flowSelection = resolveFlowSelection(config, normalizedRequest.model)
    yield* createFlowCompletionStreamWithEntries(normalizedRequest, flowSelection.entries, flowSelection.flowKey)
}
