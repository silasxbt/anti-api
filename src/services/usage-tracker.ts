import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import consola from "consola"
import { getDataDir } from "~/lib/data-dir"
import { safeErrorMessage } from "~/lib/redaction"

const USAGE_DIR = getDataDir()
const USAGE_FILE = join(USAGE_DIR, "usage.json")

// Pricing per million tokens (USD)
const PRICING = {
    gpt: { input: 1.75, output: 14.0 },
    claude: { input: 5.0, output: 25.0 },
    gemini: { input: 2.0, output: 12.0 },
} as const

interface ModelUsage {
    input: number
    output: number
}

interface DailyUsage {
    date: string  // YYYY-MM-DD
    cost: number
    input: number
    output: number
}

interface UsageData {
    lastUpdated: string
    models: Record<string, ModelUsage>
    daily: DailyUsage[]  // Last 7 days
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
            usageCache = {
                lastUpdated: data.lastUpdated || new Date().toISOString(),
                models: data.models || {},
                daily: Array.isArray(data.daily) ? data.daily.map((entry: any) => ({
                    date: entry?.date || getTodayString(),
                    cost: typeof entry?.cost === "number" ? entry.cost : 0,
                    input: typeof entry?.input === "number" ? entry.input : 0,
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

// Detect provider from model name
function detectProvider(model: string): "gpt" | "claude" | "gemini" {
    const m = model.toLowerCase()
    if (m.includes("gpt") || m.includes("o1") || m.includes("o3") || m.includes("o4")) return "gpt"
    if (m.includes("claude") || m.includes("opus") || m.includes("sonnet")) return "claude"
    if (m.includes("gemini") || m.includes("flash") || m.includes("pro")) return "gemini"
    // Default to claude for antigravity models
    return "claude"
}

// Get today's date string (local timezone)
function getTodayString(): string {
    const now = new Date()
    const year = now.getFullYear()
    const month = String(now.getMonth() + 1).padStart(2, "0")
    const day = String(now.getDate()).padStart(2, "0")
    return `${year}-${month}-${day}`
}

// Record usage (fire-and-forget, non-blocking)
export function recordUsage(model: string, inputTokens: number, outputTokens: number): void {
    if (!model || (inputTokens <= 0 && outputTokens <= 0)) return

    // Update model totals
    const existing = usageCache.models[model] || { input: 0, output: 0 }
    usageCache.models[model] = {
        input: existing.input + inputTokens,
        output: existing.output + outputTokens,
    }

    // Calculate cost for this request
    const provider = detectProvider(model)
    const pricing = PRICING[provider]
    const requestCost = (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output

    // Update daily tracking
    const today = getTodayString()
    const dailyIndex = usageCache.daily.findIndex(d => d.date === today)
    if (dailyIndex >= 0) {
        usageCache.daily[dailyIndex].cost += requestCost
        usageCache.daily[dailyIndex].input += inputTokens
        usageCache.daily[dailyIndex].output += outputTokens
    } else {
        usageCache.daily.push({
            date: today,
            cost: requestCost,
            input: inputTokens,
            output: outputTokens,
        })
        // Keep only last 14 days
        if (usageCache.daily.length > 14) {
            usageCache.daily = usageCache.daily.slice(-14)
        }
    }

    scheduleSave()
}

// Calculate cost for a model
function calculateCost(model: string, usage: ModelUsage): { inputCost: number; outputCost: number; total: number } {
    const provider = detectProvider(model)
    const pricing = PRICING[provider]
    const inputCost = (usage.input / 1_000_000) * pricing.input
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
        output: number
        inputCost: number
        outputCost: number
        cost: number
    }>
    totalCost: number
    daily: Array<{ date: string; cost: number; input: number; output: number }>
} {
    const models = Object.entries(usageCache.models).map(([model, usage]) => {
        const costs = calculateCost(model, usage)
        return {
            model,
            input: usage.input,
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
