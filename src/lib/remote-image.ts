import { lookup } from "node:dns/promises"
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http"
import { request as httpsRequest } from "node:https"
import { isIP } from "node:net"
import { RequestValidationError } from "./error"

export const MAX_REMOTE_IMAGE_BYTES = 10 * 1024 * 1024
const REMOTE_IMAGE_TIMEOUT_MS = 10_000
const REMOTE_IMAGE_TIMEOUT_MESSAGE = "remote image request timed out"
const MAX_REMOTE_IMAGE_TIMEOUT_MS = 120_000

type LookupAddress = { address: string; family: number }

export type InlineImageSource = {
    type: "base64"
    media_type: string
    data: string
}

export interface RemoteImageFetchOptions {
    fetchImpl?: typeof fetch
    lookupHost?: (hostname: string) => Promise<LookupAddress[]>
    timeoutMs?: number
    /** Stop DNS/network/body work when the downstream request is cancelled. */
    signal?: AbortSignal
    /** A caller may further restrict a fetch to its remaining request budget. */
    maxBytes?: number
}

function abortError(): DOMException {
    return new DOMException("Remote image request was aborted", "AbortError")
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw abortError()
}

/** Race a non-abortable operation (such as DNS lookup) against a caller signal. */
async function withAbort<T>(operation: Promise<T>, signal?: AbortSignal, onAbort?: () => void): Promise<T> {
    if (!signal) return operation
    if (signal.aborted) {
        onAbort?.()
        throw abortError()
    }

    let abortListener: (() => void) | undefined
    const aborted = new Promise<never>((_, reject) => {
        abortListener = () => {
            try {
                onAbort?.()
            } finally {
                reject(abortError())
            }
        }
        signal.addEventListener("abort", abortListener, { once: true })
    })

    try {
        return await Promise.race([operation, aborted])
    } finally {
        if (abortListener) signal.removeEventListener("abort", abortListener)
    }
}

function parseIpv4Octets(address: string): number[] | null {
    const octets = address.split(".").map(Number)
    if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null
    return octets
}

function ipv4IsPublic(address: string): boolean {
    const octets = parseIpv4Octets(address)
    if (!octets) return false
    const [a, b, c] = octets
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false
    if (a === 100 && b >= 64 && b <= 127) return false
    if (a === 169 && b === 254) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && (b === 0 || b === 168)) return false
    if (a === 192 && b === 2) return false
    if (a === 198 && (b === 18 || b === 19 || b === 51)) return false
    if (a === 203 && b === 0 && c === 113) return false
    return true
}

function parseIpv6Words(address: string): number[] | null {
    let value = address.toLowerCase().split("%", 1)[0].replace(/^\[|\]$/g, "")
    const lastColon = value.lastIndexOf(":")
    const tail = lastColon >= 0 ? value.slice(lastColon + 1) : ""
    if (tail.includes(".")) {
        const octets = parseIpv4Octets(tail)
        if (!octets) return null
        const high = (octets[0] << 8) | octets[1]
        const low = (octets[2] << 8) | octets[3]
        value = `${value.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`
    }

    const halves = value.split("::")
    if (halves.length > 2) return null
    const parseHalf = (half: string): number[] | null => {
        if (!half) return []
        const words = half.split(":")
        if (words.some(word => !/^[0-9a-f]{1,4}$/.test(word))) return null
        return words.map(word => parseInt(word, 16))
    }
    const left = parseHalf(halves[0])
    const right = parseHalf(halves[1] || "")
    if (!left || !right) return null
    if (halves.length === 1) return left.length === 8 ? left : null
    const missing = 8 - left.length - right.length
    if (missing < 1) return null
    return [...left, ...Array(missing).fill(0), ...right]
}

function ipv6IsPublic(address: string): boolean {
    const words = parseIpv6Words(address)
    if (!words) return false

    const embeddedIpv4 = `${words[6] >> 8}.${words[6] & 0xff}.${words[7] >> 8}.${words[7] & 0xff}`
    const ipv4Compatible = words.slice(0, 6).every(word => word === 0)
    const ipv4Mapped = words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff
    const wellKnownNat64 = words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every(word => word === 0)
    if (ipv4Compatible || ipv4Mapped || wellKnownNat64) return ipv4IsPublic(embeddedIpv4)

    // Unspecified, loopback, unique-local, link-local, site-local, multicast,
    // and discard-only IPv6 ranges must never be reachable through an image URL.
    if (words.every(word => word === 0)) return false
    if (words.slice(0, 7).every(word => word === 0) && words[7] === 1) return false
    if ((words[0] & 0xfe00) === 0xfc00) return false
    if ((words[0] & 0xffc0) === 0xfe80) return false
    if ((words[0] & 0xffc0) === 0xfec0) return false
    if ((words[0] & 0xff00) === 0xff00) return false
    if (words[0] === 0x100 && words.slice(1, 4).every(word => word === 0)) return false
    return true
}

