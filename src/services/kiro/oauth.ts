import { createHash } from "crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs"
import { getDataDir } from "~/lib/data-dir"
import { ensurePrivateDir, writePrivateFile } from "~/lib/private-file"
import { dirname, join, resolve } from "path"
import Database from "better-sqlite3"
import type { ProviderAccount } from "~/services/auth/types"

const KIRO_AUTH_TOKEN_PATH = join(process.env.HOME || "", ".aws", "sso", "cache", "kiro-auth-token.json")
const KIRO_CLI_DB_PATH = join(process.env.HOME || "", ".local", "share", "kiro-cli", "data.sqlite3")
const AMAZON_Q_CLI_DB_PATH = join(process.env.HOME || "", ".local", "share", "amazon-q", "data.sqlite3")
const KIRO_AUTH_ENDPOINT_TEMPLATE = process.env.ANTI_API_KIRO_AUTH_ENDPOINT || process.env.ANTI_API_KIRO_AUTH_ENDPOINT_TEMPLATE || "https://prod.{region}.auth.desktop.kiro.dev"
const KIRO_REGION = process.env.ANTI_API_KIRO_REGION || "us-east-1"
const KIRO_ENDPOINT_TEMPLATE = process.env.ANTI_API_KIRO_ENDPOINT || process.env.ANTI_API_KIRO_ENDPOINT_TEMPLATE || "https://q.{region}.amazonaws.com"
const REFRESH_SKEW_MS = 2 * 60 * 1000

const SQLITE_TOKEN_KEYS = [
    "kirocli:social:token",
    "kirocli:odic:token",
    "codewhisperer:odic:token",
]
const SQLITE_REGISTRATION_KEYS = [
    "kirocli:odic:device-registration",
    "codewhisperer:odic:device-registration",
]

type KiroAuthType = "kiro_desktop" | "aws_sso_oidc"
type KiroCredentialType = "json" | "sqlite" | "refresh_token"

interface KiroTokenFile {
    accessToken?: string
    refreshToken?: string
    profileArn?: string
    expiresAt?: string
    region?: string
    authMethod?: string
    provider?: string
    clientId?: string
    clientSecret?: string
    clientIdHash?: string
}

interface KiroCredential {
    credentialType: KiroCredentialType
    authType: KiroAuthType
    sourcePath?: string
    sqliteTokenKey?: string
    accessToken?: string
    refreshToken?: string
    profileArn?: string
    expiresAt?: string
    region?: string
    apiRegion?: string
    provider?: string
    clientId?: string
    clientSecret?: string
}

interface KiroImportOptions {
    paths?: string[]
    refreshToken?: string
    profileArn?: string
    region?: string
    apiRegion?: string
}

function expandHome(path: string): string {
    if (path === "~") return process.env.HOME || path
    if (path.startsWith("~/")) return join(process.env.HOME || "", path.slice(2))
    return path
}

function assertNotSymlink(path: string): void {
    try {
        if (lstatSync(path).isSymbolicLink()) {
            throw new Error(`Refusing to read symlinked Kiro credential: ${path}`)
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return
        throw error
    }
}

function parseJsonFile<T>(path: string): T {
    assertNotSymlink(path)
    return JSON.parse(readFileSync(path, "utf-8")) as T
}

function parseExpiry(value?: string): number | undefined {
    if (!value) return undefined
    const timestamp = Date.parse(value)
    return Number.isFinite(timestamp) ? timestamp : undefined
}

function formatEndpoint(template: string, region: string): string {
    return template.replace("{region}", region)
}

function getKiroUserAgent(): string {
    return `KiroIDE-${process.env.ANTI_API_KIRO_VERSION || "0.0.0"}-anti-api`
}

function stableHash(value: string): string {
    return createHash("sha256").update(value).digest("hex").slice(0, 16)
}

function getStringMetadata(account: ProviderAccount, key: string): string | undefined {
    const value = account.metadata?.[key]
    return typeof value === "string" ? value : undefined
}

function sanitizeFileKey(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, "_")
}

function getAuthDir(): string {
    return join(getDataDir(), "auth")
}

function providerToStoredType(provider: ProviderAccount["provider"]): string {
    if (provider === "copilot") return "github-copilot"
    return provider
}

function ensureAuthDir(): void {
    ensurePrivateDir(getAuthDir())
}

function saveKiroAccount(account: ProviderAccount): void {
    ensureAuthDir()
    const now = new Date().toISOString()
    const path = join(getAuthDir(), `${providerToStoredType(account.provider)}-${sanitizeFileKey(account.id)}.json`)
    writePrivateFile(path, JSON.stringify({
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
    }, null, 2))
}

