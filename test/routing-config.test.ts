import { test, expect } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

function withTempHome(): { dir: string; prevHome: string | undefined; prevProfile: string | undefined } {
    const dir = mkdtempSync(join(tmpdir(), "anti-api-test-"))
    const prevHome = process.env.HOME
    const prevProfile = process.env.USERPROFILE
    process.env.HOME = dir
    process.env.USERPROFILE = dir
    return { dir, prevHome, prevProfile }
}

function restoreEnv(prevHome: string | undefined, prevProfile: string | undefined) {
    if (prevHome === undefined) {
        delete process.env.HOME
    } else {
        process.env.HOME = prevHome
    }
    if (prevProfile === undefined) {
        delete process.env.USERPROFILE
    } else {
        process.env.USERPROFILE = prevProfile
    }
}

test("routing config saves and loads flows", async () => {
    const { dir, prevHome, prevProfile } = withTempHome()
    const { saveRoutingConfig, loadRoutingConfig } = await import(`../src/services/routing/config.ts?${Date.now()}`)

    saveRoutingConfig([
        {
            id: "flow-1",
            name: "default",
            entries: [{
                id: "route-1",
                provider: "antigravity",
                accountId: "acc-1",
                modelId: "claude-opus-4-5-thinking",
                label: "Opus A1",
                accountLabel: "Account A",
            }],
        },
    ])

    const loaded = loadRoutingConfig()
    expect(loaded.flows.length).toBe(1)
    expect(loaded.flows[0].entries[0].label).toBe("Opus A1")

    rmSync(dir, { recursive: true, force: true })
    restoreEnv(prevHome, prevProfile)
})

test("routing models expose antigravity models discovered online (no hardcoded defaults)", async () => {
    const { dir, prevHome, prevProfile } = withTempHome()
    const { getProviderModels } = await import(`../src/services/routing/models.ts?${Date.now()}`)

    const { setDynamicAntigravityModels, clearDynamicAntigravityModels } = await import(`../src/services/routing/models.ts?${Date.now()}`)
    clearDynamicAntigravityModels()
    expect(getProviderModels("antigravity").length).toBe(0)
    setDynamicAntigravityModels([{ id: "claude-opus-5-5-high", label: "x" }])
    const models = getProviderModels("antigravity")
    expect(models.length).toBeGreaterThan(0)
    clearDynamicAntigravityModels()

    rmSync(dir, { recursive: true, force: true })
    restoreEnv(prevHome, prevProfile)
})

test("routing config saves and loads account routing", async () => {
    const { dir, prevHome, prevProfile } = withTempHome()
    const { saveRoutingConfig, loadRoutingConfig } = await import(`../src/services/routing/config.ts?${Date.now()}`)

    saveRoutingConfig(
        [
            {
                id: "flow-1",
                name: "default",
                entries: [{
                    id: "route-1",
                    provider: "antigravity",
                    accountId: "acc-1",
                    modelId: "claude-opus-4-5-thinking",
                    label: "Opus A1",
                    accountLabel: "Account A",
                }],
            },
        ],
        "flow-1",
        {
            smartSwitch: true,
            routes: [
                {
                    id: "route-a",
                    modelId: "claude-sonnet-4-5",
                    entries: [
                        {
                            id: "entry-a",
                            provider: "antigravity",
                            accountId: "acc-1",
                            accountLabel: "Account A",
                        },
                    ],
                },
            ],
        }
    )

    const loaded = loadRoutingConfig()
    expect(loaded.accountRouting?.smartSwitch).toBe(true)
    expect(loaded.accountRouting?.routes[0].modelId).toBe("claude-sonnet-4-5")
    expect(loaded.accountRouting?.routes[0].entries[0].accountId).toBe("acc-1")

    rmSync(dir, { recursive: true, force: true })
    restoreEnv(prevHome, prevProfile)
})

test("loadRoutingConfig drops flows with hidden codex models", async () => {
    const { dir, prevHome, prevProfile } = withTempHome()
    const { loadRoutingConfig } = await import(`../src/services/routing/config.ts?${Date.now()}`)

    const configDir = join(dir, ".anti-api")
    mkdirSync(configDir, { recursive: true })
    const configPath = join(configDir, "routing.json")
    writeFileSync(configPath, JSON.stringify({
        version: 2,
        updatedAt: new Date().toISOString(),
        activeFlowId: "flow-hidden",
        flows: [
            {
                id: "flow-hidden",
                name: "codex-5-2-max",
                entries: [
                    {
                        id: "entry-hidden",
                        provider: "codex",
                        accountId: "acc-1",
                        modelId: "gpt-5.2-max-high",
                        label: "Codex 5.2 Max",
                    },
                ],
            },
        ],
        accountRouting: { smartSwitch: false, routes: [] },
    }, null, 2), "utf-8")

    const loaded = loadRoutingConfig()
    expect(loaded.flows.length).toBe(0)
    expect(loaded.activeFlowId).toBeUndefined()

    rmSync(dir, { recursive: true, force: true })
    restoreEnv(prevHome, prevProfile)
})