function addressIsPublic(address: string): boolean {
    const family = isIP(address)
    if (family === 4) return ipv4IsPublic(address)
    if (family === 6) return ipv6IsPublic(address)
    return false
}

function assertPublicRemoteHost(url: URL, addresses: string[]): void {
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "")
    if (
        hostname === "localhost" ||
        hostname.endsWith(".localhost") ||
        hostname === "metadata.google.internal" ||
        hostname.endsWith(".metadata.google.internal") ||
        hostname.endsWith(".internal")
    ) {
        throw new RequestValidationError("remote image host is not allowed")
    }

    if (addresses.length === 0 || addresses.some(address => !addressIsPublic(address))) {
        throw new RequestValidationError("remote image host is not allowed")
    }
}

function normalizeTimeout(timeoutMs: number | undefined): number {
    const value = timeoutMs ?? REMOTE_IMAGE_TIMEOUT_MS
    if (!Number.isFinite(value) || value <= 0) {
        throw new RequestValidationError("remote image timeout is invalid")
    }
    return Math.min(MAX_REMOTE_IMAGE_TIMEOUT_MS, Math.max(1, Math.floor(value)))
}

function normalizeMaxBytes(maxBytes: number | undefined): number {
    if (maxBytes === undefined) return MAX_REMOTE_IMAGE_BYTES
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
        throw new RequestValidationError("remote image size limit is invalid")
    }
    return Math.min(maxBytes, MAX_REMOTE_IMAGE_BYTES)
}

function remoteImageSizeError(maxBytes: number): RequestValidationError {
    if (maxBytes < MAX_REMOTE_IMAGE_BYTES) {
        return new RequestValidationError("remote image exceeds the remaining per-request image limit")
    }
    return new RequestValidationError("remote image exceeds the 10 MiB image limit")
}

function timeoutError(): RequestValidationError {
    return new RequestValidationError(REMOTE_IMAGE_TIMEOUT_MESSAGE)
}

/** Race an operation against one absolute deadline, while allowing the caller to cancel I/O. */
async function withDeadline<T>(operation: Promise<T>, deadline: number, onTimeout: () => void): Promise<T> {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
        try {
            onTimeout()
        } catch {
            // Cleanup must never hide the public timeout error.
        }
        throw timeoutError()
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    const deadlinePromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            try {
                onTimeout()
            } catch {
                // Cleanup must never hide the public timeout error.
            }
            reject(timeoutError())
        }, remaining)
    })
    try {
        return await Promise.race([operation, deadlinePromise])
    } finally {
        if (timer) clearTimeout(timer)
    }
}

async function readLimitedBody(
    response: Response,
    maxBytes: number,
    deadline: number,
    onTimeout?: () => void,
    signal?: AbortSignal
): Promise<Uint8Array> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    const operation = (async () => {
        if (!response.body) {
            // A Response without a body is defined to contain zero bytes. Do
            // not call an arbitrary/custom arrayBuffer() implementation here:
            // it could allocate without a bound or never settle.
            return new Uint8Array()
        }

        reader = response.body.getReader()
        const chunks: Uint8Array[] = []
        let total = 0
        try {
            while (true) {
                throwIfAborted(signal)
                const result = await reader.read()
                if (result.done) break
                throwIfAborted(signal)
                const chunk = result.value instanceof Uint8Array ? result.value : new Uint8Array(result.value)
                total += chunk.byteLength
                if (total > maxBytes) {
                    await reader.cancel().catch(() => {})
                    throw remoteImageSizeError(maxBytes)
                }
                chunks.push(chunk)
            }
        } finally {
            try {
                reader.releaseLock()
            } catch {
                // A cancelled custom stream may already have released its lock.
            }
        }

        const bytes = new Uint8Array(total)
        let offset = 0
        for (const chunk of chunks) {
            bytes.set(chunk, offset)
            offset += chunk.byteLength
        }
        return bytes
    })()

    return withAbort(withDeadline(operation, deadline, () => {
        if (reader) void reader.cancel().catch(() => {})
        try {
            onTimeout?.()
        } catch {
            // Cleanup must never hide the public timeout error.
        }
    }), signal, () => {
        if (reader) void reader.cancel().catch(() => {})
        try {
            onTimeout?.()
        } catch {
            // Cancellation must never hide the AbortError.
        }
    })
}

