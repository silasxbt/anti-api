import { beforeEach, describe, expect, test } from "bun:test"
import {
    computeTimeUrgencyMultiplier,
    getAccountQuotaValueEstimate,
    rankAccountCandidates,
    recordIntelligentDispatch,
    recordIntelligentTokenUsage,
    registerQuotaRefreshTrigger,
    resetIntelligentRoutingState,
    scoreAccountCandidate,
    syncIntelligentQuotaCache,
    type QuotaRefreshReason,
} from "~/services/routing/intelligent-scorer"
import {
    computeEffectiveTokenLoad,
    estimateRequestCostUsd,
    getUsage,
    recordUsage,
    resetUsage,
} from "~/services/usage-tracker"

const HOUR_MS = 3600 * 1000

describe("Intelligent Routing Scorer", () => {
    const baseNow = Date.parse("2026-10-26T22:00:00Z")

    beforeEach(() => {
        resetIntelligentRoutingState()
        registerQuotaRefreshTrigger(null)
    })

    test("heavily prioritizes 50% Argon resetting in 5h over 100% Argon resetting in 168h", () => {
        // Account A: 50% Argon left, resetting in 5 hours
        syncIntelligentQuotaCache("antigravity", "acc-expiring-50", [
            {
                key: "argon_week",
                label: "weekly argon",
                percentage: 50,
                resetTime: new Date(baseNow + 5 * HOUR_MS).toISOString(),
            },
        ])

        // Account B: 100% Argon left, resetting in 160 hours (nearly full 7-day window)
        syncIntelligentQuotaCache("antigravity", "acc-fresh-100", [
            {
                key: "argon_week",
                label: "weekly argon",
                percentage: 100,
                resetTime: new Date(baseNow + 160 * HOUR_MS).toISOString(),
            },
        ])

        const scoreExpiring = scoreAccountCandidate({
            provider: "antigravity",
            accountId: "acc-expiring-50",
            model: "gemini-4-argon",
            now: baseNow,
        })
        const scoreFresh = scoreAccountCandidate({
            provider: "antigravity",
            accountId: "acc-fresh-100",
            model: "gemini-4-argon",
            now: baseNow,
        })

        expect(scoreExpiring.totalScore).toBeGreaterThan(scoreFresh.totalScore * 2.5)
        expect(scoreExpiring.urgencyMultiplier).toBeGreaterThan(4.0)
        expect(scoreFresh.urgencyMultiplier).toBeLessThan(1.1)

        // Consecutive new chats should keep routing to the 50% expiring account to finish its quota
        const candidates = [
            { provider: "antigravity", accountId: "acc-fresh-100" },
            { provider: "antigravity", accountId: "acc-expiring-50" },
        ]

        for (let i = 0; i < 15; i++) {
            const ranked = rankAccountCandidates(candidates, {
                model: "gemini-4-argon",
                sessionKey: `new_session_${i}`,
                now: baseNow + i * 1000,
            })
            expect(ranked[0].entry.accountId).toBe("acc-expiring-50")
            recordIntelligentDispatch(
                "antigravity",
                ranked[0].entry.accountId,
                `new_session_${i}`,
                "gemini-4-argon",
                baseNow + i * 1000
            )
        }
    })

    test("mostly weights the weekly (total) reset (95%) over the 5-hour window (5%)", () => {
        // Account A: 70% weekly quota resetting in 6h (high weekly urgency), 5h bar at 40% resetting in 4h
        syncIntelligentQuotaCache("antigravity", "acc-weekly-urgent", [
            {
                key: "claude_gpt_week",
                label: "weekly claude gpt",
                percentage: 70,
                resetTime: new Date(baseNow + 6 * HOUR_MS).toISOString(),
            },
            {
                key: "claude_gpt_5h",
                label: "5hr claude gpt",
                percentage: 40,
                resetTime: new Date(baseNow + 4 * HOUR_MS).toISOString(),
            },
        ])

        // Account B: 90% weekly quota resetting in 150h (low weekly urgency), 5h bar at 90% resetting in 0.5h (urgent 5h)
        syncIntelligentQuotaCache("antigravity", "acc-5h-urgent-only", [
            {
                key: "claude_gpt_week",
                label: "weekly claude gpt",
                percentage: 90,
                resetTime: new Date(baseNow + 150 * HOUR_MS).toISOString(),
            },
            {
                key: "claude_gpt_5h",
                label: "5hr claude gpt",
                percentage: 90,
                resetTime: new Date(baseNow + 0.5 * HOUR_MS).toISOString(),
            },
        ])

        const scoreWeeklyUrgent = scoreAccountCandidate({
            provider: "antigravity",
            accountId: "acc-weekly-urgent",
            model: "claude-opus-5-5",
            now: baseNow,
        })
        const score5hUrgentOnly = scoreAccountCandidate({
            provider: "antigravity",
            accountId: "acc-5h-urgent-only",
            model: "claude-opus-5-5",
            now: baseNow,
        })

        // Effective quota fraction uses the weekly total quota (0.70), not the 0.40 5h bar
        expect(scoreWeeklyUrgent.effectiveQuotaFraction).toBeCloseTo(0.7, 2)
        // Weekly urgency strongly wins over 5h-only urgency because weekly weight is 95%
        expect(scoreWeeklyUrgent.totalScore).toBeGreaterThan(score5hUrgentOnly.totalScore)
    })

    test("distributes load across accounts when quota and reset time are close", () => {
        // Account 1: 80% Argon, resets in 100h
        syncIntelligentQuotaCache("antigravity", "acc-close-1", [
            {
                key: "argon_week",
                label: "weekly argon",
                percentage: 80,
                resetTime: new Date(baseNow + 100 * HOUR_MS).toISOString(),
            },
        ])

        // Account 2: 82% Argon, resets in 104h
        syncIntelligentQuotaCache("antigravity", "acc-close-2", [
            {
                key: "argon_week",
                label: "weekly argon",
                percentage: 82,
                resetTime: new Date(baseNow + 104 * HOUR_MS).toISOString(),
            },
        ])

        const candidates = [
            { provider: "antigravity", accountId: "acc-close-1" },
            { provider: "antigravity", accountId: "acc-close-2" },
        ]

        const chosenCounts: Record<string, number> = { "acc-close-1": 0, "acc-close-2": 0 }
        for (let i = 0; i < 10; i++) {
            const ranked = rankAccountCandidates(candidates, {
                model: "gemini-4-argon",
                sessionKey: `chat_${i}`,
                now: baseNow + i * 5000,
            })
            const winner = ranked[0].entry.accountId
            chosenCounts[winner]++
            recordIntelligentDispatch("antigravity", winner, `chat_${i}`, "gemini-4-argon", baseNow + i * 5000)
        }

        // Both close accounts should receive roughly half the load (at least 4 each out of 10)
        expect(chosenCounts["acc-close-1"]).toBeGreaterThanOrEqual(4)
        expect(chosenCounts["acc-close-2"]).toBeGreaterThanOrEqual(4)
    })

    test("preserves warm prompt cache within 5-minute TTL, then migrates to urgent account after cache expiry", () => {
        // Account 1 (urgent): 60% Claude resetting in 6h
        syncIntelligentQuotaCache("antigravity", "acc-urgent", [
            {
                key: "claude_gpt_week",
                label: "weekly claude gpt",
                percentage: 60,
                resetTime: new Date(baseNow + 6 * HOUR_MS).toISOString(),
            },
        ])

        // Account 2 (normal): 95% Claude resetting in 150h
        syncIntelligentQuotaCache("antigravity", "acc-normal", [
            {
                key: "claude_gpt_week",
                label: "weekly claude gpt",
                percentage: 95,
                resetTime: new Date(baseNow + 150 * HOUR_MS).toISOString(),
            },
        ])

        const candidates = [
            { provider: "antigravity", accountId: "acc-urgent" },
            { provider: "antigravity", accountId: "acc-normal" },
        ]

        // Suppose an existing session was started on acc-normal 30 seconds ago (warm prompt cache!)
        const sessionKey = "ag_sess_active_coding"
        recordIntelligentDispatch("antigravity", "acc-normal", sessionKey, "claude-opus-5-5", baseNow)

        const warmRanked = rankAccountCandidates(candidates, {
            model: "claude-opus-5-5",
            sessionKey,
            now: baseNow + 30 * 1000, // 30s later: warm cache bonus keeps it on acc-normal
        })
        expect(warmRanked[0].entry.accountId).toBe("acc-normal")
        expect(warmRanked[0].score.cacheAffinityBonus).toBeGreaterThan(300)

        // 20 minutes later, upstream prompt cache has expired -> session migrates to acc-urgent!
        const coldRanked = rankAccountCandidates(candidates, {
            model: "claude-opus-5-5",
            sessionKey,
            now: baseNow + 20 * 60 * 1000,
        })
        expect(coldRanked[0].entry.accountId).toBe("acc-urgent")
    })

    test("isolates quota pools by requested model family (argon vs claude_gpt vs gemini)", () => {
        // Account 1: 0% Argon, 90% Claude/GPT
        syncIntelligentQuotaCache("antigravity", "acc-no-argon", [
            { key: "argon_week", label: "weekly argon", percentage: 0 },
            {
                key: "claude_gpt_week",
                label: "weekly claude gpt",
                percentage: 90,
                resetTime: new Date(baseNow + 48 * HOUR_MS).toISOString(),
            },
        ])

        // Account 2: 50% Argon, 0% Claude/GPT
        syncIntelligentQuotaCache("antigravity", "acc-has-argon", [
            {
                key: "argon_week",
                label: "weekly argon",
                percentage: 50,
                resetTime: new Date(baseNow + 48 * HOUR_MS).toISOString(),
            },
            { key: "claude_gpt_week", label: "weekly claude gpt", percentage: 0 },
        ])

        const candidates = [
            { provider: "antigravity", accountId: "acc-no-argon" },
            { provider: "antigravity", accountId: "acc-has-argon" },
        ]

        const argonRanked = rankAccountCandidates(candidates, {
            model: "gemini-4-argon",
            now: baseNow,
        })
        expect(argonRanked[0].entry.accountId).toBe("acc-has-argon")
        expect(argonRanked[1].score.exhausted).toBe(true)

        const claudeRanked = rankAccountCandidates(candidates, {
            model: "claude-opus-5-5",
            now: baseNow,
        })
        expect(claudeRanked[0].entry.accountId).toBe("acc-no-argon")
        expect(claudeRanked[1].score.exhausted).toBe(true)
    })

    test("prefers an already-ticking account over starting an untriggered 100% reserve window", () => {
        // Account 1: 100% untriggered (no resetTime yet)
        syncIntelligentQuotaCache("antigravity", "acc-untriggered-100", [
            { key: "argon_week", label: "weekly argon", percentage: 100 },
        ])

        // Account 2: 90% with active timer (120h left)
        syncIntelligentQuotaCache("antigravity", "acc-ticking-90", [
            {
                key: "argon_week",
                label: "weekly argon",
                percentage: 90,
                resetTime: new Date(baseNow + 120 * HOUR_MS).toISOString(),
            },
        ])

        const candidates = [
            { provider: "antigravity", accountId: "acc-untriggered-100" },
            { provider: "antigravity", accountId: "acc-ticking-90" },
        ]

        const ranked = rankAccountCandidates(candidates, {
            model: "gemini-4-argon",
            now: baseNow,
        })
        expect(ranked[0].entry.accountId).toBe("acc-ticking-90")
        expect(ranked[1].score.untriggeredPenalty).toBeGreaterThan(0)
    })

    test("treats past resetTime as already reset to 100%", () => {
        // Cached bar had 0% quota, but its resetTime was 10 minutes ago
        syncIntelligentQuotaCache("antigravity", "acc-just-reset", [
            {
                key: "argon_week",
                label: "weekly argon",
                percentage: 0,
                resetTime: new Date(baseNow - 10 * 60 * 1000).toISOString(),
            },
        ])

        const score = scoreAccountCandidate({
            provider: "antigravity",
            accountId: "acc-just-reset",
            model: "gemini-4-argon",
            now: baseNow,
        })
        expect(score.exhausted).toBe(false)
        expect(score.effectiveQuotaFraction).toBe(1)
    })

    test("discounts prompt-cached tokens (0.1x) and calibrates Percentage-to-Value from quota drops", () => {
        resetUsage()
        // Verify usage-tracker discounts cached tokens at 0.1x
        const costUncached = estimateRequestCostUsd("claude-opus-5-5", 100_000, 1_000, 0)
        const costCached = estimateRequestCostUsd("claude-opus-5-5", 0, 1_000, 100_000)
        // 100k uncached @ $5/M = $0.50 + 1k output @ $25/M = $0.025 -> $0.525
        // 100k cached   @ $0.50/M = $0.05 + 1k output @ $25/M = $0.025 -> $0.075
        expect(costUncached).toBeCloseTo(0.525, 4)
        expect(costCached).toBeCloseTo(0.075, 4)

        const loadUncached = computeEffectiveTokenLoad(100_000, 1_000, 0, "claude-opus-5-5")
        const loadCached = computeEffectiveTokenLoad(0, 1_000, 100_000, "claude-opus-5-5")
        expect(loadCached).toBeLessThan(loadUncached * 0.2)

        recordUsage("claude-opus-5-5", 10_000, 1_000, 90_000)
        const usageStats = getUsage()
        const modelStat = usageStats.models.find(m => m.model === "claude-opus-5-5")
        expect(modelStat).toBeDefined()
        expect(modelStat!.input).toBe(100_000)
        expect(modelStat!.cachedInput).toBe(90_000)
        // Effective input = 10k + 9k = 19k -> $0.095 input + $0.025 output = $0.12
        expect(modelStat!.cost).toBeCloseTo(0.12, 2)

        // Now test Percentage-to-Value calibration in intelligent-scorer:
        const resetIso = new Date(baseNow + 72 * HOUR_MS).toISOString()
        syncIntelligentQuotaCache("antigravity", "acc-cal", [
            { key: "claude_gpt_week", label: "weekly claude gpt", percentage: 80, resetTime: resetIso },
        ])

        // Simulate consuming $2.00 of cache-adjusted value (e.g. 80k output tokens @ $25/M = $2.00)
        recordIntelligentTokenUsage("antigravity", "acc-cal", {
            uncachedInputTokens: 0,
            outputTokens: 80_000,
            cacheReadTokens: 0,
            model: "claude-opus-5-5",
            now: baseNow + 1000,
        })

        // Before next sync, live remaining quota fraction should be reduced by ~$2.00 / ($0.50/%) = 4% -> ~76%
        const midScore = scoreAccountCandidate({
            provider: "antigravity",
            accountId: "acc-cal",
            model: "claude-opus-5-5",
            now: baseNow + 2000,
        })
        expect(midScore.effectiveQuotaFraction).toBeCloseTo(0.76, 2)

        // Suppose upstream quota sync arrives and reports percentage dropped from 80% to 78% (delta = 2% for $2.00 -> $1.00/%)
        syncIntelligentQuotaCache("antigravity", "acc-cal", [
            { key: "claude_gpt_week", label: "weekly claude gpt", percentage: 78, resetTime: resetIso },
        ])

        const estimate = getAccountQuotaValueEstimate("antigravity", "acc-cal", "claude-opus-5-5", baseNow + 3000)
        expect(estimate.calibrationSamples).toBe(1)
        // With hardcoded priors removed, first sample directly observed is $1.00/%
        expect(estimate.valuePerPercentUsd).toBeCloseTo(1.00, 2)
        // 78% remaining * $1.00/% = $78.00 estimated remaining value!
        expect(estimate.estimatedRemainingValueUsd).toBeCloseTo(78.0, 1)
    })

    test("evaluates whether a nearly-finished account can or cannot fit the incoming request using Percentage-to-Value", () => {
        // First, calibrate acc-nearly-empty-1pct and acc-plenty-80pct with observed usage ($0.50/%)
        syncIntelligentQuotaCache("antigravity", "acc-nearly-empty-1pct", [
            { key: "claude_gpt_week", label: "weekly claude gpt", percentage: 10, resetTime: new Date(baseNow + 2 * HOUR_MS).toISOString() },
        ])
        recordIntelligentTokenUsage("antigravity", "acc-nearly-empty-1pct", {
            uncachedInputTokens: 0,
            outputTokens: 180_000, // $4.50
            cacheReadTokens: 0,
            model: "claude-opus-5-5",
            now: baseNow,
        })
        syncIntelligentQuotaCache("antigravity", "acc-nearly-empty-1pct", [
            { key: "claude_gpt_week", label: "weekly claude gpt", percentage: 1, resetTime: new Date(baseNow + 2 * HOUR_MS).toISOString() }, // 9% drop for $4.50 -> $0.50/%
        ])

        syncIntelligentQuotaCache("antigravity", "acc-plenty-80pct", [
            { key: "claude_gpt_week", label: "weekly claude gpt", percentage: 85, resetTime: new Date(baseNow + 120 * HOUR_MS).toISOString() },
        ])
        recordIntelligentTokenUsage("antigravity", "acc-plenty-80pct", {
            uncachedInputTokens: 0,
            outputTokens: 100_000, // $2.50
            cacheReadTokens: 0,
            model: "claude-opus-5-5",
            now: baseNow,
        })
        syncIntelligentQuotaCache("antigravity", "acc-plenty-80pct", [
            { key: "claude_gpt_week", label: "weekly claude gpt", percentage: 80, resetTime: new Date(baseNow + 120 * HOUR_MS).toISOString() }, // 5% drop for $2.50 -> $0.50/%
        ])

        const candidates = [
            { provider: "antigravity", accountId: "acc-nearly-empty-1pct" },
            { provider: "antigravity", accountId: "acc-plenty-80pct" },
        ]

        // Case 1: Small request (2k prompt tokens, ~$0.05 cost) easily fits inside $0.50 remaining value
        // -> Routes to acc-nearly-empty-1pct to finish off its last 1%!
        const smallRanked = rankAccountCandidates(candidates, {
            model: "claude-opus-5-5",
            estimatedPromptTokens: 2_000,
            expectedOutputTokens: 1_000,
            now: baseNow + 11 * 60 * 1000, // advance beyond decayed load window
        })
        expect(smallRanked[0].entry.accountId).toBe("acc-nearly-empty-1pct")
        expect(smallRanked[0].score.insufficientQuotaForRequest).toBe(false)

        // Case 2: Huge COLD (uncached) request (120k prompt tokens + 4k output = ~$0.70 cost, needs $0.875 with margin > $0.50 left)
        // -> Cannot safely fit on acc-nearly-empty-1pct, so it routes to acc-plenty-80pct!
        const hugeColdRanked = rankAccountCandidates(candidates, {
            model: "claude-opus-5-5",
            estimatedPromptTokens: 120_000,
            expectedOutputTokens: 4_000,
            now: baseNow,
        })
        expect(hugeColdRanked[0].entry.accountId).toBe("acc-plenty-80pct")
        const emptyScoreCold = hugeColdRanked.find(r => r.entry.accountId === "acc-nearly-empty-1pct")!.score
        expect(emptyScoreCold.insufficientQuotaForRequest).toBe(true)

        // Case 3: Huge WARM-CACHED request on acc-nearly-empty-1pct (120k prompt tokens, 85% cached @ 0.1x -> ~$0.24 cost)
        // -> Because prompt cache is warm on acc-nearly-empty-1pct, the request only costs ~$0.24 (< $0.50 remaining), so it CAN fit!
        const warmSession = "sess_warm_on_1pct"
        recordIntelligentDispatch("antigravity", "acc-nearly-empty-1pct", warmSession, "claude-opus-5-5", baseNow)
        const hugeWarmRanked = rankAccountCandidates(candidates, {
            model: "claude-opus-5-5",
            sessionKey: warmSession,
            estimatedPromptTokens: 120_000,
            expectedOutputTokens: 1_500,
            now: baseNow + 10_000,
        })
        expect(hugeWarmRanked[0].entry.accountId).toBe("acc-nearly-empty-1pct")
        expect(hugeWarmRanked[0].score.insufficientQuotaForRequest).toBe(false)
    })

    test("triggers proactive background quota refresh when reset passes or live depletion is high", async () => {
        const triggered: Array<{ provider: string; accountId: string; reason: QuotaRefreshReason }> = []
        registerQuotaRefreshTrigger((provider, accountId, reason) => {
            triggered.push({ provider, accountId, reason })
        })

        // 1. Reset time has passed -> should trigger "reset_passed"
        syncIntelligentQuotaCache("antigravity", "acc-expired-timer", [
            {
                key: "argon_week",
                label: "weekly argon",
                percentage: 10,
                resetTime: new Date(baseNow - 60_000).toISOString(),
            },
        ])
        scoreAccountCandidate({
            provider: "antigravity",
            accountId: "acc-expired-timer",
            model: "gemini-4-argon",
            now: baseNow,
        })
        await Promise.resolve()
        expect(triggered.some(t => t.accountId === "acc-expired-timer" && t.reason === "reset_passed")).toBe(true)

        // 2. High live depletion (>= 8%) -> should trigger "high_live_depletion"
        // Calibrate with an initial drop so valuePerPercentUsd is established ($0.50/%)
        syncIntelligentQuotaCache("antigravity", "acc-heavy-use", [
            { key: "claude_gpt_week", label: "weekly claude gpt", percentage: 70, resetTime: new Date(baseNow + 48 * HOUR_MS).toISOString() },
        ])
        recordIntelligentTokenUsage("antigravity", "acc-heavy-use", {
            uncachedInputTokens: 0,
            outputTokens: 200_000, // $5.00
            cacheReadTokens: 0,
            model: "claude-opus-5-5",
            now: baseNow,
        })
        syncIntelligentQuotaCache("antigravity", "acc-heavy-use", [
            { key: "claude_gpt_week", label: "weekly claude gpt", percentage: 60, resetTime: new Date(baseNow + 48 * HOUR_MS).toISOString() }, // 10% drop for $5.00 -> $0.50/%
        ])

        // Now consume $5.00 in the new sync interval (10% depletion >= 8% threshold)
        recordIntelligentTokenUsage("antigravity", "acc-heavy-use", {
            uncachedInputTokens: 0,
            outputTokens: 200_000,
            cacheReadTokens: 0,
            model: "claude-opus-5-5",
            now: baseNow,
        })
        await Promise.resolve()
        expect(triggered.some(t => t.accountId === "acc-heavy-use" && t.reason === "high_live_depletion")).toBe(true)
    })

    test("hybrid urgency curve increases monotonically as reset time approaches", () => {
        const u168h = computeTimeUrgencyMultiplier(1.0)
        const u84h = computeTimeUrgencyMultiplier(0.5)
        const u24h = computeTimeUrgencyMultiplier(24 / 168)
        const u5h = computeTimeUrgencyMultiplier(5 / 168)
        const u1h = computeTimeUrgencyMultiplier(1 / 168)

        expect(u84h).toBeGreaterThan(u168h)
        expect(u24h).toBeGreaterThan(u84h)
        expect(u5h).toBeGreaterThan(u24h)
        expect(u1h).toBeGreaterThan(u5h)
    })
})
