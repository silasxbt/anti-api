import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { clearDynamicCodexModels, clearDynamicCopilotModels, getProviderModels } from "~/services/routing/models"
import type { ProviderAccount } from "~/services/auth/types"

type Provider = "antigravity" | "codex" | "copilot"

const accountsByProvider: Record<Provider, ProviderAccount[]> = {
    antigravity: [],
    codex: [],
    copilot: [],
}

let syncMode: "success" | "error" | "slow" = "success"
let syncDelayMs = 0
let remoteModels: Array<{ id: string; name?: string; model_picker_enabled?: boolean }> = []
const syncedWithAccountIds: string[] = []
let codexSyncMode: "success" | "error" = "success"
let codexRemoteModels: Array<{ id: string; label: string }> = []
const codexSyncedWithAccountIds: string[] = []
let tempHome: string | null = null
let prevHome: string | undefined
let prevProfile: string | undefined

mock.module("~/services/auth/store", () => ({
    authStore: {
        listAccounts: (provider?: Provider) => {
            if (!provider) {
                return [...accountsByProvider.antigravity, ...accountsByProvider.codex, ...accountsByProvider.copilot]
            }
            return [...accountsByProvider[provider]]
        },
        listSummaries: (provider?: Provider) => {
            const accounts = provider
                ? accountsByProvider[provider]
                : [...accountsByProvider.antigravity, ...accountsByProvider.codex, ...accountsByProvider.copilot]
            return accounts.map(account => ({
                id: account.id,
                provider: account.provider,
                displayName: account.label || account.email || account.login || account.id,
                email: account.email,
                login: account.login,
                label: account.label,
                expiresAt: account.expiresAt,
            }))
        },
        getAccount: (provider: Provider, id: string) => {
            return accountsByProvider[provider].find(account => account.id === id) || null
        },
        saveAccount: (account: any) => {
            if (account?.provider && (accountsByProvider as any)[account.provider]) {
                const list = (accountsByProvider as any)[account.provider]
                const existingIdx = list.findIndex((a: any) => a.id === account.id)
                if (existingIdx >= 0) list[existingIdx] = account
                else list.push(account)
            }
        },
    },
}))

mock.module("~/services/antigravity/account-manager", () => {
    const knownAccounts = new Set<string>()
    return {
        accountManager: {
            load: () => { },
            clearAllRateLimits: () => { },
            hasAccount: (id?: string) => !id || knownAccounts.has(id) || true,
            addAccount: (acc: any) => { if (acc?.id) knownAccounts.add(acc.id) },
        },
    }
})

const realQuotaAggregator = await import("../src/services/quota-aggregator")
mock.module("~/services/quota-aggregator", () => ({
    ...realQuotaAggregator,
    getAggregatedQuota: async () => null,
}))

mock.module("~/services/copilot/chat", () => ({
    createCopilotCompletion: async () => ({ contentBlocks: [], stopReason: "end_turn", usage: {} }),
    getCopilotReasoningEfforts: () => [],
    listCopilotModelsForAccount: async (account: ProviderAccount) => {
        syncedWithAccountIds.push(account.id)
        if (syncMode === "error") {
            throw new Error("sync failed")
        }
        if (syncMode === "slow") {
            await new Promise(resolve => setTimeout(resolve, syncDelayMs))
        }
        return remoteModels
    },
}))

mock.module("~/services/codex/chat", () => ({
    createCodexCompletion: async () => ({ contentBlocks: [], stopReason: "end_turn", usage: {} }),
    listCodexModelsForAccount: async (account: ProviderAccount) => {
        codexSyncedWithAccountIds.push(account.id)
        if (codexSyncMode === "error") {
            throw new Error("codex sync failed")
        }
        return codexRemoteModels
    },
    isCodexModelSupportedForAccount: () => undefined,
    isCodexUnsupportedModelError: () => false,
}))

async function getRoutingRouter() {
    const mod = await import(`../src/routes/routing/route.ts?${Date.now()}-${Math.random()}`)
    return mod.routingRouter
}

function addCopilotAccount(id: string, createdAt: string): void {
    accountsByProvider.copilot.push({
        id,
        provider: "copilot",
        accessToken: `token-${id}`,
        login: id,
        createdAt,
    })
}

function addCodexAccount(id: string, createdAt: string): void {
    accountsByProvider.codex.push({
        id,
        provider: "codex",
        accessToken: `token-${id}`,
        email: `${id}@example.com`,
        createdAt,
    })
}

beforeEach(() => {
    prevHome = process.env.HOME
    prevProfile = process.env.USERPROFILE
    tempHome = mkdtempSync(join(tmpdir(), "anti-api-routing-"))
    process.env.HOME = tempHome
    process.env.USERPROFILE = tempHome
    mkdirSync(join(tempHome, ".anti-api"), { recursive: true })

    accountsByProvider.antigravity = []
    accountsByProvider.codex = []
    accountsByProvider.copilot = []
    syncedWithAccountIds.length = 0
    codexSyncedWithAccountIds.length = 0
    syncMode = "success"
    syncDelayMs = 0
    remoteModels = []
    codexSyncMode = "success"
    codexRemoteModels = []
    clearDynamicCopilotModels()
    clearDynamicCodexModels()
})

