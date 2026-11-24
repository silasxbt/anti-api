import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import consola from "consola"
import { getDataDir } from "~/lib/data-dir"
import { safeErrorMessage } from "~/lib/redaction"
import { lookupModelPrice } from "~/services/model-pricing"

const USAGE_DIR = getDataDir()
const USAGE_FILE = join(USAGE_DIR, "usage.json")

// Coarse per-family fallback (USD per million tokens), used only when the online datasheet has no entry for a model
export const PRICING = {
    gpt: { input: 1.75, output: 14.0 },
    claude: { input: 5.0, output: 25.0 },
    gemini: { input: 2.0, output: 12.0 },
    argon: { input: 3.0, output: 15.0 },
} as const

/**
 * Prompt cache read tokens are billed/weighted at 10% (0.1x) of normal uncached input tokens.
 */
export const CACHE_READ_COST_MULTIPLIER = 0.1

interface ModelUsage {
    input: number
    cachedInput?: number
    output: number
}

interface DailyUsage {
    date: string  // YYYY-MM-DD
    cost: number
    input: number
    cachedInput?: number
    output: number
}

interface UsageData {
    lastUpdated: string
    models: Record<string, ModelUsage>
    daily: DailyUsage[]  // Last 14 days
}

// In-memory cache
let usageCache: UsageData = {
    lastUpdated: new Date().toISOString(),
    models: {},
    daily: [],
}

let isDirty = false
let saveTimer: Timer | null = null

// Load usage from file
export function loadUsage(): void {
    try {
        if (existsSync(USAGE_FILE)) {
            const data = JSON.parse(readFileSync(USAGE_FILE, "utf-8"))
            const rawModels = data.models && typeof data.models === "object" ? data.models : {}
            const normalizedModels: Record<string, ModelUsage> = {}
            for (const [model, entry] of Object.entries(rawModels as Record<string, any>)) {
                normalizedModels[model] = {
                    input: typeof entry?.input === "number" ? entry.input : 0,
                    cachedInput: typeof entry?.cachedInput === "number" ? entry.cachedInput : 0,
                    output: typeof entry?.output === "number" ? entry.output : 0,
                }
            }
            usageCache = {
                lastUpdated: data.lastUpdated || new Date().toISOString(),
                models: normalizedModels,
                daily: Array.isArray(data.daily) ? data.daily.map((entry: any) => ({
                    date: entry?.date || getTodayString(),
                    cost: typeof entry?.cost === "number" ? entry.cost : 0,
                    input: typeof entry?.input === "number" ? entry.input : 0,
                    cachedInput: typeof entry?.cachedInput === "number" ? entry.cachedInput : 0,
                    output: typeof entry?.output === "number" ? entry.output : 0,
                })) : [],
            }
        }
    } catch (e) {
        consola.warn("Failed to load usage data:", safeErrorMessage(e))
    }
}

// Save usage to file (debounced)
function saveUsage(): void {
    if (!isDirty) return
    try {
        usageCache.lastUpdated = new Date().toISOString()
        if (!existsSync(USAGE_DIR)) {
            mkdirSync(USAGE_DIR, { recursive: true })
        }
        writeFileSync(USAGE_FILE, JSON.stringify(usageCache, null, 2))
        isDirty = false
    } catch (e) {
        consola.warn("Failed to save usage data:", safeErrorMessage(e))
    }
}

// Schedule save (debounce 5 seconds)
function scheduleSave(): void {
    isDirty = true
    if (saveTimer) return
    saveTimer = setTimeout(() => {
        saveUsage()
        saveTimer = null
    }, 5000)
}

// Detect pricing family from model name
export function detectPricingFamily(model: string): keyof typeof PRICING {
    const m = (model || "").toLowerCase()
    if (m.includes("argon")) return "argon"
    if (m.includes("gpt") || m.includes("o1") || m.includes("o3") || m.includes("o4")) return "gpt"
    if (m.includes("claude") || m.includes("opus") || m.includes("sonnet") || m.includes("haiku")) return "claude"
    if (m.includes("gemini") || m.includes("flash") || m.includes("pro")) return "gemini"
    // Default to claude for antigravity models
    return "claude"
}

export interface EffectivePricing {
    input: number
    output: number
    /** Cache-read price as a fraction of the input price. */
    cacheMultiplier: number
}

/** Per-model price from the online datasheet, falling back to the family table. */
export function getModelPricing(model: string): EffectivePricing {
    const online = lookupModelPrice(model)
    if (online) {
        return { input: online.input, output: online.output, cacheMultiplier: online.cacheRead / online.input }
    }
    const family = PRICING[detectPricingFamily(model)]
    return { input: family.input, output: family.output, cacheMultiplier: CACHE_READ_COST_MULTIPLIER }
}

/**
 * Estimate the cache-adjusted USD cost of a request.
 * `uncachedInputTokens` are charged at 100% of input rate;
 * `cacheReadTokens` are charged at `CACHE_READ_COST_MULTIPLIER` (10%) of input rate;
 * `outputTokens` are charged at 100% of output rate.
 */
export function estimateRequestCostUsd(
    model: string,
    uncachedInputTokens: number,
    outputTokens: number,
    cacheReadTokens: number = 0
): number {
    const pricing = getModelPricing(model)
    const safeUncached = Math.max(0, uncachedInputTokens || 0)
    const safeCached = Math.max(0, cacheReadTokens || 0)
    const safeOutput = Math.max(0, outputTokens || 0)

    const effectiveInputTokens = safeUncached + safeCached * pricing.cacheMultiplier
    return (effectiveInputTokens / 1_000_000) * pricing.input + (safeOutput / 1_000_000) * pricing.output
}

