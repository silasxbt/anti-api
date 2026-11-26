import { RequestValidationError } from "./error"

export const MAX_INFERENCE_REQUEST_BYTES = 16 * 1024 * 1024

/** Parse a JSON request while bounding both declared and chunked request bodies. */
export async function parseBoundedJson<T>(request: Request, maxBytes = MAX_INFERENCE_REQUEST_BYTES): Promise<T> {
    const contentLength = request.headers.get("content-length")
    if (contentLength !== null) {
        if (!/^\d+$/.test(contentLength)) {
            throw new RequestValidationError("request body has an invalid content length")
        }
        if (Number(contentLength) > maxBytes) {
            throw new RequestValidationError(`request body exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MiB limit`)
        }
    }

    if (!request.body) {
        throw new RequestValidationError("request body must be valid JSON")
    }

    const reader = request.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
        while (true) {
            const result = await reader.read()
            if (result.done) break
            total += result.value.byteLength
            if (total > maxBytes) {
                await reader.cancel().catch(() => {})
                throw new RequestValidationError(`request body exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MiB limit`)
            }
            chunks.push(result.value)
        }
    } catch (error) {
        if (error instanceof RequestValidationError) throw error
        throw new RequestValidationError("request body could not be read")
    } finally {
        reader.releaseLock()
    }

    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
    }
    try {
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T
    } catch {
        throw new RequestValidationError("request body must be valid JSON")
    }
}
