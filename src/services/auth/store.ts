import { existsSync, readFileSync, readdirSync, unlinkSync } from "fs"
import { join } from "path"
import consola from "consola"
import { ensurePrivateDir, tightenPrivateFile, writePrivateFile } from "~/lib/private-file"
import { parseRetryDelay } from "~/lib/retry"
import type { AuthProvider, ProviderAccount, ProviderAccountSummary } from "./types"
import { getDataDir } from "~/lib/data-dir"
import { safeErrorMessage } from "~/lib/redaction"

const AUTH_DIR = join(getDataDir(), "auth")

interface StoredAuthFile {
    id: string
    type: string
    email?: string
    login?: string
    label?: string
    auth_source?: string
    access_token: string
    refresh_token?: string
    expires_at?: number
    project_id?: string
    organization_id?: string
    server_url?: string
    metadata?: Record<string, unknown>
    created_at?: string
    updated_at?: string
}

type RateLimitState = {
    rateLimitedUntil: number | null
    consecutiveFailures: number
}

const rateLimitState = new Map<string, RateLimitState>()
const AUTH_CACHE_TTL_MS = 1000

let cachedAccounts: ProviderAccount[] | null = null
let cacheLoadedAt = 0
let cacheDirty = true

function ensureAuthDir(): void {
    ensurePrivateDir(AUTH_DIR)
}

function sanitizeFileKey(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, "_")
}

function accountKey(provider: AuthProvider, id: string): string {
    return `${provider}:${id}`
}

function providerToStoredType(provider: AuthProvider): string {
    if (provider === "copilot") return "github-copilot"
    if (provider === "zed") return "zed"
    if (provider === "kiro") return "kiro"
    return provider
}

function storedTypeToProvider(type: string): AuthProvider | null {
    if (type === "github-copilot" || type === "copilot") return "copilot"
    if (type === "antigravity") return "antigravity"
    if (type === "codex") return "codex"
    if (type === "zed") return "zed"
    if (type === "kiro") return "kiro"
    if (type === "grok") return "grok"
    return null
}

function toSummary(account: ProviderAccount): ProviderAccountSummary {
    const displayName =
        account.label ||
        account.email ||
        account.login ||
        `${account.provider}-${account.id}`

    return {
        id: account.id,
        provider: account.provider,
        displayName,
        email: account.email,
        login: account.login,
        label: account.label,
        expiresAt: account.expiresAt,
    }
}

function loadAccountFromFile(path: string): ProviderAccount | null {
    try {
        tightenPrivateFile(path)
        const raw = JSON.parse(readFileSync(path, "utf-8")) as StoredAuthFile
        const provider = storedTypeToProvider(raw.type)
        if (!provider || !raw.access_token || !raw.id) {
            return null
        }
        return {
            id: raw.id,
            provider,
            email: raw.email,
            login: raw.login,
            label: raw.label,
            accessToken: raw.access_token,
            refreshToken: raw.refresh_token,
            expiresAt: raw.expires_at,
            projectId: raw.project_id,
            organizationId: raw.organization_id,
            serverUrl: raw.server_url,
            authSource: raw.auth_source as ProviderAccount["authSource"],
            metadata: raw.metadata,
            createdAt: raw.created_at,
            updatedAt: raw.updated_at,
        }
    } catch (error) {
        consola.warn("Failed to parse auth file:", path, safeErrorMessage(error))
        return null
    }
}

function writeAccountFile(account: ProviderAccount): void {
    ensureAuthDir()

    const filename = `${providerToStoredType(account.provider)}-${sanitizeFileKey(account.id)}.json`
    const path = join(AUTH_DIR, filename)
    const now = new Date().toISOString()

    const payload: StoredAuthFile = {
        id: account.id,
        type: providerToStoredType(account.provider),
        email: account.email,
        login: account.login,
        label: account.label,
        auth_source: account.authSource,
        access_token: account.accessToken,
        refresh_token: account.refreshToken,
        expires_at: account.expiresAt,
        project_id: account.projectId,
        organization_id: account.organizationId,
        server_url: account.serverUrl,
        metadata: account.metadata,
        created_at: account.createdAt || now,
        updated_at: now,
    }

    writePrivateFile(path, JSON.stringify(payload, null, 2))
}

