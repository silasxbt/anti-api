const DEFAULT_ANTIGRAVITY_IDE_VERSION = "1.5.2"
const DEFAULT_ANTIGRAVITY_CL = "1015175089"

function isValidAntigravityVersion(value: unknown): value is string {
    return typeof value === "string" && /^(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})(?:[-+][0-9A-Za-z.-]+)?$/.test(value.trim())
}

function configuredVersion(): string | undefined {
    const value = process.env.ANTIGRAVITY_IDE_VERSION?.trim()
    return isValidAntigravityVersion(value) ? value : undefined
}

export function getAntigravityIdeVersion(): string {
    return configuredVersion() || DEFAULT_ANTIGRAVITY_IDE_VERSION
}

export function getAntigravityUserAgent(): string {
    const envAgent = process.env.ANTIGRAVITY_USER_AGENT?.trim()
    if (envAgent && envAgent.length <= 256 && /^[\x20-\x7e]+$/.test(envAgent)) return envAgent
    const version = getAntigravityIdeVersion()
    const platform = process.platform === "darwin" ? "macos" : process.platform
    const arch = process.arch === "x64" ? "amd64" : process.arch
    return `antigravity/cli/${version} (aidev_client; os_type=${platform}; arch=${arch}; cl=${DEFAULT_ANTIGRAVITY_CL}; auth_method=consumer)`
}

/** No-op stub: local consumer CLI user-agent keeps pinned version. */
export async function refreshAntigravityIdeVersion(_fetchImpl: typeof fetch = fetch): Promise<string> {
    return getAntigravityIdeVersion()
}

/** No-op stub: local consumer CLI user-agent does not poll the Hub macOS manifest. */
export function startAntigravityIdeVersionUpdater(): void {
    // intentionally disabled for local consumer CLI UA
}
