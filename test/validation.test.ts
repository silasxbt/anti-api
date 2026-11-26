import { test, expect } from "bun:test"
import { validateChatRequest, validateAnthropicRequest, validateAccountId, sanitizeString } from "../src/lib/validation"
import { MAX_MESSAGES_PER_REQUEST, MAX_TOOLS_PER_REQUEST } from "../src/lib/constants"

test("validateChatRequest accepts valid request", () => {
    const result = validateChatRequest({
        model: "claude-sonnet-4-5",
        messages: [{ role: "user", content: "Hello" }]
    })
    expect(result.valid).toBe(true)
})

test("validateChatRequest rejects missing model", () => {
    const result = validateChatRequest({
        messages: [{ role: "user", content: "Hello" }]
    })
    expect(result.valid).toBe(false)
    expect(result.error).toContain("Model")
})

test("validateChatRequest rejects empty messages", () => {
    const result = validateChatRequest({
        model: "claude-sonnet-4-5",
        messages: []
    })
    expect(result.valid).toBe(false)
    expect(result.error).toContain("empty")
})

test("validateChatRequest rejects invalid role", () => {
    const result = validateChatRequest({
        model: "claude-sonnet-4-5",
        messages: [{ role: "invalid", content: "Hello" }]
    })
    expect(result.valid).toBe(false)
    expect(result.error).toContain("Invalid role")
})

test("validateChatRequest rejects invalid max_tokens", () => {
    const result = validateChatRequest({
        model: "claude-sonnet-4-5",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: -1
    })
    expect(result.valid).toBe(false)
    expect(result.error).toContain("max_tokens")
})

test("validateChatRequest rejects invalid temperature", () => {
    const result = validateChatRequest({
        model: "claude-sonnet-4-5",
        messages: [{ role: "user", content: "Hello" }],
        temperature: 3
    })
    expect(result.valid).toBe(false)
    expect(result.error).toContain("temperature")
})

test("validateAnthropicRequest accepts valid request", () => {
    const result = validateAnthropicRequest({
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Hello" }]
    })
    expect(result.valid).toBe(true)
})

test("validateAnthropicRequest rejects missing model", () => {
    const result = validateAnthropicRequest({
        max_tokens: 1024,
        messages: [{ role: "user", content: "Hello" }]
    })
    expect(result.valid).toBe(false)
})

test("validateAnthropicRequest rejects too many messages", () => {
    const result = validateAnthropicRequest({
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        messages: Array.from({ length: MAX_MESSAGES_PER_REQUEST + 1 }, () => ({ role: "user", content: "Hello" })),
    })
    expect(result.valid).toBe(false)
    expect(result.error).toBe(`Too many messages (max ${MAX_MESSAGES_PER_REQUEST})`)
})

test("validateAnthropicRequest rejects too many tools", () => {
    const result = validateAnthropicRequest({
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Hello" }],
        tools: Array.from({ length: MAX_TOOLS_PER_REQUEST + 1 }, () => ({})),
    })
    expect(result.valid).toBe(false)
    expect(result.error).toBe(`Too many tools (max ${MAX_TOOLS_PER_REQUEST})`)
})

test("validateAccountId accepts valid IDs", () => {
    expect(validateAccountId("user@example.com")).toBe(true)
    expect(validateAccountId("account-123")).toBe(true)
    expect(validateAccountId("user_name.123")).toBe(true)
})

test("validateAccountId rejects invalid IDs", () => {
    expect(validateAccountId("")).toBe(false)
    expect(validateAccountId("user<script>")).toBe(false)
    expect(validateAccountId("a".repeat(300))).toBe(false)
})

test("sanitizeString truncates long strings", () => {
    const longString = "a".repeat(20000)
    const result = sanitizeString(longString, 100)
    expect(result.length).toBe(100)
})

test("sanitizeString handles non-strings", () => {
    expect(sanitizeString(123 as any)).toBe("")
    expect(sanitizeString(null as any)).toBe("")
})
