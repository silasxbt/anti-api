import { test, expect } from "bun:test"
import { pickResetTime } from "../src/services/antigravity/quota-fetch"
import { buildAntigravityBars } from "../src/services/quota-aggregator"

test("pickResetTime prefers explicit model reset time", () => {
    const models = {
        "model-a": { resetTime: "2025-01-02T00:00:00Z" },
        "model-b": { resetTime: "2025-01-01T00:00:00Z" },
    }

    expect(pickResetTime(models, "model-a")).toBe("2025-01-02T00:00:00Z")
})

test("pickResetTime falls back to earliest valid reset time", () => {
    const models = {
        "model-a": { resetTime: "not-a-date" },
        "model-b": { resetTime: "2025-01-03T00:00:00Z" },
        "model-c": { resetTime: "2025-01-01T12:00:00Z" },
    }

    expect(pickResetTime(models)).toBe("2025-01-01T12:00:00Z")
})

test("buildAntigravityBars uses summary weekly/5h buckets and unified Gemini pool", () => {
    const models = {
        "claude-opus-5-5-high": { remainingFraction: 0.49, resetTime: "2026-11-25T00:07:19Z" },
        "gpt-oss-120b-medium": { remainingFraction: 0.49, resetTime: "2026-11-25T00:07:19Z" },
        "gemini-4-hydrogen-sonar": { remainingFraction: 0.84, resetTime: "2026-11-20T11:12:47Z" },
        "gemini-3.8-flash-tiered": { remainingFraction: 0.84, resetTime: "2026-11-20T11:12:47Z" },
        "gemini-3-flash": { remainingFraction: 0.84, resetTime: "2026-11-20T11:12:47Z" },
    }
    const summaryGroups = [
        {
            displayName: "Gemini Models",
            buckets: [
                { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.32, resetTime: "2026-11-25T01:43:19Z" },
                { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.79, resetTime: "2026-11-20T11:12:47Z" },
            ],
        },
        {
            displayName: "Claude and GPT models",
            buckets: [
                { bucketId: "3p-weekly", window: "weekly", remainingFraction: 0.486884, resetTime: "2026-11-25T00:07:19Z" },
                { bucketId: "3p-5h", window: "5h", remainingFraction: 1, resetTime: "2026-11-20T12:15:33Z" },
            ],
        },
        {
            displayName: "Gemini 4 Argon",
            buckets: [
                { bucketId: "gemini-argon-wtu-weekly", window: "weekly", remainingFraction: 0.8179, resetTime: "2026-11-25T01:43:59Z" },
            ],
        },
    ]

    const bars = buildAntigravityBars(models, summaryGroups)
    expect(bars).toEqual([
        { key: "claude_gpt", label: "Claude & GPT · Weekly", percentage: 49, resetTime: "2026-11-25T00:07:19Z" },
        { key: "claude_gpt_5h", label: "Claude & GPT · 5h", percentage: 100, resetTime: "2026-11-20T12:15:33Z" },
        { key: "gemini_weekly", label: "Gemini · Weekly", percentage: 32, resetTime: "2026-11-25T01:43:19Z" },
        { key: "gemini", label: "Gemini · 5h", percentage: 79, resetTime: "2026-11-20T11:12:47Z" },
        { key: "gemini_argon", label: "Gemini 4 Argon · Weekly", percentage: 82, resetTime: "2026-11-25T01:43:59Z" },
    ])
})
