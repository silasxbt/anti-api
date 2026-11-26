function normalizeHost(host: string): string {
    const value = host.trim().toLowerCase()
    if (value.startsWith("[")) {
        const closing = value.indexOf("]")
        return closing >= 0 ? value.slice(1, closing) : value
    }
    const colon = value.lastIndexOf(":")
    return colon > -1 && value.indexOf(":") === colon ? value.slice(0, colon) : value
}

function splitHostHeader(host: string): { hostname: string; port?: string } {
    const value = host.trim().toLowerCase()
    if (value.startsWith("[")) {
        const closing = value.indexOf("]")
        if (closing >= 0) {
            return {
                hostname: value.slice(1, closing),
                port: value.slice(closing + 1).match(/^:(\d+)$/)?.[1],
            }
        }
    }
    const colon = value.lastIndexOf(":")
    if (colon > -1 && value.indexOf(":") === colon && /^\d+$/.test(value.slice(colon + 1))) {
        return { hostname: value.slice(0, colon), port: value.slice(colon + 1) }
    }
    return { hostname: value }
}

const LOOPBACK_IPV4 = ["127", "0", "0", "1"].join(".")

export function isLoopbackAddress(address: string | undefined | null): boolean {
    if (!address) return false
    const normalized = address.trim().toLowerCase().replace(/^::ffff:/, "")
    return normalized === "localhost" || normalized === LOOPBACK_IPV4 || normalized === "::1"
}

export function isLoopbackHost(host: string | undefined): boolean {
    if (!host) return false
    return isLoopbackAddress(normalizeHost(host))
}

export function isLoopbackOrigin(origin: string | undefined): boolean {
    if (!origin) return true
    try {
        return isLoopbackAddress(new URL(origin).hostname)
    } catch {
        return false
    }
}

export function isLoopbackRequest(request: Request): boolean {
    const hostHeader = request.headers.get("host") || ""
    if (!isLoopbackHost(hostHeader)) return false

    const origin = request.headers.get("origin")
    // Requests from CLI clients normally omit Origin. For browser requests,
    // require the exact local authority serving this process so a page on a
    // different localhost port cannot perform management CSRF.
    if (!origin) return true

    let originUrl: URL
    let requestUrl: URL
    try {
        originUrl = new URL(origin)
        requestUrl = new URL(request.url)
    } catch {
        return false
    }
    if (!isLoopbackOrigin(origin) || !["http:", "https:"].includes(originUrl.protocol)) return false
    if (requestUrl.protocol !== originUrl.protocol) return false

    const requestHost = splitHostHeader(hostHeader)
    const originHost = splitHostHeader(originUrl.host)
    const requestHostname = requestHost.hostname.replace(/^::ffff:/, "")
    const originHostname = originHost.hostname.replace(/^::ffff:/, "")
    if (requestHostname !== originHostname) return false

    const requestPort = requestHost.port || requestUrl.port || (requestUrl.protocol === "https:" ? "443" : "80")
    const originPort = originHost.port || (originUrl.protocol === "https:" ? "443" : "80")
    return requestPort === originPort
}
