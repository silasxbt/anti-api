/** Small cancellation helpers shared by the OpenAI and Anthropic SSE routes. */

export interface StreamState {
    aborted?: boolean
    closed?: boolean
}

/** Create the same error shape returned by fetch when an AbortSignal fires. */
export function createAbortError(message = "Request aborted"): Error {
    const error = new Error(message)
    error.name = "AbortError"
    return error
}

export function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw createAbortError()
}

/** Sleep between retries without keeping work alive after a client disconnect. */
export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) return new Promise(resolve => setTimeout(resolve, ms))
    if (signal.aborted) return Promise.reject(createAbortError())

    return new Promise((resolve, reject) => {
        let settled = false
        const cleanup = () => {
            clearTimeout(timer)
            signal.removeEventListener("abort", onAbort)
        }
        const finish = (callback: () => void) => {
            if (settled) return
            settled = true
            cleanup()
            callback()
        }
        const onAbort = () => finish(() => reject(createAbortError()))
        const timer = setTimeout(() => finish(resolve), ms)
        signal.addEventListener("abort", onAbort, { once: true })
    })
}

/** Combine a request signal with an internal timeout signal and clean up listeners. */
export function mergeAbortSignals(...signals: Array<AbortSignal | undefined>): {
    signal?: AbortSignal
    dispose: () => void
} {
    const active = signals.filter((signal): signal is AbortSignal => !!signal)
    if (active.length === 0) return { dispose: () => {} }
    if (active.length === 1) return { signal: active[0], dispose: () => {} }

    const controller = new AbortController()
    const listeners = active.map(signal => {
        const listener = () => {
            if (!controller.signal.aborted) controller.abort(signal.reason)
        }
        signal.addEventListener("abort", listener, { once: true })
        if (signal.aborted) listener()
        return { signal, listener }
    })

    return {
        signal: controller.signal,
        dispose: () => {
            for (const { signal, listener } of listeners) {
                signal.removeEventListener("abort", listener)
            }
        },
    }
}

/** Wait for a shared operation without making another caller own its lifetime. */
export function raceWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return operation
    if (signal.aborted) return Promise.reject(createAbortError())

    return new Promise((resolve, reject) => {
        const cleanup = () => signal.removeEventListener("abort", onAbort)
        const onAbort = () => {
            cleanup()
            reject(createAbortError())
        }
        signal.addEventListener("abort", onAbort, { once: true })
        operation.then(
            value => {
                cleanup()
                resolve(value)
            },
            error => {
                cleanup()
                reject(error)
            },
        )
    })
}

export function isAbortError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false
    const candidate = error as { name?: unknown; code?: unknown }
    return candidate.name === "AbortError" || candidate.code === "ABORT_ERR"
}

export function isStreamCancellation(
    error: unknown,
    signal: AbortSignal,
    stream?: StreamState,
): boolean {
    if (signal.aborted || stream?.aborted || stream?.closed) {
        return true
    }

    if (!error || typeof error !== "object") {
        return false
    }

    const candidate = error as { name?: unknown; code?: unknown }
    return candidate.name === "AbortError" || candidate.code === "ABORT_ERR"
}

/** Register a request-abort callback and return a listener cleanup function. */
export function onRequestAbort(signal: AbortSignal, callback: () => void): () => void {
    if (signal.aborted) {
        callback()
        return () => { }
    }
    signal.addEventListener("abort", callback, { once: true })
    return () => signal.removeEventListener("abort", callback)
}

/** Close an upstream async generator when the downstream client disconnects. */
export async function returnStream<T>(stream: AsyncGenerator<T> | null): Promise<void> {
    if (!stream?.return) return
    try {
        await stream.return(undefined)
    } catch {
        // The upstream may already have observed the same cancellation.
    }
}
