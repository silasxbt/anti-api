import { timingSafeEqual } from "crypto"

export const DEFAULT_PUBLIC_PORT = 8966

export function getPublicGatewayToken(): string | null {
    const token = process.env.ANTI_API_PUBLIC_TOKEN?.trim()
    return token || null
}

export function getPublicGatewayPort(_localPort?: number): number {
    const configured = Number.parseInt(process.env.ANTI_API_PUBLIC_PORT || "", 10)
    if (Number.isInteger(configured) && configured > 0 && configured <= 65535) {
        return configured
    }
    return DEFAULT_PUBLIC_PORT
}

export function getPublicGatewayHost(): string {
    return process.env.ANTI_API_PUBLIC_HOST?.trim() || "0.0.0.0"
}

export function tokenMatches(expected: string, provided: string | null): boolean {
    if (!provided) return false
    const expectedBytes = Buffer.from(expected)
    const providedBytes = Buffer.from(provided)
    if (expectedBytes.length !== providedBytes.length) return false
    return timingSafeEqual(expectedBytes, providedBytes)
}

export function extractPublicToken(request: Request): string | null {
    const authorization = request.headers.get("authorization")
    if (authorization?.startsWith("Bearer ")) {
        return authorization.slice("Bearer ".length).trim() || null
    }
    return request.headers.get("x-api-key")?.trim() || null
}
