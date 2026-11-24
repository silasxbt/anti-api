/**
 * Intelligent Account Routing Scorer
 *
 * Upgrades basic Cache-Aware Routing into a multi-factor Intelligent Routing engine that optimizes:
 * 1. Time-to-Reset Urgency (Hybrid Linear + Exponential curve):
 *    Prioritizes accounts whose quota window is approaching reset ("use it or lose it"),
 *    e.g., an account at 50% Argon resetting in 5h is strongly preferred over an account at 100%
 *    resetting in 7 days.
 * 2. Expiring Quota Burn-Rate (Excess Quota-to-Time Ratio):
 *    Accelerates usage of accounts that have a high ratio of remaining quota to remaining time.
 * 3. Total (Weekly) Quota Dominance over 5-Hour Window:
 *    For models with both weekly and 5-hour bars, the score is 95% driven by the weekly (total)
 *    quota and reset timer, with only a 5% minor weight on the 5-hour bar (unless the 5-hour bar
 *    is completely exhausted at 0%).
 * 4. Cache-Aware Percentage-to-Value Calibration & Request Fit Evaluation Near Exhaustion:
 *    Discounts prompt-cached tokens (0.1x) vs uncached input (1.0x) and output tokens, calibrates
 *    the dollar/token value of 1% quota (`valuePerPercentUsd`) from observed quota drops across
 *    syncs, and estimates both real-time remaining quota value (`estimatedRemainingValueUsd`) and
 *    the incoming request's cache-aware cost (`estimatedRequestCostUsd`). When an account is close
 *    to finishing its quota, evaluates whether the remaining value can or cannot fit the request.
 * 5. Proactive Background Quota Refresh Near Reset:
 *    Triggers an asynchronous single-account quota refresh when a known `resetTime` passes, when
 *    reset is imminent (<= 15 min), or when live estimated quota depletion since last sync is high.
 * 6. Untriggered Window Preservation ("Don't Start the Clock Early"):
 *    Applies a mild penalty to pristine 100% accounts whose reset timer has not started yet.
 * 7. Warm Prompt-Cache Affinity with TTL Decay & Live Load Distribution:
 *    Keeps active multi-turn conversations on the same account within the 5-minute upstream
 *    prompt cache window while smoothly distributing load when accounts have close scores.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { getDataDir } from "~/lib/data-dir"
import { quotaPoolForModel, type QuotaPool } from "~/lib/model-catalog"
import { computeEffectiveTokenLoad, estimateRequestCostUsd } from "~/services/usage-tracker"
import { resolvePlan } from "~/lib/account-plans"
import type { AuthProvider } from "~/services/auth/types"

export interface QuotaBarSnapshot {
    key: string
    label: string
    percentage: number
    /** Full-precision upstream remainingFraction (0..1) when available, to avoid 1% quantization loss. */
    rawFraction?: number
    resetTime?: string
    disabled?: boolean
    estimatedValueUsd?: number
    estimatedTotalValueUsd?: number
    valuePerPercentUsd?: number
    /** Effective tokens per 1% of pool (plan-pooled when available). */
    effectiveTokensPerPercent?: number
    /** Estimated remaining effective tokens for this bar. */
    estimatedTokensRemaining?: number
    /** True when the per-1% value was taken from a same-plan pooled estimate. */
    planShared?: boolean
    /** Number of same-plan accounts behind the pooled estimate. */
    planAccounts?: number
}

export interface AccountQuotaSnapshot {
    provider: string
    accountId: string
    bars: QuotaBarSnapshot[]
    updatedAt?: string
}

export interface IntelligentScoreBreakdown {
    accountId: string
    provider: string
    totalScore: number
    effectiveQuotaFraction: number
    primaryRemainingHours: number | null
    timeRatioRemaining: number
    urgencyMultiplier: number
    capacityScore: number
    burnRateScore: number
    cacheAffinityBonus: number
    untriggeredPenalty: number
    lowQuotaReservePenalty: number
    liveLoadPenalty: number
    concurrencyPenalty: number
    failurePenalty: number
    valuePerPercentUsd: number
    estimatedRemainingValueUsd: number
    estimatedRemainingEffectiveTokens: number
    estimatedRequestCostUsd: number
    insufficientQuotaForRequest: boolean
    exhausted: boolean
    unknownQuota: boolean
    /** True when the per-1% budget used for this score came from a same-plan pooled estimate. */
    planShared?: boolean
    /** Number of same-plan accounts contributing to the pooled estimate. */
    planAccounts?: number
}

export interface QuotaValueEstimate {
    provider: string
    accountId: string
    poolKey: string
    effectiveQuotaPercentage: number
    valuePerPercentUsd: number
    estimatedRemainingValueUsd: number
    effectiveTokensPerPercent: number
    estimatedRemainingEffectiveTokens: number
    costUsdSinceSync: number
    calibrationSamples: number
}

export interface ScoreCandidateParams {
    provider: string
    accountId: string
    model?: string
    sessionKey?: string
    forceRotate?: boolean
    isInFlight?: boolean
    consecutiveFailures?: number
    totalTokensUsed?: number
    estimatedPromptTokens?: number
    expectedOutputTokens?: number
    messages?: unknown
    now?: number
}

export interface IntelligentUsageReport {
    uncachedInputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    model?: string
    now?: number
}

export type QuotaRefreshReason = "reset_passed" | "near_reset" | "high_live_depletion"
export type QuotaRefreshCallback = (
    provider: string,
    accountId: string,
    reason: QuotaRefreshReason
) => void | Promise<void>

// ============================================================================
// Tunable Mathematical Formula Constants
// ============================================================================

/** Window durations in hours */
const WINDOW_HOURS_WEEKLY = 168  // 7 days
const WINDOW_HOURS_5H = 5        // 5 hours
const WINDOW_HOURS_MONTHLY = 720 // 30 days

/**
 * Dual-Window Blend Weights:
 * Routing is 95% driven by the total (weekly) quota and reset clock, and only 5%
 * by the 5-hour rolling window (unless the 5-hour window is exhausted at 0%).
 */
export const WEEKLY_WINDOW_WEIGHT = 0.95
export const FIVE_HOUR_WINDOW_WEIGHT = 0.05

/**
 * Sub-linear capacity exponent alpha in C(Q) = 100 * Q^alpha.
 * At alpha = 0.55: C(1.0) = 100, C(0.5) = 68.3, C(0.2) = 41.3, C(0.05) = 19.3.
 */
export const QUOTA_EXPONENT_ALPHA = 0.55

/**
 * Hybrid Urgency Multiplier:
 * U(tau) = 1 + LINEAR_URGENCY_WEIGHT * (1 - tau) + EXP_URGENCY_WEIGHT * exp(-EXP_URGENCY_DECAY * tau)
 * where tau = clamp(t_rem / W, 0, 1) is the fraction of window time remaining.
 */
export const LINEAR_URGENCY_WEIGHT = 0.6
export const EXP_URGENCY_WEIGHT = 3.5
export const EXP_URGENCY_DECAY = 8.0

/**
 * Burn-Rate Acceleration:
 * B(Q, tau) = BURN_RATE_WEIGHT * (Q / max(tau, TAU_FLOOR))
 */
export const BURN_RATE_WEIGHT = 10.0
export const TAU_FLOOR = 0.003 // ~30 minutes on a 168h weekly window

/**
 * Untriggered Window Preservation Penalty:
 * Avoids starting the 5h/7d reset timer on a pristine 100% account when another
 * account already has an active countdown clock with usable quota.
 */
