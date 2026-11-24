/**
 * Per-model token pricing pulled online from the Bifrost datasheet (LiteLLM-style JSON:
 * `model -> { input_cost_per_token, output_cost_per_token, cache_read_input_token_cost }`).
 *
 * The parsed subset is cached on disk (24h TTL) and refreshed in the background, so pricing never
 * blocks a request. When a model is unknown (or the datasheet is unreachable) callers fall back
 * to the coarse family table in usage-tracker.ts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { getDataDir } from "~/lib/data-dir"

export const PRICING_DATASHEET_URL = process.env.ANTI_API_PRICING_URL || "https://getbifrost.ai/datasheet"
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 20_000

/** USD per million tokens. */
export interface ModelPrice {
    input: number
    output: number
    cacheRead: number
}

interface PricingCacheFile {
    fetchedAt: number
    prices: Record<string, ModelPrice>
}

let index = new Map<string, ModelPrice>()
let fetchedAt = 0
let loadedFromDisk = false
let refreshInFlight: Promise<boolean> | null = null

export function normalizePricingKey(id: string): string {
    return id.trim().toLowerCase().replace(/[._]/g, "-").replace(/-+/g, "-")
}

function cacheFilePath(): string {
    return join(getDataDir(), "model-pricing.json")
}

/** Builds the lookup index from the raw datasheet, preferring first-party (bare / `gemini/`) entries. */
export function buildPricingIndex(raw: Record<string, any>): Record<string, ModelPrice> {
    const primary: Record<string, ModelPrice> = {}
    const secondary: Record<string, ModelPrice> = {}

    for (const [key, entry] of Object.entries(raw || {})) {
        if (!entry || typeof entry !== "object") continue
        if (entry.mode && entry.mode !== "chat" && entry.mode !== "responses") continue
        const input = Number(entry.input_cost_per_token) * 1e6
        const output = Number(entry.output_cost_per_token) * 1e6
        if (!Number.isFinite(input) || !Number.isFinite(output) || input <= 0 || output <= 0) continue
        const cache = Number(entry.cache_read_input_token_cost) * 1e6
        const price: ModelPrice = {
            input,
            output,
            cacheRead: Number.isFinite(cache) && cache > 0 ? cache : input * 0.1,
        }

        const slash = key.indexOf("/")
        if (slash === -1) {
            const k = normalizePricingKey(key)
            if (!(k in primary)) primary[k] = price
        } else if (key.startsWith("gemini/")) {
            const k = normalizePricingKey(key.slice(slash + 1))
            if (!(k in primary)) primary[k] = price
        } else {
            const k = normalizePricingKey(key.slice(key.lastIndexOf("/") + 1))
            if (!(k in secondary)) secondary[k] = price
        }
    }

    return { ...secondary, ...primary }
}

function setIndex(prices: Record<string, ModelPrice>, at: number): void {
    index = new Map(Object.entries(prices))
    fetchedAt = at
}

function loadFromDisk(): void {
    if (loadedFromDisk) return
    loadedFromDisk = true
    try {
        const file = cacheFilePath()
        if (!existsSync(file)) return
        const data = JSON.parse(readFileSync(file, "utf-8")) as PricingCacheFile
        if (data && typeof data.fetchedAt === "number" && data.prices && typeof data.prices === "object") {
            setIndex(data.prices, data.fetchedAt)
        }
    } catch {
        // best effort
    }
}

export interface PricingStatus {
    source: string
    models: number
    fetchedAt: string | null
}

export function getPricingStatus(): PricingStatus {
    if (process.env.NODE_ENV !== "test") loadFromDisk()
    return {
        source: PRICING_DATASHEET_URL,
        models: index.size,
        fetchedAt: fetchedAt ? new Date(fetchedAt).toISOString() : null,
    }
}

/** Refreshes the datasheet (deduplicated). Resolves true on success, false otherwise; never throws. */
export function refreshModelPricing(): Promise<boolean> {
    if (refreshInFlight) return refreshInFlight
    refreshInFlight = (async () => {
        try {
            const response = await fetch(PRICING_DATASHEET_URL, {
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
                headers: { Accept: "application/json" },
            })
            if (!response.ok) return false
            const prices = buildPricingIndex(await response.json() as Record<string, any>)
            if (Object.keys(prices).length === 0) return false
            const now = Date.now()
            setIndex(prices, now)
            try {
                const dir = getDataDir()
                if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
                writeFileSync(cacheFilePath(), JSON.stringify({ fetchedAt: now, prices } satisfies PricingCacheFile))
            } catch {
                // best effort
            }
            return true
        } catch {
            // offline / blocked: keep whatever we have
            return false
        } finally {
            refreshInFlight = null
        }
    })()
    return refreshInFlight
}

const VARIANT_SUFFIX = /-(low|medium|high|thinking|minimal|xhigh|max|none|tiered|agent)$/

/** Tests/offline use: inject prices without touching disk or network. */
export function setModelPricingForTests(prices: Record<string, ModelPrice> | null): void {
    loadedFromDisk = true
    if (prices) setIndex(prices, Date.now())
    else {
        index = new Map()
        fetchedAt = 0
    }
}

/** Returns the datasheet price for a model, or undefined when unknown. Triggers a background refresh when stale. */
export function lookupModelPrice(model: string): ModelPrice | undefined {
    if (process.env.NODE_ENV !== "test") {
        loadFromDisk()
        if (Date.now() - fetchedAt > CACHE_TTL_MS) void refreshModelPricing()
    }
    if (index.size === 0) return undefined

    let key = normalizePricingKey(model || "")
    for (let i = 0; i < 3 && key; i++) {
        const hit = index.get(key) ?? index.get(`${key}-preview`) ?? index.get(`${key}-latest`)
        if (hit) return hit
        const stripped = key.replace(VARIANT_SUFFIX, "")
        if (stripped === key) break
        key = stripped
    }
    return undefined
}
