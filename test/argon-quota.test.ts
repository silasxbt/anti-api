import { expect, test } from "bun:test"
import { buildAntigravityBars } from "~/services/quota-aggregator"
import { parseModelId, buildCatalog } from "~/lib/model-catalog"
import { getAntigravityModelName } from "~/services/antigravity/chat"
import { normalizeOfficialModelId } from "~/services/routing/router"
import { mapModel } from "~/routes/openai/translator"

test("buildAntigravityBars handles separate Argon quota group correctly", () => {
    const summary = {
        groups: [
            {
                displayName: "Gemini Models",
                buckets: [
                    {
                        bucketId: "gemini-weekly",
                        window: "weekly",
                        remainingFraction: 0.85,
                        resetTime: "2026-10-20T00:00:00Z",
                    },
                    {
                        bucketId: "gemini-5h",
                        window: "5h",
                        remainingFraction: 0.95,
                        resetTime: "2026-10-16T22:00:00Z",
                    },
                ],
            },
            {
                displayName: "Claude and GPT models",
                buckets: [
                    {
                        bucketId: "claude-weekly",
                        window: "weekly",
                        remainingFraction: 0.40,
                        resetTime: "2026-10-22T12:00:00Z",
                    },
                    {
                        bucketId: "claude-5h",
                        window: "5h",
                        remainingFraction: 0.70,
                        resetTime: "2026-10-16T23:00:00Z",
                    },
                ],
            },
            {
                displayName: "Gemini Argon",
                buckets: [
                    {
                        bucketId: "argon-weekly",
                        window: "weekly",
                        remainingFraction: 0.60,
                        resetTime: "2026-10-23T18:00:00Z",
                    },
                ],
            },
        ],
    }

    const bars = buildAntigravityBars({}, summary)

    // Verify all 5 bars are present
    expect(bars.map(b => b.key)).toEqual([
        "gemini_week",
        "gemini_5h",
        "claude_gpt_week",
        "claude_gpt_5h",
        "argon_week",
    ])

    const geminiWeek = bars.find(b => b.key === "gemini_week")!
    const claudeWeek = bars.find(b => b.key === "claude_gpt_week")!
    const argonWeek = bars.find(b => b.key === "argon_week")!

    // Verify each has its own independent limit
    expect(geminiWeek.percentage).toBe(85)
    expect(claudeWeek.percentage).toBe(40)
    expect(argonWeek.percentage).toBe(60)
    expect(argonWeek.label).toBe("weekly argon")
    expect(argonWeek.resetTime).toBe("2026-10-23T18:00:00Z")
})

test("buildAntigravityBars handles Argon bucket nested inside Gemini group", () => {
    const summary = {
        groups: [
            {
                displayName: "Gemini Models",
                buckets: [
                    {
                        bucketId: "gemini-weekly",
                        window: "weekly",
                        remainingFraction: 0.90,
                    },
                    {
                        bucketId: "gemini-5h",
                        window: "5h",
                        remainingFraction: 1.0,
                    },
                    {
                        bucketId: "argon-weekly",
                        displayName: "Gemini Argon Weekly",
                        window: "weekly",
                        remainingFraction: 0.35,
                        resetTime: "2026-10-24T00:00:00Z",
                    },
                ],
            },
            {
                displayName: "Claude and GPT models",
                buckets: [
                    {
                        bucketId: "claude-weekly",
                        window: "weekly",
                        remainingFraction: 0.50,
                    },
                    {
                        bucketId: "claude-5h",
                        window: "5h",
                        remainingFraction: 0.80,
                    },
                ],
            },
        ],
    }

    const bars = buildAntigravityBars({}, summary)

    const geminiWeek = bars.find(b => b.key === "gemini_week")!
    const argonWeek = bars.find(b => b.key === "argon_week")!

    // Ensure standard gemini weekly was NOT polluted by argon bucket
    expect(geminiWeek.percentage).toBe(90)
    expect(argonWeek.percentage).toBe(35)
    expect(argonWeek.resetTime).toBe("2026-10-24T00:00:00Z")
})

test("buildAntigravityBars fallback with model dictionary", () => {
    const models = {
        "gemini-3.8-flash-medium": {
            remainingFraction: 0.75,
            resetTime: "2026-10-16T21:00:00Z",
        },
        "gemini-4-argon": {
            remainingFraction: 0.55,
            resetTime: "2026-10-23T00:00:00Z",
        },
    }

    const bars = buildAntigravityBars(models, null)
    const argonWeek = bars.find(b => b.key === "argon_week")!
    expect(argonWeek.percentage).toBe(55)
    expect(argonWeek.resetTime).toBe("2026-10-23T00:00:00Z")
})

test("model catalog parses and aliases Gemini 4 Argon", () => {
    const parsed1 = parseModelId("gemini-4-argon")
    expect(parsed1).not.toBeNull()
    expect(parsed1?.family).toBe("gemini-argon")
    expect(parsed1?.version).toEqual([4])
    expect(parsed1?.variant).toBe("")

    const parsed2 = parseModelId("gemini-4-argon-high")
    expect(parsed2?.variant).toBe("high")

    const parsed3 = parseModelId("argon")
    expect(parsed3?.family).toBe("gemini-argon")

    const catalog = buildCatalog([
        "gemini-4-argon",
        "gemini-4-argon-high",
    ])
    expect(catalog.aliases.get("gemini-argon")).toBe("gemini-4-argon-high")
    expect(catalog.aliases.get("argon")).toBe("gemini-4-argon-high")
    expect(catalog.aliases.get("gemini-4-argon")).toBe("gemini-4-argon-high")
})

test("chat service and router normalize Gemini Argon models correctly", () => {
    expect(getAntigravityModelName("gemini-4-argon")).toBe("gemini-4-argon-medium")
    expect(getAntigravityModelName("gemini-argon")).toBe("gemini-4-argon-medium")
    expect(getAntigravityModelName("argon")).toBe("gemini-4-argon-medium")
    expect(getAntigravityModelName("gemini-4-argon-thinking")).toBe("gemini-4-argon-high")

    expect(normalizeOfficialModelId("gemini-4-argon")).toBe("gemini-4-argon")
    expect(normalizeOfficialModelId("gemini-argon")).toBe("gemini-4-argon")
    expect(normalizeOfficialModelId("argon")).toBe("gemini-4-argon")

    expect(mapModel("gemini-4-argon")).toBe("gemini-4-argon")
    expect(mapModel("gemini-4-argon", "high")).toBe("gemini-4-argon-high")
    expect(mapModel("gemini-4-argon", "low")).toBe("gemini-4-argon-low")
    expect(mapModel("argon")).toBe("gemini-4-argon")
})
