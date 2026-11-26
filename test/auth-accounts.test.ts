import { describe, expect, test } from "bun:test"
import { authRouter } from "~/routes/auth/route"

describe("auth account listing", () => {
    test("includes every supported provider", async () => {
        const response = await authRouter.request("http://localhost/accounts")
        expect(response.status).toBe(200)

        const body = await response.json() as { accounts: Record<string, unknown> }
        expect(Object.keys(body.accounts).sort()).toEqual([
            "antigravity",
            "codex",
            "copilot",
            "grok",
            "kiro",
            "zed",
        ])
    })
})
