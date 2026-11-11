import { quotaPoolForModel, type QuotaPool } from "~/lib/model-catalog"
import consola from "consola"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { authStore } from "~/services/auth/store"
import { refreshAccessToken } from "~/services/antigravity/oauth"
import {
    fetchAntigravityModels as fetchAntigravityModelsRequest,
    fetchAntigravityQuotaSummary,
    type AntigravityModelInfo,
    type AntigravityQuotaSummaryResponse,
    type AntigravityQuotaBucket,
    type AntigravityQuotaGroup,
} from "~/services/antigravity/quota-fetch"
import { refreshCodexAccessToken, refreshCodexAccountIfNeeded } from "~/services/codex/oauth"
import { accountManager } from "~/services/antigravity/account-manager"
import type { AuthProvider, ProviderAccount } from "~/services/auth/types"
import { UpstreamError } from "~/lib/error"
import { getDataDir } from "~/lib/data-dir"
import { fetchZedAccountOverview } from "~/services/zed/chat"
import { safeErrorMessage } from "~/lib/redaction"
import { setDynamicAntigravityModelsForAccount } from "~/services/routing/models"
import {
    enrichBarsWithValueEstimates,
    registerAccountPlanResolver,
    registerQuotaRefreshTrigger,
    syncIntelligentQuotaCache,
} from "~/services/routing/intelligent-scorer"

type ModelInfo = AntigravityModelInfo

export type AccountBar = {
    key: string
    label: string
    percentage: number
    /** Full-precision upstream remaining fraction (0..1) when the provider exposes it. */
    rawFraction?: number
    resetTime?: string
    disabled?: boolean
    estimatedValueUsd?: number
    estimatedTotalValueUsd?: number
    valuePerPercentUsd?: number
}

export type QuotaProvider = "antigravity" | "codex" | "copilot" | "zed" | "kiro"

export type AccountQuotaView = {
    provider: QuotaProvider
    accountId: string
    displayName: string
    bars: AccountBar[]
    proxy?: string
    label?: string
}

type QuotaCacheEntry = {
    provider: QuotaProvider
    accountId: string
    displayName: string
    bars: AccountBar[]
    models?: string[]
    updatedAt: string
    proxy?: string
    label?: string
}

const QUOTA_CACHE_DIR = getDataDir()
const QUOTA_CACHE_FILE = join(QUOTA_CACHE_DIR, "quota-cache.json")
let quotaCache = new Map<string, QuotaCacheEntry>()
let cacheLoaded = false
const PROVIDER_FETCH_TIMEOUT_MS = 4000

function getCacheKey(provider: QuotaCacheEntry["provider"], accountId: string): string {
    const raw = accountId.trim()
    const cleanId = raw.startsWith(`${provider}:`) ? raw.slice(provider.length + 1) : raw
    return `${provider}:${cleanId}`
}

function loadQuotaCache(): void {
    if (cacheLoaded) return
    cacheLoaded = true
    try {
        if (!existsSync(QUOTA_CACHE_FILE)) return
        const raw = JSON.parse(readFileSync(QUOTA_CACHE_FILE, "utf-8")) as Record<string, QuotaCacheEntry>
        quotaCache = new Map(Object.entries(raw))
        for (const entry of quotaCache.values()) {
            if (entry && Array.isArray(entry.bars)) {
                syncIntelligentQuotaCache(entry.provider, entry.accountId, entry.bars, entry.updatedAt)
            }
        }
    } catch {
        quotaCache = new Map()
    }
}

function saveQuotaCache(): void {
    try {
        if (!existsSync(QUOTA_CACHE_DIR)) {
            mkdirSync(QUOTA_CACHE_DIR, { recursive: true })
        }
        const payload: Record<string, QuotaCacheEntry> = {}
        for (const [key, value] of quotaCache.entries()) {
            payload[key] = value
        }
        writeFileSync(QUOTA_CACHE_FILE, JSON.stringify(payload, null, 2))
    } catch {
        // Best-effort cache only
    }
}

