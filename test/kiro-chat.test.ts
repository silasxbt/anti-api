import { expect, test } from "bun:test"
import { RequestValidationError } from "~/lib/error"
import { toKiroMessages } from "~/services/kiro/chat"
import type { ClaudeMessage } from "~/lib/translator"

test("Kiro history preserves assistant tool uses for subsequent tool results", async () => {
    const messages: ClaudeMessage[] = [
        {
            role: "assistant",
            content: [
                { type: "text", text: "I will check the weather." },
                { type: "tool_use", id: "toolu_weather", name: "get_weather", input: { city: "Tokyo" } },
            ],
        },
        {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_weather", content: "Sunny" }],
        },
        { role: "user", content: "What should I wear?" },
    ]

    const { history, currentMessage } = await toKiroMessages(messages)
    const assistant = history[0].assistantResponseMessage!
    const toolResult = history[1].userInputMessage!.userInputMessageContext!.toolResults![0]

    expect(assistant.content).toBe("I will check the weather.")
    expect(assistant.toolUses).toEqual([
        { toolUseId: "toolu_weather", name: "get_weather", input: { city: "Tokyo" } },
    ])
    expect(toolResult.toolUseId).toBe("toolu_weather")
    expect(currentMessage.userInputMessage!.content).toBe("What should I wear?")
})

test("Kiro maps supported user images to SDK image bytes", async () => {
    const { currentMessage } = await toKiroMessages([
        {
            role: "user",
            content: [
                { type: "text", text: "Describe this image." },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
            ],
        },
    ])

    const image = currentMessage.userInputMessage!.images![0]
    expect(image.format).toBe("png")
    expect(Array.from(image.source!.bytes!)).toEqual([1, 2, 3])
})

test("Kiro preserves supported user images in history", async () => {
    const { history } = await toKiroMessages([
        {
            role: "user",
            content: [{ type: "image", source: { type: "base64", media_type: "image/webp", data: "AQID" } }],
        },
        { role: "user", content: "Continue" },
    ])

    const image = history[0].userInputMessage!.images![0]
    expect(image.format).toBe("webp")
    expect(Array.from(image.source!.bytes!)).toEqual([1, 2, 3])
})

test("Kiro rejects unsupported or assistant-side image blocks instead of dropping them", async () => {
    await expect(toKiroMessages([
        {
            role: "user",
            content: [{ type: "image", source: { type: "base64", media_type: "image/svg+xml", data: "AQID" } }],
        },
    ])).rejects.toMatchObject({
        name: "RequestValidationError",
        status: 400,
        message: "Kiro supports only PNG, JPEG, GIF, and WebP image blocks",
    } satisfies Partial<RequestValidationError>)

    await expect(toKiroMessages([
        {
            role: "assistant",
            content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } }],
        },
        { role: "user", content: "Continue" },
    ])).rejects.toMatchObject({
        name: "RequestValidationError",
        status: 400,
        message: "Kiro only supports image blocks in user messages",
    } satisfies Partial<RequestValidationError>)

    await expect(toKiroMessages([
        {
            role: "user",
            content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "not base64!" } }],
        },
    ])).rejects.toMatchObject({
        name: "RequestValidationError",
        status: 400,
        message: "Kiro image blocks must include valid base64 image data",
    } satisfies Partial<RequestValidationError>)
})
