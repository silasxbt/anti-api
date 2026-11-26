import type { ClaudeMessage, ClaudeTool } from "~/lib/translator"
import { UpstreamError } from "~/lib/error"
import { createChatCompletionWithOptions, createChatCompletionStreamWithOptions } from "~/services/antigravity/chat"
import { accountManager } from "~/services/antigravity/account-manager"
import { createCodexCompletion, isCodexModelSupportedForAccount, isCodexUnsupportedModelError } from "~/services/codex/chat"
import { createCopilotCompletion } from "~/services/copilot/chat"
import { createZedCompletion } from "~/services/zed/chat"
import { createKiroCompletion } from "~/services/kiro/chat"
import { createGrokCompletion } from "~/services/grok/chat"
import { authStore } from "~/services/auth/store"
import type { ProviderAccount } from "~/services/auth/types"
import { loadRoutingConfig, type RoutingEntry, type RoutingConfig, type AccountRoutingEntry } from "./config"
import { getProviderModels, isHiddenCodexModel } from "./models"
import { buildMessageStart, buildContentBlockStart, buildTextDelta, buildInputJsonDelta, buildContentBlockStop, buildMessageDelta, buildMessageStop } from "~/lib/translator"
import { formatSuccessLine, setRequestLogContext } from "~/lib/logger"
import type { AuthProvider } from "~/services/auth/types"
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

type FlowStickyState = {
    cursor: number
}
type AccountStickyState = {
    cursor: number
}

type ProviderUsage = {
    usage?: {
        inputTokens?: number
        outputTokens?: number
    }
}

export function normalizeOfficialModelId(model: string): string {
    const normalized = model?.trim()
    if (!normalized) return model
    const lookupKey = normalized.toLowerCase()
    const map: Record<string, string> = {
        "claude-opus-4-7": "claude-opus-4.7",
        "claude-opus-4-6": "claude-opus-4-6-thinking",
        "claude-opus-4.6": "claude-opus-4-6-thinking",
        "claude-sonnet-4.5": "claude-sonnet-4-5",
        "claude-sonnet-4.5-thinking": "claude-sonnet-4-5-thinking",
        "claude-opus-4.5-thinking": "claude-opus-4-5-thinking",
        "claude-opus-4.6-thinking": "claude-opus-4-6-thinking",
    }
    return map[lookupKey] || normalized
}

/**
 * Return a stable comparison key for provider model IDs.
 *
 * Providers do not agree on punctuation (for example, `claude-sonnet-4.5`
 * versus `claude-sonnet-4-5`). Keep the public/request model untouched, but
 * use the same key while deciding which provider or account route applies.
 */
function officialModelKey(model: string): string {
    return normalizeOfficialModelId(model || "")
        .trim()
        .toLowerCase()
        .replace(/[._]/g, "-")
        .replace(/-+/g, "-")
}

export function modelIdsMatch(left: string, right: string): boolean {
    return officialModelKey(left) === officialModelKey(right)
}

function isEntryUsable(entry: RoutingEntry): boolean {
    if (entry.provider === "antigravity") {
        return true
    }
    return !!authStore.getAccount(entry.provider, entry.accountId)
}

// Router 级 rate-limit 兜底（仅 antigravity）：独立于 accountManager，
// 因此能在请求期 accountManager.load() 重置 rateLimitedUntil 后仍保住限流状态。
// 其它 provider 的限流仅依赖 authStore.isRateLimited。
const routerRateLimits = new Map<string, number>()  // "antigravity:accountId" -> expiry timestamp
const PROVIDER_ORDER: AuthProvider[] = ["antigravity", "codex", "copilot", "zed", "kiro", "grok"]
const flowStickyStates = new Map<string, FlowStickyState>()
const accountStickyStates = new Map<string, AccountStickyState>()

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