async function readLimitedNodeBody(
    response: IncomingMessage,
    maxBytes: number,
    deadline: number,
    signal?: AbortSignal
): Promise<Uint8Array> {
    const operation = (async () => {
        const chunks: Uint8Array[] = []
        let total = 0
        for await (const chunk of response) {
            throwIfAborted(signal)
            const bytes = typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk)
            total += bytes.byteLength
            if (total > maxBytes) {
                response.destroy()
                throw remoteImageSizeError(maxBytes)
            }
            chunks.push(bytes)
        }
        const result = new Uint8Array(total)
        let offset = 0
        for (const chunk of chunks) {
            result.set(chunk, offset)
            offset += chunk.byteLength
        }
        return result
    })()

    return withAbort(withDeadline(operation, deadline, () => response.destroy()), signal, () => response.destroy(abortError()))
}

type PinnedImageResponse = {
    status: number
    headers: Headers
    bytes: Uint8Array
}

function toHeaders(headers: IncomingMessage["headers"]): Headers {
    const result = new Headers()
    for (const [name, value] of Object.entries(headers)) {
        if (value !== undefined) result.set(name, Array.isArray(value) ? value.join(", ") : value)
    }
    return result
}

/**
 * Connect using the already-validated DNS result. Keeping the original host as
 * the TLS/server name preserves certificate validation while the custom lookup
 * prevents a DNS rebinding response from changing the connected address.
 */
async function requestPinnedImage(
    url: URL,
    address: string,
    deadline: number,
    maxBytes: number,
    signal?: AbortSignal
): Promise<PinnedImageResponse> {
    if (deadline <= Date.now()) throw timeoutError()
    throwIfAborted(signal)
    const hostname = url.hostname.replace(/^\[|\]$/g, "")
    const transport = url.protocol === "https:" ? httpsRequest : httpRequest
    return new Promise((resolve, reject) => {
        let settled = false
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined
        let request: ClientRequest | undefined
        const cleanup = () => {
            if (deadlineTimer) clearTimeout(deadlineTimer)
            signal?.removeEventListener("abort", onAbort)
        }
        const finishResolve = (value: PinnedImageResponse) => {
            if (settled) return
            settled = true
            cleanup()
            resolve(value)
        }
        const finishReject = (error: unknown) => {
            if (settled) return
            settled = true
            cleanup()
            reject(error)
        }
        const onAbort = () => {
            if (settled) return
            const error = abortError()
            request?.destroy(error)
            finishReject(error)
        }
        request = transport({
            protocol: url.protocol,
            hostname,
            port: url.port ? Number(url.port) : undefined,
            path: `${url.pathname}${url.search}`,
            method: "GET",
            headers: { Accept: "image/*" },
            lookup: (
                _host: string,
                _options: unknown,
                callback: (error: Error | null, address: string, family: number) => void
            ) => callback(null, address, isIP(address)),
            ...(url.protocol === "https:" && isIP(hostname) === 0 ? { servername: hostname } : {}),
            timeout: Math.max(1, deadline - Date.now()),
        } as any, async (response) => {
            if (settled) {
                response.destroy()
                return
            }
            const status = response.statusCode || 0
            const headers = toHeaders(response.headers)
            if (status < 200 || status >= 300) {
                // Do not drain an untrusted error body; a peer can otherwise keep
                // the connection alive indefinitely while this request is done.
                response.destroy()
                finishResolve({ status, headers, bytes: new Uint8Array() })
                return
            }
            const contentLength = Number(headers.get("content-length") || "")
            if (Number.isFinite(contentLength) && contentLength > maxBytes) {
                response.destroy()
                finishReject(remoteImageSizeError(maxBytes))
                return
            }
            try {
                const bytes = await readLimitedNodeBody(response, maxBytes, deadline, signal)
                finishResolve({ status, headers, bytes })
            } catch (error) {
                finishReject(error)
            }
        })
        const onTimeout = () => {
            if (settled) return
            const error = timeoutError()
            request.destroy(error)
            finishReject(error)
        }
        signal?.addEventListener("abort", onAbort, { once: true })
        if (signal?.aborted) {
            onAbort()
            return
        }
        deadlineTimer = setTimeout(onTimeout, Math.max(1, deadline - Date.now()))
        if (settled && deadlineTimer) clearTimeout(deadlineTimer)
        request.on("error", error => finishReject(error))
        request.on("timeout", onTimeout)
        request.end()
    })
}

