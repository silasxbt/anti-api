import { test, expect } from "bun:test"
import { mapModel, translateMessages, translateTools, mapStopReason } from "../src/routes/openai/translator"

test("mapModel preserves standard model names without hijacking them", () => {
    expect(mapModel("gpt-4")).toBe("gpt-4")
    expect(mapModel("gpt-4o")).toBe("gpt-4o")
    expect(mapModel("o1")).toBe("o1")
})

test("mapModel applies reasoning effort to tiered models", () => {
    expect(mapModel("gemini-4-argon", "high")).toBe("gemini-4-argon-high")
    expect(mapModel("gemini-3.8-flash", "low")).toBe("gemini-3.8-flash-low")
    expect(mapModel("claude-opus-5-5", "high")).toBe("claude-opus-5-5-high")
    expect(mapModel("claude-3-7-sonnet", "high")).toBe("claude-sonnet-5-5-high")
    expect(mapModel("claude-3-5-sonnet", "medium")).toBe("claude-sonnet-4-5-thinking")
    expect(mapModel("claude-3-5-sonnet")).toBe("claude-sonnet-4-5")
})

test("mapModel returns original model for unknown models", () => {
    expect(mapModel("claude-sonnet-4-5")).toBe("claude-sonnet-4-5")
    expect(mapModel("custom-model")).toBe("custom-model")
})

test("translateMessages converts user messages", () => {
    const messages = [
        { role: "user" as const, content: "Hello" }
    ]
    const result = translateMessages(messages)
    expect(result[0].role).toBe("user")
    expect(result[0].content).toBe("Hello")
})

test("translateMessages converts system to user", () => {
    const messages = [
        { role: "system" as const, content: "You are helpful" }
    ]
    const result = translateMessages(messages)
    expect(result[0].role).toBe("user")
})

test("translateMessages handles tool calls and preserves thought_signature", () => {
    const messages = [
        {
            role: "assistant" as const,
            content: null,
            tool_calls: [{
                id: "call_1",
                type: "function" as const,
                function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
                thought_signature: "sig_test_123",
            } as any]
        }
    ]
    const result = translateMessages(messages)
    expect(result[0].role).toBe("assistant")
    expect(Array.isArray(result[0].content)).toBe(true)
    const content = result[0].content as any[]
    expect(content[0].type).toBe("tool_use")
    expect(content[0].name).toBe("get_weather")
    expect(content[0].thought_signature).toBe("sig_test_123")
    expect(content[0].thoughtSignature).toBe("sig_test_123")
})

test("translateMessages handles tool results", () => {
    const messages = [
        { role: "tool" as const, tool_call_id: "call_1", content: "Sunny" }
    ]
    const result = translateMessages(messages)
    expect(result[0].role).toBe("user")
    const content = result[0].content as any[]
    expect(content[0].type).toBe("tool_result")
    expect(content[0].tool_use_id).toBe("call_1")
})

test("translateTools converts OpenAI tools to Claude format", () => {
    const tools = [{
        type: "function" as const,
        function: {
            name: "search",
            description: "Search the web",
            parameters: { type: "object", properties: { query: { type: "string" } } }
        }
    }]
    const result = translateTools(tools)
    expect(result).toBeDefined()
    expect(result![0].name).toBe("search")
    expect(result![0].description).toBe("Search the web")
})

test("translateTools returns undefined for empty array", () => {
    expect(translateTools([])).toBeUndefined()
    expect(translateTools(undefined)).toBeUndefined()
})

test("mapStopReason converts Anthropic reasons to OpenAI format", () => {
    expect(mapStopReason("end_turn")).toBe("stop")
    expect(mapStopReason("tool_use")).toBe("tool_calls")
    expect(mapStopReason("max_tokens")).toBe("length")
    expect(mapStopReason("content_filter")).toBe("content_filter")
    expect(mapStopReason("unknown")).toBe("stop")
})
