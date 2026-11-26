/**
 * 2026-10-02 Regression: per-model 429 must not poison the whole account.
 *
 * Bug: gemini-3.8-flash-high returned 429 (upstream has no such model entity).
 * That marked the single account rate-limited for 8-10s, so claude-sonnet-4-6
 * and gemini-3-flash — both healthy at that moment — also failed with
 * 400 "No account routing entries available".
 *
 * Rule under test: an account-level cooldown requires forceAccountScope.
 */
import { beforeEach, describe, expect, it } from "bun:test"
import { AccountManager } from "../account-manager"

const testManager = new AccountManager({ persist: false })

function makeManager() {
    testManager.addAccount({
        id: "acc-1",
        email: "test@example.com",
        accessToken: "tok",
        refreshToken: "ref",
        projectId: "proj",
    } as never)
    return testManager
}

// accountManager 是單例，前一個測試可能已把它標記為限流
beforeEach(() => {
    makeManager().markSuccess("acc-1")
})

describe("markRateLimitedFromError scope", () => {
    it("does NOT block the account for a plain 429 without explicit scope", async () => {
        const m = makeManager()
        const res = await m.markRateLimitedFromError("acc-1", 429, "Resource has been exhausted.")
        expect(res).toBeNull()
        expect(m.isAccountRateLimited("acc-1")).toBe(false)
    })

    it("DOES block the account when the caller declares account scope", async () => {
        const m = makeManager()
        await m.markRateLimitedFromError(
            "acc-1",
            429,
            "Resource has been exhausted.",
            undefined,
            undefined,
            { maxDurationMs: 60_000, forceAccountScope: true },
        )
        expect(m.isAccountRateLimited("acc-1")).toBe(true)
    })

    it("never account-cools-down for 404 even with a long maxDurationMs", async () => {
            // 404 是「上游找不到這個 model entity」，不是配額訊號。
            // 即使呼叫方給了 60s 的 maxDurationMs 也不該冷卻帳號。
            const m = makeManager()
            const res = await m.markRateLimitedFromError("acc-1", 404, "Requested entity was not found.", undefined, undefined, {
                maxDurationMs: 60_000,
                forceAccountScope: true,
            })
            expect(res).toBeNull()
            expect(m.isAccountRateLimited("acc-1")).toBe(false)
        })

    it("applies per-model cooldown without blocking unrelated models or the account", async () => {
        const m = makeManager()
        const res = await m.markRateLimitedFromError(
            "acc-1",
            429,
            "Resource has been exhausted.",
            undefined,
            "gemini-3.5-flash-lite",
        )
        expect(res).toBeNull()
        expect(m.isAccountRateLimited("acc-1")).toBe(false)
        expect(m.isModelRateLimited("acc-1", "gemini-3.5-flash-lite")).toBe(true)
        expect(m.isModelRateLimited("acc-1", "gemini-4-argon-low")).toBe(false)
    })
})