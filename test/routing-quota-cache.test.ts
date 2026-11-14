import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { ProviderAccount } from "~/services/auth/types"

type Provider = "antigravity" | "codex" | "copilot"

let quotaMode: "fast" | "slow" = "fast"
let quotaDelayMs = 0
const quotaSnapshot = { snapshot: "ok" }
let tempHome: string | null = null
let prevHome: string | undefined
let prevProfile: string | undefined

const realStore = await import("../src/services/auth/store")
mock.module("~/services/auth/store", () => realStore)

mock.module("~/services/antigravity/account-manager", () => ({
    accountManager: {
        load: () => { },
        clearAllRateLimits: () => { },
        hasAccount: () => true,
        addAccount: () => { },
    },
}))

mock.module("~/services/copilot/chat", () => ({
    createCopilotCompletion: async () => ({ contentBlocks: [], stopReason: "end_turn", usage: {} }),
    getCopilotReasoningEfforts: () => [],
    listCopilotModelsForAccount: async (_account: ProviderAccount) => [],
}))

mock.module("~/services/codex/chat", () => ({
    createCodexCompletion: async () => ({ contentBlocks: [], stopReason: "end_turn", usage: {} }),
    listCodexModelsForAccount: async (_account: ProviderAccount) => [],
    isCodexModelSupportedForAccount: () => undefined,
    isCodexUnsupportedModelError: () => false,
}))

mock.module("~/services/quota-aggregator", () => ({
    getAggregatedQuota: async () => {
        if (quotaMode === "slow") {
            await new Promise(resolve => setTimeout(resolve, quotaDelayMs))
        }
        return quotaSnapshot
    },
}))

async function getRoutingRouter() {
    const mod = await import(`../src/routes/routing/route.ts?${Date.now()}-${Math.random()}`)
    return mod.routingRouter
}

beforeEach(() => {
    prevHome = process.env.HOME
    prevProfile = process.env.USERPROFILE
    tempHome = mkdtempSync(join(tmpdir(), "anti-api-routing-"))
    process.env.HOME = tempHome
    process.env.USERPROFILE = tempHome
    mkdirSync(join(tempHome, ".anti-api"), { recursive: true })

    quotaMode = "fast"
    quotaDelayMs = 0
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

test("routing config returns cached quota after a slow fetch completes", async () => {
    quotaMode = "slow"
    quotaDelayMs = 1300

    const routingRouter = await getRoutingRouter()
    const res1 = await routingRouter.request("/config")
    const data1 = await res1.json()
    expect(res1.status).toBe(200)
    expect(data1.quota).toBe(null)

    await new Promise(resolve => setTimeout(resolve, quotaDelayMs + 50))
    const res2 = await routingRouter.request("/config")
    const data2 = await res2.json()
    expect(res2.status).toBe(200)
    expect(data2.quota).toEqual(quotaSnapshot)
})
