import { beforeEach, expect, test } from "bun:test"
import { isAntigravityModelSupportedForAccount, markAntigravityModelUnsupported } from "~/services/antigravity/chat"
import { updateCachedAntigravityModelsForAccount } from "~/services/quota-aggregator"

test("isAntigravityModelSupportedForAccount correctly checks account models", () => {
    const acc1 = "account-1@example.com"
    const acc2 = "account-2@example.com"

    updateCachedAntigravityModelsForAccount(acc1, [
        "gemini-2.5-flash-lite",
        "claude-opus-5-5-low",
        "claude-opus-5-5-medium",
        "claude-opus-5-5-high",
        "claude-sonnet-5-5-low",
        "claude-sonnet-5-5-medium",
        "claude-sonnet-5-5-high",
        "gemini-3.8-flash-tiered",
        "gemini-2.5-pro",
    ])

    updateCachedAntigravityModelsForAccount(acc2, [
        "gemini-3.8-flash-tiered",
        "claude-opus-4-6-thinking",
        "claude-sonnet-4-6",
        "gemini-2.5-pro",
        "gemini-4-argon-disabled",
    ])

    // Opus 5.5 should be supported on Vigna, NOT on Helilo
    expect(isAntigravityModelSupportedForAccount(acc1, "claude-opus-5-5")).toBe(true)
    expect(isAntigravityModelSupportedForAccount(acc1, "claude-opus-5-5-thinking")).toBe(true)
    expect(isAntigravityModelSupportedForAccount(acc1, "claude-opus-5-5-medium")).toBe(true)
    expect(isAntigravityModelSupportedForAccount(acc2, "claude-opus-5-5")).toBe(false)
    expect(isAntigravityModelSupportedForAccount(acc2, "claude-opus-5-5-thinking")).toBe(false)

    // Sonnet 5.5 should be supported on Vigna, NOT on Helilo
    expect(isAntigravityModelSupportedForAccount(acc1, "claude-sonnet-5-5")).toBe(true)
    expect(isAntigravityModelSupportedForAccount(acc2, "claude-sonnet-5-5")).toBe(false)

    // Opus 4.6 should be supported on Helilo, NOT on Vigna
    expect(isAntigravityModelSupportedForAccount(acc1, "claude-opus-4-6")).toBe(false)
    expect(isAntigravityModelSupportedForAccount(acc2, "claude-opus-4-6")).toBe(true)
    expect(isAntigravityModelSupportedForAccount(acc2, "claude-opus-4-6-thinking")).toBe(true)

    // Gemini 3.8 flash should be supported on both
    expect(isAntigravityModelSupportedForAccount(acc1, "gemini-3.8-flash")).toBe(true)
    expect(isAntigravityModelSupportedForAccount(acc2, "gemini-3.8-flash")).toBe(true)

    // Gemini 4 Argon has only -disabled on Helilo, absent on Vigna -> false on both
    expect(isAntigravityModelSupportedForAccount(acc1, "gemini-4-argon")).toBe(false)
    expect(isAntigravityModelSupportedForAccount(acc2, "gemini-4-argon")).toBe(false)

    // Negative caching: mark model unsupported dynamically
    markAntigravityModelUnsupported(acc1, "gemini-3.8-flash")
    expect(isAntigravityModelSupportedForAccount(acc1, "gemini-3.8-flash")).toBe(false)
})

test("resolveAccountRoutingEntries filters out accounts not supporting the requested model", async () => {
    const { resolveAccountRoutingEntries } = await import("~/services/routing/router")
    const { accountManager } = await import("~/services/antigravity/account-manager")
    const { authStore } = await import("~/services/auth/store")

    // Register accounts in authStore & accountManager
    const acc1 = { id: "acc-1@example.com", provider: "antigravity" as const, email: "acc-1@example.com", accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 10000 }
    const acc2 = { id: "acc-2@example.com", provider: "antigravity" as const, email: "acc-2@example.com", accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 10000 }
    authStore.saveAccount(acc1)
    authStore.saveAccount(acc2)
    accountManager.addAccount({ id: acc1.id, email: acc1.email, accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 10000 })
    accountManager.addAccount({ id: acc2.id, email: acc2.email, accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 10000 })

    updateCachedAntigravityModelsForAccount(acc1.id, ["claude-opus-5-5-medium"])
    updateCachedAntigravityModelsForAccount(acc2.id, ["claude-opus-4-6-thinking"])

    const { setDynamicAntigravityModels } = await import("~/services/routing/models")
    setDynamicAntigravityModels([
        { id: "claude-opus-5-5-medium", label: "Opus 5.5 Medium" },
        { id: "claude-opus-4-6-thinking", label: "Opus 4.6 Thinking" },
    ])

    const config = {
        version: 2,
        updatedAt: new Date().toISOString(),
        flows: [],
        accountRouting: {
            smartSwitch: true,
            routes: [],
        },
    }

    const entriesOpus55 = resolveAccountRoutingEntries(config as any, "claude-opus-5-5")
    expect(entriesOpus55.some(e => e.accountId === acc1.id)).toBe(true)
    expect(entriesOpus55.some(e => e.accountId === acc2.id)).toBe(false)

    const entriesOpus46 = resolveAccountRoutingEntries(config as any, "claude-opus-4-6")
    expect(entriesOpus46.some(e => e.accountId === acc1.id)).toBe(false)
    expect(entriesOpus46.some(e => e.accountId === acc2.id)).toBe(true)

    const { normalizeOfficialModelId } = await import("~/services/routing/router")
    expect(normalizeOfficialModelId("claude-opus-5-5-high")).toBe("claude-opus-5-5-high")
    expect(normalizeOfficialModelId("claude-opus-5-5-low")).toBe("claude-opus-5-5-low")
    expect(normalizeOfficialModelId("claude-sonnet-5-5-high")).toBe("claude-sonnet-5-5-high")
    expect(normalizeOfficialModelId("gemini-4-argon-high")).toBe("gemini-4-argon-high")

    const explicitRouteConfig = {
        version: 2,
        updatedAt: new Date().toISOString(),
        flows: [],
        accountRouting: {
            smartSwitch: false,
            routes: [
                {
                    id: "route-opus-5-5",
                    modelId: "claude-opus-5-5",
                    entries: [
                        { id: "e1", provider: "antigravity" as const, accountId: acc1.id },
                        { id: "e2", provider: "antigravity" as const, accountId: acc2.id },
                    ],
                },
            ],
        },
    }

    const entriesOpus55High = resolveAccountRoutingEntries(explicitRouteConfig as any, "claude-opus-5-5-high")
    expect(entriesOpus55High.map(e => e.accountId)).toEqual([acc1.id])
})

