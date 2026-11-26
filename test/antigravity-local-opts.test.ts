import { expect, test } from "bun:test"
import { buildAntigravityParts, claudeToAntigravity, getAntigravityModelName } from "~/services/antigravity/chat"
import { translateMessages } from "~/routes/openai/translator"
import { getModelEnumValue, MODEL_ENUM } from "~/proto/encoder"

test("OpenAI translator preserves extra_content.google.thought_signature on tool_calls", () => {
    const translated = translateMessages([
        { role: "user", content: "hi" },
        {
            role: "assistant",
            content: null,
            tool_calls: [
                {
                    id: "call_1",
                    type: "function",
                    function: { name: "terminal", arguments: "{\"command\":\"ls\"}" },
                    extra_content: { google: { thought_signature: "sig-abc" } },
                },
            ],
        },
        { role: "tool", tool_call_id: "call_1", content: "ok" },
    ])

    const assistantBlocks = translated[1].content as any[]
    expect(assistantBlocks[0].extra_content).toEqual({ google: { thought_signature: "sig-abc" } })
})

test("Gemini 3/4 requests include tools, toolConfig, and sibling thoughtSignature on functionCall and functionResponse", async () => {
    const tools = [{ name: "terminal", description: "run", input_schema: { type: "object", properties: {} } }]
    const messages = [
        { role: "user", content: "hi" },
        {
            role: "assistant",
            content: [
                {
                    type: "tool_use",
                    id: "toolu_sig_1",
                    name: "terminal",
                    input: { command: "pwd" },
                    extra_content: { google: { thought_signature: "real-sig-1" } },
                },
            ],
        },
        {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_sig_1", content: "/tmp" }],
        },
    ] as any

    const req = await claudeToAntigravity("gemini-4-hydrogen-low", messages, tools as any, undefined, 4096)
    expect(req.request.tools?.length).toBe(1)
    expect(req.request.toolConfig?.functionCallingConfig?.mode).toBe("VALIDATED")

    const callPart = req.request.contents[1].parts[0]
    expect(callPart.functionCall.name).toBe("terminal")
    expect(callPart.thoughtSignature).toBe("real-sig-1")
    expect(callPart.functionCall.thoughtSignature).toBeUndefined()

    const respPart = req.request.contents[2].parts[0]
    expect(respPart.functionResponse.id).toBe("toolu_sig_1")
    expect(respPart.thoughtSignature).toBe("skip_thought_signature_validator")
})

test("buildAntigravityParts leaves non-Gemini models without dummy thoughtSignature", async () => {
    const parts = await buildAntigravityParts(
        [{ type: "tool_result", tool_use_id: "toolu_c1", content: "done" }] as any,
        new Map([["toolu_c1", "custom_tool"]]),
        { modelName: "claude-sonnet-5-5-medium" },
    )
    expect(parts[0].thoughtSignature).toBeUndefined()
})

test("Local model mappings and proto enums remain intact", () => {
    expect(getAntigravityModelName("gemini-3.8-flash-tiered")).toBe("gemini-3.8-flash-medium")
    expect(getAntigravityModelName("gemini-4-argon")).toBe("gemini-4-argon-medium")
    expect(getModelEnumValue("gemini-4-argon-high")).toBe(MODEL_ENUM.GEMINI_4_ARGON_HIGH)
    expect(getModelEnumValue("gemini-3.8-flash-high")).toBeUndefined()
})
