import { afterAll, afterEach, expect, mock, test } from "bun:test"
import { clearDynamicCopilotModels, setDynamicCopilotModels } from "~/services/routing/models"

const realConfig = await import("~/services/routing/config")
mock.module("~/services/routing/config", () => ({
    ...realConfig,
    loadRoutingConfig: () => ({
        version: 2,
        updatedAt: new Date().toISOString(),
        flows: [],
        accountRouting: { smartSwitch: false, routes: [] },
    }),
}))

const realChat = await import("~/services/antigravity/chat")
mock.module("~/services/antigravity/chat", () => ({
    ...realChat,
    createChatCompletionWithOptions: async () => ({ contentBlocks: [], stopReason: "end_turn", usage: {} }),
    createChatCompletionStreamWithOptions: async function* () {
        yield ""
    },
    createAntigravityEventStreamWithOptions: async function* () {
        yield { type: "start" as const, model: "mock" }
        yield { type: "finish" as const, stopReason: "end_turn" as const }
    },
}))

mock.module("~/services/antigravity/account-manager", () => ({
    accountManager: {
        hasAccount: () => true,
        isAccountRateLimited: () => false,
        isAccountInFlight: () => false,
        markRateLimitedFromError: () => ({ reason: "rate_limited", durationMs: 1_000 }),
    },
}))

const realCodex = await import("../src/services/codex/chat")
mock.module("~/services/codex/chat", () => ({
    ...realCodex,
    createCodexCompletion: async () => ({ contentBlocks: [], stopReason: "end_turn", usage: {} }),
    createCodexResponsesDirect: async () => ({ kind: "json" as const, status: 200, data: {}, resolvedModel: "mock" }),
    isCodexInsecureTlsEnabled: () => false,
    listCodexModelsForAccount: async () => [],
    isCodexModelSupportedForAccount: () => undefined,
    isCodexUnsupportedModelError: () => false,
}))

const realCopilot = await import("../src/services/copilot/chat")
mock.module("~/services/copilot/chat", () => ({
    ...realCopilot,
    createCopilotCompletion: async () => ({ contentBlocks: [], stopReason: "end_turn", usage: {} }),
    createCopilotResponsesDirect: async () => ({ kind: "json" as const, status: 200, data: {}, resolvedModel: "mock" }),
    createCopilotChatDirect: async () => null,
    getCopilotReasoningEfforts: () => [],
    isCopilotInsecureTlsEnabled: () => false,
    listCopilotModelsForAccount: async () => [],
}))

mock.module("~/services/auth/store", () => ({
    authStore: {
        getAccount: () => null,
        isRateLimited: () => false,
        markRateLimited: () => 1_000,
        markSuccess: () => { },
        listAccounts: () => [],
        saveAccount: () => { },
    },
}))

afterEach(() => {
    clearDynamicCopilotModels()
})

afterAll(() => {
    mock.restore()
})

test("dynamic copilot model is treated as official model by router", async () => {
    setDynamicCopilotModels([{ id: "gpt-5.2-new", label: "Copilot - GPT-5.2 New" }])

    const router = await import(`../src/services/routing/router.ts?${Date.now()}-${Math.random()}`)

    await expect(
        router.createRoutedCompletion({
            model: "gpt-5.2-new",
            messages: [],
        })
    ).rejects.toThrow('No account routing configured for model "gpt-5.2-new"')
})

test("official model aliases use one routing key", async () => {
    const router = await import(`../src/services/routing/router.ts?${Date.now()}-${Math.random()}`)

    expect(router.normalizeOfficialModelId("claude-sonnet-4.5")).toBe("claude-sonnet-4-5")
    expect(router.modelIdsMatch("claude-sonnet-4.5", "claude-sonnet-4-5")).toBe(true)
    expect(router.modelIdsMatch("CLAUDE-SONNET-4-5", "claude-sonnet-4.5")).toBe(true)
})

test("streaming normalizes the dotted Copilot model before route selection", async () => {
    setDynamicCopilotModels([{ id: "claude-sonnet-4.5", label: "Copilot - Claude Sonnet 4.5" }])
    const router = await import(`../src/services/routing/router.ts?${Date.now()}-${Math.random()}`)
    const stream = router.createRoutedCompletionStream({
        model: "claude-sonnet-4.5",
        messages: [],
    })

    await expect(stream.next()).rejects.toThrow('No account routing configured for model "claude-sonnet-4-5"')
})