export const UNTRIGGERED_WINDOW_PENALTY = 18.0

/**
 * Warm Prompt Cache Affinity TTLs:
 * Upstream Gemini/Anthropic prompt cache TTL is 5 minutes.
 */
export const WARM_CACHE_TTL_MS = 5 * 60 * 1000
export const EXTENDED_SESSION_TTL_MS = 15 * 60 * 1000
export const WARM_CACHE_MAX_BONUS = 420.0

/**
 * Live Load Balancing Half-Life (10 minutes):
 * Smoothly distributes load across accounts with close scores between quota syncs.
 */
const LIVE_LOAD_HALF_LIFE_MS = 10 * 60 * 1000
const DISPATCH_LOAD_PENALTY = 8.0
const TOKEN_UNIT_SIZE = 15_000
const TOKEN_LOAD_PENALTY = 5.0
const LIVE_QUOTA_DEPLETION_PER_DISPATCH = 0.002 // 0.2% baseline per dispatch
const MAX_LIVE_QUOTA_DEPLETION = 0.35 // Never deduct more than 35% purely from local estimation

/**
 * Default Quota Percentage-to-Value priors (USD per 1% of weekly/total quota)
 * before empirical EWMA calibration from observed quota drops.
 */
const DEFAULT_VALUE_PER_PERCENT_USD: Record<string, number> = {
    argon_week: 0.60,
     argon_5h: 0.15,
    claude_gpt_week: 0.50,
    claude_gpt_5h: 0.12,
    gemini_week: 0.40,
    gemini_5h: 0.10,
    week: 0.50,
    session: 0.12,
    premium: 0.40,
    hosted: 0.40,
    default: 0.50,
}

const DEFAULT_EFFECTIVE_TOKENS_PER_PERCENT = 100_000
const CALIBRATION_EWMA_ALPHA = 0.35

/**
 * Near-exhaustion request fit evaluation constants:
 * When remaining quota is <= 10% (`NEAR_EXHAUSTION_QUOTA_FRACTION`), we check whether
 * `estimatedRemainingValueUsd` can cover `estimatedRequestCostUsd * REQUEST_FIT_SAFETY_MARGIN`.
 */
export const NEAR_EXHAUSTION_QUOTA_FRACTION = 0.10
export const REQUEST_FIT_SAFETY_MARGIN = 1.25
export const INSUFFICIENT_QUOTA_FOR_REQUEST_PENALTY = 650.0

/**
 * Proactive Background Quota Refresh thresholds
 */
export const PROACTIVE_REFRESH_COOLDOWN_MS = 60_000
export const PROACTIVE_REFRESH_NEAR_RESET_HOURS = 0.25 // 15 minutes
export const PROACTIVE_REFRESH_DEPLETION_THRESHOLD = 0.08 // 8% live quota depletion since last sync

/**
 * Calibration precision & contamination guard:
 * `remainingFraction` upstream has ~1e-7 precision, so a genuine drop can be detected far
 * below the legacy 2% rounding threshold. We accept calibration samples from any drop >=
 * MIN_CALIBRATION_DROP_PCT (0.05% = 5e-4 fraction, a comfortable margin over quantization
 * noise) as long as our own locally-tracked cost explains it. When the observed $/1% falls
 * below CONTAMINATION_REJECT_RATIO of the account's trusted prior, the drop was mostly
 * external (non-gateway) usage: the sample is rejected so the budget estimate is never
 * dragged down by usage we cannot account for.
 */
export const MIN_CALIBRATION_DROP_PCT = 0.05
export const CONTAMINATION_REJECT_RATIO = 0.8
export const CONTAMINATION_GUARD_MIN_SAMPLES = 3

// ============================================================================
// In-Memory State (Quota Snapshots, Value Estimators, Session Bindings, Load)
// ============================================================================

const memoryQuotaSnapshots = new Map<string, AccountQuotaSnapshot>()
let diskCacheLoadedAt = 0
let diskCalibrationsLoaded = false
const DISK_CACHE_RELOAD_TTL_MS = 10_000

interface SessionBinding {
    provider: string
    accountId: string
    model?: string
    lastSeen: number
}

const sessionBindings = new Map<string, SessionBinding>()

interface LiveAccountLoad {
    decayedDispatches: number
    decayedTokenUnits: number
    lastUpdatedAt: number
    dispatchesSinceQuotaSync: number
    tokenUnitsSinceQuotaSync: number
}

const liveAccountLoads = new Map<string, LiveAccountLoad>()

interface PoolValueCalibrationState {
    poolBarKey: string
    lastSyncedPercentage: number
    lastSyncedResetTime?: string
    costUsdSinceSync: number
    effectiveTokensSinceSync: number
    /** Undefined / null when insufficient local data exists. */
    valuePerPercentUsd?: number
    effectiveTokensPerPercent?: number
    calibrationSamples: number
    /** History of recent valid observed samples (USD per 1% drop) for median filter & fallback. */
    recentEstimates: number[]
    /** History of recent observed tokens per 1% drop. */
    recentTokenEstimates?: number[]
    /** Samples rejected by the external-usage contamination guard. */
    externalSkewRejects?: number
}

const poolCalibrations = new Map<string, PoolValueCalibrationState>()

let quotaRefreshTrigger: QuotaRefreshCallback | null = null
const lastRefreshTriggeredAt = new Map<string, number>()

export function registerQuotaRefreshTrigger(callback: QuotaRefreshCallback | null): void {
    quotaRefreshTrigger = callback
}

/**
 * Resolves the user-configured subscription plan for an account (explicit plan, or
 * null/undefined to fall back to the provider default). Registered by quota-aggregator.
 */
export type AccountPlanResolver = (provider: string, accountId: string) => string | null | undefined
let accountPlanResolver: AccountPlanResolver | null = null

export function registerAccountPlanResolver(resolver: AccountPlanResolver | null): void {
    accountPlanResolver = resolver
}

function makeAccountKey(provider: string, accountId: string): string {
    const cleanId = accountId.trim().startsWith(`${provider}:`)
        ? accountId.trim().slice(provider.length + 1)
        : accountId.trim()
    return `${provider}:${cleanId}`
}

function makePoolCalibrationKey(provider: string, accountId: string, poolBarKey: string): string {
    return `${makeAccountKey(provider, accountId)}:${poolBarKey}`
}

