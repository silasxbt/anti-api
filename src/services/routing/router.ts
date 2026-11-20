import type { ClaudeMessage, ClaudeTool, CompletionUsage, ContentBlock } from "~/lib/translator"
import { UpstreamError } from "~/lib/error"
import {
    createChatCompletionWithOptions,
    createAntigravityEventStreamWithOptions,
    isAntigravityModelSupportedForAccount,
    markAntigravityModelUnsupported,
    computeSessionKey,
} from "~/services/antigravity/chat"
import { accountManager } from "~/services/antigravity/account-manager"
import {
    createCodexChatDirect,
    createCodexCompletion,
    createCodexEventStream,
    createCodexResponsesDirect,
    isCodexModelSupportedForAccount,
    isCodexUnsupportedModelError,
} from "~/services/codex/chat"
import {
    createCopilotChatDirect,
    createCopilotCompletion,
    createCopilotEventStream,
    createCopilotResponsesDirect,
} from "~/services/copilot/chat"
import { createZedCompletion } from "~/services/zed/chat"
import { createKiroCompletion } from "~/services/kiro/chat"
import { createGrokChatDirect, createGrokCompletion, createGrokResponsesDirect } from "~/services/grok/chat"
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
import { baseModelIdFor, getAntigravityCatalog } from "~/lib/model-catalog"
import { formatSuccessLine, setRequestLogContext } from "~/lib/logger"
import { recordUsage } from "~/services/usage-tracker"
import {
    completionToEvents,
    formatAnthropicSse,
    type RoutedStreamEvent,
} from "~/lib/stream-events"
import {
    extractResponsesPromptText,
    type DirectResult,
    type DirectUsage,
} from "~/lib/direct-stream"
import { createImageInputBudget } from "~/lib/image-input"
import {
    completionToOpenAIChatObject,
    eventsToOpenAIChatSse,
    extractOpenAIReasoningEffort,
    mapModel,
    translateMessages,
    translateOpenAIToolChoice,
    translateTools,
} from "~/routes/openai/translator"
import type { OpenAIChatCompletionRequest } from "~/routes/openai/types"
import {
    completionToResponseObject,
    eventsToResponsesSse,
    extractResponsesReasoningEffort,
    generateResponseId,
    responsesToRoutedInput,
} from "~/routes/responses/translator"
import type { ResponsesCreateRequest } from "~/routes/responses/types"

export class RoutingError extends Error {
    status: number
    constructor(message: string, status: number = 400) {
        super(message)
        this.name = "RoutingError"
        this.status = status
    }
}

export interface RoutedRequest {
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

const routerRateLimits = new Map<string, number>()
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
    routerRateLimits.set(getRouterRateLimitKey(provider, accountId), Date.now() + durationMs)
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
    return Array.from(buildOfficialModelIndex().get(officialModelKey(model)) || [])
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
        if (aTime && bTime) return aTime.localeCompare(bTime)
        if (aTime) return -1
        if (bTime) return 1
        return 0
    })
}

function buildAutoEntriesForProvider(provider: AuthProvider): AccountRoutingEntry[] {
    return listProviderAccountsInOrder(provider).map(account => ({
        id: crypto.randomUUID(),
        provider,
        accountId: account.id,
        accountLabel: account.label || account.email || account.login || account.id,
    }))
}

