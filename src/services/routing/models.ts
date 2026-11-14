import { buildCatalog, getAntigravityCatalog, setDiscoveredAntigravityModelIds } from "~/lib/model-catalog"
import { isSeparateThinkingModelsEnabled, isHiddenCodexModel, CODEX_HIDDEN_MODELS } from "./config"
import type { AuthProvider } from "~/services/auth/types"

export { isHiddenCodexModel }

let modelSyncHook: (() => Promise<void>) | null = null

/** Registered by the routing route: pulls every provider's real model list online. */
export function setModelSyncHook(hook: (() => Promise<void>) | null): void {
    modelSyncHook = hook
}

export async function ensureProviderModelsSynced(): Promise<void> {
    try {
        await modelSyncHook?.()
    } catch {
        // best effort: routing falls back to whatever was discovered last
    }
}

export interface ProviderModelOption {
    id: string
    label: string
    maxInputTokens?: number
    maxOutputTokens?: number
}

// No hardcoded model lists: every provider's models are discovered online per account (see syncProviderModels).
// Kiro is the only exception left: it has no listing API, so listKiroModelsForAccount (services/kiro/chat.ts) returns a fixed list.

export function isInternalAntigravityModel(id: string): boolean {
    const lower = id.toLowerCase()
    return lower.startsWith("tab_") ||
        lower.startsWith("chat_") ||
        lower.includes("tiered") ||
        lower.includes("extra-low") ||
        lower.endsWith("-disabled")
}

interface ProviderModelStore {
    global: ProviderModelOption[]
    byAccount: Map<string, ProviderModelOption[]>
}

interface ProviderModelSpec {
    prefix: string
    getStaticModels: () => ProviderModelOption[]
    filter?: (model: ProviderModelOption) => boolean
    dynamicReplacesStatic?: boolean
    onUpdate?: () => void
}

const stores = new Map<AuthProvider, ProviderModelStore>()

function getStore(provider: AuthProvider): ProviderModelStore {
    let store = stores.get(provider)
    if (!store) {
        store = { global: [], byAccount: new Map() }
        stores.set(provider, store)
    }
    return store
}

function sanitizeModelOptions(
    models: ProviderModelOption[],
    prefix: string,
    filter?: (model: ProviderModelOption) => boolean
): ProviderModelOption[] {
    const deduped = new Map<string, ProviderModelOption>()

    for (const model of models || []) {
        const id = model?.id?.trim()
        if (!id || deduped.has(id)) continue

        const entry: ProviderModelOption = { id, label: model?.label?.trim() || `${prefix} - ${id}` }
        if (typeof model?.maxInputTokens === "number" && Number.isFinite(model.maxInputTokens) && model.maxInputTokens > 0) {
            entry.maxInputTokens = Math.floor(model.maxInputTokens)
        }
        if (typeof model?.maxOutputTokens === "number" && Number.isFinite(model.maxOutputTokens) && model.maxOutputTokens > 0) {
            entry.maxOutputTokens = Math.floor(model.maxOutputTokens)
        }
        if (filter && !filter(entry)) continue
        deduped.set(id, entry)
    }

    return Array.from(deduped.values())
}

function mergeModelOptions(...groups: ProviderModelOption[][]): ProviderModelOption[] {
    const merged = new Map<string, ProviderModelOption>()
    for (const group of groups) {
        for (const model of group) {
            if (!merged.has(model.id)) {
                merged.set(model.id, model)
            }
        }
    }
    return Array.from(merged.values())
}

function flattenDynamicModelsByAccount(bucket: Map<string, ProviderModelOption[]>): ProviderModelOption[] {
    return Array.from(bucket.values()).flat()
}

/** Feeds every discovered Antigravity model ID to the catalog, which resolves family/base aliases to the newest native ID. */
function syncAntigravityCatalog(): void {
    const store = getStore("antigravity")
    const discovered = mergeModelOptions(
        flattenDynamicModelsByAccount(store.byAccount),
        store.global
    )
    setDiscoveredAntigravityModelIds(discovered.map(m => m.id))
}