function computeMedian(values: number[]): number | undefined {
    if (!values || values.length === 0) return undefined
    const sorted = [...values].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function loadDiskCalibrationsIfNeeded(): void {
    if (diskCalibrationsLoaded || process.env.NODE_ENV === "test") return
    diskCalibrationsLoaded = true
    try {
        const file = join(getDataDir(), "quota-value-calibration.json")
        if (!existsSync(file)) return
        const raw = JSON.parse(readFileSync(file, "utf-8")) as Record<string, PoolValueCalibrationState>
        if (!raw || typeof raw !== "object") return
        for (const [calKey, entry] of Object.entries(raw)) {
            if (!entry) continue
            if (!poolCalibrations.has(calKey)) {
                const recentEstimates = Array.isArray(entry.recentEstimates)
                    ? entry.recentEstimates.filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0).slice(-7)
                    : (typeof entry.valuePerPercentUsd === "number" ? [entry.valuePerPercentUsd] : [])
                const recentTokenEstimates = Array.isArray(entry.recentTokenEstimates)
                    ? entry.recentTokenEstimates.filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0).slice(-7)
                    : (typeof entry.effectiveTokensPerPercent === "number" ? [entry.effectiveTokensPerPercent] : [])
                const medianValue = computeMedian(recentEstimates)
                const medianTokens = computeMedian(recentTokenEstimates)

                poolCalibrations.set(calKey, {
                    poolBarKey: entry.poolBarKey || "default",
                    lastSyncedPercentage: typeof entry.lastSyncedPercentage === "number" ? entry.lastSyncedPercentage : 100,
                    lastSyncedResetTime: entry.lastSyncedResetTime,
                    costUsdSinceSync: typeof entry.costUsdSinceSync === "number" ? entry.costUsdSinceSync : 0,
                    effectiveTokensSinceSync: typeof entry.effectiveTokensSinceSync === "number" ? entry.effectiveTokensSinceSync : 0,
                    valuePerPercentUsd: medianValue,
                    effectiveTokensPerPercent: medianTokens,
                    calibrationSamples: typeof entry.calibrationSamples === "number" ? entry.calibrationSamples : recentEstimates.length,
                    recentEstimates,
                    recentTokenEstimates,
                    externalSkewRejects: typeof entry.externalSkewRejects === "number" ? entry.externalSkewRejects : 0,
                })
            }
        }
    } catch {
        // Best-effort calibration hydration
    }
}

function saveDiskCalibrations(): void {
    if (process.env.NODE_ENV === "test") return
    try {
        const dir = getDataDir()
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true })
        }
        const file = join(dir, "quota-value-calibration.json")
        const payload: Record<string, PoolValueCalibrationState> = {}
        for (const [k, v] of poolCalibrations.entries()) {
            payload[k] = v
        }
        writeFileSync(file, JSON.stringify(payload, null, 2))
    } catch {
        // Best-effort save
    }
}

function getOrCreatePoolCalibration(
    provider: string,
    accountId: string,
    poolBarKey: string,
    initialPercentage: number = 100,
    resetTime?: string
): PoolValueCalibrationState {
    loadDiskCalibrationsIfNeeded()
    const calKey = makePoolCalibrationKey(provider, accountId, poolBarKey)
    let state = poolCalibrations.get(calKey)
    if (!state) {
        state = {
            poolBarKey,
            lastSyncedPercentage: initialPercentage,
            lastSyncedResetTime: resetTime,
            costUsdSinceSync: 0,
            effectiveTokensSinceSync: 0,
            valuePerPercentUsd: undefined,
            effectiveTokensPerPercent: undefined,
            calibrationSamples: 0,
            recentEstimates: [],
            recentTokenEstimates: [],
            externalSkewRejects: 0,
        }
        poolCalibrations.set(calKey, state)
    }
    return state
}

/**
 * Precise bar percentage (0..100) using the full-precision upstream `remainingFraction` when
 * available, instead of the integer-rounded `percentage` which loses ~1% quantization resolution.
 */
function preciseBarPct(bar: QuotaBarSnapshot): number {
    if (typeof bar.rawFraction === "number" && Number.isFinite(bar.rawFraction)) {
        return Math.max(0, Math.min(100, bar.rawFraction * 100))
    }
    return Math.max(0, Math.min(100, typeof bar.percentage === "number" ? bar.percentage : 0))
}

export interface PlanPooledBarEstimate {
    valuePerPercentUsd?: number
    effectiveTokensPerPercent?: number
    /** Number of same-plan accounts that contributed a valid per-account median. */
    planAccounts: number
    /** True when more than one same-plan account shares the budget. */
    planShared: boolean
}

/**
 * Same-plan quota budget pooling.
 *
 * Accounts on the same provider + subscription plan share identical real pool limits, so the
 * fleet reports identical budgets: each account first reduces its own observed samples to a
 * robust per-account MEDIAN ($/1% and effective tokens/1%), then the group budget is the MAX
 * of those medians across accounts with the same plan. The cleanest account (least external
 * contamination) dominates, so usage outside the gateway on one account can no longer drag
 * the whole fleet's estimate down.
 */
export function getPlanPooledBarEstimate(
    provider: string,
    accountId: string,
    poolBarKey: string
): PlanPooledBarEstimate | null {
    if (!accountPlanResolver) return null
    loadDiskCalibrationsIfNeeded()

    let plan: string
    try {
        plan = resolvePlan(provider as AuthProvider, accountPlanResolver(provider, accountId) ?? undefined)
    } catch {
        return null
    }
    if (!plan) return null

    const prefix = `${provider}:`
    const suffix = `:${poolBarKey}`
    let bestVpp: number | undefined
    let bestTpp: number | undefined
    let accounts = 0

    for (const [calKey, cal] of poolCalibrations) {
        if (!calKey.startsWith(prefix) || !calKey.endsWith(suffix)) continue
        const groupAccountId = calKey.slice(prefix.length, calKey.length - suffix.length)
        if (!groupAccountId) continue
        let groupPlan: string
        try {
            groupPlan = resolvePlan(provider as AuthProvider, accountPlanResolver(provider, groupAccountId) ?? undefined)
        } catch {
            continue
        }
        if (groupPlan !== plan) continue

        const vpp = typeof cal.valuePerPercentUsd === "number" && cal.valuePerPercentUsd > 0
            ? cal.valuePerPercentUsd
            : computeMedian(cal.recentEstimates)
        if (typeof vpp !== "number" || vpp <= 0) continue

        const tpp = typeof cal.effectiveTokensPerPercent === "number" && cal.effectiveTokensPerPercent > 0
            ? cal.effectiveTokensPerPercent
            : computeMedian(cal.recentTokenEstimates || [])

        accounts++
        bestVpp = Math.max(bestVpp ?? 0, vpp)
        if (typeof tpp === "number" && tpp > 0) bestTpp = Math.max(bestTpp ?? 0, tpp)
    }

    if (accounts === 0) return null
    return { valuePerPercentUsd: bestVpp, effectiveTokensPerPercent: bestTpp, planAccounts: accounts, planShared: accounts > 1 }
}

function primaryBarKeyForModel(provider: string, model?: string): string {
    if (provider === "antigravity") {
        const pool: QuotaPool = (model ? quotaPoolForModel(model) : null) || "claude_gpt"
        if (pool === "argon") return "argon_week"
        if (pool === "gemini") return "gemini_week"
        return "claude_gpt_week"
    }
    if (provider === "codex") return "week"
    if (provider === "copilot") return "premium"
    if (provider === "zed") return "hosted"
    if (provider === "kiro") return "access"
    return "default"
}

/**
 * Estimate incoming prompt token count from messages array.
 */
export function estimatePromptTokensFromMessages(messages: unknown): number {
    if (!Array.isArray(messages) || messages.length === 0) return 1_000
    let charCount = 0
    for (const msg of messages) {
        if (!msg || typeof msg !== "object") continue
        const content = (msg as any).content
        if (typeof content === "string") {
            charCount += content.length
        } else if (Array.isArray(content)) {
            for (const block of content) {
                if (!block || typeof block !== "object") continue
                if (typeof block.text === "string") {
                    charCount += block.text.length
                } else if (typeof block.content === "string") {
                    charCount += block.content.length
                } else if (block.input && typeof block.input === "object") {
                    try {
                        charCount += JSON.stringify(block.input).length
                    } catch {}
                }
            }
        }
    }
    return Math.max(250, Math.ceil(charCount / 4))
}

/**
 * Enrich quota bars with calibrated `valuePerPercentUsd` and `estimatedValueUsd`
 * for dashboard display in `quota.html`.
 */