function normalizeJsonCredential(path: string, overrides: Partial<KiroCredential> = {}): KiroCredential | null {
    const data = parseJsonFile<KiroTokenFile>(path)
    const device = data.clientIdHash
        ? readEnterpriseDeviceRegistration(data.clientIdHash)
        : {}
    const clientId = data.clientId || device.clientId
    const clientSecret = data.clientSecret || device.clientSecret
    if (!data.accessToken && !data.refreshToken) return null
    return {
        credentialType: "json",
        authType: clientId && clientSecret ? "aws_sso_oidc" : "kiro_desktop",
        sourcePath: path,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        profileArn: overrides.profileArn || data.profileArn,
        expiresAt: data.expiresAt,
        region: overrides.region || data.region || KIRO_REGION,
        apiRegion: overrides.apiRegion || data.region || KIRO_REGION,
        provider: data.provider || data.authMethod,
        clientId,
        clientSecret,
    }
}

function readEnterpriseDeviceRegistration(clientIdHash: string): Partial<KiroTokenFile> {
    const path = join(process.env.HOME || "", ".aws", "sso", "cache", `${clientIdHash}.json`)
    if (!existsSync(path)) return {}
    try {
        return parseJsonFile<KiroTokenFile>(path)
    } catch {
        return {}
    }
}

function readSqliteJson<T>(db: Database.Database, key: string): T | null {
    const row = db.prepare("SELECT value FROM auth_kv WHERE key = ?").get(key) as { value?: string } | undefined
    if (!row?.value) return null
    return JSON.parse(row.value) as T
}

function readSqliteStateJson<T>(db: Database.Database, key: string): T | null {
    const row = db.prepare("SELECT value FROM state WHERE key = ?").get(key) as { value?: string } | undefined
    if (!row?.value) return null
    return JSON.parse(row.value) as T
}

function loadSqliteCredential(path: string, overrides: Partial<KiroCredential> = {}): KiroCredential | null {
    assertNotSymlink(path)
    const db = new Database(path, { readonly: true, fileMustExist: true })
    try {
        let tokenKey: string | undefined
        let tokenData: any = null
        for (const key of SQLITE_TOKEN_KEYS) {
            tokenData = readSqliteJson<any>(db, key)
            if (tokenData) {
                tokenKey = key
                break
            }
        }
        if (!tokenData || !tokenKey) return null

        let registration: any = null
        for (const key of SQLITE_REGISTRATION_KEYS) {
            registration = readSqliteJson<any>(db, key)
            if (registration) break
        }

        const profile = (() => {
            try {
                return readSqliteStateJson<any>(db, "api.codewhisperer.profile")
            } catch {
                return null
            }
        })()
        const arn = tokenData.profile_arn || profile?.arn
        const arnRegion = typeof arn === "string" ? arn.split(":")[3] : undefined
        const region = overrides.region || tokenData.region || registration?.region || KIRO_REGION
        const apiRegion = overrides.apiRegion || arnRegion || region
        const clientId = registration?.client_id
        const clientSecret = registration?.client_secret

        return {
            credentialType: "sqlite",
            authType: clientId && clientSecret ? "aws_sso_oidc" : "kiro_desktop",
            sourcePath: path,
            sqliteTokenKey: tokenKey,
            accessToken: tokenData.access_token,
            refreshToken: tokenData.refresh_token,
            profileArn: overrides.profileArn || arn,
            expiresAt: tokenData.expires_at,
            region,
            apiRegion,
            provider: tokenData.provider || tokenKey.replace(":token", ""),
            clientId,
            clientSecret,
        }
    } finally {
        db.close()
    }
}

function saveCredentialToSource(credential: KiroCredential): void {
    if (process.env.ANTI_API_KIRO_WRITEBACK !== "1") return
    if (!credential.sourcePath) return
    if (credential.credentialType === "json") {
        assertNotSymlink(credential.sourcePath)
        mkdirSync(dirname(credential.sourcePath), { recursive: true })
        const existing = existsSync(credential.sourcePath)
            ? parseJsonFile<Record<string, unknown>>(credential.sourcePath)
            : {}
        const payload = {
            ...existing,
            accessToken: credential.accessToken,
            refreshToken: credential.refreshToken,
            expiresAt: credential.expiresAt,
            profileArn: credential.profileArn,
            region: credential.region,
        }
        writeFileSync(credential.sourcePath, JSON.stringify(payload, null, 2), { mode: 0o600 })
        return
    }
    if (credential.credentialType === "sqlite" && credential.sqliteTokenKey) {
        const db = new Database(credential.sourcePath)
        try {
            const existing = readSqliteJson<Record<string, unknown>>(db, credential.sqliteTokenKey) || {}
            const payload = {
                ...existing,
                access_token: credential.accessToken,
                refresh_token: credential.refreshToken,
                expires_at: credential.expiresAt,
                region: credential.region,
            }
            db.prepare("UPDATE auth_kv SET value = ? WHERE key = ?")
                .run(JSON.stringify(payload), credential.sqliteTokenKey)
        } finally {
            db.close()
        }
    }
}