function updateQuotaCache(entry: QuotaCacheEntry): void {
    loadQuotaCache()
    const existing = quotaCache.get(getCacheKey(entry.provider, entry.accountId))
    if (!entry.models && existing?.models) {
        entry.models = existing.models
    }
    quotaCache.set(getCacheKey(entry.provider, entry.accountId), entry)
    syncIntelligentQuotaCache(entry.provider, entry.accountId, entry.bars, entry.updatedAt)
    saveQuotaCache()
}

export function getCachedAntigravityModelsForAccount(accountId: string): string[] | undefined {
    loadQuotaCache()
    const cached = quotaCache.get(getCacheKey("antigravity", accountId))
    if (cached?.models && cached.models.length > 0) {
        return cached.models
    }
    const account = authStore.getAccount("antigravity", accountId)
    if (account?.metadata && Array.isArray((account.metadata as any).availableModels)) {
        return (account.metadata as any).availableModels
    }
    return undefined
}

export function updateCachedAntigravityModelsForAccount(accountId: string, models: string[]): void {
    loadQuotaCache()
    const key = getCacheKey("antigravity", accountId)
    const existing = quotaCache.get(key)
    if (existing) {
        existing.models = models
        saveQuotaCache()
    } else {
        const entry: QuotaCacheEntry = {
            provider: "antigravity",
            accountId,
            displayName: accountId,
            bars: [],
            models,
            updatedAt: new Date().toISOString(),
        }
        quotaCache.set(key, entry)
        saveQuotaCache()
    }
    if (models.length > 0) {
        setDynamicAntigravityModelsForAccount(
            accountId,
            models.map(id => ({ id, label: `Antigravity - ${id}` }))
        )
    }
}

function getCachedBars(provider: QuotaCacheEntry["provider"], accountId: string): AccountBar[] | null {
    const cached = quotaCache.get(getCacheKey(provider, accountId))
    return cached?.bars || null
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: () => T, label: string): Promise<T> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return promise
    }
    return new Promise(resolve => {
        let settled = false
        const timer = setTimeout(() => {
            if (settled) return
            settled = true
            consola.warn(`${label} quota fetch timed out after ${timeoutMs}ms, using cached data`)
            resolve(fallback())
        }, timeoutMs)
        promise.then(result => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(result)
        }).catch(error => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            consola.warn(`${label} quota fetch failed, using cached data:`, safeErrorMessage(error))
            resolve(fallback())
        })
    })
}

function defaultBarsForProvider(provider: QuotaProvider): AccountBar[] {
    switch (provider) {
        case "antigravity":
            return buildAntigravityBars({})
        case "codex":
            return [
                { key: "session", label: "5h", percentage: 0, rawFraction: 0 },
                { key: "week", label: "week", percentage: 0, rawFraction: 0 },
            ]
        case "copilot":
            return [{ key: "premium", label: "premium", percentage: 0, rawFraction: 0 }]
        case "zed":
            return [{ key: "hosted", label: "hosted", percentage: 0, rawFraction: 0 }]
        case "kiro":
            return [{ key: "access", label: "access", percentage: 100, rawFraction: 1 }]
    }
}

function buildCachedViews(provider: QuotaCacheEntry["provider"], accounts: ProviderAccount[]): AccountQuotaView[] {
    return accounts.map(account => {
        const displayName = account.label || account.email || account.login || account.id
        const bars = getCachedBars(provider, account.id) || defaultBarsForProvider(provider)
        return {
            provider,
            accountId: account.id,
            displayName,
            bars,
            proxy: account.proxy,
            label: account.label,
        }
    })
}