export function enrichBarsWithValueEstimates(
    provider: string,
    accountId: string,
    bars: QuotaBarSnapshot[]
): QuotaBarSnapshot[] {
    if (!Array.isArray(bars)) return []
    return bars.map(bar => {
        if (!bar || typeof bar.percentage !== "number") return bar
        const cal = getOrCreatePoolCalibration(provider, accountId, bar.key, bar.percentage, bar.resetTime)
        const pooled = getPlanPooledBarEstimate(provider, accountId, bar.key)
        const effVpp = pooled?.valuePerPercentUsd ?? cal.valuePerPercentUsd
        const effTpp = pooled?.effectiveTokensPerPercent ?? cal.effectiveTokensPerPercent
        const planShared = Boolean(pooled?.planShared)
        const planAccounts = pooled?.planAccounts
        if (typeof effVpp !== "number" || effVpp <= 0) {
            return {
                ...bar,
                estimatedValueUsd: undefined,
                estimatedTotalValueUsd: undefined,
                valuePerPercentUsd: undefined,
                effectiveTokensPerPercent: undefined,
                estimatedTokensRemaining: undefined,
                planShared,
                planAccounts,
            }
        }
        const valueDepletionPct = (cal.costUsdSinceSync / Math.max(0.05, effVpp))
        const effectivePct = Math.max(0, Math.min(100, bar.percentage - valueDepletionPct))
        const estimatedValueUsd = Math.round(effectivePct * effVpp * 100) / 100
        const estimatedTotalValueUsd = Math.round(100 * effVpp * 100) / 100
        const valuePerPercentUsd = Math.round(effVpp * 100) / 100
        return {
            ...bar,
            estimatedValueUsd,
            estimatedTotalValueUsd,
            valuePerPercentUsd,
            effectiveTokensPerPercent: typeof effTpp === "number" && effTpp > 0 ? Math.round(effTpp) : undefined,
            estimatedTokensRemaining: typeof effTpp === "number" && effTpp > 0 ? Math.round(effectivePct * effTpp) : undefined,
            planShared,
            planAccounts,
        }
    })
}

/**
 * Synchronize fresh quota bars from quota-aggregator into the intelligent scorer.
 * Also calibrates the Percentage-to-Value estimator when a quota percentage drop is observed,
 * and resets the "since quota sync" live depletion counters.
 */
export function syncIntelligentQuotaCache(
    provider: string,
    accountId: string,
    bars: QuotaBarSnapshot[],
    updatedAt?: string
): void {
    loadDiskCalibrationsIfNeeded()
    const key = makeAccountKey(provider, accountId)
    const safeBars = Array.isArray(bars) ? bars : []
    let calibrationUpdated = false

    // Update Percentage-to-Value calibration for each bar
    for (const bar of safeBars) {
        if (!bar || typeof bar.percentage !== "number" || !Number.isFinite(bar.percentage)) continue
        const newPct = preciseBarPct(bar)
        const calKey = makePoolCalibrationKey(provider, accountId, bar.key)
        const existingCal = poolCalibrations.get(calKey)

        if (!existingCal) {
            getOrCreatePoolCalibration(provider, accountId, bar.key, newPct, bar.resetTime)
            continue
        }

        const prevPct = existingCal.lastSyncedPercentage
        const resetChanged =
            Boolean(bar.resetTime && existingCal.lastSyncedResetTime && bar.resetTime !== existingCal.lastSyncedResetTime)

        if (newPct < prevPct && !resetChanged) {
            const deltaPct = prevPct - newPct
            if (deltaPct < MIN_CALIBRATION_DROP_PCT) {
                // Sub-threshold drift (quantization noise or minor external usage): keep
                // accumulating our local cost, just refine the precise anchor percentage.
                existingCal.lastSyncedPercentage = newPct
                existingCal.lastSyncedResetTime = bar.resetTime ?? existingCal.lastSyncedResetTime
            } else {
                // Significant drop: attribute it to us only when our locally-tracked cost is material.
                const observedUsdPerPct = existingCal.costUsdSinceSync / deltaPct
                const observedTokensPerPct = existingCal.effectiveTokensSinceSync / deltaPct

                if (existingCal.costUsdSinceSync > 0.05 && Number.isFinite(observedUsdPerPct) && observedUsdPerPct > 0) {
                    // Contamination guard: external usage during the drop window inflates the
                    // observed Δ% and collapses $/1% below the trusted prior. Reject the sample
                    // (never let uncontrollable usage lower the plan budget estimate).
                    const prior = existingCal.valuePerPercentUsd
                    const contaminated =
                        typeof prior === "number" && prior > 0 &&
                        existingCal.calibrationSamples >= CONTAMINATION_GUARD_MIN_SAMPLES &&
                        observedUsdPerPct < prior * CONTAMINATION_REJECT_RATIO
                    if (contaminated) {
                        existingCal.externalSkewRejects = (existingCal.externalSkewRejects ?? 0) + 1
                        calibrationUpdated = true
                    } else {
                        existingCal.recentEstimates = [...(existingCal.recentEstimates || []), observedUsdPerPct].slice(-5)
                        existingCal.recentTokenEstimates = [...(existingCal.recentTokenEstimates || []), observedTokensPerPct].slice(-5)
                        existingCal.valuePerPercentUsd = computeMedian(existingCal.recentEstimates)
                        existingCal.effectiveTokensPerPercent = computeMedian(existingCal.recentTokenEstimates)
                        existingCal.calibrationSamples = existingCal.recentEstimates.length
                        calibrationUpdated = true
                    }
                }
                // The drop (ours + any external share) is spent: restart the since-sync accumulators.
                existingCal.costUsdSinceSync = 0
                existingCal.effectiveTokensSinceSync = 0
                existingCal.lastSyncedPercentage = newPct
                existingCal.lastSyncedResetTime = bar.resetTime
            }
        } else if (newPct > prevPct || resetChanged) {
            // Quota reset occurred
            existingCal.costUsdSinceSync = 0
            existingCal.effectiveTokensSinceSync = 0
            existingCal.lastSyncedPercentage = newPct
            existingCal.lastSyncedResetTime = bar.resetTime
        } else {
            // Percentage unchanged on this sync (e.g., < 2% consumed so far).
            // Keep accumulating our own usage until the percentage ticks down.
            const cap = typeof existingCal.valuePerPercentUsd === "number" ? existingCal.valuePerPercentUsd * 4.0 : 10.0
            existingCal.costUsdSinceSync = Math.min(existingCal.costUsdSinceSync, cap)
            if (typeof existingCal.effectiveTokensPerPercent === "number") {
                existingCal.effectiveTokensSinceSync = Math.min(existingCal.effectiveTokensSinceSync, existingCal.effectiveTokensPerPercent * 4.0)
            }
            existingCal.lastSyncedResetTime = bar.resetTime ?? existingCal.lastSyncedResetTime
        }
    }

    if (calibrationUpdated) {
        saveDiskCalibrations()
    }

    memoryQuotaSnapshots.set(key, {
        provider,
        accountId,
        bars: safeBars,
        updatedAt: updatedAt || new Date().toISOString(),
    })

    const load = liveAccountLoads.get(key)
    if (load) {
        load.dispatchesSinceQuotaSync = 0
        load.tokenUnitsSinceQuotaSync = 0
    }
}

