import { expect, test } from "bun:test"
import { fetchRemoteImageAsBase64 } from "~/lib/remote-image"
import { RequestValidationError } from "~/lib/error"

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }]

test("remote image fetch converts a bounded public image to inline data", async () => {
    let calledUrl = ""
    let calledInit: RequestInit | undefined
    const result = await fetchRemoteImageAsBase64("https://example.com/photo.png", {
        lookupHost: publicLookup,
        fetchImpl: async (input, init) => {
            calledUrl = String(input)
            calledInit = init
            return new Response(Uint8Array.from([1, 2, 3]), {
                status: 200,
                headers: { "content-type": "image/png", "content-length": "3" },
            })
        },
    })

    expect(result).toEqual({ type: "base64", media_type: "image/png", data: "AQID" })
    expect(calledUrl).toBe("https://example.com/photo.png")
    expect(calledInit?.redirect).toBe("error")
    expect(calledInit?.headers).toEqual({ Accept: "image/*" })
})

test("remote image fetch rejects private hosts and non-image responses", async () => {
    let fetchCalls = 0
    await expect(fetchRemoteImageAsBase64("http://127.0.0.1/image.png", {
        fetchImpl: async () => {
            fetchCalls += 1
            return new Response()
        },
    })).rejects.toBeInstanceOf(RequestValidationError)
    expect(fetchCalls).toBe(0)

    await expect(fetchRemoteImageAsBase64("https://example.com/not-image", {
        lookupHost: publicLookup,
        fetchImpl: async () => new Response("not an image", {
            status: 200,
            headers: { "content-type": "text/plain" },
        }),
    })).rejects.toBeInstanceOf(RequestValidationError)
})

test("remote image fetch rejects DNS results that resolve to private addresses", async () => {
    await expect(fetchRemoteImageAsBase64("https://example.com/image.png", {
        lookupHost: async () => [{ address: "10.0.0.4", family: 4 }],
        fetchImpl: async () => new Response(),
    })).rejects.toBeInstanceOf(RequestValidationError)
})

test("remote image fetch rejects hexadecimal IPv4-mapped IPv6 loopback addresses", async () => {
    let fetchCalls = 0
    await expect(fetchRemoteImageAsBase64("https://example.com/image.png", {
        lookupHost: async () => [{ address: "::ffff:7f00:1", family: 6 }],
        fetchImpl: async () => {
            fetchCalls += 1
            return new Response()
        },
    })).rejects.toBeInstanceOf(RequestValidationError)
    expect(fetchCalls).toBe(0)
})

test("remote image fetch rejects private IPv6 scopes", async () => {
    for (const address of ["fec0::1", "ff02::1"]) {
        await expect(fetchRemoteImageAsBase64("https://example.com/image.png", {
            lookupHost: async () => [{ address, family: 6 }],
            fetchImpl: async () => new Response(),
        })).rejects.toBeInstanceOf(RequestValidationError)
    }
})

test("remote image body reads obey the absolute deadline and cancel the stream", async () => {
    let cancelled = false
    let signal: AbortSignal | undefined
    const body = new ReadableStream<Uint8Array>({
        cancel() {
            cancelled = true
        },
    })

    const startedAt = Date.now()
    await expect(fetchRemoteImageAsBase64("https://example.com/slow.png", {
        lookupHost: publicLookup,
        timeoutMs: 25,
        fetchImpl: async (_input, init) => {
            signal = init?.signal as AbortSignal
            return new Response(body, {
                status: 200,
                headers: { "content-type": "image/png" },
            })
        },
    })).rejects.toBeInstanceOf(RequestValidationError)

    expect(Date.now() - startedAt).toBeLessThan(500)
    expect(cancelled).toBe(true)
    expect(signal?.aborted).toBe(true)
})

test("remote image fetch does not drain non-success response bodies", async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
        cancel() {
            cancelled = true
        },
    })

    await expect(fetchRemoteImageAsBase64("https://example.com/missing.png", {
        lookupHost: publicLookup,
        fetchImpl: async () => new Response(body, {
            status: 404,
            headers: { "content-type": "text/html" },
        }),
    })).rejects.toBeInstanceOf(RequestValidationError)
    expect(cancelled).toBe(true)
})

test("remote image fetch rejects an oversized declared body before reading it", async () => {
    const body = new ReadableStream<Uint8Array>({
        pull() {
            throw new Error("body should not be read")
        },
    })

    await expect(fetchRemoteImageAsBase64("https://example.com/large.png", {
        lookupHost: publicLookup,
        fetchImpl: async () => new Response(body, {
            status: 200,
            headers: {
                "content-type": "image/png",
                "content-length": String(10 * 1024 * 1024 + 1),
            },
        }),
    })).rejects.toBeInstanceOf(RequestValidationError)
})

test("remote image fetch treats a missing body as empty without calling arbitrary arrayBuffer", async () => {
    let arrayBufferCalled = false
    const response = {
        status: 200,
        headers: new Headers({ "content-type": "image/png" }),
        body: null,
        arrayBuffer: async () => {
            arrayBufferCalled = true
            await new Promise(() => {})
            return new ArrayBuffer(0)
        },
    } as unknown as Response

    const result = await fetchRemoteImageAsBase64("https://example.com/empty.png", {
        lookupHost: publicLookup,
        timeoutMs: 25,
        fetchImpl: async () => response,
    })

    expect(result).toEqual({ type: "base64", media_type: "image/png", data: "" })
    expect(arrayBufferCalled).toBe(false)
})

test("remote image fetch rejects invalid timeout values", async () => {
    await expect(fetchRemoteImageAsBase64("https://example.com/image.png", {
        lookupHost: publicLookup,
        timeoutMs: 0,
        fetchImpl: async () => new Response(),
    })).rejects.toBeInstanceOf(RequestValidationError)
})