export async function getAggregatedQuota(): Promise<{
    timestamp: string
    accounts: AccountQuotaView[]
}> {
    loadQuotaCache()
    accountManager.load()

    const antigravityAccounts = authStore.listAccounts("antigravity")
    const codexAccounts = authStore.listAccounts("codex")
    const copilotAccounts = authStore.listAccounts("copilot")
    const zedAccounts = authStore.listAccounts("zed")
    const kiroAccounts = authStore.listAccounts("kiro")

    const [antigravity, codex, copilot, zed, kiro] = await Promise.all([
        withTimeout(
            fetchAntigravityQuotas(antigravityAccounts),
            PROVIDER_FETCH_TIMEOUT_MS,
            () => buildCachedViews("antigravity", antigravityAccounts),
            "Antigravity",
        ),
        withTimeout(
            fetchCodexQuotas(codexAccounts),
            PROVIDER_FETCH_TIMEOUT_MS,
            () => buildCachedViews("codex", codexAccounts),
            "Codex",
        ),
        withTimeout(
            fetchCopilotQuotas(copilotAccounts),
            PROVIDER_FETCH_TIMEOUT_MS,
            () => buildCachedViews("copilot", copilotAccounts),
            "Copilot",
        ),
        withTimeout(
            fetchZedQuotas(zedAccounts),
            PROVIDER_FETCH_TIMEOUT_MS,
            () => buildCachedViews("zed", zedAccounts),
            "Zed",
        ),
        withTimeout(
            fetchKiroQuotas(kiroAccounts),
            PROVIDER_FETCH_TIMEOUT_MS,
            () => buildCachedViews("kiro", kiroAccounts),
            "Kiro",
        ),
    ])
    saveQuotaCache()

    return {
        timestamp: new Date().toISOString(),
        accounts: [...antigravity, ...codex, ...copilot, ...zed, ...kiro].map(acc => ({
            ...acc,
            bars: enrichBarsWithValueEstimates(acc.provider, acc.accountId, acc.bars),
        })),
    }
}

/**
 * Proactively refresh quota for a single account in the background (e.g., when a known
 * resetTime passes, when reset is imminent, or when live depletion crosses the threshold).
 */
export async function refreshAccountQuotaInBackground(
    provider: string,
    accountId: string
): Promise<AccountQuotaView | null> {
    loadQuotaCache()
    const cleanId = accountId.trim().startsWith(`${provider}:`)
        ? accountId.trim().slice(provider.length + 1)
        : accountId.trim()
    const account = authStore.getAccount(provider as any, cleanId)
    if (!account) return null

    try {
        if (provider === "antigravity") {
            const views = await fetchAntigravityQuotas([account])
            return views[0] || null
        }
        if (provider === "codex") {
            const views = await fetchCodexQuotas([account])
            return views[0] || null
        }
        if (provider === "copilot") {
            const views = await fetchCopilotQuotas([account])
            return views[0] || null
        }
        if (provider === "zed") {
            const views = await fetchZedQuotas([account])
            return views[0] || null
        }
        if (provider === "kiro") {
            const views = await fetchKiroQuotas([account])
            return views[0] || null
        }
    } catch {
        // Best-effort background refresh
    }
    return null
}

/**
 * Same-plan quota budget pooling resolver: exposes the per-account subscription plan (set from
 * the dashboard options) to the intelligent scorer, so accounts sharing one plan share one
 * pooled per-1% quota budget. Snapshot of the auth store, refreshed at most once per minute.
 * Returns undefined when no explicit plan is set (provider default then applies).
 */
const accountPlanSnapshot = new Map<string, string | null>()
let accountPlanSnapshotAt = 0

function accountPlanResolver(provider: string, accountId: string): string | undefined {
    const now = Date.now()
    if (accountPlanSnapshotAt === 0 || now - accountPlanSnapshotAt > 60_000) {
        accountPlanSnapshot.clear()
        for (const prov of ["antigravity", "codex", "copilot", "zed", "kiro", "grok"] as AuthProvider[]) {
            try {
                for (const a of authStore.listAccounts(prov)) {
                    accountPlanSnapshot.set(`${prov}:${a.id}`, a.plan ?? null)
                }
            } catch {
                // provider unavailable
            }
        }
        accountPlanSnapshotAt = now
    }
    const cleanId = accountId.trim().startsWith(`${provider}:`)
        ? accountId.trim().slice(provider.length + 1)
        : accountId.trim()
    return accountPlanSnapshot.get(`${provider}:${cleanId}`) ?? undefined
}

if (process.env.NODE_ENV !== "test") {
    registerQuotaRefreshTrigger((provider, accountId) => {
        void refreshAccountQuotaInBackground(provider, accountId)
    })
    registerAccountPlanResolver(accountPlanResolver)
}