function hydrateFromDiskQuotaCacheIfNeeded(now: number): void {
    if (now - diskCacheLoadedAt < DISK_CACHE_RELOAD_TTL_MS && memoryQuotaSnapshots.size > 0) {
        return
    }
    diskCacheLoadedAt = now
    try {
        const file = join(getDataDir(), "quota-cache.json")
        if (!existsSync(file)) return
        const raw = JSON.parse(readFileSync(file, "utf-8")) as Record<string, AccountQuotaSnapshot>
        if (!raw || typeof raw !== "object") return
        for (const [rawKey, entry] of Object.entries(raw)) {
            if (!entry || !Array.isArray(entry.bars)) continue
            const provider = entry.provider || rawKey.split(":")[0] || "antigravity"
            const accountId = entry.accountId || rawKey.slice(provider.length + 1)
            const key = makeAccountKey(provider, accountId)
            const existing = memoryQuotaSnapshots.get(key)
            if (!existing || !existing.updatedAt || (entry.updatedAt && entry.updatedAt >= existing.updatedAt)) {
                syncIntelligentQuotaCache(provider, accountId, entry.bars, entry.updatedAt)
            }
        }
    } catch {
        // Best-effort disk hydration
    }
}

export function getAccountQuotaSnapshot(provider: string, accountId: string, now: number = Date.now()): AccountQuotaSnapshot | null {
    const key = makeAccountKey(provider, accountId)
    if (!memoryQuotaSnapshots.has(key)) {
        hydrateFromDiskQuotaCacheIfNeeded(now)
    }
    return memoryQuotaSnapshots.get(key) || null
}

function decayFactor(elapsedMs: number): number {
    if (elapsedMs <= 0) return 1
    return Math.pow(0.5, elapsedMs / LIVE_LOAD_HALF_LIFE_MS)
}

function getOrUpdateLiveLoad(key: string, now: number): LiveAccountLoad {
    let load = liveAccountLoads.get(key)
    if (!load) {
        load = {
            decayedDispatches: 0,
            decayedTokenUnits: 0,
            lastUpdatedAt: now,
            dispatchesSinceQuotaSync: 0,
            tokenUnitsSinceQuotaSync: 0,
        }
        liveAccountLoads.set(key, load)
        return load
    }
    const elapsed = Math.max(0, now - load.lastUpdatedAt)
    if (elapsed > 0) {
        const factor = decayFactor(elapsed)
        load.decayedDispatches *= factor
        load.decayedTokenUnits *= factor
        load.lastUpdatedAt = now
    }
    return load
}

function maybeTriggerProactiveQuotaRefresh(
    provider: string,
    accountId: string,
    reason: QuotaRefreshReason,
    now: number
): void {
    if (!quotaRefreshTrigger) return
    const key = makeAccountKey(provider, accountId)
    const lastTriggered = lastRefreshTriggeredAt.get(key) || 0
    if (now - lastTriggered < PROACTIVE_REFRESH_COOLDOWN_MS) {
        return
    }
    lastRefreshTriggeredAt.set(key, now)
    Promise.resolve()
        .then(() => quotaRefreshTrigger?.(provider, accountId, reason))
        .catch(() => {})
}

/**
 * Record that a request was routed to `(provider, accountId)`.
 * Updates both the session-to-account cache affinity binding and the live load counter.
 */
export function recordIntelligentDispatch(
    provider: string,
    accountId: string,
    sessionKey?: string,
    model?: string,
    now: number = Date.now()
): void {
    if (!accountId || accountId === "auto") return
    const key = makeAccountKey(provider, accountId)
    const load = getOrUpdateLiveLoad(key, now)
    load.decayedDispatches += 1
    load.dispatchesSinceQuotaSync += 1

    if (sessionKey) {
        cleanupExpiredSessions(now)
        sessionBindings.set(sessionKey, {
            provider,
            accountId,
            model,
            lastSeen: now,
        })
    }
}

/**
 * Record token consumption for `(provider, accountId)`.
 * Accepts either a raw token count or a cache-aware `IntelligentUsageReport`
 * (`{ uncachedInputTokens, outputTokens, cacheReadTokens, model }`) so cached tokens
 * are properly discounted at 0.1x and Percentage-to-Value tracking is updated.
 */
export function recordIntelligentTokenUsage(
    provider: string,
    accountId: string,
    tokensOrReport: number | IntelligentUsageReport,
    now: number = Date.now()
): void {
    if (!accountId || accountId === "auto") return

    let effectiveTokens = 0
    let costUsd = 0
    let model: string | undefined
    let eventNow = now

    if (typeof tokensOrReport === "number") {
        if (!Number.isFinite(tokensOrReport) || tokensOrReport <= 0) return
        effectiveTokens = tokensOrReport
        costUsd = (tokensOrReport / 1_000_000) * 3.0
    } else if (tokensOrReport && typeof tokensOrReport === "object") {
        const uncached = Math.max(0, tokensOrReport.uncachedInputTokens || 0)
        const output = Math.max(0, tokensOrReport.outputTokens || 0)
        const cached = Math.max(0, tokensOrReport.cacheReadTokens || 0)
        if (uncached <= 0 && output <= 0 && cached <= 0) return
        model = tokensOrReport.model
        if (typeof tokensOrReport.now === "number") {
            eventNow = tokensOrReport.now
        }
        effectiveTokens = computeEffectiveTokenLoad(uncached, output, cached, model)
        costUsd = estimateRequestCostUsd(model || "claude", uncached, output, cached)
    } else {
        return
    }

    const key = makeAccountKey(provider, accountId)
    const load = getOrUpdateLiveLoad(key, eventNow)
    const units = effectiveTokens / TOKEN_UNIT_SIZE
    load.decayedTokenUnits += units
    load.tokenUnitsSinceQuotaSync += units

    const barKey = primaryBarKeyForModel(provider, model)
    const cal = getOrCreatePoolCalibration(provider, accountId, barKey)
    cal.costUsdSinceSync += costUsd
    cal.effectiveTokensSinceSync += effectiveTokens

    // If live estimated quota depletion since last sync crosses threshold, trigger proactive refresh
    if (typeof cal.valuePerPercentUsd === "number" && cal.valuePerPercentUsd > 0) {
        const estimatedDepletion = cal.costUsdSinceSync / (100 * cal.valuePerPercentUsd)
        if (estimatedDepletion >= PROACTIVE_REFRESH_DEPLETION_THRESHOLD) {
            maybeTriggerProactiveQuotaRefresh(provider, accountId, "high_live_depletion", eventNow)
        }
    }
}

let lastSessionCleanupAt = 0
const SESSION_CLEANUP_INTERVAL_MS = 30_000

function cleanupExpiredSessions(now: number): void {
    if (now - lastSessionCleanupAt < SESSION_CLEANUP_INTERVAL_MS && sessionBindings.size < 500) {
        return
    }
    lastSessionCleanupAt = now
    for (const [k, v] of sessionBindings.entries()) {
        if (now - v.lastSeen > EXTENDED_SESSION_TTL_MS * 2) {
            sessionBindings.delete(k)
        }
    }
}

export function getSessionAccountBinding(sessionKey: string, now: number = Date.now()): SessionBinding | null {
    const binding = sessionBindings.get(sessionKey)
    if (!binding) return null
    if (now - binding.lastSeen > EXTENDED_SESSION_TTL_MS * 2) {
        sessionBindings.delete(sessionKey)
        return null
    }
    return binding
}

/**
 * Reset in-memory state (useful for isolated unit tests).
 */