function credentialToAccount(credential: KiroCredential): ProviderAccount {
    if (!credential.accessToken) {
        throw new Error("Kiro credential does not contain an access token.")
    }
    const region = credential.apiRegion || credential.region || KIRO_REGION
    const id = credential.profileArn || `kiro-${stableHash(`${credential.sourcePath || credential.credentialType}:${credential.refreshToken || credential.accessToken}`)}`
    const labelSuffix = credential.provider || credential.credentialType
    return {
        id,
        provider: "kiro",
        label: `Kiro ${labelSuffix}`,
        accessToken: credential.accessToken,
        refreshToken: credential.refreshToken,
        expiresAt: parseExpiry(credential.expiresAt),
        projectId: credential.profileArn,
        organizationId: region,
        serverUrl: formatEndpoint(KIRO_ENDPOINT_TEMPLATE, region),
        authSource: credential.credentialType === "sqlite" ? "kiro-cli" : credential.credentialType === "refresh_token" ? "kiro-refresh-token" : "kiro-local",
        metadata: {
            kiroCredentialType: credential.credentialType,
            kiroAuthType: credential.authType,
            sourcePath: credential.sourcePath,
            sqliteTokenKey: credential.sqliteTokenKey,
            ssoRegion: credential.region || KIRO_REGION,
            apiRegion: region,
            clientId: credential.clientId,
            clientSecret: credential.clientSecret,
        },
    }
}

function accountToCredential(account: ProviderAccount): KiroCredential {
    return {
        credentialType: (getStringMetadata(account, "kiroCredentialType") as KiroCredentialType | undefined) || "json",
        authType: (getStringMetadata(account, "kiroAuthType") as KiroAuthType | undefined) || "kiro_desktop",
        sourcePath: getStringMetadata(account, "sourcePath"),
        sqliteTokenKey: getStringMetadata(account, "sqliteTokenKey"),
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        profileArn: account.projectId,
        expiresAt: account.expiresAt ? new Date(account.expiresAt).toISOString() : undefined,
        region: getStringMetadata(account, "ssoRegion") || account.organizationId || KIRO_REGION,
        apiRegion: getStringMetadata(account, "apiRegion") || account.organizationId || KIRO_REGION,
        clientId: getStringMetadata(account, "clientId"),
        clientSecret: getStringMetadata(account, "clientSecret"),
    }
}

async function refreshKiroDesktopToken(credential: KiroCredential): Promise<KiroCredential> {
    if (!credential.refreshToken) {
        throw new Error("Kiro token is expired and no refresh token is available.")
    }
    const region = credential.region || KIRO_REGION
    const response = await fetch(`${formatEndpoint(KIRO_AUTH_ENDPOINT_TEMPLATE, region)}/refreshToken`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "User-Agent": getKiroUserAgent(),
        },
        body: JSON.stringify({ refreshToken: credential.refreshToken }),
    })
    const text = await response.text()
    const data = text ? JSON.parse(text) : null
    if (!response.ok || !data?.accessToken) {
        throw new Error(`Kiro token refresh failed (${response.status})`)
    }
    return {
        ...credential,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken || credential.refreshToken,
        expiresAt: data.expiresAt || (data.expiresIn ? new Date(Date.now() + (data.expiresIn - 60) * 1000).toISOString() : credential.expiresAt),
        profileArn: data.profileArn || credential.profileArn,
    }
}

