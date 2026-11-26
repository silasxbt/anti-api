import { timingSafeEqual } from "crypto"

export const DEFAULT_PUBLIC_PORT = 8966
export const CONTROL_PLANE_COOKIE = "anti_api_control"

export function isContainerControlPlaneEnabled(): boolean {
    return process.env.ANTI_API_CONTAINER_CONTROL_PLANE === "1"
}

export function getControlPlaneToken(): string | null {
    const token = process.env.ANTI_API_CONTROL_TOKEN?.trim()
    return token || null
}

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
    // This listener is started only after a non-empty public token is present.
    // A real bind address prevents the placeholder value from failing at startup.
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

function extractCookieToken(request: Request): string | null {
    const cookieHeader = request.headers.get("cookie") || ""
    for (const part of cookieHeader.split(";")) {
        const [name, ...valueParts] = part.trim().split("=")
        if (name !== CONTROL_PLANE_COOKIE) continue
        const value = valueParts.join("=")
        try {
            return decodeURIComponent(value).trim() || null
        } catch {
            return null
        }
    }
    return null
}

/** Extract a container control token from an API header or an established cookie. */
export function extractControlPlaneToken(request: Request): string | null {
    return extractPublicToken(request) || extractCookieToken(request)
}

export function extractControlPlaneBootstrapToken(request: Request): string | null {
    if (request.method !== "GET") return null
    try {
        return new URL(request.url).searchParams.get("control_token")?.trim() || null
    } catch {
        return null
    }
}