export function resetIntelligentRoutingState(): void {
    memoryQuotaSnapshots.clear()
    sessionBindings.clear()
    liveAccountLoads.clear()
    poolCalibrations.clear()
    lastRefreshTriggeredAt.clear()
    diskCacheLoadedAt = 0
    lastSessionCleanupAt = 0
}

// ============================================================================
// Core Mathematical Formula Implementation
// ============================================================================

interface EvaluatedWindow {
    quotaFraction: number // 0..1
    remainingHours: number | null
    windowHours: number
    tau: number // normalized remaining time in [0, 1]
    timerActive: boolean
    disabled: boolean
    resetPassed: boolean
}

function evaluateBarWindow(bar: QuotaBarSnapshot, windowHours: number, now: number): EvaluatedWindow {
    if (bar.disabled) {
        return {
            quotaFraction: 0,
            remainingHours: null,
            windowHours,
            tau: 1,
            timerActive: false,
            disabled: true,
            resetPassed: false,
        }
    }

    let rawPct = preciseBarPct(bar)

    let remainingHours: number | null = null
    let timerActive = false
    let tau = 1.0
    let resetPassed = false

    if (bar.resetTime) {
        const resetMs = Date.parse(bar.resetTime)
        if (!Number.isNaN(resetMs)) {
            const deltaMs = resetMs - now
            if (deltaMs <= 0) {
                rawPct = 100
                remainingHours = null
                timerActive = false
                tau = 1.0
                resetPassed = true
            } else {
                remainingHours = deltaMs / (3600 * 1000)
                timerActive = true
                tau = Math.max(0.0005, Math.min(1.0, remainingHours / windowHours))
            }
        }
    }

    return {
        quotaFraction: rawPct / 100,
        remainingHours,
        windowHours,
        tau,
        timerActive,
        disabled: false,
        resetPassed,
    }
}

/**
 * Compute the hybrid linear + exponential urgency multiplier U(tau).
 */
export function computeTimeUrgencyMultiplier(tau: number): number {
    const clampedTau = Math.max(0, Math.min(1, tau))
    const linearTerm = LINEAR_URGENCY_WEIGHT * (1 - clampedTau)
    const expTerm = EXP_URGENCY_WEIGHT * Math.exp(-EXP_URGENCY_DECAY * clampedTau)
    return 1 + linearTerm + expTerm
}

/**
 * Compute the single-window quota + time urgency score.
 */
export function computeWindowQuotaTimeScore(
    effectiveQuotaFraction: number,
    windowQuotaFraction: number,
    tau: number
): { urgencyMultiplier: number; capacityScore: number; burnRateScore: number } {
    if (effectiveQuotaFraction <= 0 || windowQuotaFraction <= 0) {
        return { urgencyMultiplier: 1, capacityScore: 0, burnRateScore: 0 }
    }
    const urgencyMultiplier = computeTimeUrgencyMultiplier(tau)
    const baseCapacity = 100 * Math.pow(effectiveQuotaFraction, QUOTA_EXPONENT_ALPHA)
    const capacityScore = baseCapacity * urgencyMultiplier

    const effectiveTau = Math.max(tau, TAU_FLOOR)
    const burnRateScore = BURN_RATE_WEIGHT * (windowQuotaFraction / effectiveTau)

    return { urgencyMultiplier, capacityScore, burnRateScore }
}

function selectRelevantBarsForModel(
    provider: string,
    bars: QuotaBarSnapshot[],
    model?: string
): { primary?: { bar: QuotaBarSnapshot; windowHours: number }; secondary5h?: { bar: QuotaBarSnapshot; windowHours: number } } {
    if (!bars || bars.length === 0) return {}

    const findBar = (key: string, labelFragment?: string) =>
        bars.find(b => b.key === key) ||
        (labelFragment ? bars.find(b => (b.label || "").toLowerCase().includes(labelFragment)) : undefined)

    if (provider === "antigravity") {
        const pool: QuotaPool = (model ? quotaPoolForModel(model) : null) || "claude_gpt"
        if (pool === "argon") {
            const week = findBar("argon_week", "weekly argon")
            const fiveH = findBar("argon_5h", "5hr argon")
            return {
                primary: week ? { bar: week, windowHours: WINDOW_HOURS_WEEKLY } : undefined,
                secondary5h: fiveH ? { bar: fiveH, windowHours: WINDOW_HOURS_5H } : undefined,
            }
        }
        if (pool === "gemini") {
            const week = findBar("gemini_week", "weekly gemini")
            const fiveH = findBar("gemini_5h", "5hr gemini")
            return {
                primary: week ? { bar: week, windowHours: WINDOW_HOURS_WEEKLY } : undefined,
                secondary5h: fiveH ? { bar: fiveH, windowHours: WINDOW_HOURS_5H } : undefined,
            }
        }
        // Default Antigravity pool: claude_gpt
        const week = findBar("claude_gpt_week", "weekly claude")
        const fiveH = findBar("claude_gpt_5h", "5hr claude")
        return {
            primary: week ? { bar: week, windowHours: WINDOW_HOURS_WEEKLY } : undefined,
            secondary5h: fiveH ? { bar: fiveH, windowHours: WINDOW_HOURS_5H } : undefined,
        }
    }

    if (provider === "codex") {
        const week = findBar("week", "week")
        const session = findBar("session", "5h")
        return {
            primary: week ? { bar: week, windowHours: WINDOW_HOURS_WEEKLY } : undefined,
            secondary5h: session ? { bar: session, windowHours: WINDOW_HOURS_5H } : undefined,
        }
    }

    if (provider === "copilot") {
        const premium = findBar("premium", "premium")
        return {
            primary: premium ? { bar: premium, windowHours: WINDOW_HOURS_MONTHLY } : undefined,
        }
    }

    if (provider === "zed") {
        const hosted = findBar("hosted", "hosted")
        return {
            primary: hosted ? { bar: hosted, windowHours: WINDOW_HOURS_MONTHLY } : undefined,
        }
    }

    if (provider === "kiro") {
        const access = findBar("access", "access")
        return {
            primary: access ? { bar: access, windowHours: WINDOW_HOURS_MONTHLY } : undefined,
        }
    }

    return {
        primary: bars[0] ? { bar: bars[0], windowHours: WINDOW_HOURS_WEEKLY } : undefined,
    }
}

/**
 * Inspect the calibrated Percentage-to-Value and remaining work estimate for an account/model.
 */
export function getAccountQuotaValueEstimate(
    provider: string,
    accountId: string,
    model?: string,
    now: number = Date.now()
): QuotaValueEstimate {
    const score = scoreAccountCandidate({ provider, accountId, model, now })
    const poolKey = primaryBarKeyForModel(provider, model)
    const cal = getOrCreatePoolCalibration(provider, accountId, poolKey)
    const pooled = getPlanPooledBarEstimate(provider, accountId, poolKey)
    const effVpp = pooled?.valuePerPercentUsd ?? cal.valuePerPercentUsd
    const effTpp = pooled?.effectiveTokensPerPercent ?? cal.effectiveTokensPerPercent
    return {
        provider,
        accountId,
        poolKey,
        effectiveQuotaPercentage: Math.round(score.effectiveQuotaFraction * 1000) / 10,
        valuePerPercentUsd: typeof effVpp === "number" ? Math.round(effVpp * 1000) / 1000 : 0,
        estimatedRemainingValueUsd: typeof score.estimatedRemainingValueUsd === "number" ? Math.round(score.estimatedRemainingValueUsd * 100) / 100 : 0,
        effectiveTokensPerPercent: typeof effTpp === "number" ? Math.round(effTpp) : 0,
        estimatedRemainingEffectiveTokens: typeof score.estimatedRemainingEffectiveTokens === "number" ? Math.round(score.estimatedRemainingEffectiveTokens) : 0,
        costUsdSinceSync: Math.round(cal.costUsdSinceSync * 10000) / 10000,
        calibrationSamples: cal.calibrationSamples,
    }
}