async function refreshAwsSsoOidcToken(credential: KiroCredential): Promise<KiroCredential> {
    if (!credential.refreshToken || !credential.clientId || !credential.clientSecret) {
        throw new Error("Kiro AWS SSO token refresh requires refreshToken, clientId and clientSecret.")
    }
    const region = credential.region || KIRO_REGION
    const response = await fetch(`https://oidc.${region}.amazonaws.com/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            grantType: "refresh_token",
            clientId: credential.clientId,
            clientSecret: credential.clientSecret,
            refreshToken: credential.refreshToken,
        }),
    })
    const text = await response.text()
    const data = text ? JSON.parse(text) : null
    if (!response.ok || !data?.accessToken) {
        throw new Error(`Kiro AWS SSO token refresh failed (${response.status})`)
    }
    return {
        ...credential,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken || credential.refreshToken,
        expiresAt: data.expiresIn ? new Date(Date.now() + (data.expiresIn - 60) * 1000).toISOString() : credential.expiresAt,
    }
}

async function refreshCredentialIfNeeded(credential: KiroCredential, force = false): Promise<KiroCredential> {
    const expiresAt = parseExpiry(credential.expiresAt)
    if (!force && expiresAt && expiresAt > Date.now() + REFRESH_SKEW_MS) {
        return credential
    }
    const refreshed = credential.authType === "aws_sso_oidc"
        ? await refreshAwsSsoOidcToken(credential)
        : await refreshKiroDesktopToken(credential)
    saveCredentialToSource(refreshed)
    return refreshed
}

function collectCredentialPaths(paths: string[] = []): string[] {
    const candidates = [
        process.env.ANTI_API_KIRO_CREDS_FILE,
        process.env.ANTI_API_KIRO_CLI_DB_FILE,
        KIRO_AUTH_TOKEN_PATH,
        KIRO_CLI_DB_PATH,
        AMAZON_Q_CLI_DB_PATH,
        ...paths,
    ].filter(Boolean).map(path => resolve(expandHome(path!)))

    const expanded: string[] = []
    const seen = new Set<string>()
    for (const candidate of candidates) {
        if (!existsSync(candidate)) continue
        const stat = statSync(candidate)
        const files = stat.isDirectory()
            ? readdirSync(candidate).map(file => join(candidate, file)).filter(file => statSync(file).isFile())
            : [candidate]
        for (const file of files) {
            const resolved = resolve(file)
            if (!seen.has(resolved)) {
                seen.add(resolved)
                expanded.push(resolved)
            }
        }
    }
    return expanded
}

export async function importKiroAuthSources(options: KiroImportOptions = {}): Promise<{ accounts: ProviderAccount[]; sources: string[] }> {
    const credentials: KiroCredential[] = []
    const sources: string[] = []

    for (const path of collectCredentialPaths(options.paths)) {
        try {
            const credential = path.endsWith(".sqlite") || path.endsWith(".sqlite3") || path.endsWith(".db")
                ? loadSqliteCredential(path, options)
                : normalizeJsonCredential(path, options)
            if (!credential) continue
            credentials.push(await refreshCredentialIfNeeded(credential))
            sources.push(path)
        } catch {
            continue
        }
    }

    if (options.refreshToken) {
        const credential = await refreshCredentialIfNeeded({
            credentialType: "refresh_token",
            authType: "kiro_desktop",
            refreshToken: options.refreshToken,
            profileArn: options.profileArn,
            region: options.region || KIRO_REGION,
            apiRegion: options.apiRegion || options.region || KIRO_REGION,
        }, true)
        credentials.push(credential)
        sources.push("refresh_token")
    }

    const accounts = credentials.map(credentialToAccount)
    for (const account of accounts) {
        saveKiroAccount(account)
    }
    return { accounts, sources }
}

export async function readKiroToken(refreshIfNeeded = true): Promise<KiroTokenFile> {
    const credential = normalizeJsonCredential(KIRO_AUTH_TOKEN_PATH)
    if (!credential) {
        throw new Error(`Kiro auth file not found or invalid: ${KIRO_AUTH_TOKEN_PATH}. Sign in with Kiro first.`)
    }
    const refreshed = refreshIfNeeded ? await refreshCredentialIfNeeded(credential) : credential
    return {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        profileArn: refreshed.profileArn,
        expiresAt: refreshed.expiresAt,
        region: refreshed.region,
        provider: refreshed.provider,
    }
}

export async function refreshKiroAccountIfNeeded(account: ProviderAccount): Promise<ProviderAccount> {
    const expiresAt = account.expiresAt
    if (!expiresAt || expiresAt > Date.now() + REFRESH_SKEW_MS) {
        return account
    }
    const refreshedCredential = await refreshCredentialIfNeeded(accountToCredential(account), true)
    const refreshed = {
        ...credentialToAccount(refreshedCredential),
        id: account.id,
        createdAt: account.createdAt,
        updatedAt: new Date().toISOString(),
    }
    saveKiroAccount(refreshed)
    return refreshed
}

export async function importKiroLocalAccount(): Promise<ProviderAccount> {
    const result = await importKiroAuthSources({ paths: [KIRO_AUTH_TOKEN_PATH] })
    const account = result.accounts[0]
    if (!account) {
        throw new Error(`Kiro auth file not found: ${KIRO_AUTH_TOKEN_PATH}. Sign in with Kiro first.`)
    }
    return account
}

export function getKiroRegion(account?: ProviderAccount): string {
    return account?.organizationId || KIRO_REGION
}

export function getKiroEndpoint(account?: ProviderAccount): string {
    return account?.serverUrl || formatEndpoint(KIRO_ENDPOINT_TEMPLATE, getKiroRegion(account))
}