function toInlineImage(status: number, headers: Headers, bytes: Uint8Array, maxBytes: number): InlineImageSource {
    if (status < 200 || status >= 300) {
        throw new RequestValidationError("remote image could not be fetched")
    }
    const mediaType = (headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase()
    if (!mediaType.startsWith("image/")) {
        throw new RequestValidationError("remote image response must have an image content type")
    }
    const contentLength = Number(headers.get("content-length") || "")
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw remoteImageSizeError(maxBytes)
    }
    if (bytes.byteLength > maxBytes) {
        throw remoteImageSizeError(maxBytes)
    }
    return {
        type: "base64",
        media_type: mediaType,
        data: Buffer.from(bytes).toString("base64"),
    }
}

/** Fetch a public HTTP(S) image without following redirects or exposing response data in errors. */
export async function fetchRemoteImageAsBase64(
    rawUrl: string,
    options: RemoteImageFetchOptions = {}
): Promise<InlineImageSource> {
    throwIfAborted(options.signal)
    let url: URL
    try {
        url = new URL(rawUrl)
    } catch {
        throw new RequestValidationError("remote image URL is invalid")
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new RequestValidationError("remote image URL must use http(s)")
    }
    if (url.username || url.password) {
        throw new RequestValidationError("remote image URL must not include credentials")
    }

    const hostname = url.hostname.replace(/^\[|\]$/g, "")
    const timeoutMs = normalizeTimeout(options.timeoutMs)
    const maxBytes = normalizeMaxBytes(options.maxBytes)
    const deadline = Date.now() + timeoutMs
    const lookupHost = options.lookupHost || (async (host: string) => await lookup(host, { all: true, verbatim: true }))
    let addresses: string[]
    try {
        const result = isIP(hostname)
            ? [{ address: hostname }]
            : await withAbort(withDeadline(Promise.resolve(lookupHost(hostname)), deadline, () => {}), options.signal)
        addresses = result.map(item => item.address)
    } catch {
        if (options.signal?.aborted) throw abortError()
        throw new RequestValidationError("remote image host is not allowed")
    }
    throwIfAborted(options.signal)
    assertPublicRemoteHost(url, addresses)

    if (!options.fetchImpl) {
        try {
            const response = await requestPinnedImage(url, addresses[0], deadline, maxBytes, options.signal)
            return toInlineImage(response.status, response.headers, response.bytes, maxBytes)
        } catch (error) {
            if (options.signal?.aborted || (error as { name?: string } | undefined)?.name === "AbortError") throw abortError()
            if (error instanceof RequestValidationError) throw error
            throw new RequestValidationError("remote image could not be fetched")
        }
    }

    const fetchImpl = options.fetchImpl
    const controller = new AbortController()
    let response: Response
    try {
        response = await withAbort(withDeadline(
            Promise.resolve(
                fetchImpl(url, {
                    method: "GET",
                    headers: { Accept: "image/*" },
                    redirect: "error",
                    signal: controller.signal,
                })
            ),
            deadline,
            () => controller.abort()
        ), options.signal, () => controller.abort())
    } catch (error) {
        if (options.signal?.aborted || (error as { name?: string } | undefined)?.name === "AbortError") throw abortError()
        if (error instanceof RequestValidationError) throw error
        throw new RequestValidationError("remote image could not be fetched")
    }

    // Do not read untrusted error pages. Cancel the body and return the same
    // sanitized status error that the normal conversion path emits.
    if (response.status < 200 || response.status >= 300) {
        void response.body?.cancel().catch(() => {})
        return toInlineImage(response.status, response.headers, new Uint8Array(), maxBytes)
    }

    const declaredLength = Number(response.headers.get("content-length") || "")
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        void response.body?.cancel().catch(() => {})
        throw remoteImageSizeError(maxBytes)
    }

    let bytes: Uint8Array
    try {
        bytes = await readLimitedBody(response, maxBytes, deadline, () => controller.abort(), options.signal)
    } catch (error) {
        if (options.signal?.aborted || (error as { name?: string } | undefined)?.name === "AbortError") throw abortError()
        if (error instanceof RequestValidationError) throw error
        throw new RequestValidationError("remote image could not be read")
    }
    return toInlineImage(response.status, response.headers, bytes, maxBytes)
}