/**
 * Compute cache-adjusted effective token load (normalized to uncached input token equivalents).
 * - Uncached input tokens: 1.0x
 * - Cached input tokens:   0.1x (CACHE_READ_COST_MULTIPLIER)
 * - Output tokens:         (pricing.output / pricing.input)x (typically 5x-8x)
 */
export function computeEffectiveTokenLoad(
    uncachedInputTokens: number,
    outputTokens: number,
    cacheReadTokens: number = 0,
    model: string = "claude"
): number {
    const pricing = getModelPricing(model)
    const outputWeight = pricing.output / pricing.input
    const safeUncached = Math.max(0, uncachedInputTokens || 0)
    const safeCached = Math.max(0, cacheReadTokens || 0)
    const safeOutput = Math.max(0, outputTokens || 0)
    return safeUncached + safeCached * pricing.cacheMultiplier + safeOutput * outputWeight
}

// Get today's date string (local timezone)
function getTodayString(): string {
    const now = new Date()
    const year = now.getFullYear()
    const month = String(now.getMonth() + 1).padStart(2, "0")
    const day = String(now.getDate()).padStart(2, "0")
    return `${year}-${month}-${day}`
}

/**
 * Record usage (fire-and-forget, non-blocking).
 * When `cacheReadTokens` is provided, `inputTokens` represents uncached input tokens
 * and `cacheReadTokens` represents prompt-cached tokens (discounted at 10% cost).
 */
export function recordUsage(
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens: number = 0
): void {
    const safeUncachedInput = Math.max(0, inputTokens || 0)
    const safeCachedInput = Math.max(0, cacheReadTokens || 0)
    const safeOutput = Math.max(0, outputTokens || 0)
    const totalInputTokens = safeUncachedInput + safeCachedInput

    if (!model || (totalInputTokens <= 0 && safeOutput <= 0)) return

    // Update model totals
    const existing = usageCache.models[model] || { input: 0, cachedInput: 0, output: 0 }
    usageCache.models[model] = {
        input: existing.input + totalInputTokens,
        cachedInput: (existing.cachedInput || 0) + safeCachedInput,
        output: existing.output + safeOutput,
    }

    // Calculate cache-aware cost for this request
    const requestCost = estimateRequestCostUsd(model, safeUncachedInput, safeOutput, safeCachedInput)

    // Update daily tracking
    const today = getTodayString()
    const dailyIndex = usageCache.daily.findIndex(d => d.date === today)
    if (dailyIndex >= 0) {
        usageCache.daily[dailyIndex].cost += requestCost
        usageCache.daily[dailyIndex].input += totalInputTokens
        usageCache.daily[dailyIndex].cachedInput = (usageCache.daily[dailyIndex].cachedInput || 0) + safeCachedInput
        usageCache.daily[dailyIndex].output += safeOutput
    } else {
        usageCache.daily.push({
            date: today,
            cost: requestCost,
            input: totalInputTokens,
            cachedInput: safeCachedInput,
            output: safeOutput,
        })
        // Keep only last 14 days
        if (usageCache.daily.length > 14) {
            usageCache.daily = usageCache.daily.slice(-14)
        }
    }

    scheduleSave()
}

// Calculate cost for a model (accounting for cached input discount)
function calculateCost(model: string, usage: ModelUsage): { inputCost: number; outputCost: number; total: number } {
    const pricing = getModelPricing(model)
    const cachedInput = Math.min(usage.input, Math.max(0, usage.cachedInput || 0))
    const uncachedInput = Math.max(0, usage.input - cachedInput)
    const effectiveInput = uncachedInput + cachedInput * pricing.cacheMultiplier

    const inputCost = (effectiveInput / 1_000_000) * pricing.input
    const outputCost = (usage.output / 1_000_000) * pricing.output
    return {
        inputCost: Math.round(inputCost * 100) / 100,
        outputCost: Math.round(outputCost * 100) / 100,
        total: Math.round((inputCost + outputCost) * 100) / 100,
    }
}

// Get usage statistics
export function getUsage(): {
    lastUpdated: string
    today: string
    models: Array<{
        model: string
        input: number
        cachedInput: number
        output: number
        inputCost: number
        outputCost: number
        cost: number
    }>
    totalCost: number
    daily: Array<{ date: string; cost: number; input: number; cachedInput: number; output: number }>
} {
    const models = Object.entries(usageCache.models).map(([model, usage]) => {
        const costs = calculateCost(model, usage)
        return {
            model,
            input: usage.input,
            cachedInput: usage.cachedInput || 0,
            output: usage.output,
            inputCost: costs.inputCost,
            outputCost: costs.outputCost,
            cost: costs.total,
        }
    })

    // Sort by cost descending
    models.sort((a, b) => b.cost - a.cost)

    const totalCost = models.reduce((sum, m) => sum + m.cost, 0)

    return {
        lastUpdated: usageCache.lastUpdated,
        today: getTodayString(),
        models,
        totalCost: Math.round(totalCost * 100) / 100,
        daily: usageCache.daily.map(d => ({
            date: d.date,
            cost: Math.round(d.cost * 100) / 100,
            input: Math.round(d.input || 0),
            cachedInput: Math.round(d.cachedInput || 0),
            output: Math.round(d.output || 0),
        })),
    }
}

// Reset all usage data
export function resetUsage(): void {
    usageCache = {
        lastUpdated: new Date().toISOString(),
        models: {},
        daily: [],
    }
    isDirty = true
    saveUsage()
}

// Initialize on module load
loadUsage()