const PROVIDER_SPECS: Record<AuthProvider, ProviderModelSpec> = {
    antigravity: {
        prefix: "Antigravity",
        getStaticModels: () => [],
        filter: model => !isInternalAntigravityModel(model.id),
        onUpdate: syncAntigravityCatalog,
    },
    codex: {
        prefix: "Codex",
        getStaticModels: () => [],
        filter: model => !CODEX_HIDDEN_MODELS.has(model.id),
        dynamicReplacesStatic: true,
    },
    copilot: {
        prefix: "Copilot",
        getStaticModels: () => [],
        dynamicReplacesStatic: true,
    },
    zed: {
        prefix: "Zed",
        getStaticModels: () => [],
    },
    kiro: {
        prefix: "Kiro",
        getStaticModels: () => [],
    },
    grok: {
        prefix: "Grok",
        getStaticModels: () => [],
    },
}

export function setDynamicProviderModels(provider: AuthProvider, models: ProviderModelOption[]): void {
    const spec = PROVIDER_SPECS[provider]
    const store = getStore(provider)
    store.global = sanitizeModelOptions(models, spec.prefix, spec.filter)
    spec.onUpdate?.()
}

export function clearDynamicProviderModels(provider: AuthProvider): void {
    const spec = PROVIDER_SPECS[provider]
    const store = getStore(provider)
    store.global = []
    store.byAccount.clear()
    spec.onUpdate?.()
}

export function setDynamicProviderModelsForAccount(provider: AuthProvider, accountId: string, models: ProviderModelOption[]): void {
    const id = accountId?.trim()
    if (!id) return
    const spec = PROVIDER_SPECS[provider]
    const store = getStore(provider)
    store.byAccount.set(id, sanitizeModelOptions(models, spec.prefix, spec.filter))
    spec.onUpdate?.()
}

export function clearDynamicProviderModelsForAccount(provider: AuthProvider, accountId: string): void {
    const spec = PROVIDER_SPECS[provider]
    getStore(provider).byAccount.delete(accountId)
    spec.onUpdate?.()
}

export function clearAllDynamicProviderModelsByAccount(provider: AuthProvider): void {
    const spec = PROVIDER_SPECS[provider]
    getStore(provider).byAccount.clear()
    spec.onUpdate?.()
}

export function getDynamicAntigravityModelIdsForAccount(accountId: string): string[] | undefined {
    const models = getStore("antigravity").byAccount.get(accountId)
    return models && models.length > 0 ? models.map(m => m.id) : undefined
}

function getCatalogAntigravityModels(): ProviderModelOption[] {
    const catalog = getAntigravityCatalog()
    return [...catalog.base, ...catalog.variants].map(m => ({ id: m.id, label: m.name }))
}

/** True for explicit effort/thinking variants such as `-xhigh`, `-high`, `-low`, `-medium` and `-thinking`. */
export function isVariantModelId(id: string): boolean {
    return /-(xhigh|high|low|medium|thinking)$/.test(id)
}

/** Every known Antigravity model (catalog + discovered + static), with no per-family filtering. */
export function getAllAntigravityModels(): ProviderModelOption[] {
    const store = getStore("antigravity")
    const dynamic = mergeModelOptions(flattenDynamicModelsByAccount(store.byAccount), store.global)
    return mergeModelOptions(getCatalogAntigravityModels(), dynamic)
}

export const setDynamicCopilotModels = (models: ProviderModelOption[]) => setDynamicProviderModels("copilot", models)
export const clearDynamicCopilotModels = () => clearDynamicProviderModels("copilot")
export const setDynamicCopilotModelsForAccount = (accountId: string, models: ProviderModelOption[]) => setDynamicProviderModelsForAccount("copilot", accountId, models)
export const clearDynamicCopilotModelsForAccount = (accountId: string) => clearDynamicProviderModelsForAccount("copilot", accountId)
export const clearAllDynamicCopilotModelsByAccount = () => clearAllDynamicProviderModelsByAccount("copilot")

export const setDynamicCodexModels = (models: ProviderModelOption[]) => setDynamicProviderModels("codex", models)
export const clearDynamicCodexModels = () => clearDynamicProviderModels("codex")
export const setDynamicCodexModelsForAccount = (accountId: string, models: ProviderModelOption[]) => setDynamicProviderModelsForAccount("codex", accountId, models)
export const clearDynamicCodexModelsForAccount = (accountId: string) => clearDynamicProviderModelsForAccount("codex", accountId)
export const clearAllDynamicCodexModelsByAccount = () => clearAllDynamicProviderModelsByAccount("codex")