function getFlowStickyState(flowKey: string, entriesLength: number): FlowStickyState {
    const existing = flowStickyStates.get(flowKey)
    if (!existing) {
        const state = { cursor: 0 }
        flowStickyStates.set(flowKey, state)
        return state
    }
    if (existing.cursor < 0 || existing.cursor >= entriesLength) {
        existing.cursor = 0
    }
    return existing
}

function getAccountStickyState(model: string, entriesLength: number): AccountStickyState {
    const key = model || ""
    const existing = accountStickyStates.get(key)
    if (!existing) {
        const state = { cursor: 0 }
        accountStickyStates.set(key, state)
        return state
    }
    if (existing.cursor < 0 || existing.cursor >= entriesLength) {
        existing.cursor = 0
    }
    return existing
}

function advanceAccountCursor(state: AccountStickyState | null, entriesLength: number, currentIndex: number): void {
    if (!state || entriesLength <= 1) return
    state.cursor = (currentIndex + 1) % entriesLength
}

function buildOfficialModelIndex(): Map<string, Set<AuthProvider>> {
    const index = new Map<string, Set<AuthProvider>>()
    for (const provider of PROVIDER_ORDER) {
        const models = getProviderModels(provider)
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
        // 🆕 Antigravity 账号需检查是否存在于 accountManager
        if (entry.provider === "antigravity" && entry.accountId !== "auto") {
            if (!accountManager.hasAccount(entry.accountId)) {
                return false
            }
        }
        return true
    })
}