async function fetchAntigravityQuotas(accounts: ProviderAccount[]): Promise<AccountQuotaView[]> {
    const promises = accounts.map(async (account) => {
        let lastError: Error | null = null

        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const refreshed = await refreshAntigravityToken(account)
                const quotaModels = await fetchAntigravityModelsForAccount(refreshed).catch(() => ({}))
                const quotaSummary = await fetchAntigravityQuotaSummaryForAccount(refreshed)
                const bars = buildAntigravityBars(quotaModels, quotaSummary)
                const displayName = account.label || account.email || account.id
                const modelList = Object.keys(quotaModels || {})
                if (modelList.length > 0) {
                    setDynamicAntigravityModelsForAccount(
                        account.id,
                        modelList.map(id => ({ id, label: `Antigravity - ${id}` }))
                    )
                }
                updateQuotaCache({
                    provider: "antigravity",
                    accountId: account.id,
                    displayName,
                    bars,
                    models: modelList.length > 0 ? modelList : undefined,
                    updatedAt: new Date().toISOString(),
                    proxy: account.proxy,
                    label: account.label,
                })
                return {
                    provider: "antigravity" as const,
                    accountId: account.id,
                    displayName,
                    bars,
                    proxy: account.proxy,
                    label: account.label,
                }
            } catch (error) {
                lastError = error as Error
                if (attempt < 1) {
                    await new Promise(resolve => setTimeout(resolve, 500))
                }
            }
        }

        if (lastError && !isCertificateError(lastError) && !isAuthError(lastError)) {
            consola.warn("Antigravity quota fetch failed:", safeErrorMessage(lastError))
        }
        const displayName = account.label || account.email || account.id
        return {
            provider: "antigravity" as const,
            accountId: account.id,
            displayName,
            bars: getCachedBars("antigravity", account.id) || defaultBarsForProvider("antigravity"),
            proxy: account.proxy,
            label: account.label,
        }
    })

    return Promise.all(promises)
}

async function refreshAntigravityToken(account: ProviderAccount): Promise<ProviderAccount> {
    if (!account.refreshToken) {
        return account
    }
    if (!account.expiresAt || account.expiresAt > Date.now() + 60_000) {
        return account
    }

    try {
        const refreshed = await refreshAccessToken(account.refreshToken, account.proxy)
        const updated = {
            ...account,
            accessToken: refreshed.accessToken,
            expiresAt: Date.now() + refreshed.expiresIn * 1000,
        }
        authStore.saveAccount(updated)
        return updated
    } catch (error) {
        if (isCertificateError(error) || isAuthError(error)) {
            const updated = {
                ...account,
                expiresAt: 0,
            }
            authStore.saveAccount(updated)
            return updated
        }
        throw error
    }
}

async function withAntigravityTokenRetry<T>(
    account: ProviderAccount,
    requestFn: (acc: ProviderAccount) => Promise<T>,
    fallbackOnAuthFailure: T,
    rethrowOtherErrors: boolean
): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            return await requestFn(account)
        } catch (error) {
            if (error instanceof UpstreamError && error.status === 401 && account.refreshToken && attempt === 0) {
                try {
                    const refreshed = await refreshAccessToken(account.refreshToken, account.proxy)
                    account.accessToken = refreshed.accessToken
                    account.expiresAt = Date.now() + refreshed.expiresIn * 1000
                    authStore.saveAccount(account)
                    continue
                } catch (refreshError) {
                    if (isCertificateError(refreshError) || isAuthError(refreshError)) {
                        return fallbackOnAuthFailure
                    }
                    throw refreshError
                }
            }
            if (error instanceof UpstreamError && error.status === 401) {
                return fallbackOnAuthFailure
            }
            if (rethrowOtherErrors) {
                throw error
            }
            return fallbackOnAuthFailure
        }
    }
    return fallbackOnAuthFailure
}

async function fetchAntigravityModelsForAccount(account: ProviderAccount): Promise<Record<string, ModelInfo>> {
    return withAntigravityTokenRetry(
        account,
        async (acc) => {
            const result = await fetchAntigravityModelsRequest(acc.accessToken, acc.projectId, acc.proxy)
            if (!acc.projectId && result.projectId) {
                acc.projectId = result.projectId
                authStore.saveAccount(acc)
            }
            return result.models
        },
        {},
        true
    )
}

