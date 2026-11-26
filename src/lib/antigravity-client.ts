const DEFAULT_ANTIGRAVITY_IDE_VERSION = "1.5.2"
const DEFAULT_ANTIGRAVITY_CL = "1015175089"

export function getAntigravityIdeVersion(): string {
    return process.env.ANTIGRAVITY_IDE_VERSION?.trim() || DEFAULT_ANTIGRAVITY_IDE_VERSION
}

export function getAntigravityUserAgent(): string {
    const envAgent = process.env.ANTIGRAVITY_USER_AGENT?.trim()
    if (envAgent) return envAgent
    const version = getAntigravityIdeVersion()
    const platform = process.platform === "darwin" ? "macos" : process.platform
    const arch = process.arch === "x64" ? "amd64" : process.arch
    return `antigravity/cli/${version} (aidev_client; os_type=${platform}; arch=${arch}; cl=${DEFAULT_ANTIGRAVITY_CL}; auth_method=consumer)`
}