function listProviderAccountsInOrder(provider: AuthProvider): ProviderAccount[] {
    if (provider === "antigravity") {
        const agAccounts = accountManager.listAccounts()
        if (agAccounts.length > 0) {
            return agAccounts.map(a => ({
                id: a.id,
                email: a.email,
                label: a.label || a.email,
                login: a.email,
                createdAt: a.createdAt,
            } as ProviderAccount))
        }
    }
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

function resolveAccountRoutingEntries(config: RoutingConfig, model: string): AccountRoutingEntry[] {
    const providers = getOfficialModelProviders(model)
    if (providers.length === 0) {
        throw new RoutingError(`Model "${model}" is not an official model`, 400)
    }

    const accountRouting = config.accountRouting
    const smartSwitch = accountRouting?.smartSwitch ?? false
    const route = accountRouting?.routes.find(r => modelIdsMatch(r.modelId, model))

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

    let filtered = entries.filter(entry => providers.includes(entry.provider))

    let valid = filtered.filter(entry => {
        if (!isEntryUsable(entry as RoutingEntry)) return false
        if (entry.provider === "antigravity" && entry.accountId !== "auto") {
            return accountManager.hasAccount(entry.accountId)
        }
        return true
    })

    if (valid.length === 0 && smartSwitch) {
        filtered = providers.flatMap(provider => buildAutoEntriesForProvider(provider))
        valid = filtered.filter(entry => {
            if (!isEntryUsable(entry as RoutingEntry)) return false
            if (entry.provider === "antigravity" && entry.accountId !== "auto") {
                return accountManager.hasAccount(entry.accountId)
            }
            return true
        })
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

function selectFlowEntries(config: RoutingConfig, model: string): RoutingEntry[] {
    return findFlow(config, model)?.entries || []
}

function resolveFlowEntries(config: RoutingConfig, model: string): RoutingEntry[] {
    const entries = normalizeEntries(selectFlowEntries(config, model))
    if (entries.length === 0) {
        throw new RoutingError(`No flow routing entries configured for model "${model}"`, 400)
    }
    return entries
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

function resolveAccountEntries(config: RoutingConfig, model: string): AccountRoutingEntry[] {
    return resolveAccountRoutingEntries(config, model)
}

function shouldSkipFlowEntry(
    entry: RoutingEntry,
    entriesLength: number,
    options: { ignoreRateLimit?: boolean } = {}
): boolean {
    const ignoreRateLimit = options.ignoreRateLimit ?? false
    if (entry.provider === "antigravity") {
        const accountId = entry.accountId === "auto" ? undefined : entry.accountId
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

function applyFlowRateLimit(entry: RoutingEntry, error: UpstreamError, requestModel: string): void {
    if (entry.provider === "antigravity" && entry.accountId !== "auto") {
        // 404/400 is usually a model-account mismatch, bad argument or transient upstream routing miss,
            // not an account quota/rate-limit signal. Avoid cooling down the account.
            // 401/403 are auth/permission class errors and should not poison account
            // availability with synthetic 429 "account unavailable" on subsequent requests.
            // 429 同樣不可在此標記：chat.ts 內部已處理（只在明確 quota_exhausted 時才標記
            // 帳號並嘗試換帳號）。在這裡再標一次會把「唯一帳號」封 30 秒，讓該帳號下所有
            // 其他模型全部回 400 "No account routing entries"。
            // 2026-10-02 實測：gemini-3.8-flash-high 一次 429 之後，當下完全正常的
            // claude-sonnet-4-6 與 gemini-3-flash 也立刻開始回 400。
            if (error.status === 404 || error.status === 400 || error.status === 401 || error.status === 403 || error.status === 429) {
                return
            }
        const cooldownMs = error.status >= 500 ? ANTIGRAVITY_SERVER_ERROR_COOLDOWN_MS : 30_000
        accountManager
            .markRateLimitedFromError(entry.accountId, error.status, error.body, error.retryAfter, requestModel, { maxDurationMs: cooldownMs })
            .then((limit) => {
                const duration = limit?.durationMs ?? cooldownMs
                markRouterRateLimited("antigravity", entry.accountId, duration)
            })
            .catch(() => {
                markRouterRateLimited("antigravity", entry.accountId, cooldownMs)
            })
        return
    }

    if (entry.provider !== "antigravity") {
        authStore.markRateLimited(entry.provider, entry.accountId, error.status, error.body, error.retryAfter)
    }
}

function advanceFlowCursor(flowState: FlowStickyState | null, entries: RoutingEntry[], startIndex: number): void {
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

function recordProviderUsage(modelId: string, completion: ProviderUsage | null | undefined): void {
    if (!completion?.usage) return
    const inputTokens = completion.usage.inputTokens ?? 0
    const outputTokens = completion.usage.outputTokens ?? 0
    if (inputTokens > 0 || outputTokens > 0) {
        recordUsage(modelId, inputTokens, outputTokens)
    }
}

async function createHostedProviderCompletion(
    provider: Exclude<AuthProvider, "antigravity">,
    account: ProviderAccount,
    model: string,
    request: RoutedRequest
) {
    if (provider === "codex") {
        return createCodexCompletion(account, model, request.messages, request.tools, request.maxTokens, request.reasoningEffort, request.signal)
    }
    if (provider === "copilot") {
        return createCopilotCompletion(account, model, request.messages, request.tools, request.maxTokens, request.signal)
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

async function createFlowCompletionWithEntries(request: RoutedRequest, entries: RoutingEntry[], flowKey?: string) {
    let lastError: Error | null = null
    const flowState = flowKey ? getFlowStickyState(flowKey, entries.length) : null
    const startIndex = flowState?.cursor ?? 0

    const attemptEntry = async (entry: RoutingEntry) => {
        if (entry.provider === "antigravity") {
            const accountId = entry.accountId === "auto" ? undefined : entry.accountId
            setRequestLogContext({ model: entry.modelId, provider: "antigravity", account: entry.accountId, routeTag: "fr" })
            return await createChatCompletionWithOptions({ ...request, model: entry.modelId }, {
                accountId,
                allowRotation: accountId ? false : true,
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
            if (entry.provider === "antigravity" && isAccountUnavailableError(error)) {
                continue
            }
            if (error instanceof UpstreamError && shouldFallbackOnUpstream(entry, error)) {
                const shouldAdvance = shouldAdvanceCursorOnError(entry, error)
                if (shouldAdvance) {
                    applyFlowRateLimit(entry, error, request.model)
                    if (flowState && index === startIndex) {
                        advanceFlowCursor(flowState, entries, startIndex)
                    }
                }
                continue
            }
            if (isTransientTransportError(error)) {
                if (entry.provider !== "antigravity") {
                    authStore.markRateLimited(entry.provider, entry.accountId, 500, (error as Error).message)
                }
                continue
            }
            throw error
        }
    }

    if (!lastError && entries.length > 0) {
        const fallbackIndex = flowState?.cursor ?? 0
        let entry: RoutingEntry | null = null
        for (let offset = 0; offset < entries.length; offset++) {
            const index = (fallbackIndex + offset) % entries.length
            const candidate = entries[index]
            if (shouldSkipFlowEntry(candidate, entries.length)) {
                continue
            }
            entry = candidate
            break
        }
        if (!entry) {
            const cursorEntry = entries[fallbackIndex]
            if (cursorEntry.provider === "codex") {
                const support = isCodexModelSupportedForAccount(cursorEntry.accountId, cursorEntry.modelId)
                if (support === false) {
                    throw new RoutingError("No routing entries available", 400)
                }
            }
            entry = cursorEntry
        }
        try {
            return await attemptEntry(entry)
        } catch (error) {
            lastError = error as Error
            throw error
        }
    }

    if (lastError) {
        throw lastError
    }

    throw new RoutingError("No routing entries available", 400)
}

async function createAccountCompletionWithEntries(request: RoutedRequest, entries: AccountRoutingEntry[]) {
    let lastError: Error | null = null
    const accountState = getAccountStickyState(request.model, entries.length)
    const startIndex = accountState?.cursor ?? 0

    for (let offset = 0; offset < entries.length; offset++) {
        const index = (startIndex + offset) % entries.length
        const entry = entries[index]
        try {
            if (entry.provider === "antigravity") {
                if (entry.accountId === "auto") {
                    throw new RoutingError(`Account routing entry for "${request.model}" cannot use auto without smart switch expansion`, 400)
                }
                const isLimited =
                    accountManager.isAccountRateLimited(entry.accountId) ||
                    accountManager.isModelRateLimited?.(entry.accountId, request.model) ||
                    isRouterRateLimited("antigravity", entry.accountId)
                if (entries.length > 1 && isLimited) continue
                if (entries.length > 1 && accountManager.isAccountInFlight(entry.accountId)) continue
                const accountDisplay = getAccountDisplay("antigravity", entry.accountId)
                setRequestLogContext({ model: request.model, provider: "antigravity", account: accountDisplay, routeTag: "ar" })
                const result = await createChatCompletionWithOptions({ ...request, model: request.model }, {
                    accountId: entry.accountId,
                    allowRotation: false,
                    routeTag: "ar",
                })
                accountState.cursor = index
                return result
            }

            if (authStore.isRateLimited(entry.provider, entry.accountId)) {
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
            recordProviderUsage(request.model, result)
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
            console.log(formatSuccessLine({ elapsed, model: request.model, provider: entry.provider, account: accountDisplay, routeTag: "ar" }))
            accountState.cursor = index
            return result
        } catch (error) {
            lastError = error as Error
            if (entry.provider === "antigravity" && isAccountUnavailableError(error)) {
                advanceAccountCursor(accountState, entries.length, index)
                continue
            }
            if (error instanceof UpstreamError && shouldFallbackOnUpstream(entry, error)) {
                const shouldAdvance = shouldAdvanceCursorOnError(entry, error)
                if (shouldAdvance) {
                    if (entry.provider === "antigravity") {
                        // 429 已由 chat.ts 內部處理（只在明確 quota_exhausted 時標記
                        // 帳號並嘗試換帳號）。這裡再標一次會用 60 秒的
                        // DEFAULT_ROUTER_COOLDOWN_MS 把「唯一帳號」整個封死，讓同一
                        // 帳號下所有其他模型全部回 400 "No account routing entries"。
                        // 2026-10-02 實測：gemini-3.8-flash-high 一次 429 之後，
                        // 當下完全正常的 claude-sonnet-4-6 也開始回 400。
                        if (error.status !== 429 && error.status !== 404 && error.status !== 400 && error.status !== 401 && error.status !== 403) {
                            const cooldownMs = error.status >= 500 ? ANTIGRAVITY_SERVER_ERROR_COOLDOWN_MS : DEFAULT_ROUTER_COOLDOWN_MS
                            accountManager.markRateLimitedFromError(
                                entry.accountId,
                                error.status,
                                error.body,
                                error.retryAfter,
                                request.model,
                                { maxDurationMs: cooldownMs }
                            )
                            markRouterRateLimited("antigravity", entry.accountId, cooldownMs)
                        }
                    } else {
                        authStore.markRateLimited(entry.provider, entry.accountId, error.status, error.body, error.retryAfter)
                    }
                    advanceAccountCursor(accountState, entries.length, index)
                }
                continue
            }
            if (isTransientTransportError(error)) {
                if (entry.provider !== "antigravity") {
                    authStore.markRateLimited(entry.provider, entry.accountId, 500, (error as Error).message)
                    advanceAccountCursor(accountState, entries.length, index)
                }
                continue
            }
            throw error
        }
    }

    if (!lastError && entries.length > 0) {
        const fallbackEntry = entries[startIndex]
        if (fallbackEntry.provider === "antigravity" && fallbackEntry.accountId !== "auto") {
            const accountDisplay = getAccountDisplay("antigravity", fallbackEntry.accountId)
            setRequestLogContext({ model: request.model, provider: "antigravity", account: accountDisplay, routeTag: "ar" })
            const result = await createChatCompletionWithOptions({ ...request, model: request.model }, {
                accountId: fallbackEntry.accountId,
                allowRotation: false,
                routeTag: "ar",
            })
            accountState.cursor = startIndex
            return result
        }
    }

    if (lastError) {
        throw lastError
    }

    throw new RoutingError(`No account routing entries available for model "${request.model}"`, 400)
}

export async function createRoutedCompletion(request: RoutedRequest) {
    const normalizedModel = normalizeOfficialModelId(request.model)
    if (isHiddenCodexModel(normalizedModel)) {
        throw new RoutingError("Model is not available", 400)
    }
    const normalizedRequest = normalizedModel === request.model ? request : { ...request, model: normalizedModel }
    const config = loadRoutingConfig()
    const activeFlow = resolveActiveFlowSelection(config)
    if (activeFlow) {
        return createFlowCompletionWithEntries(normalizedRequest, activeFlow.entries, activeFlow.flowKey)
    }
    if (isOfficialModel(normalizedModel)) {
        const accountEntries = resolveAccountEntries(config, normalizedModel)
        return createAccountCompletionWithEntries(normalizedRequest, accountEntries)
    }

    const flowSelection = resolveFlowSelection(config, normalizedRequest.model)
    return createFlowCompletionWithEntries(normalizedRequest, flowSelection.entries, flowSelection.flowKey)
}

async function* createFlowCompletionStreamWithEntries(request: RoutedRequest, entries: RoutingEntry[], flowKey?: string): AsyncGenerator<string, void, unknown> {
    let lastError: Error | null = null
    const flowState = flowKey ? getFlowStickyState(flowKey, entries.length) : null
    const startIndex = flowState?.cursor ?? 0

    async function* streamEntry(entry: RoutingEntry): AsyncGenerator<string, void, unknown> {
        if (entry.provider === "antigravity") {
            const accountId = entry.accountId === "auto" ? undefined : entry.accountId
            setRequestLogContext({ model: entry.modelId, provider: "antigravity", account: entry.accountId, routeTag: "fr" })
            yield* createChatCompletionStreamWithOptions({ ...request, model: entry.modelId }, {
                accountId,
                allowRotation: accountId ? false : true,
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

        yield buildMessageStart(request.model)
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
        yield buildMessageDelta(completion.stopReason || "end_turn", completion.usage)
        yield buildMessageStop()

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
            if (entry.provider === "antigravity" && isAccountUnavailableError(error)) {
                continue
            }
            if (error instanceof UpstreamError && shouldFallbackOnUpstream(entry, error)) {
                const shouldAdvance = shouldAdvanceCursorOnError(entry, error)
                if (shouldAdvance) {
                    applyFlowRateLimit(entry, error, request.model)
                    if (flowState && index === startIndex) {
                        advanceFlowCursor(flowState, entries, startIndex)
                    }
                }
                continue
            }
            if (isTransientTransportError(error)) {
                if (entry.provider !== "antigravity") {
                    authStore.markRateLimited(entry.provider, entry.accountId, 500, (error as Error).message)
                }
                continue
            }
            throw error
        }
    }

    if (!lastError && entries.length > 0) {
        const fallbackIndex = flowState?.cursor ?? 0
        let entry: RoutingEntry | null = null
        for (let offset = 0; offset < entries.length; offset++) {
            const index = (fallbackIndex + offset) % entries.length
            const candidate = entries[index]
            if (shouldSkipFlowEntry(candidate, entries.length)) {
                continue
            }
            entry = candidate
            break
        }
        if (!entry) {
            const cursorEntry = entries[fallbackIndex]
            if (cursorEntry.provider === "codex") {
                const support = isCodexModelSupportedForAccount(cursorEntry.accountId, cursorEntry.modelId)
                if (support === false) {
                    throw new RoutingError("No routing entries available", 400)
                }
            }
            entry = cursorEntry
        }
        yield* streamEntry(entry)
        return
    }

    if (lastError) {
        throw lastError
    }

    throw new RoutingError("No routing entries available", 400)
}

async function* createAccountCompletionStreamWithEntries(request: RoutedRequest, entries: AccountRoutingEntry[]): AsyncGenerator<string, void, unknown> {
    let lastError: Error | null = null
    const accountState = getAccountStickyState(request.model, entries.length)
    const startIndex = accountState?.cursor ?? 0

    for (let offset = 0; offset < entries.length; offset++) {
        const index = (startIndex + offset) % entries.length
        const entry = entries[index]
        try {
            if (entry.provider === "antigravity") {
                if (entry.accountId === "auto") {
                    throw new RoutingError(`Account routing entry for "${request.model}" cannot use auto without smart switch expansion`, 400)
                }
                const isLimited =
                    accountManager.isAccountRateLimited(entry.accountId) ||
                    accountManager.isModelRateLimited?.(entry.accountId, request.model) ||
                    isRouterRateLimited("antigravity", entry.accountId)
                if (entries.length > 1 && isLimited) continue
                if (entries.length > 1 && accountManager.isAccountInFlight(entry.accountId)) continue
                const accountDisplay = getAccountDisplay("antigravity", entry.accountId)
                setRequestLogContext({ model: request.model, provider: "antigravity", account: accountDisplay, routeTag: "ar" })
                yield* createChatCompletionStreamWithOptions({ ...request, model: request.model }, {
                    accountId: entry.accountId,
                    allowRotation: false,
                    routeTag: "ar",
                })
                accountState.cursor = index
                return
            }

            if (authStore.isRateLimited(entry.provider, entry.accountId)) {
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

            yield buildMessageStart(request.model)
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
            yield buildMessageDelta(completion.stopReason || "end_turn", completion.usage)
            yield buildMessageStop()

            recordProviderUsage(request.model, completion)

            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
            console.log(formatSuccessLine({ elapsed, model: request.model, provider: entry.provider, account: accountDisplay, routeTag: "ar" }))
            accountState.cursor = index
            return
        } catch (error) {
            lastError = error as Error
            if (entry.provider === "antigravity" && isAccountUnavailableError(error)) {
                advanceAccountCursor(accountState, entries.length, index)
                continue
            }
            if (error instanceof UpstreamError && shouldFallbackOnUpstream(entry, error)) {
                const shouldAdvance = shouldAdvanceCursorOnError(entry, error)
                if (shouldAdvance) {
                    if (entry.provider === "antigravity") {
                        // 429 已由 chat.ts 內部處理（只在明確 quota_exhausted 時標記
                        // 帳號並嘗試換帳號）。這裡再標一次會用 60 秒的
                        // DEFAULT_ROUTER_COOLDOWN_MS 把「唯一帳號」整個封死，讓同一
                        // 帳號下所有其他模型全部回 400 "No account routing entries"。
                        // 2026-10-02 實測：gemini-3.8-flash-high 一次 429 之後，
                        // 當下完全正常的 claude-sonnet-4-6 也開始回 400。
                        if (error.status !== 429 && error.status !== 404 && error.status !== 400 && error.status !== 401 && error.status !== 403) {
                            const cooldownMs = error.status >= 500 ? ANTIGRAVITY_SERVER_ERROR_COOLDOWN_MS : DEFAULT_ROUTER_COOLDOWN_MS
                            accountManager.markRateLimitedFromError(
                                entry.accountId,
                                error.status,
                                error.body,
                                error.retryAfter,
                                request.model,
                                { maxDurationMs: cooldownMs }
                            )
                            markRouterRateLimited("antigravity", entry.accountId, cooldownMs)
                        }
                    } else {
                        authStore.markRateLimited(entry.provider, entry.accountId, error.status, error.body, error.retryAfter)
                    }
                    advanceAccountCursor(accountState, entries.length, index)
                }
                continue
            }
            if (isTransientTransportError(error)) {
                if (entry.provider !== "antigravity") {
                    authStore.markRateLimited(entry.provider, entry.accountId, 500, (error as Error).message)
                    advanceAccountCursor(accountState, entries.length, index)
                }
                continue
            }
            throw error
        }
    }

    if (!lastError && entries.length > 0) {
        const fallbackEntry = entries[startIndex]
        if (fallbackEntry.provider === "antigravity" && fallbackEntry.accountId !== "auto") {
            const accountDisplay = getAccountDisplay("antigravity", fallbackEntry.accountId)
            setRequestLogContext({ model: request.model, provider: "antigravity", account: accountDisplay, routeTag: "ar" })
            yield* createChatCompletionStreamWithOptions({ ...request, model: request.model }, {
                accountId: fallbackEntry.accountId,
                allowRotation: false,
                routeTag: "ar",
            })
            accountState.cursor = startIndex
            return
        }
    }

    if (lastError) {
        throw lastError
    }

    throw new RoutingError(`No account routing entries available for model "${request.model}"`, 400)
}

export async function* createRoutedCompletionStream(request: RoutedRequest): AsyncGenerator<string, void, unknown> {
    const normalizedModel = normalizeOfficialModelId(request.model)
    if (isHiddenCodexModel(normalizedModel)) {
        throw new RoutingError("Model is not available", 400)
    }
    const normalizedRequest = normalizedModel === request.model ? request : { ...request, model: normalizedModel }
    const config = loadRoutingConfig()
    const activeFlow = resolveActiveFlowSelection(config)
    if (activeFlow) {
        yield* createFlowCompletionStreamWithEntries(normalizedRequest, activeFlow.entries, activeFlow.flowKey)
        return
    }

    if (isOfficialModel(normalizedModel)) {
        const accountEntries = resolveAccountEntries(config, normalizedModel)
        yield* createAccountCompletionStreamWithEntries(normalizedRequest, accountEntries)
        return
    }

    const flowSelection = resolveFlowSelection(config, normalizedRequest.model)
    yield* createFlowCompletionStreamWithEntries(normalizedRequest, flowSelection.entries, flowSelection.flowKey)
}
