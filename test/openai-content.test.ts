import { expect, test } from "bun:test"
import { RequestValidationError } from "~/lib/error"
import { translateMessages, translateOpenAIContent, translateTools } from "~/routes/openai/translator"
import { toOpenAIMessages, toOpenAIResponsesContent } from "~/services/providers/openai-adapter"

test("OpenAI multimodal content keeps text and data images", () => {
    const content = translateOpenAIContent([
        { type: "text", text: "describe this" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
    ])

    expect(content).toEqual([
        { type: "text", text: "describe this" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
    ])

    const roundTrip = toOpenAIMessages([{ role: "user", content: content as any }])
    expect(roundTrip[0].content).toEqual([
        { type: "text", text: "describe this" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
    ])

    expect(toOpenAIResponsesContent(roundTrip[0].content, "user")).toEqual([
        { type: "input_text", text: "describe this" },
        { type: "input_image", image_url: "data:image/png;base64,AQID" },
    ])
})

test("OpenAI remote image URLs are represented as URL image sources", () => {
    const messages = translateMessages([{
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.com/image.jpg" } }],
    }])
    expect(messages[0].content).toEqual([{
        type: "image",
        source: { type: "url", url: "https://example.com/image.jpg" },
    }])
})

test("OpenAI rejects unsupported image URL schemes", () => {
    expect(() => translateOpenAIContent([
        { type: "image_url", image_url: { url: "file:///tmp/secret.png" } },
    ])).toThrow(RequestValidationError)
})

test("OpenAI rejects malformed inline image data and tool arguments", () => {
    expect(() => translateOpenAIContent([
        { type: "image_url", image_url: { url: "data:image/png;base64,not-valid!" } },
    ])).toThrow(RequestValidationError)

    expect(() => translateMessages([{
        role: "assistant",
        content: null,
        tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "lookup", arguments: "{" },
        }],
    }] as any)).toThrow(RequestValidationError)

    expect(() => translateOpenAIContent([{
        type: "image_url",
        image_url: { url: 42 },
    }] as any)).toThrow(RequestValidationError)
    expect(() => translateMessages([{
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", function: null }],
    }] as any)).toThrow(RequestValidationError)
})

test("OpenAI accepts valid inline images near the 10 MiB limit", () => {
    const encoded = Buffer.alloc(8 * 1024 * 1024, 7).toString("base64")
    const content = translateOpenAIContent([
        { type: "image_url", image_url: { url: `data:image/png;base64,${encoded}` } },
    ])

    expect(content).toEqual([{
        type: "image",
        source: { type: "base64", media_type: "image/png", data: encoded },
    }])
})

test("OpenAI rejects malformed tool definitions as request validation errors", () => {
    expect(() => translateTools([{ function: null }] as any)).toThrow(RequestValidationError)
    expect(() => translateTools([{ function: { name: "lookup", parameters: [] } }] as any)).toThrow(RequestValidationError)
})