async function fetchAntigravityQuotaSummaryForAccount(account: ProviderAccount): Promise<AntigravityQuotaSummaryResponse | null> {
    return withAntigravityTokenRetry(
        account,
        (acc) => fetchAntigravityQuotaSummary(acc.accessToken, acc.projectId, acc.proxy),
        null,
        false
    )
}

export function buildAntigravityBars(
    models: Record<string, ModelInfo>,
    summary?: AntigravityQuotaSummaryResponse | null
): AccountBar[] {
    if (summary?.groups && summary.groups.length > 0) {
        const groups = summary.groups

        const geminiGroup = groups.find(g => {
            const name = (g.displayName || "").toLowerCase()
            return name.includes("gemini") && !name.includes("argon")
        }) || groups.find(g => (g.buckets || []).some(b => {
            const id = b.bucketId.toLowerCase()
            const d = (b.displayName || "").toLowerCase()
            return (id.includes("gemini") || d.includes("gemini")) && !id.includes("argon") && !d.includes("argon")
        }))

        const claudeGroup = groups.find(g => {
            const name = (g.displayName || "").toLowerCase()
            return name.includes("claude") || name.includes("gpt") || name.includes("3p")
        }) || groups.find(g => (g.buckets || []).some(b => {
            const id = b.bucketId.toLowerCase()
            return id.includes("3p") || id.includes("claude") || id.includes("gpt")
        }))

        const argonGroup = groups.find(g => {
            const name = (g.displayName || "").toLowerCase()
            return name.includes("argon")
        }) || groups.find(g => (g.buckets || []).some(b => {
            const id = b.bucketId.toLowerCase()
            const d = (b.displayName || "").toLowerCase()
            return id.includes("argon") || d.includes("argon")
        }))

        const allBuckets = groups.flatMap(g => g.buckets || [])

        const getBucket = (group: AntigravityQuotaGroup | undefined, isWeekly: boolean, filterArgon = false) => {
            const buckets = group?.buckets || []
            return buckets.find(b => {
                const w = (b.window || "").toLowerCase()
                const id = b.bucketId.toLowerCase()
                const d = (b.displayName || "").toLowerCase()
                if (filterArgon && (id.includes("argon") || d.includes("argon"))) return false
                return isWeekly ? (w === "weekly" || id.includes("week")) : (w === "5h" || id.includes("5h"))
            })
        }

        const isArgonBucket = (b: AntigravityQuotaBucket) => {
            const id = (b.bucketId || "").toLowerCase()
            const d = (b.displayName || "").toLowerCase()
            return id.includes("argon") || d.includes("argon")
        }

        const getArgonBucket = (isWeekly: boolean) => {
            const isDedicatedArgonGroup = Boolean(argonGroup && (argonGroup.displayName || "").toLowerCase().includes("argon"))
            const candidateBuckets = isDedicatedArgonGroup
                ? (argonGroup?.buckets || [])
                : allBuckets.filter(isArgonBucket)

            return candidateBuckets.find(b => {
                if (!isDedicatedArgonGroup && !isArgonBucket(b)) return false
                const w = (b.window || "").toLowerCase()
                const id = b.bucketId.toLowerCase()
                return isWeekly ? (w === "weekly" || id.includes("week") || !id.includes("5h")) : (w === "5h" || id.includes("5h"))
            })
        }

        const gWeekly = getBucket(geminiGroup, true, true)
        const g5h = getBucket(geminiGroup, false, true)
        const cWeekly = getBucket(claudeGroup, true)
        const c5h = getBucket(claudeGroup, false)
        const aWeekly = getArgonBucket(true)
        const a5h = getArgonBucket(false)

        const toBar = (key: string, label: string, bucket?: AntigravityQuotaBucket, defaultPct = 100): AccountBar => {
            if (!bucket) {
                return { key, label, percentage: defaultPct }
            }
            const fraction = typeof bucket.remainingFraction === "number" ? bucket.remainingFraction : (defaultPct / 100)
            const percentage = Math.max(0, Math.min(100, Math.round(fraction * 100)))
            return {
                key,
                label,
                percentage,
                rawFraction: Math.max(0, Math.min(1, fraction)),
                resetTime: bucket.resetTime || undefined,
                ...(bucket.disabled !== undefined ? { disabled: bucket.disabled } : {}),
            }
        }

        const result: AccountBar[] = [
            toBar("gemini_week", "weekly gemini", gWeekly, 100),
            toBar("gemini_5h", "5hr gemini", g5h, 100),
            toBar("claude_gpt_week", "weekly claude gpt", cWeekly, 0),
            toBar("claude_gpt_5h", "5hr claude gpt", c5h, 0),
            toBar("argon_week", "weekly argon", aWeekly, 0),
        ]

        if (a5h) {
            result.push(toBar("argon_5h", "5hr argon", a5h, 0))
        }

        return result
    }

    const idsInPool = (pool: QuotaPool) => Object.keys(models).filter(id => quotaPoolForModel(id) === pool)
    const argonIds = idsInPool("argon")
    const claudeGptIds = idsInPool("claude_gpt")
    const geminiIds = idsInPool("gemini")

    const geminiRaw = buildMergedBar("gemini", "gemini", models, geminiIds)
    const claudeGptRaw = buildMergedBar("claude_gpt", "claude_gpt", models, claudeGptIds)
    const argonRaw = buildMergedBar("argon", "argon", models, argonIds)

    const now = Date.now()
    const isGeminiWeekly = geminiRaw.resetTime ? (Date.parse(geminiRaw.resetTime) - now > 12 * 3600 * 1000) : false
    const isClaudeWeekly = claudeGptRaw.resetTime ? (Date.parse(claudeGptRaw.resetTime) - now > 12 * 3600 * 1000) : true
    const hasArgonModels = argonIds.length > 0

    const geminiFrac = geminiRaw.rawFraction ?? geminiRaw.percentage / 100
    const claudeGptFrac = claudeGptRaw.rawFraction ?? claudeGptRaw.percentage / 100
    const argonFrac = argonRaw.rawFraction ?? argonRaw.percentage / 100
    const geminiWeekly: AccountBar = {
        key: "gemini_week",
        label: "weekly gemini",
        percentage: isGeminiWeekly ? geminiRaw.percentage : 100,
        rawFraction: isGeminiWeekly ? geminiFrac : 1,
        resetTime: isGeminiWeekly ? geminiRaw.resetTime : undefined,
    }
    const gemini5h: AccountBar = {
        key: "gemini_5h",
        label: "5hr gemini",
        percentage: isGeminiWeekly ? 0 : geminiRaw.percentage,
        rawFraction: isGeminiWeekly ? 0 : geminiFrac,
        resetTime: isGeminiWeekly ? undefined : geminiRaw.resetTime,
    }
    const claudeGptWeekly: AccountBar = {
        key: "claude_gpt_week",
        label: "weekly claude gpt",
        percentage: isClaudeWeekly ? claudeGptRaw.percentage : 100,
        rawFraction: isClaudeWeekly ? claudeGptFrac : 1,
        resetTime: isClaudeWeekly ? claudeGptRaw.resetTime : undefined,
    }
    const claudeGpt5h: AccountBar = {
        key: "claude_gpt_5h",
        label: "5hr claude gpt",
        percentage: !isClaudeWeekly ? claudeGptRaw.percentage : (claudeGptRaw.percentage <= 0 ? 0 : 100),
        rawFraction: !isClaudeWeekly ? claudeGptFrac : (claudeGptFrac <= 0 ? 0 : 1),
        resetTime: !isClaudeWeekly ? claudeGptRaw.resetTime : undefined,
    }
    const argonWeekly: AccountBar = {
        key: "argon_week",
        label: "weekly argon",
        percentage: hasArgonModels ? argonRaw.percentage : 0,
        rawFraction: hasArgonModels ? argonFrac : 0,
        resetTime: hasArgonModels ? argonRaw.resetTime : undefined,
    }

    return [
        geminiWeekly,
        gemini5h,
        claudeGptWeekly,
        claudeGpt5h,
        argonWeekly,
    ]
}

