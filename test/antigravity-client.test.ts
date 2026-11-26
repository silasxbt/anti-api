import { expect, test } from "bun:test"
import { getAntigravityUserAgent, refreshAntigravityIdeVersion } from "~/lib/antigravity-client"

test("Antigravity Hub user agent matches the native manifest platform", () => {
    expect(getAntigravityUserAgent()).toMatch(/^antigravity\/hub\/[^\s]+ darwin\/arm64$/)
})

test("Antigravity version refresh uses the native updater request profile", async () => {
    const version = await refreshAntigravityIdeVersion((async (_input, init) => {
        const headers = new Headers(init?.headers)
        expect(headers.get("User-Agent")).toBe("electron-builder")
        expect(headers.get("Cache-Control")).toBe("no-cache")
        return new Response("version: 2.9.7\n", { status: 200 })
    }) as typeof fetch)

    expect(version).toBe("2.9.7")
})
