import consola from "consola"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { authStore } from "~/services/auth/store"
import { refreshAccessToken } from "~/services/antigravity/oauth"
import {
    fetchAntigravityModels as fetchAntigravityModelsRequest,
    fetchAntigravityQuotaSummary as fetchAntigravityQuotaSummaryRequest,
    type AntigravityModelInfo,
    type AntigravityQuotaSummaryGroup,
} from "~/services/antigravity/quota-fetch"
import { refreshCodexAccessToken, refreshCodexAccountIfNeeded } from "~/services/codex/oauth"
import { accountManager } from "~/services/antigravity/account-manager"
import type { ProviderAccount } from "~/services/auth/types"
import { UpstreamError } from "~/lib/error"
import { getDataDir } from "~/lib/data-dir"
import { fetchZedAccountOverview } from "~/services/zed/chat"
import { safeErrorMessage } from "~/lib/redaction"

type ModelInfo = AntigravityModelInfo

type AccountBar = {
    key: string
    label: string
    percentage: number
    resetTime?: string
}

type QuotaProvider = "antigravity" | "codex" | "copilot" | "zed" | "kiro"

export type AccountQuotaView = {
    provider: QuotaProvider
    accountId: string
    displayName: string
    bars: AccountBar[]
}

type QuotaCacheEntry = {
    provider: QuotaProvider
    accountId: string
    displayName: string
    bars: AccountBar[]
    updatedAt: string
}

const QUOTA_CACHE_DIR = getDataDir()
const QUOTA_CACHE_FILE = join(QUOTA_CACHE_DIR, "quota-cache.json")
let quotaCache = new Map<string, QuotaCacheEntry>()
let cacheLoaded = false
const PROVIDER_FETCH_TIMEOUT_MS = 4000

function getCacheKey(provider: QuotaCacheEntry["provider"], accountId: string): string {
    return `${provider}:${accountId}`
}

