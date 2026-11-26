import { expect, test } from "bun:test"
import { AVAILABLE_MODELS } from "~/lib/config"
import { getModelEnumValue, MODEL_ENUM } from "~/proto/encoder"
import { getProviderModels } from "~/services/routing/models"

const GEMINI_31_MODELS = [
    "gemini-3.1-pro-high",
    "gemini-3.1-pro-low",
    "gemini-3.1-flash",
    "gemini-3.1-flash-lite",
] as const

test("Gemini 3.1 models are exposed as Antigravity models", () => {
    const configuredIds = new Set(AVAILABLE_MODELS.map(model => model.id))
    const providerIds = new Set(getProviderModels("antigravity").map(model => model.id))

    for (const model of GEMINI_31_MODELS) {
        expect(configuredIds.has(model)).toBe(true)
        expect(providerIds.has(model)).toBe(true)
    }
})

test("Gemini 3.1 models map to the corresponding Antigravity proto enums", () => {
    expect(getModelEnumValue("gemini-3.1-pro-high")).toBe(MODEL_ENUM.GEMINI_3_PRO_HIGH)
    expect(getModelEnumValue("gemini-3.1-pro-low")).toBe(MODEL_ENUM.GEMINI_3_PRO_LOW)
    expect(getModelEnumValue("gemini-3.1-flash")).toBe(MODEL_ENUM.GEMINI_3_FLASH)
    expect(getModelEnumValue("gemini-3.1-flash-lite")).toBe(MODEL_ENUM.GEMINI_3_FLASH)
})
