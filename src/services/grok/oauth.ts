/**
 * Grok (xAI) 账户认证
 *
 * Grok CLI 把会话凭证存放在 ~/.grok/auth.json，键名形如：
 *   "https://auth.x.ai::<oidc_client_id>"
 * value 中包含 OIDC session access token（字段 key）、refresh_token、expires_at 等。
 *
 * anti-api 复用该凭证（不实现独立登录流程）：
 *  - 启动/失效时从 ~/.grok/auth.json 重新导入（Grok CLI 会自行续期该文件）
 *  - 必要时用 refresh_token 走 https://auth.x.ai/oauth2/token 续期作为兜底
 */

import { existsSync, readFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import consola from "consola"
import { authStore } from "~/services/auth/store"
import type { AuthProvider, ProviderAccount } from "~/services/auth/types"
import { safeErrorMessage } from "~/lib/redaction"

const GROK_HOME = process.env.GROK_HOME || join(homedir(), ".grok")
const GROK_AUTH_FILE = process.env.GROK_AUTH_PATH || join(GROK_HOME, "auth.json")
const GROK_TOKEN_URL = process.env.ANTI_API_GROK_TOKEN_URL || "https://auth.x.ai/oauth2/token"
const GROK_AUTH_SCOPE_PREFIX = "https://auth.x.ai::"

export const GROK_PROVIDER: AuthProvider = "grok"

interface GrokAuthEntry {
    key?: string
    auth_method?: string
    created_at?: string
    user_id?: string
    email?: string
    first_name?: string
    team_id?: string
    refresh_token?: string
    expires_at?: string
    oidc_issuer?: string
    oidc_client_id?: string
}

const refreshLocks = new Map<string, Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }>>()

function decodeJwtPayload(token: string): Record<string, unknown> | null {
    try {
        const part = token.split(".")[1]
        if (!part) return null
        const padded = part + "=".repeat((4 - (part.length % 4)) % 4)
        const json = Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8")
        return JSON.parse(json)
    } catch {
        return null
    }
}

function getJwtExpiresAt(token: string): number | undefined {
    const payload = decodeJwtPayload(token)
    const exp = payload?.exp
    if (typeof exp === "number" && Number.isFinite(exp)) {
        return exp * 1000
    }
    return undefined
}

function isJwtExpired(token: string): boolean {
    const expiresAt = getJwtExpiresAt(token)
    if (!expiresAt) return false
    return expiresAt <= Date.now() + 60_000
}

function parseExpiresAt(value: string | undefined, token: string): number | undefined {
    if (value) {
        const parsed = Date.parse(value)
        if (Number.isFinite(parsed)) return parsed
    }
    return getJwtExpiresAt(token)
}

function clientIdFromScope(scope: string, entry: GrokAuthEntry): string | undefined {
    if (entry.oidc_client_id) return entry.oidc_client_id
    if (scope.startsWith(GROK_AUTH_SCOPE_PREFIX)) {
        return scope.slice(GROK_AUTH_SCOPE_PREFIX.length) || undefined
    }
    return undefined
}

function entryToAccount(scope: string, entry: GrokAuthEntry): ProviderAccount | null {
    const accessToken = entry.key
    if (!accessToken) return null
    const id = entry.user_id || entry.email || scope
    const clientId = clientIdFromScope(scope, entry)
    const label = entry.first_name
        ? `Grok (${entry.first_name})`
        : entry.email
            ? `Grok (${entry.email})`
            : "Grok"

    return {
        id,
        provider: GROK_PROVIDER,
        email: entry.email,
        login: entry.first_name,
        label,
        accessToken,
        refreshToken: entry.refresh_token,
        expiresAt: parseExpiresAt(entry.expires_at, accessToken),
        authSource: "grok-cli",
        metadata: {
            scope,
            clientId,
            teamId: entry.team_id,
            oidcIssuer: entry.oidc_issuer,
        },
    }
}

function readGrokAuthFile(): ProviderAccount[] {
    if (!existsSync(GROK_AUTH_FILE)) return []
    try {
        const raw = JSON.parse(readFileSync(GROK_AUTH_FILE, "utf-8")) as Record<string, GrokAuthEntry>
        const accounts: ProviderAccount[] = []
        for (const [scope, entry] of Object.entries(raw)) {
            if (!entry || typeof entry !== "object") continue
            const account = entryToAccount(scope, entry)
            if (account) accounts.push(account)
        }
        return accounts
    } catch (error) {
        consola.warn("Failed to parse Grok auth file:", safeErrorMessage(error))
        return []
    }
}

/**
 * 从 ~/.grok/auth.json 导入 Grok 账户并写入 authStore。
 * 会保留已有账户的 metadata/label（仅刷新 token 字段）。
 */