function buildMergedBar(
    key: string,
    label: string,
    models: Record<string, ModelInfo>,
    ids: string[]
): AccountBar {
    const entries = ids
        .map(id => models[id])
        .filter(Boolean)

    if (entries.length === 0) {
        return { key, label, percentage: 100 }
    }

    const fractions = entries.map(item => Math.max(0, Math.min(1, item?.remainingFraction ?? 0)))
    const minFraction = Math.min(...fractions)
    const percentage = Math.max(0, Math.min(100, Math.round(minFraction * 100)))
    const resetTime = earliestResetTime(entries.map(item => item?.resetTime).filter(Boolean) as string[])
    return { key, label, percentage, rawFraction: minFraction, resetTime }
}

function earliestResetTime(times: string[]): string | undefined {
    if (times.length === 0) return undefined
    return times.reduce((earliest, current) => {
        if (!earliest) return current
        return new Date(current).getTime() < new Date(earliest).getTime() ? current : earliest
    }, times[0])
}

async function fetchProviderQuotasWithCache(
    provider: Exclude<QuotaProvider, "antigravity">,
    label: string,
    accounts: ProviderAccount[],
    getDisplayName: (account: ProviderAccount) => string,
    fetchBars: (account: ProviderAccount) => Promise<AccountBar[]>
): Promise<AccountQuotaView[]> {
    return Promise.all(
        accounts.map(async (account) => {
            const displayName = getDisplayName(account)
            try {
                const bars = await fetchBars(account)
                updateQuotaCache({
                    provider,
                    accountId: account.id,
                    displayName,
                    bars,
                    updatedAt: new Date().toISOString(),
                })
                return { provider, accountId: account.id, displayName, bars }
            } catch (error) {
                if (!isCertificateError(error)) {
                    consola.warn(`${label} quota fetch failed:`, safeErrorMessage(error))
                }
                return {
                    provider,
                    accountId: account.id,
                    displayName,
                    bars: getCachedBars(provider, account.id) || defaultBarsForProvider(provider),
                }
            }
        })
    )
}

