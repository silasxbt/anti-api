import { Hono } from "hono"
import consola from "consola"
import { authStore } from "~/services/auth/store"
import { listCopilotModelsForAccount, getCopilotReasoningEfforts, type CopilotModelInfo } from "~/services/copilot/chat"
import { listCodexModelsForAccount } from "~/services/codex/chat"
import { fetchAntigravityModels } from "~/services/antigravity/quota-fetch"
import { listZedModelsForAccount } from "~/services/zed/chat"
import { listKiroModelsForAccount } from "~/services/kiro/chat"
import { listGrokModelsForAccount } from "~/services/grok/chat"
import {
    clearAllDynamicProviderModelsByAccount,
    clearDynamicProviderModels,
    clearDynamicProviderModelsForAccount,
    getProviderModels,
    getProviderModelsForAccount,
    setDynamicProviderModels,
    setModelSyncHook,
    setDynamicProviderModelsForAccount,
    type ProviderModelOption,
} from "~/services/routing/models"
import { loadRoutingConfig, saveRoutingConfig, setActiveFlow, type RoutingEntry, type RoutingFlow, type AccountRoutingConfig } from "~/services/routing/config"
import { accountManager } from "~/services/antigravity/account-manager"
import { getAggregatedQuota } from "~/services/quota-aggregator"
import { readFileSync } from "fs"
import { join } from "path"
import { randomUUID } from "crypto"
import { AUTH_PROVIDERS, type AuthProvider, type ProviderAccount, type ProviderAccountSummary } from "~/services/auth/types"
import { getPublicDir } from "~/lib/public-dir"

export const routingRouter = new Hono()

const SYNC_TTL_MS = 60_000
const SYNC_TIMEOUT_MS = 800
const PER_ACCOUNT_SYNC_TIMEOUT_MS = 10_000
const MAX_SYNC_FLIGHT_MS = 20_000
const QUOTA_TIMEOUT_MS = 1200
const QUOTA_TTL_MS = 15_000

interface ProviderSyncState {
    lastSyncAt: number
    inFlight: Promise<void> | null
    inFlightStartedAt: number
}

const syncStates = new Map<AuthProvider, ProviderSyncState>()

function getSyncState(provider: AuthProvider): ProviderSyncState {
    let state = syncStates.get(provider)
    if (!state) {
        state = { lastSyncAt: 0, inFlight: null, inFlightStartedAt: 0 }
        syncStates.set(provider, state)
    }
    return state
}

let lastQuotaSnapshot: Awaited<ReturnType<typeof getAggregatedQuota>> | null = null
let lastQuotaAt = 0
let quotaInFlight: Promise<Awaited<ReturnType<typeof getAggregatedQuota>> | null> | null = null

async function settleWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<{ ok: boolean; value?: T; error?: Error; timedOut?: boolean }> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    const timeoutPromise = new Promise<{ ok: boolean; error: Error; timedOut: boolean }>((resolve) => {
        timeoutId = setTimeout(() => resolve({ ok: false, error: new Error("timeout"), timedOut: true }), timeoutMs)
    })
    const result = await Promise.race([
        promise
            .then(value => ({ ok: true, value }))
            .catch(error => ({ ok: false, error: error instanceof Error ? error : new Error(String(error)) })),
        timeoutPromise,
    ])
    if (timeoutId) clearTimeout(timeoutId)
    return result as { ok: boolean; value?: T; error?: Error; timedOut?: boolean }
}

function resolveAccountLabel(provider: AuthProvider, accountId: string, fallback?: string): string {
    if (accountId === "auto") return "auto"
    const account = authStore.getAccount(provider, accountId)
    return account?.label || account?.email || account?.login || fallback || accountId
}

function syncFlowLabels(flows: RoutingFlow[]): RoutingFlow[] {
    return flows.map(flow => ({
        ...flow,
        entries: flow.entries.map(entry => ({
            ...entry,
            accountLabel: resolveAccountLabel(entry.provider, entry.accountId, entry.accountLabel),
        })),
    }))
}

