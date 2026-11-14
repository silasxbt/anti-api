import { expect, test } from "bun:test"
import { normalizeCopilotModels, resolveCopilotModel, COPILOT_AUTO_MODEL_ID } from "~/services/copilot/chat"
import { getProviderModels, setDynamicCopilotModels, clearDynamicCopilotModels } from "~/services/routing/models"

test("normalizeCopilotModels always includes copilot-auto as the base auto model", () => {
    const models = normalizeCopilotModels([])
    expect(models.length).toBe(1)
    expect(models[0].id).toBe(COPILOT_AUTO_MODEL_ID)
    expect(models[0].name).toBe("Auto")
})

test("free/edu accounts without picker-enabled models only see copilot-auto", () => {
    const remote = [
        { id: "gpt-4o", name: "GPT-4o", model_picker_enabled: false },
        { id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5", model_picker_enabled: false },
        { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", model_picker_enabled: false },
        { id: "text-embedding-3-small", name: "Embedding V3", model_picker_enabled: false },
    ]
    const models = normalizeCopilotModels(remote as any)
    expect(models.map(m => m.id)).toEqual(["copilot-auto"])
})

test("pro/enterprise accounts see picker-enabled models in addition to copilot-auto", () => {
    const remote = [
        { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", model_picker_enabled: true },
        { id: "gpt-4.1", name: "GPT-4.1", model_picker_enabled: true },
        { id: "claude-opus-5.5", name: "Claude Opus 5.5", model_picker_enabled: false }, // locked
        { id: "copilot-search-a", name: "Search Agent", model_picker_enabled: true }, // internal
    ]
    const models = normalizeCopilotModels(remote as any)
    expect(models.map(m => m.id)).toEqual(["copilot-auto", "claude-sonnet-4.5", "gpt-4.1"])
})

test("resolveCopilotModel maps auto variants to their respective tiers and reasoning efforts", () => {
    const available = [{ id: "copilot-auto", name: "Auto" }]

    expect(resolveCopilotModel(available as any, "copilot-auto")).toEqual({
        id: "copilot-auto",
        isAuto: true,
    })

    expect(resolveCopilotModel(available as any, "auto")).toEqual({
        id: "copilot-auto",
        isAuto: true,
    })

    expect(resolveCopilotModel(available as any, "copilot-auto-low")).toEqual({
        id: "copilot-auto",
        effort: "low",
        isAuto: true,
        tier: "efficiency",
    })

    expect(resolveCopilotModel(available as any, "copilot-auto-medium")).toEqual({
        id: "copilot-auto",
        effort: "medium",
        isAuto: true,
        tier: "balance",
    })

    expect(resolveCopilotModel(available as any, "copilot-auto-high")).toEqual({
        id: "copilot-auto",
        effort: "high",
        isAuto: true,
        tier: "intelligence",
    })

    expect(resolveCopilotModel(available as any, "copilot-auto-thinking")).toEqual({
        id: "copilot-auto",
        effort: "high",
        isAuto: true,
        tier: "intelligence",
    })
})

test("separateThinkingModels controls whether auto tiers are exposed as distinct model IDs", () => {
    clearDynamicCopilotModels()
    setDynamicCopilotModels([
        { id: "copilot-auto", label: "Copilot - Auto" },
        { id: "copilot-auto-low", label: "Copilot - Auto (low)" },
        { id: "copilot-auto-medium", label: "Copilot - Auto (medium)" },
        { id: "copilot-auto-high", label: "Copilot - Auto (high)" },
        { id: "copilot-auto-thinking", label: "Copilot - Auto (thinking)" },
    ])

    // When separateThinkingModels is disabled (default): only base copilot-auto is exposed
    const baseModels = getProviderModels("copilot", { includeAllVariants: false })
    expect(baseModels.map(m => m.id)).toEqual(["copilot-auto"])

    // When separateThinkingModels is enabled: all variants are exposed
    const allModels = getProviderModels("copilot", { includeAllVariants: true })
    expect(allModels.map(m => m.id)).toEqual([
        "copilot-auto",
        "copilot-auto-low",
        "copilot-auto-medium",
        "copilot-auto-high",
        "copilot-auto-thinking",
    ])
    clearDynamicCopilotModels()
})