afterEach(() => {
    if (tempHome) {
        rmSync(tempHome, { recursive: true, force: true })
    }
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = prevProfile
    tempHome = null
})

afterAll(() => {
    mock.restore()
})

test("routing config syncs copilot models from the first available account", async () => {
    addCopilotAccount("older-account", "2026-01-01T00:00:00.000Z")
    addCopilotAccount("newer-account", "2026-01-02T00:00:00.000Z")
    remoteModels = [{ id: "gpt-5.2", name: "GPT-5.2", model_picker_enabled: true }]

    const routingRouter = await getRoutingRouter()
    const res = await routingRouter.request("/config")
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(syncedWithAccountIds[0]).toBe("older-account")
    expect(data.models.copilot.some((model: { id: string }) => model.id === "gpt-5.2")).toBe(true)
    expect(data.models.copilot.some((model: { id: string }) => model.id === "gpt-4o")).toBe(false)
})

test("routing config has no copilot models when dynamic sync fails", async () => {
    addCopilotAccount("copilot-1", "2026-01-01T00:00:00.000Z")
    syncMode = "error"

    const routingRouter = await getRoutingRouter()
    const res = await routingRouter.request("/config")
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(syncedWithAccountIds.length).toBe(1)
    expect(data.models.copilot.some((model: { id: string }) => model.id === "gpt-4o")).toBe(false)
    expect(data.models.copilot.some((model: { id: string }) => model.id === "gpt-5.2")).toBe(false)
})

test("routing config exposes no hardcoded copilot models when no account exists", async () => {
    const routingRouter = await getRoutingRouter()
    const res = await routingRouter.request("/config")
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(syncedWithAccountIds.length).toBe(0)
    expect(data.models.copilot.some((model: { id: string }) => model.id === "gpt-4o")).toBe(false)
})

test("routing config returns quickly on slow copilot sync and updates on subsequent request", async () => {
    addCopilotAccount("copilot-1", "2026-01-01T00:00:00.000Z")
    syncMode = "slow"
    syncDelayMs = 1200
    remoteModels = [{ id: "gpt-5.2", name: "GPT-5.2", model_picker_enabled: true }]

    const routingRouter = await getRoutingRouter()
    const res1 = await routingRouter.request("/config")
    const data1 = await res1.json()

    expect(res1.status).toBe(200)
    expect(data1.models.copilot.some((model: { id: string }) => model.id === "gpt-5.2")).toBe(false)

    await new Promise(resolve => setTimeout(resolve, syncDelayMs + 50))
    const res2 = await routingRouter.request("/config")
    const data2 = await res2.json()

    expect(res2.status).toBe(200)
    expect(data2.models.copilot.some((model: { id: string }) => model.id === "gpt-5.2")).toBe(true)
})

test("routing config syncs codex models from available codex account", async () => {
    addCodexAccount("codex-a", "2026-01-01T00:00:00.000Z")
    codexRemoteModels = [
        { id: "gpt-5.3-codex", label: "Codex - 5.3 Codex" },
        { id: "gpt-5.2-codex", label: "Codex - 5.2 Codex" },
    ]

    const routingRouter = await getRoutingRouter()
    const res = await routingRouter.request("/config")
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(codexSyncedWithAccountIds[0]).toBe("codex-a")
    expect(data.models.codex.some((model: { id: string }) => model.id === "gpt-5.3-codex")).toBe(true)
})

test("routing config has no codex models when codex sync fails", async () => {
    addCodexAccount("codex-a", "2026-01-01T00:00:00.000Z")
    codexSyncMode = "error"

    const routingRouter = await getRoutingRouter()
    const res = await routingRouter.request("/config")
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(codexSyncedWithAccountIds.length).toBe(1)
    expect(data.models.codex.some((model: { id: string }) => model.id === "gpt-5.3-codex")).toBe(false)
})

test("syncProviderModels does not deadlock when a copilot account sync hangs", async () => {
    addCopilotAccount("hanging-account", "2026-01-01T00:00:00.000Z")
    syncMode = "slow"
    syncDelayMs = 5_000
    remoteModels = [{ id: "copilot-auto", name: "Copilot - Auto" }]

    const mod = await import(`../src/routes/routing/route.ts?${Date.now()}-${Math.random()}`)
    const t0 = Date.now()
    await mod.syncProviderModels(t0, 1000, 100)
    expect(Date.now() - t0).toBeLessThan(1000)

    syncMode = "success"
    syncDelayMs = 0
    await mod.syncProviderModels(t0 + 61_000, 1000, 100)
    expect(getProviderModels("copilot").some((model) => model.id === "copilot-auto")).toBe(true)
})