function syncAccountRoutingLabels(accountRouting?: AccountRoutingConfig): AccountRoutingConfig | undefined {
    if (!accountRouting) return accountRouting
    return {
        ...accountRouting,
        routes: accountRouting.routes.map(route => ({
            ...route,
            entries: route.entries.map(entry => ({
                ...entry,
                accountLabel: resolveAccountLabel(entry.provider, entry.accountId, entry.accountLabel),
            })),
        })),
    }
}

function listAccountsInOrder(provider: AuthProvider): ProviderAccount[] {
    let accounts: ProviderAccount[] = []
    try {
        accounts = authStore.listAccounts(provider) || []
    } catch {
        accounts = []
    }
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

function toSummary(account: ProviderAccount): ProviderAccountSummary {
    return {
        id: account.id,
        provider: account.provider,
        displayName: account.label || account.email || account.login || account.id,
        email: account.email,
        login: account.login,
        label: account.label,
        expiresAt: account.expiresAt,
    }
}

function normalizeRemoteModels(prefix: string, models: Array<{ id?: string; name?: string }>): ProviderModelOption[] {
    const merged = new Map<string, ProviderModelOption>()
    for (const model of models) {
        const id = model.id?.trim()
        if (!id || merged.has(id)) continue
        merged.set(id, { id, label: `${prefix} - ${model.name?.trim() || id}` })
    }
    return Array.from(merged.values())
}

function triggerProviderSync(
    provider: AuthProvider,
    displayName: string,
    accounts: ProviderAccount[],
    now: number,
    fetchModelsForAccount: (account: ProviderAccount) => Promise<ProviderModelOption[]>,
    perAccountTimeoutMs: number = PER_ACCOUNT_SYNC_TIMEOUT_MS
): Promise<void> | null {
    const state = getSyncState(provider)
    if (accounts.length === 0) {
        clearDynamicProviderModels(provider)
        clearAllDynamicProviderModelsByAccount(provider)
        state.lastSyncAt = 0
        return state.inFlight
    }

    if (state.inFlight && now - state.inFlightStartedAt > MAX_SYNC_FLIGHT_MS) {
        consola.warn(`[routing] ${displayName} sync exceeded ${MAX_SYNC_FLIGHT_MS}ms; resetting stuck in-flight state`)
        state.inFlight = null
        state.inFlightStartedAt = 0
    }

    if (now - state.lastSyncAt > SYNC_TTL_MS && !state.inFlight) {
        state.lastSyncAt = now
        state.inFlightStartedAt = now
        let currentFlight: Promise<void>
        currentFlight = (async () => {
            const mergedModels = new Map<string, ProviderModelOption>()
            try {
                for (const account of accounts) {
                    const outcome = await settleWithTimeout(
                        fetchModelsForAccount(account),
                        perAccountTimeoutMs
                    )
                    if (!outcome.ok) {
                        const message = outcome.timedOut
                            ? `timeout after ${perAccountTimeoutMs}ms`
                            : (outcome.error?.message || "sync failed")
                        clearDynamicProviderModelsForAccount(provider, account.id)
                        consola.debug(`[routing] ${displayName} models sync skipped ${account.id}: ${message}`)
                        continue
                    }
                    const dynamicModels = outcome.value || []
                    if (dynamicModels.length === 0) {
                        clearDynamicProviderModelsForAccount(provider, account.id)
                        continue
                    }
                    setDynamicProviderModelsForAccount(provider, account.id, dynamicModels)
                    for (const model of dynamicModels) {
                        if (!mergedModels.has(model.id)) mergedModels.set(model.id, model)
                    }
                    consola.debug(`[routing] ${displayName} models synced (${dynamicModels.length}) from ${account.id}`)
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                consola.warn(`[routing] ${displayName} models sync failed: ${message}`)
            } finally {
                if (mergedModels.size > 0) {
                    setDynamicProviderModels(provider, Array.from(mergedModels.values()))
                } else {
                    clearDynamicProviderModels(provider)
                    consola.debug(`[routing] ${displayName} models sync unavailable; using static fallback`)
                }
                if (state.inFlight === currentFlight) {
                    state.inFlight = null
                    state.inFlightStartedAt = 0
                }
            }
        })()
        state.inFlight = currentFlight
    }

    return state.inFlight
}

/** Copilot models as the account really has them, plus per-effort variants when the model advertises reasoning effort. */
function copilotModelOptions(remote: CopilotModelInfo[]): ProviderModelOption[] {
    const options: ProviderModelOption[] = []
    for (const model of remote) {
        const name = model.name?.trim() || model.id
        options.push({ id: model.id, label: `Copilot - ${name}` })
        const efforts = getCopilotReasoningEfforts(model).filter(e => e === "low" || e === "medium" || e === "high")
        for (const effort of efforts) {
            options.push({ id: `${model.id}-${effort}`, label: `Copilot - ${name} (${effort})` })
        }
        if (model.id === "copilot-auto" || (efforts.includes("high") && !options.some(o => o.id === `${model.id}-thinking`))) {
            options.push({ id: `${model.id}-thinking`, label: `Copilot - ${name} (thinking)` })
        }
    }
    return options
}

/**
 * Refreshes the online model list of every provider with accounts (TTL-throttled).
 * Used by the routing panel and by /v1/models so exposed models match what each account really has.
 */
export async function syncProviderModels(
    now: number = Date.now(),
    timeoutMs: number = SYNC_TIMEOUT_MS,
    perAccountTimeoutMs: number = PER_ACCOUNT_SYNC_TIMEOUT_MS
): Promise<void> {
    accountManager.load()
    const antigravityAccounts = listAccountsInOrder("antigravity")
    const codexAccounts = listAccountsInOrder("codex")
    const copilotAccounts = listAccountsInOrder("copilot")
    const zedAccounts = listAccountsInOrder("zed")
    const kiroAccounts = listAccountsInOrder("kiro")
    const grokAccounts = listAccountsInOrder("grok")

    const activeSyncs = [
        triggerProviderSync("grok", "Grok", grokAccounts, now, async (account) => {
            const remote = await listGrokModelsForAccount(account)
            return normalizeRemoteModels("Grok", remote.map(m => ({ id: m.id, name: (m as { name?: string }).name })))
        }, perAccountTimeoutMs),
        triggerProviderSync("copilot", "Copilot", copilotAccounts, now, async (account) => {
            const remote = await listCopilotModelsForAccount(account)
            return copilotModelOptions(remote)
        }, perAccountTimeoutMs),
        triggerProviderSync("codex", "Codex", codexAccounts, now, (account) => listCodexModelsForAccount(account), perAccountTimeoutMs),
        triggerProviderSync("antigravity", "Antigravity", antigravityAccounts, now, async (account) => {
            const active = await accountManager.getAccountById(account.id)
            if (!active) return []
            const remote = await fetchAntigravityModels(active.accessToken, active.projectId, active.proxy)
            return Object.entries(remote.models || {}).map(([id, info]) => ({
                id,
                label: `Antigravity - ${id}`,
                ...(typeof info.maxTokens === "number" && info.maxTokens > 0 ? { maxInputTokens: info.maxTokens } : {}),
                ...(typeof info.maxOutputTokens === "number" && info.maxOutputTokens > 0 ? { maxOutputTokens: info.maxOutputTokens } : {}),
            }))
        }, perAccountTimeoutMs),
        triggerProviderSync("zed", "Zed", zedAccounts, now, async (account) => {
            const remote = await listZedModelsForAccount(account)
            return normalizeRemoteModels("Zed", remote.map(model => ({
                id: model.id,
                name: model.display_name || model.id,
            })))
        }, perAccountTimeoutMs),
        triggerProviderSync("kiro", "Kiro", kiroAccounts, now, async (account) => {
            const remote = await listKiroModelsForAccount(account)
            return normalizeRemoteModels("Kiro", remote)
        }, perAccountTimeoutMs),
    ].filter((p): p is Promise<void> => p !== null)

    if (activeSyncs.length > 0) {
        await Promise.all(activeSyncs.map(p => settleWithTimeout(p, timeoutMs)))
    }
}
// Lets the router sync models on demand (e.g. first request right after startup)
setModelSyncHook(() => syncProviderModels(Date.now(), 4000))

routingRouter.get("/", (c) => {
    try {
        const htmlPath = join(getPublicDir(import.meta.dir, "../../../public"), "routing.html")
        const html = readFileSync(htmlPath, "utf-8")
        return c.html(html)
    } catch {
        return c.text("Routing panel not found", 404)
    }
})

routingRouter.get("/config", async (c) => {
    accountManager.load()
    const config = loadRoutingConfig()
    const syncedConfig = {
        ...config,
        flows: syncFlowLabels(config.flows),
        accountRouting: syncAccountRoutingLabels(config.accountRouting),
    }

    const antigravityAccounts = listAccountsInOrder("antigravity")
    const codexAccounts = listAccountsInOrder("codex")
    const copilotAccounts = listAccountsInOrder("copilot")
    const zedAccounts = listAccountsInOrder("zed")
    const kiroAccounts = listAccountsInOrder("kiro")

    const now = Date.now()
    await syncProviderModels(now)
    const accounts = {
        antigravity: antigravityAccounts.map(toSummary),
        codex: codexAccounts.map(toSummary),
        copilot: copilotAccounts.map(toSummary),
        zed: zedAccounts.map(toSummary),
        kiro: kiroAccounts.map(toSummary),
    }

    const models = {
        antigravity: getProviderModels("antigravity"),
        codex: getProviderModels("codex"),
        copilot: getProviderModels("copilot"),
        zed: getProviderModels("zed"),
        kiro: getProviderModels("kiro"),
    }

    const accountModels = {
        antigravity: Object.fromEntries(antigravityAccounts.map(account => [account.id, getProviderModelsForAccount("antigravity", account.id)])),
        codex: Object.fromEntries(codexAccounts.map(account => [account.id, getProviderModelsForAccount("codex", account.id)])),
        copilot: Object.fromEntries(copilotAccounts.map(account => [account.id, getProviderModelsForAccount("copilot", account.id)])),
        zed: Object.fromEntries(zedAccounts.map(account => [account.id, getProviderModelsForAccount("zed", account.id)])),
        kiro: Object.fromEntries(kiroAccounts.map(account => [account.id, getProviderModelsForAccount("kiro", account.id)])),
    }

    // Get quota data for displaying on model blocks
    let quota: Awaited<ReturnType<typeof getAggregatedQuota>> | null = null
    const shouldFetchQuota = !lastQuotaSnapshot || now - lastQuotaAt > QUOTA_TTL_MS
    if (shouldFetchQuota && !quotaInFlight) {
        quotaInFlight = (async () => {
            try {
                const snapshot = await getAggregatedQuota()
                lastQuotaSnapshot = snapshot
                lastQuotaAt = Date.now()
                return snapshot
            } catch {
                return null
            } finally {
                quotaInFlight = null
            }
        })()
    }

    if (quotaInFlight) {
        const quotaResult = await settleWithTimeout(quotaInFlight, QUOTA_TIMEOUT_MS)
        if (quotaResult.ok && quotaResult.value) {
            quota = quotaResult.value
        } else {
            quota = lastQuotaSnapshot
        }
    } else {
        quota = lastQuotaSnapshot
    }

    return c.json({ config: syncedConfig, accounts, models, accountModels, quota })
})

routingRouter.post("/config", async (c) => {
    const body = await c.req.json<{ flows?: RoutingFlow[]; entries?: RoutingEntry[]; accountRouting?: AccountRoutingConfig }>()
    let flows: RoutingFlow[] = []

    if (Array.isArray(body.flows)) {
        flows = body.flows
    } else if (Array.isArray(body.entries)) {
        flows = [{ id: randomUUID(), name: "default", entries: body.entries }]
    } else {
        const existing = loadRoutingConfig()
        flows = existing.flows
    }

    const normalized = flows.map((flow, index) => ({
        id: flow.id || randomUUID(),
        name: (flow.name || `Flow ${index + 1}`).trim() || `Flow ${index + 1}`,
        entries: Array.isArray(flow.entries)
            ? flow.entries.map(entry => ({
                ...entry,
                id: entry.id || randomUUID(),
                label: entry.label || `${entry.provider}:${entry.modelId}`,
                accountLabel: resolveAccountLabel(entry.provider, entry.accountId, entry.accountLabel),
            }))
            : [],
    }))

    let accountRouting: AccountRoutingConfig | undefined
    if (body.accountRouting) {
        const currentConfig = loadRoutingConfig()
        accountRouting = {
            smartSwitch: body.accountRouting.smartSwitch ?? currentConfig.accountRouting?.smartSwitch ?? false,
            separateThinkingModels: body.accountRouting.separateThinkingModels !== undefined
                ? !!body.accountRouting.separateThinkingModels
                : currentConfig.accountRouting?.separateThinkingModels ?? false,
            routes: Array.isArray(body.accountRouting.routes)
                ? body.accountRouting.routes.map(route => ({
                    id: route.id || randomUUID(),
                    modelId: (route.modelId || "").trim(),
                    entries: Array.isArray(route.entries)
                        ? route.entries.map(entry => ({
                            ...entry,
                            id: entry.id || randomUUID(),
                            accountLabel: resolveAccountLabel(entry.provider, entry.accountId, entry.accountLabel),
                        }))
                        : [],
                }))
                : [],
        }
    }

    const config = saveRoutingConfig(normalized, undefined, accountRouting)
    return c.json({ success: true, config })
})

// 🆕 设置/清除激活的 flow
routingRouter.post("/active-flow", async (c) => {
    const body = await c.req.json<{ flowId: string | null }>()
    const config = setActiveFlow(body.flowId)
    return c.json({ success: true, config })
})

// 🆕 清理孤立账号（已删除但仍在 routing 中的账号）
routingRouter.post("/cleanup", async (c) => {
    const config = loadRoutingConfig()

    const validByProvider = new Map<AuthProvider, Set<string>>(
        AUTH_PROVIDERS.map(provider => [
            provider,
            new Set(authStore.listSummaries(provider).map(a => a.id || a.email || "")),
        ])
    )

    const isEntryValid = (entry: { provider: AuthProvider; accountId: string }): boolean => {
        if (entry.provider === "antigravity" && entry.accountId === "auto") return true
        return validByProvider.get(entry.provider)?.has(entry.accountId) ?? false
    }

    let removedCount = 0
    const filterEntries = <T extends { provider: AuthProvider; accountId: string }>(entries: T[]): T[] =>
        entries.filter(entry => {
            const valid = isEntryValid(entry)
            if (!valid) removedCount++
            return valid
        })

    const cleanedFlows = config.flows.map(flow => ({
        ...flow,
        entries: filterEntries(flow.entries),
    }))

    const cleanedAccountRouting = config.accountRouting
        ? {
            ...config.accountRouting,
            routes: config.accountRouting.routes.map(route => ({
                ...route,
                entries: filterEntries(route.entries),
            })),
        }
        : config.accountRouting

    const newConfig = saveRoutingConfig(cleanedFlows, undefined, cleanedAccountRouting)
    accountManager.clearAllRateLimits()

    return c.json({
        success: true,
        removedCount,
        config: newConfig,
    })
})