export const setDynamicAntigravityModels = (models: ProviderModelOption[]) => setDynamicProviderModels("antigravity", models)
export const clearDynamicAntigravityModels = () => clearDynamicProviderModels("antigravity")
export const setDynamicAntigravityModelsForAccount = (accountId: string, models: ProviderModelOption[]) => setDynamicProviderModelsForAccount("antigravity", accountId, models)
export const clearDynamicAntigravityModelsForAccount = (accountId: string) => clearDynamicProviderModelsForAccount("antigravity", accountId)
export const clearAllDynamicAntigravityModelsByAccount = () => clearAllDynamicProviderModelsByAccount("antigravity")

export const setDynamicZedModels = (models: ProviderModelOption[]) => setDynamicProviderModels("zed", models)
export const clearDynamicZedModels = () => clearDynamicProviderModels("zed")
export const setDynamicZedModelsForAccount = (accountId: string, models: ProviderModelOption[]) => setDynamicProviderModelsForAccount("zed", accountId, models)
export const clearDynamicZedModelsForAccount = (accountId: string) => clearDynamicProviderModelsForAccount("zed", accountId)
export const clearAllDynamicZedModelsByAccount = () => clearAllDynamicProviderModelsByAccount("zed")

export const setDynamicKiroModels = (models: ProviderModelOption[]) => setDynamicProviderModels("kiro", models)
export const clearDynamicKiroModels = () => clearDynamicProviderModels("kiro")
export const setDynamicKiroModelsForAccount = (accountId: string, models: ProviderModelOption[]) => setDynamicProviderModelsForAccount("kiro", accountId, models)
export const clearDynamicKiroModelsForAccount = (accountId: string) => clearDynamicProviderModelsForAccount("kiro", accountId)
export const clearAllDynamicKiroModelsByAccount = () => clearAllDynamicProviderModelsByAccount("kiro")

export const setDynamicGrokModels = (models: ProviderModelOption[]) => setDynamicProviderModels("grok", models)
export const clearDynamicGrokModels = () => clearDynamicProviderModels("grok")
export const setDynamicGrokModelsForAccount = (accountId: string, models: ProviderModelOption[]) => setDynamicProviderModelsForAccount("grok", accountId, models)
export const clearDynamicGrokModelsForAccount = (accountId: string) => clearDynamicProviderModelsForAccount("grok", accountId)
export const clearAllDynamicGrokModelsByAccount = () => clearAllDynamicProviderModelsByAccount("grok")

export function getProviderModels(
    provider: AuthProvider,
    options?: { includeAllVariants?: boolean }
): ProviderModelOption[] {
    if (provider === "antigravity") {
        const all = getAllAntigravityModels()
        const separateThinking = options?.includeAllVariants ?? isSeparateThinkingModelsEnabled()
        return separateThinking ? all : all.filter(m => !isVariantModelId(m.id))
    }

    const spec = PROVIDER_SPECS[provider]
    if (!spec) return []

    const store = getStore(provider)
    const mergedDynamic = mergeModelOptions(
        flattenDynamicModelsByAccount(store.byAccount),
        store.global
    )

    const separateThinking = options?.includeAllVariants ?? isSeparateThinkingModelsEnabled()
    const baseList = spec.dynamicReplacesStatic
        ? (mergedDynamic.length > 0 ? mergedDynamic : spec.getStaticModels())
        : mergeModelOptions(mergedDynamic, spec.getStaticModels())

    return separateThinking ? baseList : baseList.filter(m => !isVariantModelId(m.id))
}

export function getProviderModelsForAccount(provider: AuthProvider, accountId: string): ProviderModelOption[] {
    const spec = PROVIDER_SPECS[provider]
    if (!spec) return []

    const dynamic = getStore(provider).byAccount.get(accountId)
    if (provider === "antigravity") {
        if (dynamic && dynamic.length > 0) {
            const dynamicIds = dynamic.map(m => m.id)
            const accountCatalog = buildCatalog(dynamicIds)
            const separateThinking = isSeparateThinkingModelsEnabled()
            const catalogModels = (separateThinking
                ? [...accountCatalog.base, ...accountCatalog.variants]
                : accountCatalog.base
            ).map(m => ({ id: m.id, label: m.name }))

            const knownIds = new Set(catalogModels.map(m => m.id))
            const leftovers = dynamic.filter(m => !knownIds.has(m.id) && (separateThinking || !isVariantModelId(m.id)))
            return [...catalogModels, ...leftovers]
        }
        return getProviderModels(provider)
    }

    if (dynamic && dynamic.length > 0) {
        return spec.dynamicReplacesStatic ? dynamic : mergeModelOptions(dynamic, spec.getStaticModels())
    }
    return getProviderModels(provider)
}