async function fetchCodexQuotas(accounts: ProviderAccount[]): Promise<AccountQuotaView[]> {
    return fetchProviderQuotasWithCache(
        "codex",
        "Codex",
        accounts,
        account => account.email || account.id,
        async account => {
            const updated = await refreshCodexAccountIfNeeded(account)
            return fetchCodexUsage(updated)
        }
    )
}

async function fetchCodexUsage(account: ProviderAccount): Promise<AccountBar[]> {
    const response = await fetchSecureJson("https://chatgpt.com/backend-api/wham/usage", {
        method: "GET",
        headers: {
            Authorization: `Bearer ${account.accessToken}`,
            Accept: "application/json",
        },
    })

    if (response.status === 401 && account.refreshToken) {
        const refreshed = await refreshCodexAccessToken(account.refreshToken, account.authSource)
        account.accessToken = refreshed.accessToken
        if (refreshed.expiresIn) {
            account.expiresAt = Date.now() + refreshed.expiresIn * 1000
        }
        authStore.saveAccount(account)
        return fetchCodexUsage(account)
    }

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`Codex usage error ${response.status}`)
    }

    const data = response.data as any
    const rateLimit = data.rate_limit || {}
    const primary = rateLimit.primary_window || {}
    const secondary = rateLimit.secondary_window || {}

    return [
        {
            key: "session",
            label: "5h",
            percentage: 100 - (primary.used_percent || 0),
            rawFraction: Math.max(0, Math.min(1, (100 - (primary.used_percent || 0)) / 100)),
            resetTime: primary.reset_at ? new Date(primary.reset_at * 1000).toISOString() : undefined,
        },
        {
            key: "week",
            label: "week",
            percentage: 100 - (secondary.used_percent || 0),
            rawFraction: Math.max(0, Math.min(1, (100 - (secondary.used_percent || 0)) / 100)),
            resetTime: secondary.reset_at ? new Date(secondary.reset_at * 1000).toISOString() : undefined,
        },
    ]
}

