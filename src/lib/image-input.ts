import {
    MAX_IMAGE_BYTES_PER_IMAGE,
    MAX_IMAGE_BYTES_PER_REQUEST,
    MAX_IMAGES_PER_REQUEST,
} from "./constants"
import { RequestValidationError } from "./error"
import type { ClaudeMessage } from "./translator"

function isBase64Character(charCode: number): boolean {
    return (
        (charCode >= 0x41 && charCode <= 0x5a) ||
        (charCode >= 0x61 && charCode <= 0x7a) ||
        (charCode >= 0x30 && charCode <= 0x39) ||
        charCode === 0x2b ||
        charCode === 0x2f
    )
}

/** Return the decoded byte length after validating standard padded Base64. */
export function decodedBase64ImageBytes(data: unknown, allowEmpty = false): number {
    if (typeof data !== "string") {
        throw new RequestValidationError("image source must include valid base64 data")
    }

    const normalized = data.replace(/[\t\n\f\r ]/g, "")
    if ((!allowEmpty && normalized.length === 0) || normalized.length % 4 !== 0) {
        throw new RequestValidationError("image source must include valid base64 data")
    }

    let firstPadding = -1
    for (let index = 0; index < normalized.length; index++) {
        const charCode = normalized.charCodeAt(index)
        if (charCode === 0x3d) {
            if (firstPadding === -1) firstPadding = index
            continue
        }
        if (firstPadding !== -1 || !isBase64Character(charCode)) {
            throw new RequestValidationError("image source must include valid base64 data")
        }
    }

    let padding = 0
    if (firstPadding !== -1) {
        padding = normalized.length - firstPadding
        const unpaddedLength = firstPadding % 4
        if (
            (padding !== 1 && padding !== 2) ||
            (padding === 1 && unpaddedLength !== 3) ||
            (padding === 2 && unpaddedLength !== 2)
        ) {
            throw new RequestValidationError("image source must include valid base64 data")
        }
    }

    return (normalized.length / 4) * 3 - padding
}

function imageCountError(): RequestValidationError {
    return new RequestValidationError(`Too many images (max ${MAX_IMAGES_PER_REQUEST})`)
}

function perImageSizeError(): RequestValidationError {
    return new RequestValidationError(`image exceeds the ${Math.floor(MAX_IMAGE_BYTES_PER_IMAGE / (1024 * 1024))} MiB image limit`)
}

function aggregateSizeError(): RequestValidationError {
    return new RequestValidationError(`image inputs exceed the ${Math.floor(MAX_IMAGE_BYTES_PER_REQUEST / (1024 * 1024))} MiB per-request limit`)
}

/**
 * Tracks validated image work for one request. Inline images are charged before
 * provider conversion; remote images reserve their count up front and charge
 * their decoded bytes while they are fetched.
 */
export class ImageInputBudget {
    private imageCount = 0
    private byteCount = 0

    get images(): number {
        return this.imageCount
    }

    get bytes(): number {
        return this.byteCount
    }

    get remainingBytes(): number {
        return MAX_IMAGE_BYTES_PER_REQUEST - this.byteCount
    }

    registerInlineImage(data: unknown): void {
        this.registerImage()
        this.addBytes(decodedBase64ImageBytes(data))
    }

    registerRemoteImage(): void {
        this.registerImage()
    }

    addFetchedBytes(byteLength: number): void {
        if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
            throw new RequestValidationError("remote image size is invalid")
        }
        this.addBytes(byteLength)
    }

    private registerImage(): void {
        this.imageCount += 1
        if (this.imageCount > MAX_IMAGES_PER_REQUEST) {
            throw imageCountError()
        }
    }

    private addBytes(byteLength: number): void {
        if (byteLength > MAX_IMAGE_BYTES_PER_IMAGE) {
            throw perImageSizeError()
        }
        if (byteLength > this.remainingBytes) {
            throw aggregateSizeError()
        }
        this.byteCount += byteLength
    }
}

/** Validate image count and inline bytes before any provider request conversion. */
export function createImageInputBudget(messages: ClaudeMessage[]): ImageInputBudget {
    const budget = new ImageInputBudget()

    for (const message of messages) {
        if (!Array.isArray(message.content)) continue
        for (const block of message.content) {
            if (!block || typeof block !== "object" || block.type !== "image") continue
            const source = block.source
            if (!source || typeof source !== "object") {
                throw new RequestValidationError("image block must include a source")
            }
            if (source.type === "base64") {
                budget.registerInlineImage(source.data)
                continue
            }
            if (source.type === "url") {
                if (typeof source.url !== "string" || !source.url.trim()) {
                    throw new RequestValidationError("image URL source must include a URL")
                }
                budget.registerRemoteImage()
                continue
            }
            throw new RequestValidationError("image source type is not supported")
        }
    }

    return budget
}
