import { afterAll, expect, mock, test } from "bun:test"

let sentAbortSignal: AbortSignal | undefined
let sendCalls = 0
let yieldedEventCount = 0
let abortBeforeSecondEvent: (() => void) | undefined

mock.module("@aws/codewhisperer-streaming-client", () => ({
    CodeWhispererStreaming: class {
        async send(_command: unknown, options?: { abortSignal?: AbortSignal }) {
            sendCalls += 1
            sentAbortSignal = options?.abortSignal
            return {
                generateAssistantResponseResponse: (async function* () {
                    yieldedEventCount += 1
                    yield { assistantResponseEvent: { content: "first" } }
                    abortBeforeSecondEvent?.()
                    yieldedEventCount += 1
                    yield { assistantResponseEvent: { content: "second" } }
                    yieldedEventCount += 1
                    yield { assistantResponseEvent: { content: "third" } }
                })(),
            }
        }
    },
    AccessDeniedException: class AccessDeniedException extends Error { },
    ThrottlingException: class ThrottlingException extends Error { },
    GenerateAssistantResponseCommand: class {
        constructor(readonly input: unknown) { }
    },
    Origin: { AI_EDITOR: "AI_EDITOR" },
    ChatTriggerType: { MANUAL: "MANUAL" },
    ImageFormat: { GIF: "gif", JPEG: "jpeg", PNG: "png", WEBP: "webp" },
    ToolResultStatus: { ERROR: "ERROR", SUCCESS: "SUCCESS" },
}))

mock.module("~/services/kiro/oauth", () => ({
    refreshKiroAccountIfNeeded: async (account: unknown) => account,
    getKiroEndpoint: () => "https://example.com",
    getKiroRegion: () => "us-east-1",
}))

mock.module("~/services/auth/store", () => ({
    authStore: { markSuccess: () => { } },
}))

const { createKiroCompletion } = await import(`../src/services/kiro/chat.ts?${Date.now()}`)

const account = {
    id: "kiro-account",
    provider: "kiro" as const,
    label: "Kiro",
    accessToken: "test-token",
    projectId: "profile",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
}

afterAll(() => {
    mock.restore()
})

test("Kiro forwards AbortSignal to the Smithy request handler", async () => {
    sendCalls = 0
    sentAbortSignal = undefined
    yieldedEventCount = 0
    abortBeforeSecondEvent = undefined
    const controller = new AbortController()

    const result = await createKiroCompletion(account, "auto", [{ role: "user", content: "hello" }], undefined, undefined, controller.signal)

    expect(result.contentBlocks).toEqual([{ type: "text", text: "firstsecondthird" }])
    expect(sendCalls).toBe(1)
    expect(sentAbortSignal).toBe(controller.signal)
})

test("Kiro does not start an upstream request after cancellation", async () => {
    sendCalls = 0
    yieldedEventCount = 0
    abortBeforeSecondEvent = undefined
    const controller = new AbortController()
    controller.abort()

    await expect(createKiroCompletion(account, "auto", [{ role: "user", content: "hello" }], undefined, undefined, controller.signal))
        .rejects.toMatchObject({ name: "AbortError" })
    expect(sendCalls).toBe(0)
})

test("Kiro stops consuming stream events after cancellation", async () => {
    sendCalls = 0
    yieldedEventCount = 0
    const controller = new AbortController()
    abortBeforeSecondEvent = () => controller.abort()

    await expect(createKiroCompletion(account, "auto", [{ role: "user", content: "hello" }], undefined, undefined, controller.signal))
        .rejects.toMatchObject({ name: "AbortError" })

    expect(sendCalls).toBe(1)
    expect(yieldedEventCount).toBe(2)
    abortBeforeSecondEvent = undefined
})