async function fetchCopilotQuotas(accounts: ProviderAccount[]): Promise<AccountQuotaView[]> {
    return fetchProviderQuotasWithCache(
        "copilot",
        "Copilot",
        accounts,
        account => account.login || account.id,
        async account => [await fetchCopilotPremium(account)]
    )
}

async function fetchZedQuotas(accounts: ProviderAccount[]): Promise<AccountQuotaView[]> {
    return fetchProviderQuotasWithCache(
        "zed",
        "Zed",
        accounts,
        account => account.label || account.login || account.id,
        async account => [buildZedHostedBar(await fetchZedAccountOverview(account))]
    )
}

async function fetchKiroQuotas(accounts: ProviderAccount[]): Promise<AccountQuotaView[]> {
    return fetchProviderQuotasWithCache(
        "kiro",
        "Kiro",
        accounts,
        account => account.label || account.login || account.id,
        async () => defaultBarsForProvider("kiro")
    )
}

function buildZedHostedBar(data: Awaited<ReturnType<typeof fetchZedAccountOverview>>): AccountBar {
    const plan = data.plan?.plan_v3 || ""
    const entitledPlans = new Set(["zed_pro", "zed_pro_trial", "zed_student"])
    return {
        key: "hosted",
        label: "hosted",
        percentage: entitledPlans.has(plan) ? 100 : 0,
        rawFraction: entitledPlans.has(plan) ? 1 : 0,
        resetTime: data.plan?.subscription_period?.ended_at || undefined,
    }
}

async function fetchCopilotPremium(account: ProviderAccount): Promise<AccountBar> {
    let response: InsecureResponse
    try {
        response = await fetchSecureJson("https://api.github.com/copilot_internal/user", {
            method: "GET",
            headers: {
                Authorization: `Bearer ${account.accessToken}`,
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        })
    } catch (error) {
        if (isCertificateError(error)) {
            return { key: "premium", label: "premium", percentage: 0 }
        }
        throw error
    }

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`Copilot entitlement error ${response.status}`)
    }

    const data = response.data as any
    const premium = data.quota_snapshots?.premium_interactions
    const precisePct = derivePrecisePercent(premium)
    const reset = data.quota_reset_date_utc || data.quota_reset_date || data.limited_user_reset_date

    return {
        key: "premium",
        label: "premium",
        percentage: Math.max(0, Math.min(100, Math.round(precisePct))),
        rawFraction: precisePct / 100,
        resetTime: reset || undefined,
    }
}

function derivePrecisePercent(snapshot: any): number {
    if (!snapshot) return 0
    if (snapshot.unlimited === true) return 100
    if (typeof snapshot.percent_remaining === "number") {
        return Math.max(0, Math.min(100, snapshot.percent_remaining))
    }
    if (typeof snapshot.remaining === "number" && typeof snapshot.entitlement === "number") {
        if (snapshot.entitlement <= 0) return 0
        return Math.max(0, Math.min(100, (snapshot.remaining / snapshot.entitlement) * 100))
    }
    return 0
}

function isCertificateError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false
    const code = (error as { code?: string }).code
    if (code === "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR") return true
    const message = String((error as { message?: string }).message || "")
    return message.toLowerCase().includes("certificate")
}

function isAuthError(error: unknown): boolean {
    if (!error) return false
    const message = String((error as { message?: string }).message || "")
    if (message.includes("401")) return true
    if (message.toLowerCase().includes("unauthenticated")) return true
    if (message.toLowerCase().includes("invalid_grant")) return true
    return false
}

type InsecureResponse = {
    status: number
    data: any
    text: string
}

async function fetchSecureJson(
    url: string,
    options: { method?: string; headers?: Record<string, string>; body?: string }
): Promise<InsecureResponse> {
    const response = await fetch(url, {
        method: options.method,
        headers: { "User-Agent": "anti-api", ...(options.headers || {}) },
        body: options.body,
        signal: AbortSignal.timeout(10_000),
    })
    const text = await response.text()
    let data: any = null
    if (text) {
        try { data = JSON.parse(text) } catch { }
    }
    return { status: response.status, data, text }
}