/**
 * Compute the comprehensive Intelligent Routing score for an account candidate.
 */
export function scoreAccountCandidate(params: ScoreCandidateParams): IntelligentScoreBreakdown {
    const now = params.now ?? Date.now()
    const key = makeAccountKey(params.provider, params.accountId)
    const load = getOrUpdateLiveLoad(key, now)
    const snapshot = getAccountQuotaSnapshot(params.provider, params.accountId, now)

    const { primary, secondary5h } = selectRelevantBarsForModel(
        params.provider,
        snapshot?.bars || [],
        params.model
    )

    const poolBarKey = primary?.bar.key || primaryBarKeyForModel(params.provider, params.model)
    const cal = getOrCreatePoolCalibration(
        params.provider,
        params.accountId,
        poolBarKey,
        primary?.bar.percentage ?? 100,
        primary?.bar.resetTime
    )
    const pooled = getPlanPooledBarEstimate(params.provider, params.accountId, poolBarKey)
    const effVpp = pooled?.valuePerPercentUsd ?? cal.valuePerPercentUsd
    const effTpp = pooled?.effectiveTokensPerPercent ?? cal.effectiveTokensPerPercent

    let unknownQuota = false
    let rawQuotaFraction = 0.85
    let primaryRemainingHours: number | null = null
    let tau = 0.85
    let urgencyMultiplier = 1.0
    let capacityScore = 0
    let burnRateScore = 0
    let untriggeredPenalty = 0

    // Cache-aware live quota depletion estimate since the last upstream quota sync:
    // Uses calibrated valuePerPercentUsd when token/cost usage was recorded, plus a small per-dispatch baseline.
    const unitValue = typeof effVpp === "number" && effVpp > 0 ? effVpp : 0.50
    const valueDepletion = cal.costUsdSinceSync / (100 * unitValue)
    const dispatchDepletion = load.dispatchesSinceQuotaSync * LIVE_QUOTA_DEPLETION_PER_DISPATCH
    const liveDepletion = Math.min(MAX_LIVE_QUOTA_DEPLETION, valueDepletion + dispatchDepletion)

    if (!primary && !secondary5h) {
        unknownQuota = true
        const effectiveQ = Math.max(0.1, rawQuotaFraction - liveDepletion)
        const base = computeWindowQuotaTimeScore(effectiveQ, effectiveQ, tau)
        rawQuotaFraction = effectiveQ
        urgencyMultiplier = base.urgencyMultiplier
        capacityScore = base.capacityScore
        burnRateScore = base.burnRateScore
    } else {
        const evalPrimary = primary ? evaluateBarWindow(primary.bar, primary.windowHours, now) : null
        let eval5h = secondary5h ? evaluateBarWindow(secondary5h.bar, secondary5h.windowHours, now) : null

        if (
            eval5h &&
            evalPrimary &&
            eval5h.quotaFraction === 0 &&
            !eval5h.timerActive &&
            !secondary5h?.bar.resetTime &&
            evalPrimary.quotaFraction > 0 &&
            evalPrimary.timerActive
        ) {
            eval5h = null
        }

        const activeWindows = [evalPrimary, eval5h].filter((w): w is EvaluatedWindow => w !== null)

        // Proactive background quota refresh checks:
        if (activeWindows.some(w => w.resetPassed)) {
            maybeTriggerProactiveQuotaRefresh(params.provider, params.accountId, "reset_passed", now)
        } else if (
            activeWindows.some(
                w => w.remainingHours !== null && w.remainingHours > 0 && w.remainingHours <= PROACTIVE_REFRESH_NEAR_RESET_HOURS
            )
        ) {
            const snapshotUpdatedMs = snapshot?.updatedAt ? Date.parse(snapshot.updatedAt) : 0
            if (!snapshotUpdatedMs || now - snapshotUpdatedMs >= PROACTIVE_REFRESH_COOLDOWN_MS) {
                maybeTriggerProactiveQuotaRefresh(params.provider, params.accountId, "near_reset", now)
            }
        } else if (liveDepletion >= PROACTIVE_REFRESH_DEPLETION_THRESHOLD) {
            maybeTriggerProactiveQuotaRefresh(params.provider, params.accountId, "high_live_depletion", now)
        }

        const isPrimaryExhausted = evalPrimary ? evalPrimary.quotaFraction <= 0 : false
        const is5hHardExhausted = eval5h ? eval5h.quotaFraction <= 0 && (eval5h.timerActive || !evalPrimary) : false
        const anyDisabled = activeWindows.some(w => w.disabled)

        const mainWin = evalPrimary || eval5h!
        primaryRemainingHours = mainWin.remainingHours
        tau = mainWin.tau

        if (anyDisabled || isPrimaryExhausted || is5hHardExhausted) {
            rawQuotaFraction = 0
        } else {
            rawQuotaFraction = Math.max(0.005, mainWin.quotaFraction - liveDepletion)
        }

        if (rawQuotaFraction > 0) {
            const mainScore = computeWindowQuotaTimeScore(rawQuotaFraction, rawQuotaFraction, mainWin.tau)

            if (eval5h && evalPrimary && eval5h.timerActive) {
                const fiveHQ = Math.max(0.01, eval5h.quotaFraction - liveDepletion)
                const fiveHScore = computeWindowQuotaTimeScore(fiveHQ, fiveHQ, eval5h.tau)
                // Total (weekly) reset drives 95% of the score; 5h window is only a 5% minor factor
                urgencyMultiplier =
                    WEEKLY_WINDOW_WEIGHT * mainScore.urgencyMultiplier +
                    FIVE_HOUR_WINDOW_WEIGHT * fiveHScore.urgencyMultiplier
                capacityScore =
                    WEEKLY_WINDOW_WEIGHT * mainScore.capacityScore +
                    FIVE_HOUR_WINDOW_WEIGHT * fiveHScore.capacityScore
                burnRateScore =
                    WEEKLY_WINDOW_WEIGHT * mainScore.burnRateScore +
                    FIVE_HOUR_WINDOW_WEIGHT * fiveHScore.burnRateScore
            } else {
                urgencyMultiplier = mainScore.urgencyMultiplier
                capacityScore = mainScore.capacityScore
                burnRateScore = mainScore.burnRateScore
            }

            const anyTimerActive = activeWindows.some(w => w.timerActive)
            if (!anyTimerActive && mainWin.quotaFraction >= 0.99) {
                untriggeredPenalty = UNTRIGGERED_WINDOW_PENALTY
            }
        }
    }

    const exhausted = rawQuotaFraction <= 0

    // Warm Prompt Cache Affinity Bonus
    let cacheAffinityBonus = 0
    let hasWarmCacheOnAccount = false
    if (!exhausted && !params.forceRotate && params.sessionKey) {
        const binding = getSessionAccountBinding(params.sessionKey, now)
        if (binding && binding.accountId === params.accountId && binding.provider === params.provider) {
            const ageMs = Math.max(0, now - binding.lastSeen)
            if (ageMs <= WARM_CACHE_TTL_MS) {
                hasWarmCacheOnAccount = true
                cacheAffinityBonus = WARM_CACHE_MAX_BONUS * Math.exp(-ageMs / WARM_CACHE_TTL_MS)
            } else if (ageMs <= EXTENDED_SESSION_TTL_MS) {
                const overMs = ageMs - WARM_CACHE_TTL_MS
                cacheAffinityBonus = 40.0 * Math.exp(-overMs / (5 * 60 * 1000))
            }
        }
    }

    // Estimate remaining dollar value and effective token capacity from calibrated Percentage-to-Value
    const effectiveQuotaPercent = exhausted ? 0 : rawQuotaFraction * 100
    const estimatedRemainingValueUsd = typeof effVpp === "number" ? effectiveQuotaPercent * effVpp : 0
    const estimatedRemainingEffectiveTokens = typeof effTpp === "number" ? effectiveQuotaPercent * effTpp : 0

    // Estimate how much value the incoming request will consume on THIS candidate account
    // (accounting for whether the prompt cache is warm on this account: 85% cached @ 0.1x vs 100% uncached @ 1.0x)
    const promptTokens =
        typeof params.estimatedPromptTokens === "number" && params.estimatedPromptTokens > 0
            ? params.estimatedPromptTokens
            : params.messages
              ? estimatePromptTokensFromMessages(params.messages)
              : 4_000
    const expectedOutputTokens =
        typeof params.expectedOutputTokens === "number" && params.expectedOutputTokens > 0
            ? params.expectedOutputTokens
            : 1_500

    const estimatedCachedInput = hasWarmCacheOnAccount && promptTokens > 2_000 ? Math.floor(promptTokens * 0.85) : 0
    const estimatedUncachedInput = Math.max(0, promptTokens - estimatedCachedInput)
    const estimatedRequestCostUsd = estimateRequestCostUsd(
        params.model || "claude",
        estimatedUncachedInput,
        expectedOutputTokens,
        estimatedCachedInput
    )

    // Near-Exhaustion Request Fit Evaluation:
    // When an account is close to finishing its quota (<= 10%), check whether its estimated remaining
    // dollar value (`estimatedRemainingValueUsd`) is enough to cover `estimatedRequestCostUsd * 1.25`.
    // - If YES: the request fits! When the window is also approaching reset (tau < 0.25), lift the
    //   effective capacity floor so the router keeps draining the last 1-10% instead of abandoning it early.
    // - If NO: strong penalty (`insufficientQuotaForRequest = true`) so a heavy request that wouldn't fit
    //   is routed to another account instead of hitting a mid-stream 429.
    let lowQuotaReservePenalty = 0
    let insufficientQuotaForRequest = false
    if (!exhausted && !unknownQuota && rawQuotaFraction <= NEAR_EXHAUSTION_QUOTA_FRACTION) {
        if (typeof effVpp === "number" && effVpp > 0) {
            const requiredValueUsd = Math.max(0.06, estimatedRequestCostUsd * REQUEST_FIT_SAFETY_MARGIN)
            if (estimatedRemainingValueUsd < requiredValueUsd) {
                insufficientQuotaForRequest = true
                const deficitRatio = Math.max(0, Math.min(1, 1 - estimatedRemainingValueUsd / requiredValueUsd))
                lowQuotaReservePenalty = INSUFFICIENT_QUOTA_FOR_REQUEST_PENALTY + 250.0 * deficitRatio
            } else if (tau < 0.25) {
                // The incoming request fits in the remaining value and the reset is approaching:
                // ensure capacityScore doesn't collapse just because percentage is 1-5%, so we finish the quota!
                const finishableCapacityFloor = 0.30 * (1 - tau / 0.25)
                if (rawQuotaFraction < finishableCapacityFloor) {
                    const boostedCapacity = 100 * Math.pow(finishableCapacityFloor, QUOTA_EXPONENT_ALPHA) * urgencyMultiplier
                    capacityScore = Math.max(capacityScore, boostedCapacity)
                }
            }
        }
    }

    // Live Load Penalty (distributes load when accounts have similar scores)
    const historicalTokenUnits = (params.totalTokensUsed || 0) / 100_000
    const liveLoadPenalty =
        load.decayedDispatches * DISPATCH_LOAD_PENALTY +
        load.decayedTokenUnits * TOKEN_LOAD_PENALTY +
        Math.min(15.0, historicalTokenUnits * 2.0)

    // Concurrency & Health Penalties
    const concurrencyPenalty = params.isInFlight ? 500.0 : 0
    const failurePenalty = (params.consecutiveFailures || 0) * 25.0

    const totalScore = exhausted
        ? -1000.0 - concurrencyPenalty - failurePenalty - liveLoadPenalty
        : capacityScore +
          burnRateScore +
          cacheAffinityBonus -
          untriggeredPenalty -
          lowQuotaReservePenalty -
          liveLoadPenalty -
          concurrencyPenalty -
          failurePenalty

    return {
        accountId: params.accountId,
        provider: params.provider,
        totalScore,
        effectiveQuotaFraction: rawQuotaFraction,
        primaryRemainingHours,
        timeRatioRemaining: tau,
        urgencyMultiplier,
        capacityScore,
        burnRateScore,
        cacheAffinityBonus,
        untriggeredPenalty,
        lowQuotaReservePenalty,
        liveLoadPenalty,
        concurrencyPenalty,
        failurePenalty,
        valuePerPercentUsd: effVpp ?? 0,
        estimatedRemainingValueUsd,
        estimatedRemainingEffectiveTokens,
        estimatedRequestCostUsd,
        insufficientQuotaForRequest,
        exhausted,
        unknownQuota,
        planShared: pooled?.planShared ?? false,
        planAccounts: pooled?.planAccounts ?? 0,
    }
}

