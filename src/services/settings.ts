/**
 * Server-side Settings Service
 * Stores user preferences in a JSON file
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "fs"
import { join } from "path"
import { ensureDataDir, getDataDir } from "~/lib/data-dir"

const SETTINGS_DIR = getDataDir()
const SETTINGS_FILE = join(SETTINGS_DIR, "settings.json")

export interface AppSettings {
    language: "en" | "zh-CN" | "it"
    preloadRouting: boolean
    autoNgrok: boolean
    autoOpenDashboard: boolean
    autoRefresh: boolean
    autoRestart: boolean
    privacyMode: boolean
    compactLayout: boolean
    trackUsage: boolean
    optimizeQuotaSort: boolean
    captureLogs: boolean
    // API & Model filter settings
    onlyActiveProviders: boolean
    separateThinkingModels: boolean
    disabledModels: string[]
    cacheAwareRouting: boolean
}

const DEFAULT_SETTINGS: AppSettings = {
    language: detectSystemLanguage(),
    preloadRouting: true,
    autoNgrok: false,
    autoOpenDashboard: true,
    autoRefresh: true,
    autoRestart: false,
    privacyMode: false,
    compactLayout: false,
    trackUsage: true,
    optimizeQuotaSort: false,
    captureLogs: false,
    onlyActiveProviders: true,
    separateThinkingModels: false,
    disabledModels: [],
    cacheAwareRouting: false,
}

function detectSystemLanguage(): "en" | "zh-CN" | "it" {
    const locale = [
        process.env.LC_ALL,
        process.env.LC_MESSAGES,
        process.env.LANG,
        process.env.LANGUAGE,
    ].filter(Boolean).join(" ").toLowerCase()
    if (locale.includes("it")) return "it"
    if (locale.includes("zh")) return "zh-CN"
    return "en"
}

function ensureSettingsDir(): void {
    ensureDataDir()
    mkdirSync(SETTINGS_DIR, { recursive: true })
}

export function loadSettings(): AppSettings {
    try {
        ensureSettingsDir()
        if (existsSync(SETTINGS_FILE)) {
            const data = readFileSync(SETTINGS_FILE, "utf-8")
            return { ...DEFAULT_SETTINGS, ...JSON.parse(data) }
        }
    } catch (error) {
        // Ignore errors, return defaults
    }
    return { ...DEFAULT_SETTINGS }
}

export function saveSettings(settings: Partial<AppSettings>): AppSettings {
    ensureSettingsDir()
    const current = loadSettings()
    const updated = { ...current, ...settings }
    const payload = JSON.stringify(updated, null, 2)
    const tmpFile = `${SETTINGS_FILE}.tmp`
    writeFileSync(tmpFile, payload, "utf-8")
    try {
        renameSync(tmpFile, SETTINGS_FILE)
    } catch {
        try {
            rmSync(SETTINGS_FILE, { force: true })
        } catch {
            // Ignore cleanup failures, rename will throw if it still can't proceed.
        }
        renameSync(tmpFile, SETTINGS_FILE)
    }
    return updated
}

export function getSetting<K extends keyof AppSettings>(key: K): AppSettings[K] {
    return loadSettings()[key]
}

export function isCacheAwareRoutingEnabled(): boolean {
    if (
        process.env.ANTI_API_CACHE_AWARE_ROUTING === "1" ||
        process.env.ANTI_API_INTELLIGENT_ROUTING === "1" ||
        process.env.ANTI_API_ACCOUNT_STRATEGY === "cache_aware" ||
        process.env.ANTI_API_ACCOUNT_STRATEGY === "intelligent"
    ) {
        return true
    }
    return loadSettings().cacheAwareRouting ?? false
}

export function isIntelligentRoutingEnabled(): boolean {
    return isCacheAwareRoutingEnabled()
}