function loadAccountsFromDisk(): ProviderAccount[] {
    ensureAuthDir()
    const files = readdirSync(AUTH_DIR).filter(f => f.endsWith(".json"))
    const accounts: ProviderAccount[] = []
    for (const file of files) {
        const account = loadAccountFromFile(join(AUTH_DIR, file))
        if (!account) continue
        accounts.push(account)
    }
    return accounts
}

function ensureAccountCache(force = false): ProviderAccount[] {
    const expired = Date.now() - cacheLoadedAt > AUTH_CACHE_TTL_MS
    if (!force && cachedAccounts && !cacheDirty && !expired) {
        return cachedAccounts
    }
    cachedAccounts = loadAccountsFromDisk()
    cacheLoadedAt = Date.now()
    cacheDirty = false
    return cachedAccounts
}

function invalidateAccountCache(): void {
    cacheDirty = true
}

function cloneAccount(account: ProviderAccount): ProviderAccount {
    return { ...account }
}

export const authStore = {
    listAccounts(provider?: AuthProvider): ProviderAccount[] {
        const accounts = ensureAccountCache()
        const filtered = provider
            ? accounts.filter(account => account.provider === provider)
            : accounts
        return filtered.map(cloneAccount)
    },

    listSummaries(provider?: AuthProvider): ProviderAccountSummary[] {
        return this.listAccounts(provider).map(toSummary)
    },

    getAccount(provider: AuthProvider, id: string): ProviderAccount | null {
        const accounts = ensureAccountCache()
        const account = accounts.find(acc => acc.provider === provider && acc.id === id)
        return account ? cloneAccount(account) : null
    },

    saveAccount(account: ProviderAccount): void {
        writeAccountFile(account)
        invalidateAccountCache()
    },

    deleteAccount(provider: AuthProvider, id: string): boolean {
        ensureAuthDir()
        const filename = `${providerToStoredType(provider)}-${sanitizeFileKey(id)}.json`
        const path = join(AUTH_DIR, filename)
        if (!existsSync(path)) return false
        try {
            unlinkSync(path)
            invalidateAccountCache()
            return true
        } catch (error) {
            consola.warn("Failed to delete auth file:", path, safeErrorMessage(error))
            return false
        }
    },

    markRateLimited(
        provider: AuthProvider,
        id: string,
        statusCode: number,
        errorText: string,
        retryAfterHeader?: string
    ): number {
        const key = accountKey(provider, id)
        const existing = rateLimitState.get(key) || { rateLimitedUntil: null, consecutiveFailures: 0 }
        existing.consecutiveFailures += 1

        const retryDelay = parseRetryDelay(errorText, retryAfterHeader)
        const baseDelay = retryDelay ?? 30_000
        const delay = retryDelay ? Math.max(baseDelay + 500, 2_000) : baseDelay
        const nextUntil = Date.now() + delay
        existing.rateLimitedUntil = nextUntil
        rateLimitState.set(key, existing)

        consola.warn(
            `[${provider}] Account ${id} rate limited (status ${statusCode}) for ${Math.ceil(delay / 1000)}s`
        )
        return delay
    },

    isRateLimited(provider: AuthProvider, id: string): boolean {
        const key = accountKey(provider, id)
        const state = rateLimitState.get(key)
        if (!state || !state.rateLimitedUntil) return false
        if (state.rateLimitedUntil <= Date.now()) {
            rateLimitState.set(key, { ...state, rateLimitedUntil: null })
            return false
        }
        return true
    },

    markSuccess(provider: AuthProvider, id: string): void {
        const key = accountKey(provider, id)
        rateLimitState.set(key, { rateLimitedUntil: null, consecutiveFailures: 0 })
    },
}
