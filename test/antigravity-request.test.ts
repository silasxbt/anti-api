import { expect, test } from "bun:test"
import {
    buildAntigravityParts,
    buildGenerationConfig,
    claudeToAntigravity,
    getAntigravityModelName,
    getToolSignatureKey,
    parseApiResponse,
    thoughtSignatureCache,
} from "~/services/antigravity/chat"

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

test("Gemini models attach tools and use AUTO function calling mode", async () => {
    const tools = [{
        name: "terminal",
        description: "Run shell command",
        input_schema: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"]
        }
    }]

    const request = await claudeToAntigravity(
        "gemini-3.8-flash-medium",
        [{ role: "user", content: "update servers" }],
        tools
    )

    expect(request.request.tools).toBeDefined()
    expect(request.request.tools.length).toBe(1)
    expect(request.request.tools[0].functionDeclarations[0].name).toBe("terminal")
    expect(request.request.toolConfig).toEqual({ functionCallingConfig: { mode: "AUTO" } })
})

test("Gemini models with specific tool choice use ANY mode with allowed function names", async () => {
    const tools = [{
        name: "terminal",
        description: "Run shell command",
        input_schema: { type: "object", properties: {} }
    }]

    const request = await claudeToAntigravity(
        "gemini-3.8-flash-medium",
        [{ role: "user", content: "run command" }],
        tools,
        { type: "tool", name: "terminal" }
    )

    expect(request.request.toolConfig).toEqual({
        functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["terminal"] }
    })
})

test("Claude models attach tools and use AUTO function calling mode", async () => {
    const tools = [{
        name: "search",
        description: "Search web",
        input_schema: { type: "object", properties: {} }
    }]

    const request = await claudeToAntigravity(
        "claude-sonnet-4-5",
        [{ role: "user", content: "search web" }],
        tools
    )

    expect(request.request.tools).toBeDefined()
    expect(request.request.tools[0].functionDeclarations[0].name).toBe("search")
    expect(request.request.toolConfig).toEqual({ functionCallingConfig: { mode: "AUTO" } })
})

test("Claude models without tools omit toolConfig", async () => {
    const request = await claudeToAntigravity(
        "claude-sonnet-4-5",
        [{ role: "user", content: "hello" }]
    )

    expect(request.request.tools).toBeUndefined()
    expect(request.request.toolConfig).toBeUndefined()
})

test("Gemini models without tools omit toolConfig", async () => {
    const request = await claudeToAntigravity(
        "gemini-3.8-flash-medium",
        [{ role: "user", content: "hello" }]
    )

    expect(request.request.tools).toBeUndefined()
    expect(request.request.toolConfig).toBeUndefined()
})

test("buildAntigravityParts injects thoughtSignature from block or cache", async () => {
    // 1. Explicit signature on block
    const partsWithBlockSig = await buildAntigravityParts([
        {
            type: "tool_use",
            id: "call_abc123",
            name: "search_files",
            input: { path: "/tmp" },
            thoughtSignature: "sig_direct",
        } as any,
    ], new Map())

    expect(partsWithBlockSig[0].thoughtSignature).toBe("sig_direct")
    expect(partsWithBlockSig[0].functionCall.name).toBe("search_files")

    // 2. Cached by toolId
    thoughtSignatureCache.set("call_cached_id", "sig_from_cache_id")
    const partsCachedById = await buildAntigravityParts([
        {
            type: "tool_use",
            id: "call_cached_id",
            name: "search_files",
            input: { query: "hello" },
        },
    ], new Map())

    expect(partsCachedById[0].thoughtSignature).toBe("sig_from_cache_id")

    // 3. Cached by toolName:args when ID is changed/unknown
    const argsKey = getToolSignatureKey("search_files", { target: "files", order: "discovery" })
    thoughtSignatureCache.set(argsKey, "sig_from_cache_args")
    const partsCachedByArgs = await buildAntigravityParts([
        {
            type: "tool_use",
            id: "call_unknown_id",
            name: "search_files",
            input: { order: "discovery", target: "files" }, // note key order difference to verify canonicalization
        },
    ], new Map())

    expect(partsCachedByArgs[0].thoughtSignature).toBe("sig_from_cache_args")

    // 4. Missing signature for Gemini models falls back to skip_thought_signature_validator
    const partsFallbackGemini = await buildAntigravityParts([
        {
            type: "tool_use",
            id: "call_missing_sig",
            name: "default_api:terminal",
            input: { command: "ls -la" },
        },
    ], new Map(), { model: "gemini-3.8-flash-medium" })

    expect(partsFallbackGemini[0].thoughtSignature).toBe("skip_thought_signature_validator")

    // 5. Missing signature for Claude models also injects fallback
    const partsClaude = await buildAntigravityParts([
        {
            type: "tool_use",
            id: "call_claude_no_sig",
            name: "random_unique_tool_name_test",
            input: { path: "foo.txt" },
        },
    ], new Map(), { model: "claude-sonnet-4-5" })

    expect(partsClaude[0].thoughtSignature).toBe("skip_thought_signature_validator")
})

test("parseApiResponse handles MAX_TOKENS without content gracefully", () => {
    const raw = JSON.stringify([{
        response: {
            candidates: [{
                finishReason: "MAX_TOKENS",
                content: { parts: [] }
            }],
            usageMetadata: {
                promptTokenCount: 100,
                thoughtsTokenCount: 65536,
                candidatesTokenCount: 0
            }
        }
    }])

    const res = parseApiResponse(raw)
    expect(res.stopReason).toBe("max_tokens")
    expect(res.contentBlocks).toEqual([{ type: "text", text: "" }])
    expect(res.usage.outputTokens).toBe(65536)
})

