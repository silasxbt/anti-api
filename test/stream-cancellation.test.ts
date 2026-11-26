import { expect, test } from "bun:test"
import { isAbortError, mergeAbortSignals, raceWithAbort, sleepWithAbort, throwIfAborted } from "~/lib/stream-cancellation"

test("sleepWithAbort stops a retry delay when the caller aborts", async () => {
    const controller = new AbortController()
    const startedAt = Date.now()
    const pending = sleepWithAbort(5_000, controller.signal)
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(Date.now() - startedAt).toBeLessThan(500)
})

test("raceWithAbort lets one caller leave a shared operation", async () => {
    const controller = new AbortController()
    let resolveOperation!: (value: string) => void
    const operation = new Promise<string>(resolve => {
        resolveOperation = resolve
    })

    const pending = raceWithAbort(operation, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })

    resolveOperation("still available to another caller")
    await expect(operation).resolves.toBe("still available to another caller")
})

test("mergeAbortSignals propagates either timeout or caller cancellation", () => {
    const caller = new AbortController()
    const timeout = new AbortController()
    const merged = mergeAbortSignals(caller.signal, timeout.signal)

    expect(merged.signal?.aborted).toBe(false)
    timeout.abort()
    expect(merged.signal?.aborted).toBe(true)

    merged.dispose()
    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    const second = mergeAbortSignals(alreadyAborted.signal)
    expect(second.signal?.aborted).toBe(true)
})

test("throwIfAborted and isAbortError use the fetch-compatible error shape", () => {
    const controller = new AbortController()
    controller.abort()

    expect(() => throwIfAborted(controller.signal)).toThrow(/Request aborted/)
    expect(isAbortError(new DOMException("cancelled", "AbortError"))).toBe(true)
    expect(isAbortError({ name: "AbortError" })).toBe(true)
})