function loadQuotaCache(): void {
    if (cacheLoaded) return
    cacheLoaded = true
    try {
        if (!existsSync(QUOTA_CACHE_FILE)) return
        const raw = JSON.parse(readFileSync(QUOTA_CACHE_FILE, "utf-8")) as Record<string, QuotaCacheEntry>
        quotaCache = new Map(Object.entries(raw))
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
    quotaCache.set(getCacheKey(entry.provider, entry.accountId), entry)
}

function getCachedBars(provider: QuotaCacheEntry["provider"], accountId: string): AccountBar[] | null {
    const cached = quotaCache.get(getCacheKey(provider, accountId))
    if (!cached?.bars) return null
    if (provider === "antigravity" && cached.bars.some(b => b.key === "gpro" || b.key === "gflash")) {
        return null
    }
    return cached.bars
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

function defaultCodexBars(): AccountBar[] {
    return [
        { key: "session", label: "5h", percentage: 0 },
        { key: "week", label: "week", percentage: 0 },
    ]
}

function defaultCopilotBars(): AccountBar[] {
    return [{ key: "premium", label: "premium", percentage: 0 }]
}

function defaultZedBars(): AccountBar[] {
    return [{ key: "hosted", label: "hosted", percentage: 0 }]
}

function defaultKiroBars(): AccountBar[] {
    return [{ key: "access", label: "access", percentage: 100 }]
}

function buildCachedViews(provider: QuotaCacheEntry["provider"], accounts: ProviderAccount[]): AccountQuotaView[] {
    return accounts.map(account => {
        const displayName = account.email || account.login || account.id
        const cachedBars = getCachedBars(provider, account.id)
        const bars = cachedBars || (
            provider === "antigravity"
                ? buildAntigravityBars({})
                : provider === "codex"
                    ? defaultCodexBars()
                    : provider === "copilot"
                        ? defaultCopilotBars()
                        : provider === "zed"
                            ? defaultZedBars()
                            : defaultKiroBars()
        )
        return {
            provider,
            accountId: account.id,
            displayName,
            bars,
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
        accounts: [...antigravity, ...codex, ...copilot, ...zed, ...kiro],
    }
}

async function fetchAntigravityQuotas(accounts: ProviderAccount[]): Promise<AccountQuotaView[]> {
    // Fetch all accounts in parallel for faster loading
    const promises = accounts.map(async (account) => {
        let lastError: Error | null = null

        // Retry up to 2 times for each account
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const refreshed = await refreshAntigravityToken(account)
                const [quotaModels, summaryGroups] = await Promise.all([
                    fetchAntigravityModelsForAccount(refreshed),
                    fetchAntigravityQuotaSummaryForAccount(refreshed),
                ])
                const bars = buildAntigravityBars(quotaModels, summaryGroups)
                updateQuotaCache({
                    provider: "antigravity",
                    accountId: account.id,
                    displayName: account.email || account.id,
                    bars,
                    updatedAt: new Date().toISOString(),
                })
                return {
                    provider: "antigravity" as const,
                    accountId: account.id,
                    displayName: account.email || account.id,
                    bars,
                }
            } catch (error) {
                lastError = error as Error
                if (attempt < 1) {
                    // Wait 500ms before retry (reduced from 1000ms)
                    await new Promise(resolve => setTimeout(resolve, 500))
                }
            }
        }

        if (lastError) {
            if (!isCertificateError(lastError) && !isAuthError(lastError)) {
                consola.warn("Antigravity quota fetch failed:", safeErrorMessage(lastError))
            }
        }
        const cachedBars = getCachedBars("antigravity", account.id)
        if (cachedBars) {
            return {
                provider: "antigravity" as const,
                accountId: account.id,
                displayName: account.email || account.id,
                bars: cachedBars,
            }
        }
        return {
            provider: "antigravity" as const,
            accountId: account.id,
            displayName: account.email || account.id,
            bars: buildAntigravityBars({}),
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
        const refreshed = await refreshAccessToken(account.refreshToken)
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

async function fetchAntigravityModelsForAccount(
    account: ProviderAccount,
    hasRefreshed = false
): Promise<Record<string, ModelInfo>> {
    try {
        const result = await fetchAntigravityModelsRequest(account.accessToken, account.projectId)
        if (!account.projectId && result.projectId) {
            account.projectId = result.projectId
            authStore.saveAccount(account)
        }
        return result.models
    } catch (error) {
        if (error instanceof UpstreamError && error.status === 401 && account.refreshToken && !hasRefreshed) {
            try {
                const refreshed = await refreshAccessToken(account.refreshToken)
                account.accessToken = refreshed.accessToken
                account.expiresAt = Date.now() + refreshed.expiresIn * 1000
                authStore.saveAccount(account)
                return fetchAntigravityModelsForAccount(account, true)
            } catch (refreshError) {
                if (isCertificateError(refreshError) || isAuthError(refreshError)) {
                    return {}
                }
                throw refreshError
            }
        }

        if (error instanceof UpstreamError && error.status === 401) {
            return {}
        }

        throw error
    }
}

async function fetchAntigravityQuotaSummaryForAccount(
    account: ProviderAccount
): Promise<AntigravityQuotaSummaryGroup[]> {
    try {
        const result = await fetchAntigravityQuotaSummaryRequest(account.accessToken, account.projectId)
        if (!account.projectId && result.projectId) {
            account.projectId = result.projectId
            authStore.saveAccount(account)
        }
        return result.groups
    } catch {
        return []
    }
}

export function buildAntigravityBars(
    models: Record<string, ModelInfo>,
    summaryGroups: AntigravityQuotaSummaryGroup[] = []
): AccountBar[] {
    const bars: AccountBar[] = []

    const claudeGptGroup = summaryGroups.find(g => {
        const name = (g.displayName || "").toLowerCase()
        return name.includes("claude") || name.includes("gpt")
    })
    const weeklyBucket = claudeGptGroup?.buckets?.find(b => b.window === "weekly" || b.bucketId?.includes("weekly"))
    const fiveHourBucket = claudeGptGroup?.buckets?.find(b => b.window === "5h" || b.bucketId?.includes("5h"))

    const claudeGptIds = Object.keys(models).filter(id => /^(claude-|gpt-)/.test(id))

    if (weeklyBucket) {
        bars.push({
            key: "claude_gpt",
            label: "Claude & GPT · Weekly",
            percentage: Math.round((weeklyBucket.remainingFraction ?? 0) * 100),
            ...(weeklyBucket.resetTime ? { resetTime: weeklyBucket.resetTime } : {}),
        })
    } else {
        bars.push(buildMergedBar("claude_gpt", "Claude & GPT · Weekly", models, claudeGptIds))
    }

    if (fiveHourBucket) {
        bars.push({
            key: "claude_gpt_5h",
            label: "Claude & GPT · 5h",
            percentage: Math.round((fiveHourBucket.remainingFraction ?? 0) * 100),
            ...(fiveHourBucket.resetTime ? { resetTime: fiveHourBucket.resetTime } : {}),
        })
    }

    const geminiGroup = summaryGroups.find(g => {
        const name = (g.displayName || "").toLowerCase()
        return name.includes("gemini") && !name.includes("argon")
    })
    const geminiWeekly = geminiGroup?.buckets?.find(b => b.window === "weekly" || b.bucketId?.includes("weekly"))
    const gemini5h = geminiGroup?.buckets?.find(b => b.window === "5h" || b.bucketId?.includes("5h"))

    if (gemini5h || geminiWeekly) {
        if (geminiWeekly) {
            bars.push({
                key: "gemini_weekly",
                label: "Gemini · Weekly",
                percentage: Math.round((geminiWeekly.remainingFraction ?? 0) * 100),
                ...(geminiWeekly.resetTime ? { resetTime: geminiWeekly.resetTime } : {}),
            })
        }
        if (gemini5h) {
            bars.push({
                key: "gemini",
                label: "Gemini · 5h",
                percentage: Math.round((gemini5h.remainingFraction ?? 0) * 100),
                ...(gemini5h.resetTime ? { resetTime: gemini5h.resetTime } : {}),
            })
        }
    } else {
        const geminiIds = Object.keys(models).filter(id => id.startsWith("gemini-") && !id.startsWith("gemini-4-argon"))
        bars.push(buildMergedBar("gemini", "Gemini", models, geminiIds))
    }

    const argonGroup = summaryGroups.find(g => {
        const name = (g.displayName || "").toLowerCase()
        return name.includes("argon") || (g.buckets || []).some(b => (b.bucketId || "").toLowerCase().includes("argon"))
    })
    const argonWeekly = argonGroup?.buckets?.find(b => b.window === "weekly" || b.bucketId?.includes("weekly"))
    const argon5h = argonGroup?.buckets?.find(b => b.window === "5h" || b.bucketId?.includes("5h"))

    if (argonWeekly || argon5h) {
        if (argonWeekly) {
            bars.push({
                key: "gemini_argon",
                label: "Gemini 4 Argon · Weekly",
                percentage: Math.round((argonWeekly.remainingFraction ?? 0) * 100),
                ...(argonWeekly.resetTime ? { resetTime: argonWeekly.resetTime } : {}),
            })
        }
        if (argon5h) {
            bars.push({
                key: "gemini_argon_5h",
                label: "Gemini 4 Argon · 5h",
                percentage: Math.round((argon5h.remainingFraction ?? 0) * 100),
                ...(argon5h.resetTime ? { resetTime: argon5h.resetTime } : {}),
            })
        }
    } else {
        const argonIds = Object.keys(models).filter(id => id.startsWith("gemini-4-argon"))
        if (argonIds.length > 0) {
            bars.push(buildMergedBar("gemini_argon", "Gemini 4 Argon · Weekly", models, argonIds))
        }
    }

    return bars
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
        return { key, label, percentage: 0 }
    }

    const percentages = entries.map(item => Math.round((item?.remainingFraction ?? 0) * 100))
    const percentage = Math.min(...percentages)
    const resetTime = earliestResetTime(entries.map(item => item?.resetTime).filter(Boolean) as string[])
    return { key, label, percentage, resetTime }
}

function earliestResetTime(times: string[]): string | undefined {
    if (times.length === 0) return undefined
    return times.reduce((earliest, current) => {
        if (!earliest) return current
        return new Date(current).getTime() < new Date(earliest).getTime() ? current : earliest
    }, times[0])
}

async function fetchCodexQuotas(accounts: ProviderAccount[]): Promise<AccountQuotaView[]> {
    // Fetch all accounts in parallel for faster loading
    const promises = accounts.map(async (account) => {
        try {
            const updated = await refreshCodexIfNeeded(account)
            const quota = await fetchCodexUsage(updated)
            updateQuotaCache({
                provider: "codex",
                accountId: account.id,
                displayName: account.email || account.id,
                bars: quota,
                updatedAt: new Date().toISOString(),
            })
            return {
                provider: "codex" as const,
                accountId: account.id,
                displayName: account.email || account.id,
                bars: quota,
            }
        } catch (error) {
            if (!isCertificateError(error)) {
                consola.warn("Codex quota fetch failed:", safeErrorMessage(error))
            }
            const cachedBars = getCachedBars("codex", account.id)
            if (cachedBars) {
                return {
                    provider: "codex" as const,
                    accountId: account.id,
                    displayName: account.email || account.id,
                    bars: cachedBars,
                }
            }
            return {
                provider: "codex" as const,
                accountId: account.id,
                displayName: account.email || account.id,
                bars: [
                    { key: "session", label: "5h", percentage: 0 },
                    { key: "week", label: "week", percentage: 0 },
                ],
            }
        }
    })
    return Promise.all(promises)
}

async function refreshCodexIfNeeded(account: ProviderAccount): Promise<ProviderAccount> {
    return refreshCodexAccountIfNeeded(account)
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
            resetTime: primary.reset_at ? new Date(primary.reset_at * 1000).toISOString() : undefined,
        },
        {
            key: "week",
            label: "week",
            percentage: 100 - (secondary.used_percent || 0),
            resetTime: secondary.reset_at ? new Date(secondary.reset_at * 1000).toISOString() : undefined,
        },
    ]
}

async function fetchCopilotQuotas(accounts: ProviderAccount[]): Promise<AccountQuotaView[]> {
    // Fetch all accounts in parallel for faster loading
    const promises = accounts.map(async (account) => {
        try {
            const bar = await fetchCopilotPremium(account)
            updateQuotaCache({
                provider: "copilot",
                accountId: account.id,
                displayName: account.login || account.id,
                bars: [bar],
                updatedAt: new Date().toISOString(),
            })
            return {
                provider: "copilot" as const,
                accountId: account.id,
                displayName: account.login || account.id,
                bars: [bar],
            }
        } catch (error) {
            consola.warn("Copilot quota fetch failed:", safeErrorMessage(error))
            const cachedBars = getCachedBars("copilot", account.id)
            if (cachedBars) {
                return {
                    provider: "copilot" as const,
                    accountId: account.id,
                    displayName: account.login || account.id,
                    bars: cachedBars,
                }
            }
            return {
                provider: "copilot" as const,
                accountId: account.id,
                displayName: account.login || account.id,
                bars: [{ key: "premium", label: "premium", percentage: 0 }],
            }
        }
    })
    return Promise.all(promises)
}

async function fetchZedQuotas(accounts: ProviderAccount[]): Promise<AccountQuotaView[]> {
    const promises = accounts.map(async (account) => {
        try {
            const overview = await fetchZedAccountOverview(account)
            const bars = [buildZedHostedBar(overview)]
            updateQuotaCache({
                provider: "zed",
                accountId: account.id,
                displayName: account.label || account.login || account.id,
                bars,
                updatedAt: new Date().toISOString(),
            })
            return {
                provider: "zed" as const,
                accountId: account.id,
                displayName: account.label || account.login || account.id,
                bars,
            }
        } catch (error) {
            consola.warn("Zed quota fetch failed:", safeErrorMessage(error))
            const cachedBars = getCachedBars("zed", account.id)
            if (cachedBars) {
                return {
                    provider: "zed" as const,
                    accountId: account.id,
                    displayName: account.label || account.login || account.id,
                    bars: cachedBars,
                }
            }
            return {
                provider: "zed" as const,
                accountId: account.id,
                displayName: account.label || account.login || account.id,
                bars: defaultZedBars(),
            }
        }
    })
    return Promise.all(promises)
}

async function fetchKiroQuotas(accounts: ProviderAccount[]): Promise<AccountQuotaView[]> {
    return accounts.map(account => {
        const bars = defaultKiroBars()
        updateQuotaCache({
            provider: "kiro",
            accountId: account.id,
            displayName: account.label || account.login || account.id,
            bars,
            updatedAt: new Date().toISOString(),
        })
        return {
            provider: "kiro" as const,
            accountId: account.id,
            displayName: account.label || account.login || account.id,
            bars,
        }
    })
}

function buildZedHostedBar(data: Awaited<ReturnType<typeof fetchZedAccountOverview>>): AccountBar {
    const plan = data.plan?.plan_v3 || ""
    const entitledPlans = new Set(["zed_pro", "zed_pro_trial", "zed_student"])
    return {
        key: "hosted",
        label: "hosted",
        percentage: entitledPlans.has(plan) ? 100 : 0,
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
    const percent = derivePercent(premium)
    const reset = data.quota_reset_date_utc || data.quota_reset_date || data.limited_user_reset_date

    return {
        key: "premium",
        label: "premium",
        percentage: percent,
        resetTime: reset || undefined,
    }
}

function derivePercent(snapshot: any): number {
    if (!snapshot) return 0
    if (snapshot.unlimited === true) return 100
    if (typeof snapshot.percent_remaining === "number") return Math.round(snapshot.percent_remaining)
    if (typeof snapshot.remaining === "number" && typeof snapshot.entitlement === "number") {
        if (snapshot.entitlement <= 0) return 0
        return Math.round((snapshot.remaining / snapshot.entitlement) * 100)
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