/**
 * Rank a list of candidate accounts in descending order of Intelligent Score.
 */
export function rankAccountCandidates<T extends { provider: string; accountId: string }>(
    candidates: T[],
    options: {
        model?: string
        sessionKey?: string
        forceRotate?: boolean
        isInFlight?: (accountId: string) => boolean
        getConsecutiveFailures?: (accountId: string) => number
        getTotalTokens?: (accountId: string) => number
        estimatedPromptTokens?: number
        expectedOutputTokens?: number
        messages?: unknown
        now?: number
    } = {}
): Array<{ entry: T; score: IntelligentScoreBreakdown; originalIndex: number }> {
    const now = options.now ?? Date.now()
    const estimatedPromptTokens =
        options.estimatedPromptTokens ??
        (options.messages ? estimatePromptTokensFromMessages(options.messages) : undefined)

    const scored = candidates.map((entry, originalIndex) => {
        const score = scoreAccountCandidate({
            provider: entry.provider,
            accountId: entry.accountId,
            model: options.model,
            sessionKey: options.sessionKey,
            forceRotate: options.forceRotate,
            isInFlight: options.isInFlight ? options.isInFlight(entry.accountId) : false,
            consecutiveFailures: options.getConsecutiveFailures ? options.getConsecutiveFailures(entry.accountId) : 0,
            totalTokensUsed: options.getTotalTokens ? options.getTotalTokens(entry.accountId) : 0,
            estimatedPromptTokens,
            expectedOutputTokens: options.expectedOutputTokens,
            now,
        })
        return { entry, score, originalIndex }
    })

    scored.sort((a, b) => {
        const diff = b.score.totalScore - a.score.totalScore
        if (Math.abs(diff) > 1e-6) return diff
        return a.originalIndex - b.originalIndex
    })

    return scored
}