function isAccountRoutingEntryValid(entry: AccountRoutingEntry, model: string): boolean {
    if (!isEntryUsable(entry)) return false
    if (entry.provider === "antigravity" && entry.accountId !== "auto") {
        if (!accountManager.hasAccount(entry.accountId)) return false
        if (isAntigravityModelSupportedForAccount(entry.accountId, model) === false) return false
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
    if (error instanceof UpstreamError && error.status === 429) {
        if ((error.body || "").trim().startsWith("Account unavailable:")) return true
    }
    if (!(error instanceof Error)) return false
    return error.message.startsWith("Account not found:") || error.message.startsWith("Account unavailable:")
}

function isTransientTransportError(error: unknown): boolean {
    if (!(error instanceof Error)) return false
    return /certificate|fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timed out/i.test(error.message)
}

function shouldFallbackOnUpstream(error: UpstreamError): boolean {
    if ((error as any).streamingStarted) return false
    if (error.status === 429) return true
    if (error.status === 404 && (error.provider === "codex" || error.provider === "antigravity")) return true
    if (error.provider === "codex" && isCodexUnsupportedModelError(error)) return true
    return FALLBACK_STATUSES.has(error.status)
}

function shouldAdvanceCursorOnError(entry: RoutingEntry | AccountRoutingEntry, error: UpstreamError): boolean {
    if (entry.provider !== "antigravity") return true
    return (
        isAccountUnavailableError(error) ||
        error.status === 401 ||
        error.status === 403 ||
        error.status === 404 ||
        error.status === 429 ||
        error.status >= 500
    )
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
    if (exact) return exact
    if (raw.toLowerCase().startsWith("route:")) return undefined
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

function applyEntryRateLimit(
    entry: RoutingEntry | AccountRoutingEntry,
    error: UpstreamError,
    requestModel: string,
    defaultAntigravityCooldownMs: number
): void {
    if (entry.provider === "antigravity" && entry.accountId !== "auto") {
        if (error.status === 404 || error.status === 401 || error.status === 403) return
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
                    markRouterRateLimited("antigravity", entry.accountId, limit?.durationMs ?? cooldownMs)
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
        if (!shouldSkipFlowEntry(entries[nextIndex], entries.length)) {
            flowState.cursor = nextIndex
            return
        }
    }
}

function shouldSkipFlowEntry(entry: RoutingEntry, entriesLength: number): boolean {
    if (entry.provider === "antigravity") {
        const accountId = entry.accountId === "auto" ? undefined : entry.accountId
        if (accountId && isAntigravityModelSupportedForAccount(accountId, entry.modelId) === false) {
            return true
        }
        if (accountId && entriesLength > 1) {
            if (accountManager.isAccountRateLimited(accountId) || isRouterRateLimited("antigravity", accountId)) {
                return true
            }
            if (accountManager.isAccountInFlight(accountId)) return true
        }
        return false
    }

    if (authStore.isRateLimited(entry.provider, entry.accountId)) return true
    if (entry.provider === "codex" && isCodexModelSupportedForAccount(entry.accountId, entry.modelId) === false) {
        return true
    }
    return !authStore.getAccount(entry.provider, entry.accountId)
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
    if (entry.provider === "antigravity" && isAccountUnavailableError(error)) return true
    if (error instanceof UpstreamError && shouldFallbackOnUpstream(error)) {
        if (entry.provider === "antigravity" && error.status === 404 && entry.accountId !== "auto") {
            markAntigravityModelUnsupported(entry.accountId, requestModel)
        }
        if (shouldAdvanceCursorOnError(entry, error)) {
            applyEntryRateLimit(entry, error, requestModel, 30_000)
            if (flowState && index === startIndex) advanceFlowCursor(flowState, entries, startIndex)
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
    if (error instanceof UpstreamError && shouldFallbackOnUpstream(error)) {
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

function selectFallbackFlowEntry(entries: RoutingEntry[], fallbackIndex: number): RoutingEntry {
    for (let offset = 0; offset < entries.length; offset++) {
        const candidate = entries[(fallbackIndex + offset) % entries.length]
        if (!shouldSkipFlowEntry(candidate, entries.length)) return candidate
    }
    const cursorEntry = entries[fallbackIndex]
    if (cursorEntry.provider === "codex" && isCodexModelSupportedForAccount(cursorEntry.accountId, cursorEntry.modelId) === false) {
        throw new RoutingError("No routing entries available", 400)
    }
    return cursorEntry
}

function recordProviderUsage(
    modelId: string,
    usage: Partial<CompletionUsage> | DirectUsage | null | undefined,
    provider?: string,
    accountId?: string
): void {
    if (!usage) return
    const inputTokens = usage.inputTokens ?? 0
    const cacheReadTokens = usage.cacheReadTokens ?? 0
    const outputTokens = usage.outputTokens ?? 0
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

/**
 * Pull the first item from an async generator before returning it so pre-stream
 * HTTP/429/404 errors are caught by the routing loop and fall back cleanly.
 */
async function peekStream<T>(stream: AsyncGenerator<T, void, unknown>): Promise<AsyncGenerator<T, void, unknown>> {
    const first = await stream.next()
    if (first.done) {
        return (async function* () {})()
    }
    return (async function* () {
        try {
            yield first.value
            for await (const item of stream) {
                yield item
            }
        } finally {
            await stream.return?.()
        }
    })()
}

type RoutedTarget = {
    provider: AuthProvider
    accountId: string
    modelId: string
    routeTag: "fr" | "ar"
    account?: ProviderAccount
    accountDisplay: string
}

function orderAccountEntriesForRequest(
    model: string,
    entries: AccountRoutingEntry[],
    useIntelligentRouting: boolean,
    sessionMessages?: ClaudeMessage[]
): {
    orderedEntries: Array<{ entry: AccountRoutingEntry; originalIndex: number }>
    sessionKey?: string
    accountState: StickyCursorState
} {
    const accountState = getStickyCursorState(accountStickyStates, model || "", entries.length)
    const startIndex = accountState.cursor
    const sessionKey =
        typeof computeSessionKey === "function" && Array.isArray(sessionMessages) && sessionMessages.length > 0
            ? computeSessionKey(sessionMessages)
            : undefined

    if (useIntelligentRouting && entries.length > 1) {
        const ranked = rankAccountCandidates(entries, {
            model,
            sessionKey,
            isInFlight: (id) => accountManager.isAccountInFlight?.(id) ?? false,
            getConsecutiveFailures: (id) => accountManager.getAccount?.(id)?.consecutiveFailures ?? 0,
            getTotalTokens: (id) => accountManager.getAccountUsage?.(id) ?? 0,
            messages: sessionMessages,
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

async function runFlowEntries<T>(
    requestModel: string,
    entries: RoutingEntry[],
    flowKey: string | undefined,
    runner: (target: RoutedTarget) => Promise<T>
): Promise<T> {
    let lastError: Error | null = null
    const flowState = flowKey ? getStickyCursorState(flowStickyStates, flowKey, entries.length) : null
    const startIndex = flowState?.cursor ?? 0

    const attemptEntry = async (entry: RoutingEntry): Promise<T> => {
        if (entry.provider === "antigravity") {
            const target: RoutedTarget = {
                provider: "antigravity",
                accountId: entry.accountId,
                modelId: entry.modelId,
                routeTag: "fr",
                accountDisplay: entry.accountId,
            }
            setRequestLogContext({ model: entry.modelId, provider: "antigravity", account: entry.accountId, routeTag: "fr" })
            return await runner(target)
        }
        const account = authStore.getAccount(entry.provider, entry.accountId)
        if (!account) throw new Error("Account not found")
        const accountDisplay = account.login || account.email || entry.accountId
        setRequestLogContext({ model: entry.modelId, provider: entry.provider, account: accountDisplay, routeTag: "fr" })
        return await runner({
            provider: entry.provider,
            accountId: entry.accountId,
            modelId: entry.modelId,
            routeTag: "fr",
            account,
            accountDisplay,
        })
    }

    for (let offset = 0; offset < entries.length; offset++) {
        const index = (startIndex + offset) % entries.length
        const entry = entries[index]
        if (shouldSkipFlowEntry(entry, entries.length)) continue
        try {
            const result = await attemptEntry(entry)
            if (flowState) flowState.cursor = index
            return result
        } catch (error) {
            lastError = error as Error
            if (handleFlowEntryError(entry, error, requestModel, flowState, entries, index, startIndex)) {
                continue
            }
            throw error
        }
    }

    if (!lastError && entries.length > 0) {
        return await attemptEntry(selectFallbackFlowEntry(entries, flowState?.cursor ?? 0))
    }
    if (lastError) throw lastError
    throw new RoutingError("No routing entries available", 400)
}

async function runAccountEntries<T>(
    model: string,
    entries: AccountRoutingEntry[],
    useIntelligentRouting: boolean,
    sessionMessages: ClaudeMessage[] | undefined,
    runner: (target: RoutedTarget) => Promise<T>
): Promise<T> {
    let lastError: Error | null = null
    const { orderedEntries, sessionKey, accountState } = orderAccountEntriesForRequest(
        model,
        entries,
        useIntelligentRouting,
        sessionMessages
    )
    let inFlightEntry: { entry: AccountRoutingEntry; index: number } | null = null
    let hasRateLimited = false

    for (const { entry, originalIndex: index } of orderedEntries) {
        try {
            if (entry.provider === "antigravity") {
                if (entry.accountId === "auto") {
                    throw new RoutingError(`Account routing entry for "${model}" cannot use auto without smart switch expansion`, 400)
                }
                if (isAntigravityModelSupportedForAccount(entry.accountId, model) === false) {
                    advanceAccountCursor(accountState, entries.length, index)
                    continue
                }
                if (accountManager.isAccountRateLimited(entry.accountId) || isRouterRateLimited("antigravity", entry.accountId)) {
                    hasRateLimited = true
                    continue
                }
                if (entries.length > 1 && accountManager.isAccountInFlight(entry.accountId)) {
                    if (!inFlightEntry) inFlightEntry = { entry, index }
                    continue
                }
                const accountDisplay = getAccountDisplay("antigravity", entry.accountId)
                setRequestLogContext({ model, provider: "antigravity", account: accountDisplay, routeTag: "ar" })
                const result = await runner({
                    provider: "antigravity",
                    accountId: entry.accountId,
                    modelId: model,
                    routeTag: "ar",
                    accountDisplay,
                })
                if (useIntelligentRouting) {
                    recordIntelligentDispatch("antigravity", entry.accountId, sessionKey, model)
                }
                accountState.cursor = index
                return result
            }

            if (authStore.isRateLimited(entry.provider, entry.accountId)) {
                hasRateLimited = true
                continue
            }
            if (entry.provider === "codex" && isCodexModelSupportedForAccount(entry.accountId, model) === false) {
                advanceAccountCursor(accountState, entries.length, index)
                continue
            }
            const account = authStore.getAccount(entry.provider, entry.accountId)
            if (!account) continue

            const accountDisplay = account.login || account.email || entry.accountId
            setRequestLogContext({ model, provider: entry.provider, account: accountDisplay, routeTag: "ar" })
            const result = await runner({
                provider: entry.provider,
                accountId: entry.accountId,
                modelId: model,
                routeTag: "ar",
                account,
                accountDisplay,
            })
            if (useIntelligentRouting) {
                recordIntelligentDispatch(entry.provider, entry.accountId, sessionKey, model)
            }
            accountState.cursor = index
            return result
        } catch (error) {
            lastError = error as Error
            if (handleAccountEntryError(entry, error, model, accountState, entries.length, index)) {
                continue
            }
            throw error
        }
    }

    if (inFlightEntry && inFlightEntry.entry.provider === "antigravity") {
        const { entry, index } = inFlightEntry
        const accountDisplay = getAccountDisplay("antigravity", entry.accountId)
        setRequestLogContext({ model, provider: "antigravity", account: accountDisplay, routeTag: "ar" })
        const result = await runner({
            provider: "antigravity",
            accountId: entry.accountId,
            modelId: model,
            routeTag: "ar",
            accountDisplay,
        })
        if (useIntelligentRouting) {
            recordIntelligentDispatch("antigravity", entry.accountId, sessionKey, model)
        }
        accountState.cursor = index
        return result
    }

    if (lastError) throw lastError
    if (hasRateLimited) {
        throw new UpstreamError("antigravity", 429, `All accounts for model "${model}" are currently rate-limited.`)
    }
    throw new RoutingError(`No account routing entries available for model "${model}"`, 400)
}

async function runRouted<T>(
    rawModel: string,
    sessionMessages: ClaudeMessage[] | undefined,
    runner: (target: RoutedTarget, normalizedModel: string) => Promise<T>
): Promise<T> {
    const normalizedModel = normalizeOfficialModelId(rawModel)
    if (isHiddenCodexModel(normalizedModel)) {
        throw new RoutingError("Model is not available", 400)
    }
    const config = loadRoutingConfig()

    const activeFlow = resolveActiveFlowSelection(config)
    if (activeFlow) {
        return runFlowEntries(normalizedModel, activeFlow.entries, activeFlow.flowKey, t => runner(t, normalizedModel))
    }

    if (!isOfficialModel(normalizedModel)) await ensureProviderModelsSynced()
    if (isOfficialModel(normalizedModel)) {
        const accountEntries = resolveAccountRoutingEntries(config, normalizedModel)
        const useIntelligent = isCacheAwareRoutingEnabled() || (config.accountRouting?.smartSwitch ?? false)
        return runAccountEntries(normalizedModel, accountEntries, useIntelligent, sessionMessages, t => runner(t, normalizedModel))
    }

    const flowSelection = resolveFlowSelection(config, normalizedModel)
    return runFlowEntries(normalizedModel, flowSelection.entries, flowSelection.flowKey, t => runner(t, normalizedModel))
}

export async function createRoutedCompletion(request: RoutedRequest) {
    return runRouted(request.model, request.messages, async (target, normalizedModel) => {
        const req = normalizedModel === request.model ? request : { ...request, model: normalizedModel }
        if (target.provider === "antigravity") {
            const accountId = target.accountId === "auto" ? undefined : target.accountId
            return await createChatCompletionWithOptions({ ...req, model: target.modelId }, {
                accountId,
                allowRotation: target.routeTag === "fr" ? !accountId : false,
                routeTag: target.routeTag,
            })
        }

        const startTime = Date.now()
        const result = await createHostedProviderCompletion(target.provider, target.account!, target.modelId, req)
        recordProviderUsage(
            target.modelId,
            result.usage,
            target.routeTag === "ar" ? target.provider : undefined,
            target.routeTag === "ar" ? target.accountId : undefined
        )
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
        console.log(formatSuccessLine({
            elapsed,
            model: req.model,
            provider: target.provider,
            account: target.accountDisplay,
            routeTag: target.routeTag,
        }))
        return result
    })
}

async function openTargetEventStream(
    target: RoutedTarget,
    req: RoutedRequest
): Promise<AsyncGenerator<RoutedStreamEvent, void, unknown>> {
    if (target.provider === "antigravity") {
        const accountId = target.accountId === "auto" ? undefined : target.accountId
        return await peekStream(createAntigravityEventStreamWithOptions({ ...req, model: target.modelId }, {
            accountId,
            allowRotation: target.routeTag === "fr" ? !accountId : false,
            routeTag: target.routeTag,
        }))
    }

    const startTime = Date.now()
    const onUsage = makeDirectUsageCallback(target, target.modelId)

    if (target.provider === "copilot" && typeof createCopilotEventStream === "function") {
        const stream = await peekStream(createCopilotEventStream(
            target.account!,
            target.modelId,
            req.messages,
            req.tools,
            req.maxTokens,
            req.reasoningEffort,
            req.signal,
            { onUsage }
        ))
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
        console.log(formatSuccessLine({
            elapsed,
            model: req.model,
            provider: target.provider,
            account: target.accountDisplay,
            routeTag: target.routeTag,
        }))
        return stream
    }

    if (target.provider === "codex" && typeof createCodexEventStream === "function") {
        const stream = await peekStream(createCodexEventStream(
            target.account!,
            target.modelId,
            req.messages,
            req.tools,
            req.maxTokens,
            req.reasoningEffort,
            req.signal,
            { onUsage }
        ))
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
        console.log(formatSuccessLine({
            elapsed,
            model: req.model,
            provider: target.provider,
            account: target.accountDisplay,
            routeTag: target.routeTag,
        }))
        return stream
    }

    const completion = await createHostedProviderCompletion(target.provider, target.account!, target.modelId, req)
    if (!completion) throw new Error("Empty completion")
    recordProviderUsage(
        target.modelId,
        completion.usage,
        target.routeTag === "ar" ? target.provider : undefined,
        target.routeTag === "ar" ? target.accountId : undefined
    )
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(formatSuccessLine({
        elapsed,
        model: req.model,
        provider: target.provider,
        account: target.accountDisplay,
        routeTag: target.routeTag,
    }))
    return (async function* () {
        yield* completionToEvents(req.model, completion)
    })()
}

export async function* createRoutedEventStream(request: RoutedRequest): AsyncGenerator<RoutedStreamEvent, void, unknown> {
    const stream = await runRouted(request.model, request.messages, async (target, normalizedModel) => {
        const req = normalizedModel === request.model ? request : { ...request, model: normalizedModel }
        return await openTargetEventStream(target, req)
    })
    yield* stream
}

export async function* createRoutedCompletionStream(request: RoutedRequest): AsyncGenerator<string, void, unknown> {
    yield* formatAnthropicSse(createRoutedEventStream(request), request.model)
}

function makeDirectUsageCallback(target: RoutedTarget, fallbackModel: string) {
    return (usage: DirectUsage) => {
        recordProviderUsage(
            fallbackModel,
            usage,
            target.routeTag === "ar" ? target.provider : undefined,
            target.routeTag === "ar" ? target.accountId : undefined
        )
    }
}

function buildResponsesSessionHint(payload: ResponsesCreateRequest): ClaudeMessage[] | undefined {
    const promptText = extractResponsesPromptText(payload.input)
    if (!promptText) return undefined
    return [{ role: "user", content: promptText }]
}

/**
 * Direct-first OpenAI Responses dispatcher (/v1/responses).
 * Native /responses upstreams (Codex, Grok, Copilot) receive the raw payload with zero
 * intermediate translation; other upstreams (Antigravity, Kiro, Zed) adapt in a single hop.
 */
export async function createRoutedResponses(
    payload: ResponsesCreateRequest,
    signal?: AbortSignal
): Promise<DirectResult> {
    const effort = extractResponsesReasoningEffort(payload)
    const mappedModel = mapModel(payload.model, effort)
    const sessionHint = buildResponsesSessionHint(payload)

    let cachedRoutedInput: ReturnType<typeof responsesToRoutedInput> | null = null
    const getRoutedInput = () => {
        if (!cachedRoutedInput) {
            const translated = responsesToRoutedInput(payload)
            createImageInputBudget(translated.messages)
            cachedRoutedInput = translated
        }
        return cachedRoutedInput
    }

    return runRouted(mappedModel, sessionHint, async (target, normalizedModel) => {
        const startTime = Date.now()
        const onUsage = makeDirectUsageCallback(target, target.modelId)

        if (target.provider === "codex" || target.provider === "grok" || target.provider === "copilot") {
            const directFn =
                target.provider === "codex"
                    ? createCodexResponsesDirect
                    : target.provider === "grok"
                      ? createGrokResponsesDirect
                      : createCopilotResponsesDirect

            const direct = await directFn(target.account!, target.modelId, payload as Record<string, any>, signal, { onUsage })
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
            if (direct.kind === "sse") {
                const peeked = await peekStream(direct.stream)
                console.log(formatSuccessLine({
                    elapsed,
                    model: direct.resolvedModel || target.modelId,
                    provider: target.provider,
                    account: target.accountDisplay,
                    routeTag: target.routeTag,
                }))
                return { ...direct, stream: peeked }
            }
            console.log(formatSuccessLine({
                elapsed,
                model: direct.resolvedModel || target.modelId,
                provider: target.provider,
                account: target.accountDisplay,
                routeTag: target.routeTag,
            }))
            return direct
        }

        const routed = getRoutedInput()
        const req: RoutedRequest = {
            model: normalizedModel,
            messages: routed.messages,
            tools: routed.tools,
            toolChoice: routed.toolChoice,
            maxTokens: routed.maxTokens,
            reasoningEffort: routed.reasoningEffort,
            signal,
        }

        if (payload.stream === true) {
            const events = await openTargetEventStream(target, req)
            return {
                kind: "sse",
                status: 200,
                resolvedModel: target.modelId,
                stream: eventsToResponsesSse(events, {
                    id: generateResponseId(),
                    model: payload.model,
                    payload,
                }),
            }
        }

        const completion =
            target.provider === "antigravity"
                ? await createChatCompletionWithOptions({ ...req, model: target.modelId }, {
                      accountId: target.accountId === "auto" ? undefined : target.accountId,
                      allowRotation: target.routeTag === "fr" ? target.accountId === "auto" : false,
                      routeTag: target.routeTag,
                  })
                : await (async (hostedProvider: Exclude<AuthProvider, "antigravity">) => {
                      const res = await createHostedProviderCompletion(hostedProvider, target.account!, target.modelId, req)
                      recordProviderUsage(
                          target.modelId,
                          res.usage,
                          target.routeTag === "ar" ? hostedProvider : undefined,
                          target.routeTag === "ar" ? target.accountId : undefined
                      )
                      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
                      console.log(formatSuccessLine({
                          elapsed,
                          model: req.model,
                          provider: hostedProvider,
                          account: target.accountDisplay,
                          routeTag: target.routeTag,
                      }))
                      return res
                  })(target.provider)

        return {
            kind: "json",
            status: 200,
            resolvedModel: target.modelId,
            data: completionToResponseObject(completion, {
                model: payload.model,
                payload,
            }),
        }
    })
}

function buildChatSessionHint(messages: OpenAIChatCompletionRequest["messages"]): ClaudeMessage[] | undefined {
    if (!Array.isArray(messages)) return undefined
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (!msg || msg.role !== "user") continue
        if (typeof msg.content === "string" && msg.content.trim()) {
            return [{ role: "user", content: msg.content }]
        }
        if (Array.isArray(msg.content)) {
            const text = msg.content
                .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
                .filter(Boolean)
                .join(" ")
                .trim()
            if (text) return [{ role: "user", content: text }]
        }
    }
    return undefined
}

/**
 * Direct-first OpenAI Chat Completions dispatcher (/v1/chat/completions).
 * - Copilot native `/chat/completions`: 0 conversions, raw pass-through.
 * - Codex, Grok, `copilot-auto` (/responses), and `/responses`-only Copilot models: 1-hop Chat <-> Responses with live SSE.
 * - Antigravity, Zed, Kiro: typed `RoutedStreamEvent` / `BufferedCompletion` without Anthropic-SSE parsing.
 */
export async function createRoutedOpenAIChat(
    payload: OpenAIChatCompletionRequest,
    signal?: AbortSignal
): Promise<DirectResult> {
    const reasoningEffort = extractOpenAIReasoningEffort(payload)
    const mappedModel = mapModel(payload.model, reasoningEffort)
    const sessionHint = buildChatSessionHint(payload.messages)

    let cachedTranslated: {
        messages: ClaudeMessage[]
        tools?: ClaudeTool[]
        toolChoice?: RoutedRequest["toolChoice"]
    } | null = null
    const getTranslatedInput = () => {
        if (!cachedTranslated) {
            const messages = translateMessages(payload.messages)
            createImageInputBudget(messages)
            cachedTranslated = {
                messages,
                tools: translateTools(payload.tools),
                toolChoice: translateOpenAIToolChoice(payload.tool_choice),
            }
        }
        return cachedTranslated
    }

    return runRouted(mappedModel, sessionHint, async (target, normalizedModel) => {
        const startTime = Date.now()
        const onUsage = makeDirectUsageCallback(target, target.modelId)

        if (target.provider === "copilot" || target.provider === "codex" || target.provider === "grok") {
            const directFn =
                target.provider === "copilot"
                    ? createCopilotChatDirect
                    : target.provider === "codex"
                      ? createCodexChatDirect
                      : createGrokChatDirect

            if (typeof directFn === "function") {
                const direct = await directFn(target.account!, target.modelId, payload as Record<string, any>, signal, { onUsage })
                if (direct) {
                    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
                    if (direct.kind === "sse") {
                        const peeked = await peekStream(direct.stream)
                        console.log(formatSuccessLine({
                            elapsed,
                            model: direct.resolvedModel || target.modelId,
                            provider: target.provider,
                            account: target.accountDisplay,
                            routeTag: target.routeTag,
                        }))
                        return { ...direct, stream: peeked }
                    }
                    console.log(formatSuccessLine({
                        elapsed,
                        model: direct.resolvedModel || target.modelId,
                        provider: target.provider,
                        account: target.accountDisplay,
                        routeTag: target.routeTag,
                    }))
                    return direct
                }
            }
        }

        const translated = getTranslatedInput()
        const req: RoutedRequest = {
            model: normalizedModel,
            messages: translated.messages,
            tools: translated.tools,
            toolChoice: translated.toolChoice,
            maxTokens: payload.max_tokens ?? payload.max_completion_tokens,
            reasoningEffort,
            signal,
        }

        if (payload.stream === true) {
            const events = await openTargetEventStream(target, req)
            return {
                kind: "sse",
                status: 200,
                resolvedModel: target.modelId,
                stream: eventsToOpenAIChatSse(events, payload.model, {
                    includeUsage: payload.stream_options?.include_usage === true,
                }),
            }
        }

        const completion =
            target.provider === "antigravity"
                ? await createChatCompletionWithOptions({ ...req, model: target.modelId }, {
                      accountId: target.accountId === "auto" ? undefined : target.accountId,
                      allowRotation: target.routeTag === "fr" ? target.accountId === "auto" : false,
                      routeTag: target.routeTag,
                  })
                : await (async (hostedProvider: Exclude<AuthProvider, "antigravity">) => {
                      const res = await createHostedProviderCompletion(hostedProvider, target.account!, target.modelId, req)
                      recordProviderUsage(
                          target.modelId,
                          res.usage,
                          target.routeTag === "ar" ? hostedProvider : undefined,
                          target.routeTag === "ar" ? target.accountId : undefined
                      )
                      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
                      console.log(formatSuccessLine({
                          elapsed,
                          model: req.model,
                          provider: hostedProvider,
                          account: target.accountDisplay,
                          routeTag: target.routeTag,
                      }))
                      return res
                  })(target.provider)

        return {
            kind: "json",
            status: 200,
            resolvedModel: target.modelId,
            data: completionToOpenAIChatObject(completion, payload.model),
        }
    })
}
