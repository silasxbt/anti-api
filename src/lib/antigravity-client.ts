const DEFAULT_ANTIGRAVITY_IDE_VERSION = "2.24.0"
const ANTIGRAVITY_VERSION_MANIFEST_URL = "https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml"
const ANTIGRAVITY_HUB_PLATFORM = "darwin/arm64"
const VERSION_CACHE_TTL_MS = 6 * 60 * 60 * 1000
const VERSION_FETCH_TIMEOUT_MS = 10_000
const MAX_MANIFEST_BYTES = 64 * 1024

let cachedVersion = DEFAULT_ANTIGRAVITY_IDE_VERSION
let cachedVersionExpiresAt = 0
let updaterStarted = false

export function isValidAntigravityVersion(value: unknown): value is string {
    return typeof value === "string" && /^(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})(?:[-+][0-9A-Za-z.-]+)?$/.test(value.trim())
}

function configuredVersion(): string | undefined {
    const value = process.env.ANTIGRAVITY_IDE_VERSION?.trim()
    return isValidAntigravityVersion(value) ? value : undefined
}

export function getAntigravityIdeVersion(): string {
    return configuredVersion() || cachedVersion || DEFAULT_ANTIGRAVITY_IDE_VERSION
}

export function getAntigravityUserAgent(): string {
    const envAgent = process.env.ANTIGRAVITY_USER_AGENT?.trim()
    if (envAgent && envAgent.length <= 256 && /^[\x20-\x7e]+$/.test(envAgent)) return envAgent
    const version = getAntigravityIdeVersion()
    // Match the native Hub update channel represented by the arm64 macOS manifest.
    return `antigravity/hub/${version} ${ANTIGRAVITY_HUB_PLATFORM}`
}

function parseManifestVersion(body: string): string | undefined {
    const match = body.match(/(?:^|\n)\s*version\s*:\s*["']?([^"'\s#]+)["']?/i)
    const version = match?.[1]?.trim()
    return isValidAntigravityVersion(version) ? version : undefined
}

async function readManifestBody(response: Response): Promise<string> {
    if (!response.body) {
        const body = await response.text()
        if (new TextEncoder().encode(body).byteLength > MAX_MANIFEST_BYTES) throw new Error("manifest too large")
        return body
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
        while (true) {
            const result = await reader.read()
            if (result.done) break
            const chunk = result.value instanceof Uint8Array ? result.value : new Uint8Array(result.value)
            total += chunk.byteLength
            if (total > MAX_MANIFEST_BYTES) {
                await reader.cancel().catch(() => {})
                throw new Error("manifest too large")
            }
            chunks.push(chunk)
        }
    } finally {
        reader.releaseLock()
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
    }
    return new TextDecoder().decode(bytes)
}

/** Refresh the cached native client version; failures retain the last safe value. */
export async function refreshAntigravityIdeVersion(fetchImpl: typeof fetch = fetch): Promise<string> {
    const override = configuredVersion()
    if (override) return override

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), VERSION_FETCH_TIMEOUT_MS)
    try {
        const response = await fetchImpl(ANTIGRAVITY_VERSION_MANIFEST_URL, {
            headers: {
                Accept: "application/yaml,text/plain",
                "User-Agent": "electron-builder",
                "Cache-Control": "no-cache",
            },
            redirect: "error",
            signal: controller.signal,
        })
        if (!response.ok) throw new Error("manifest request failed")
        const version = parseManifestVersion(await readManifestBody(response))
        if (!version) throw new Error("manifest version missing")
        cachedVersion = version
        cachedVersionExpiresAt = Date.now() + VERSION_CACHE_TTL_MS
        return version
    } catch {
        if (!cachedVersion) cachedVersion = DEFAULT_ANTIGRAVITY_IDE_VERSION
        cachedVersionExpiresAt = Date.now() + VERSION_CACHE_TTL_MS
        return cachedVersion
    } finally {
        clearTimeout(timeoutId)
    }
}

/** Start a non-blocking periodic updater used by the long-running server. */
export function startAntigravityIdeVersionUpdater(): void {
    if (updaterStarted || configuredVersion() || process.env.ANTI_API_DISABLE_ANTIGRAVITY_VERSION_REFRESH === "1") return
    updaterStarted = true
    void refreshAntigravityIdeVersion()
    const timer = setInterval(() => {
        if (cachedVersionExpiresAt <= Date.now()) void refreshAntigravityIdeVersion()
    }, VERSION_CACHE_TTL_MS / 2)
    ;(timer as any).unref?.()
}
