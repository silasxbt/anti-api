import { expect, test } from "bun:test"
import { buildAntigravityParts, buildGenerationConfig, claudeToAntigravity, getAntigravityModelName } from "~/services/antigravity/chat"

test("Gemini 3.1 generation config omits legacy safety settings and caps output", async () => {
    expect(buildGenerationConfig("gemini-3.1-pro-low", 100000)).toEqual({ maxOutputTokens: 65536 })
    const request = await claudeToAntigravity("gemini-3.1-pro-low", [{ role: "user", content: "hello" }], undefined, undefined, 100000)
    expect(request.request.generationConfig).toEqual({ maxOutputTokens: 65536 })
    expect(request.request.safetySettings).toBeUndefined()
})

test("Gemini 3.1 aliases resolve to current native Antigravity model IDs", async () => {
    expect(getAntigravityModelName("gemini-3.1-pro-high")).toBe("gemini-pro-agent")
    expect(getAntigravityModelName("gemini-3.1-flash")).toBe("gemini-3.1-flash")

    const request = await claudeToAntigravity(
        getAntigravityModelName("gemini-3.1-pro-high"),
        [{ role: "user", content: "hello" }],
        undefined,
        undefined,
        100000,
    )
    expect(request.model).toBe("gemini-pro-agent")
    expect(request.request.generationConfig).toEqual({ maxOutputTokens: 65536 })
    expect(request.request.safetySettings).toBeUndefined()
})

test("Antigravity request builder emits inline data for image blocks", async () => {
    const parts = await buildAntigravityParts([
        { type: "text", text: "what is this?" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
    ], new Map())

    expect(parts).toEqual([
        { text: "what is this?" },
        { inlineData: { mimeType: "image/png", data: "AQID" } },
    ])
})
