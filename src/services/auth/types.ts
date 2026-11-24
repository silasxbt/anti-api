/** Every supported provider, in routing priority order. */
export const AUTH_PROVIDERS = ["antigravity", "codex", "copilot", "zed", "kiro", "grok"] as const
export type AuthProvider = (typeof AUTH_PROVIDERS)[number]

/** Human-readable provider names for logs and UI. */
export const PROVIDER_DISPLAY_NAMES: Record<AuthProvider, string> = {
    antigravity: "Antigravity",
    codex: "ChatGPT Codex",
    copilot: "GitHub Copilot",
    zed: "Zed",
    kiro: "Kiro",
    grok: "Grok",
}
export type AuthSource = "codex-cli" | "cli-proxy" | "zed-local" | "zed-credentials-file" | "kiro-local" | "kiro-cli" | "kiro-refresh-token" | "grok-cli"

export interface ProviderAccount {
    id: string
    provider: AuthProvider
    email?: string
    login?: string
    label?: string
    proxy?: string
    accessToken: string
    refreshToken?: string
    expiresAt?: number
    projectId?: string
    /** User-configured subscription plan for quota budget calibration (see lib/account-plans). */
    plan?: string
    organizationId?: string
    serverUrl?: string
    authSource?: AuthSource
    metadata?: Record<string, unknown>
    createdAt?: string
    updatedAt?: string
}

export interface ProviderAccountSummary {
    id: string
    provider: AuthProvider
    displayName: string
    email?: string
    login?: string
    label?: string
    proxy?: string
    expiresAt?: number
}