export async function importGrokAuthSources(): Promise<{ accounts: ProviderAccount[]; sources: string[] }> {
    const accounts = readGrokAuthFile()
    const sources: string[] = []
    if (accounts.length > 0) {
        sources.push(GROK_AUTH_FILE)
    }
    for (const account of accounts) {
        const existing = authStore.getAccount(GROK_PROVIDER, account.id)
        authStore.saveAccount({
            ...existing,
            ...account,
            metadata: { ...(existing?.metadata || {}), ...(account.metadata || {}) },
            createdAt: existing?.createdAt,
        })
    }
    return { accounts, sources }
}

export function getGrokClientId(account: ProviderAccount): string | undefined {
    const fromMeta = account.metadata?.clientId
    if (typeof fromMeta === "string" && fromMeta) return fromMeta
    const scope = account.metadata?.scope
    if (typeof scope === "string" && scope.startsWith(GROK_AUTH_SCOPE_PREFIX)) {
        return scope.slice(GROK_AUTH_SCOPE_PREFIX.length) || undefined
    }
    return undefined
}

export async function refreshGrokAccessToken(
    refreshToken: string,
    clientId?: string
): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }> {
    const key = `${clientId || "grok"}:${refreshToken}`
    const existing = refreshLocks.get(key)
    if (existing) return existing

    const task = (async () => {
        try {
            const params = new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: refreshToken,
            })
            if (clientId) params.set("client_id", clientId)

            const response = await fetch(GROK_TOKEN_URL, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
                body: params.toString(),
            })

            const text = await response.text()
            if (response.status < 200 || response.status >= 300) {
                throw new Error(`Grok token refresh failed (${response.status})`)
            }

            const data = (text ? JSON.parse(text) : {}) as {
                access_token?: string
                accessToken?: string
                refresh_token?: string
                refreshToken?: string
                expires_in?: number
            }
            const accessToken = data.access_token || data.accessToken
            if (!accessToken) {
                throw new Error("Grok token refresh failed: missing access token")
            }
            return {
                accessToken,
                refreshToken: data.refresh_token || data.refreshToken,
                expiresIn: data.expires_in,
            }
        } finally {
            refreshLocks.delete(key)
        }
    })()

    refreshLocks.set(key, task)
    return task
}

/**
 * 续期顺序：
 *  1. token 仍有效 → 直接返回
 *  2. 先尝试从 ~/.grok/auth.json 重新导入（Grok CLI 通常已续期该文件）
 *  3. 仍失效则用 refresh_token 走 OIDC token 端点兜底
 */
export async function refreshGrokAccountIfNeeded(account: ProviderAccount): Promise<ProviderAccount> {
    const now = Date.now()
    const hasAccessToken = !!account.accessToken
    const hasExpiry = typeof account.expiresAt === "number" && Number.isFinite(account.expiresAt)

    if (hasAccessToken && hasExpiry && account.expiresAt! > now + 60_000) {
        return account
    }
    if (hasAccessToken && !hasExpiry && !isJwtExpired(account.accessToken)) {
        return account
    }

    // 2. 重新从磁盘导入
    try {
        const fromDisk = readGrokAuthFile().find(acc => acc.id === account.id || (acc.email && acc.email === account.email))
        if (fromDisk?.accessToken && fromDisk.accessToken !== account.accessToken) {
            const updated: ProviderAccount = {
                ...account,
                accessToken: fromDisk.accessToken,
                refreshToken: fromDisk.refreshToken || account.refreshToken,
                expiresAt: fromDisk.expiresAt || account.expiresAt,
                metadata: { ...(account.metadata || {}), ...(fromDisk.metadata || {}) },
            }
            if (!isJwtExpired(updated.accessToken)) {
                authStore.saveAccount(updated)
                return updated
            }
        }
    } catch {
        // ignore and fall through to refresh-token flow
    }

    // 3. refresh_token 兜底
    if (!account.refreshToken) {
        return account
    }
    const refreshed = await refreshGrokAccessToken(account.refreshToken, getGrokClientId(account))
    const updated: ProviderAccount = {
        ...account,
        accessToken: refreshed.accessToken,
    }
    if (refreshed.refreshToken) {
        updated.refreshToken = refreshed.refreshToken
    }
    if (refreshed.expiresIn) {
        updated.expiresAt = now + refreshed.expiresIn * 1000
    } else {
        const jwtExpiry = getJwtExpiresAt(refreshed.accessToken)
        if (jwtExpiry) updated.expiresAt = jwtExpiry
    }
    authStore.saveAccount(updated)
    return updated
}
