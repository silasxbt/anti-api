import { afterEach, expect, test } from "bun:test"
import { clearDynamicCodexModels, clearDynamicCopilotModels, clearDynamicKiroModels, getProviderModels, setDynamicCodexModels, setDynamicCopilotModels, setDynamicKiroModels } from "~/services/routing/models"

afterEach(() => {
    clearDynamicCopilotModels()
    clearDynamicCodexModels()
    clearDynamicKiroModels()
})

test("copilot models are not hardcoded when dynamic list is empty", () => {
    clearDynamicCopilotModels()
    const models = getProviderModels("copilot")

    expect(models).toEqual([])
})

test("copilot models come only from the dynamic list", () => {
    setDynamicCopilotModels([
        { id: "gpt-5.2", label: "Copilot - GPT-5.2" },
        { id: "gpt-4o", label: "Copilot - GPT-4o Dynamic" },
    ])

    const models = getProviderModels("copilot")
    const gpt52 = models.find(model => model.id === "gpt-5.2")
    const gpt4o = models.find(model => model.id === "gpt-4o")

    expect(gpt52?.label).toBe("Copilot - GPT-5.2")
    expect(gpt4o?.label).toBe("Copilot - GPT-4o Dynamic")
    expect(models.length).toBe(2)
})

test("dynamic copilot model options are sanitized and deduplicated", () => {
    setDynamicCopilotModels([
        { id: " gpt-5.2 ", label: "  Copilot - GPT-5.2  " },
        { id: "gpt-5.2", label: "Copilot - Duplicate" },
        { id: "", label: "invalid" },
    ])

    const models = getProviderModels("copilot")
    const matches = models.filter(model => model.id === "gpt-5.2")

    expect(matches.length).toBe(1)
    expect(matches[0].label).toBe("Copilot - GPT-5.2")
})

test("codex models are not hardcoded when dynamic list is empty", () => {
    clearDynamicCodexModels()
    const models = getProviderModels("codex")

    expect(models).toEqual([])
})

test("codex dynamic models override static list when available", () => {
    setDynamicCodexModels([
        { id: "gpt-5.3-codex", label: "Codex - 5.3 Codex" },
        { id: "gpt-5.2-codex", label: "Codex - 5.2 Codex" },
    ])

    const models = getProviderModels("codex")
    expect(models.map(model => model.id)).toEqual(["gpt-5.3-codex", "gpt-5.2-codex"])
})

test("kiro models are not hardcoded when dynamic list is empty", () => {
    clearDynamicKiroModels()
    const models = getProviderModels("kiro")

    expect(models).toEqual([])
})

test("kiro models merge dynamic models before static fallback", () => {
    setDynamicKiroModels([
        { id: "custom-kiro-model", label: "Kiro - Custom" },
        { id: "auto", label: "Kiro - Dynamic Auto" },
    ])

    const models = getProviderModels("kiro")
    const custom = models.find(model => model.id === "custom-kiro-model")
    const auto = models.find(model => model.id === "auto")

    expect(custom?.label).toBe("Kiro - Custom")
    expect(auto?.label).toBe("Kiro - Dynamic Auto")
})
