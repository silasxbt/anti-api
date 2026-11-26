import { expect, test } from "bun:test"
import {
    ImageInputBudget,
    createImageInputBudget,
    decodedBase64ImageBytes,
} from "~/lib/image-input"
import {
    MAX_IMAGE_BYTES_PER_REQUEST,
    MAX_IMAGES_PER_REQUEST,
} from "~/lib/constants"
import { RequestValidationError } from "~/lib/error"
import type { ClaudeMessage } from "~/lib/translator"
import { fetchRemoteImageAsBase64 } from "~/lib/remote-image"

function image(data = "AQID"): ClaudeMessage {
    return {
        role: "user",
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }],
    }
}

test("image budget counts all inline and remote images before conversion", () => {
    const messages: ClaudeMessage[] = [
        image(),
        {
            role: "user",
            content: [{ type: "image", source: { type: "url", url: "https://example.com/image.png" } }],
        },
    ]
    const budget = createImageInputBudget(messages)

    expect(budget.images).toBe(2)
    expect(budget.bytes).toBe(3)
    expect(budget.remainingBytes).toBe(MAX_IMAGE_BYTES_PER_REQUEST - 3)
})

test("image budget rejects too many images and aggregate bytes", () => {
    const tooMany: ClaudeMessage[] = Array.from({ length: MAX_IMAGES_PER_REQUEST + 1 }, () => image())
    expect(() => createImageInputBudget(tooMany)).toThrow(`Too many images (max ${MAX_IMAGES_PER_REQUEST})`)

    const budget = new ImageInputBudget()
    budget.addFetchedBytes(10 * 1024 * 1024)
    budget.addFetchedBytes(MAX_IMAGE_BYTES_PER_REQUEST - 10 * 1024 * 1024)
    expect(() => budget.addFetchedBytes(2)).toThrow("image inputs exceed the 16 MiB per-request limit")
})

test("image budget validates decoded Base64 size without allocating decoded bytes", () => {
    expect(decodedBase64ImageBytes("AQ I\nD")).toBe(3)
    expect(() => createImageInputBudget([image("AQI")])).toThrow(RequestValidationError)
    expect(() => createImageInputBudget([{
        role: "user",
        content: [{ type: "image", source: { type: "url", url: "" } }],
    }])).toThrow(RequestValidationError)
})

test("remote image fetch honors caller abort while reading the body", async () => {
    let cancelled = false
    let fetchSignal: AbortSignal | undefined
    const body = new ReadableStream<Uint8Array>({
        pull() {
            return new Promise<void>(() => {})
        },
        cancel() {
            cancelled = true
        },
    })
    const controller = new AbortController()
    const pending = fetchRemoteImageAsBase64("https://example.com/slow.png", {
        lookupHost: async () => [{ address: "93.184.216.34", family: 4 }],
        fetchImpl: async (_input, init) => {
            fetchSignal = init?.signal as AbortSignal
            return new Response(body, { status: 200, headers: { "content-type": "image/png" } })
        },
        signal: controller.signal,
    })

    setTimeout(() => controller.abort(), 10)
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(fetchSignal?.aborted).toBe(true)
    expect(cancelled).toBe(true)
})

test("remote image fetch enforces the remaining request image budget", async () => {
    await expect(fetchRemoteImageAsBase64("https://example.com/image.png", {
        lookupHost: async () => [{ address: "93.184.216.34", family: 4 }],
        maxBytes: 3,
        fetchImpl: async () => new Response(Uint8Array.from([1, 2, 3, 4]), {
            status: 200,
            headers: { "content-type": "image/png", "content-length": "4" },
        }),
    })).rejects.toThrow("remaining per-request image limit")
})
