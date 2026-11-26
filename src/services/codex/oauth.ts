import consola from "consola"
import https from "https"
import { createHash, randomBytes } from "node:crypto"
import { existsSync, readFileSync, readdirSync } from "fs"
import { join } from "path"
import { ensurePrivateDir, writePrivateFile } from "~/lib/private-file"
import { authStore } from "~/services/auth/store"
import type { AuthSource, ProviderAccount } from "~/services/auth/types"
import { openBrowser } from "~/lib/open-browser"
import { redactSensitiveText, safeErrorMessage } from "~/lib/redaction"

const CODEX_AUTH_FILE = "~/.codex/auth.json"
const CODEX_PROXY_AUTH_DIR = "~/.cli-proxy-api"
const CODEX_PROXY_REFRESH_URL = process.env.ANTI_API_CODEX_PROXY_REFRESH_URL?.trim()
const ALLOW_THIRD_PARTY_CODEX_REFRESH = process.env.ANTI_API_ALLOW_THIRD_PARTY_CODEX_REFRESH === "1"
const CODEX_CLI_LOGIN_TIMEOUT_MS = 10 * 60 * 1000
const CODEX_INSECURE_TLS = process.env.ANTI_API_CODEX_INSECURE_TLS === "1"
const CODEX_TLS_HINT = "Codex OAuth TLS certificate error. Set ANTI_API_CODEX_INSECURE_TLS=1 to bypass."

type CodexCliLoginSession = {
    id: string
    status: "pending" | "success" | "error"
    message?: string
    userCode?: string
    verificationUri?: string
    output: string
    createdAt: number
    exitCode?: number
    imported?: boolean
    process: ReturnType<typeof Bun.spawn>
}

const codexCliSessions = new Map<string, CodexCliLoginSession>()

const CODEX_OAUTH_CONFIG = {
    clientId: process.env.CODEX_CLIENT_ID || "app_EMoamEEZ73f0CkXaXp7hrann",
    clientSecret: process.env.CODEX_CLIENT_SECRET || "",
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    scopes: ["openid", "email", "profile", "offline_access"],
    callbackPort: 1455,
    callbackPath: "/auth/callback",
}

const refreshLocks = new Map<string, Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }>>()

type CodexTokens = {
    accessToken: string
    refreshToken?: string
    expiresIn?: number
    idToken?: string
}

type JsonResponse = {
    status: number
    data: any
    text: string
}

type CodexCallbackResult = {
    code?: string
    state?: string
    error?: string
    redirectUri?: string
}

type CodexOAuthSession = {
    state: string
    authUrl: string
    fallbackUrl?: string
    redirectUri: string
    expiresAt: number
    callback?: CodexCallbackResult
    server: any
    codeVerifier?: string
}

let activeSession: CodexOAuthSession | null = null
let callbackServer: any | null = null
let callbackServerPort: number | null = null

/**
 * Codex registers one loopback redirect URI.  The callback listener may be
 * reached through another loopback spelling (127.0.0.1 or ::1), but that
 * request origin must never be copied into the token exchange request.
 */
export function getCodexOAuthRedirectUri(port: number): string {
    return `http://localhost:${port}${CODEX_OAUTH_CONFIG.callbackPath}`
}

/** Docker publishes callback ports only to host loopback; the container must
 * accept the NATed connection on its own interface. */
export function getCodexCallbackHostname(): "127.0.0.1" | "0.0.0.0" {
    return process.env.ANTI_API_DOCKER_OAUTH_CALLBACK === "1" ? "0.0.0.0" : "127.0.0.1"
}

/** Compare state values without making a mismatch's common prefix observable. */
export function isCodexOAuthStateValid(expected: string | undefined, actual: string | undefined): boolean {
    if (!expected || !actual || expected.length !== actual.length || expected.length > 512) {
        return false
    }
    let difference = 0
    for (let index = 0; index < expected.length; index++) {
        difference |= expected.charCodeAt(index) ^ actual.charCodeAt(index)
    }
    return difference === 0
}

/** Do not reflect arbitrary OAuth provider text through the local API/UI. */
export function sanitizeCodexOAuthError(value: unknown): string {
    const raw = typeof value === "string" ? value.trim() : ""
    if (/^[a-zA-Z0-9._-]{1,64}$/.test(raw)) {
        return `Codex OAuth authorization failed (${raw})`
    }
    return "Codex OAuth authorization failed"
}

function decodeJwt(token: string): Record<string, any> | null {
    const parts = token.split(".")
    if (parts.length < 2) return null
    const payload = parts[1]
    const padded = payload.padEnd(payload.length + (4 - payload.length % 4) % 4, "=")
    try {
        const decoded = Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8")
        return JSON.parse(decoded)
    } catch {
        return null
    }
}

function expandHomePath(value: string): string {
    const homeDir = process.env.HOME || process.env.USERPROFILE || ""
    return value.replace(/^~\//, `${homeDir}/`)
}

function getErrorCode(error: unknown): string | undefined {
    if (!error || typeof error !== "object") return undefined
    const direct = (error as { code?: string }).code
    const cause = (error as { cause?: { code?: string } }).cause
    return direct || cause?.code
}

function getErrorMessage(error: unknown): string {
    if (!error || typeof error !== "object") return ""
    const direct = (error as { message?: string }).message
    const cause = (error as { cause?: { message?: string } }).cause
    return String(direct || cause?.message || "")
}

function isCertificateError(error: unknown): boolean {
    const code = getErrorCode(error)
    if (code === "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR") return true
    if (code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") return true
    if (code === "SELF_SIGNED_CERT_IN_CHAIN") return true
    if (code === "DEPTH_ZERO_SELF_SIGNED_CERT") return true
    if (code === "CERT_HAS_EXPIRED") return true
    const message = getErrorMessage(error).toLowerCase()
    if (message.includes("certificate") || message.includes("self signed")) return true
    if (message.includes("unable to verify") || message.includes("ssl") || message.includes("tls")) return true
    const fallback = String(error).toLowerCase()
    return fallback.includes("certificate") || fallback.includes("self signed") || fallback.includes("unable to verify")
}

async function fetchJsonWithFallback(
    url: string,
    options: { method?: string; headers?: Record<string, string>; body?: string }
): Promise<JsonResponse> {
    try {
        const bunFetch = (globalThis as { Bun?: { fetch?: typeof fetch } }).Bun?.fetch
        const tls = CODEX_INSECURE_TLS ? { rejectUnauthorized: false } : undefined
        const response = bunFetch
            ? await bunFetch(url, {
                method: options.method,
                headers: options.headers,
                body: options.body,
                ...(tls ? { tls } : {}),
            })
            : await fetch(url, {
                method: options.method,
                headers: options.headers,
                body: options.body,
            })
        const text = await response.text()
        let data: any = null
        if (text) {
            try {
                data = JSON.parse(text)
            } catch {
                data = null
            }
        }
        return { status: response.status, data, text }
    } catch (error) {
        if (!isCertificateError(error)) {
            throw error
        }
        if (!CODEX_INSECURE_TLS) {
            throw new Error(CODEX_TLS_HINT)
        }
        consola.warn("Codex OAuth TLS error detected, retrying with insecure agent")
        return fetchInsecureJson(url, options)
    }
}

async function fetchInsecureJson(
    url: string,
    options: { method?: string; headers?: Record<string, string>; body?: string }
): Promise<JsonResponse> {
    if (!CODEX_INSECURE_TLS) {
        throw new Error(CODEX_TLS_HINT)
    }
    const bunFetch = (globalThis as { Bun?: { fetch?: typeof fetch } }).Bun?.fetch
    if (bunFetch) {
        const response = await bunFetch(url, {
            method: options.method,
            headers: options.headers,
            body: options.body,
            tls: { rejectUnauthorized: false },
        })
        const text = await response.text()
        let data: any = null
        if (text) {
            try {
                data = JSON.parse(text)
            } catch {
                data = null
            }
        }
        return { status: response.status, data, text }
    }

    const target = new URL(url)
    const method = options.method || "GET"
    const headers = {
        "User-Agent": "anti-api",
        ...(options.headers || {}),
    }
    const insecureAgent = new https.Agent({ rejectUnauthorized: false })

    return new Promise((resolve, reject) => {
        const req = https.request(
            {
                protocol: target.protocol,
                hostname: target.hostname,
                port: target.port || 443,
                path: `${target.pathname}${target.search}`,
                method,
                headers,
                agent: insecureAgent,
                rejectUnauthorized: false,
                timeout: 10000,
            },
            (res) => {
                let body = ""
                res.on("data", (chunk) => {
                    body += chunk
                })
                res.on("end", () => {
                    let data: any = null
                    if (body) {
                        try {
                            data = JSON.parse(body)
                        } catch {
                            data = null
                        }
                    }
                    resolve({
                        status: res.statusCode || 0,
                        data,
                        text: body,
                    })
                })
            }
        )

        req.on("error", reject)
        req.on("timeout", () => {
            req.destroy(new Error("Request timed out"))
        })

        if (options.body) {
            req.write(options.body)
        }
        req.end()
    })
}

function formatOAuthError(data: any, fallback: string, status?: number): string {
    let message = fallback
    if (typeof data === "string") {
        message = data
    } else if (data && typeof data === "object") {
        if (typeof data.error_description === "string") {
            message = data.error_description
        } else if (typeof data.error === "string") {
            message = data.error
        } else if (data.error && typeof data.error.message === "string") {
            message = data.error.message
        } else if (typeof data.message === "string") {
            message = data.message
        } else {
            message = fallback
        }
    }

    if (status) {
        return redactSensitiveText(`${message} (status ${status})`)
    }
    return redactSensitiveText(message)
}

function parseExpiresAt(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value < 1_000_000_000_000 ? value * 1000 : value
    }
    if (typeof value === "string" && value.trim()) {
        const asNumber = Number(value)
        if (Number.isFinite(asNumber)) {
            return asNumber < 1_000_000_000_000 ? asNumber * 1000 : asNumber
        }
        const parsed = Date.parse(value)
        if (!Number.isNaN(parsed)) {
            return parsed
        }
    }
    return undefined
}

function getJwtExpiresAt(token: string): number | undefined {
    const claims = decodeJwt(token)
    if (!claims || typeof claims.exp !== "number") {
        return undefined
    }
    return claims.exp * 1000
}

function extractCodexTokenFields(raw: any): {
    accessToken?: string
    refreshToken?: string
    idToken?: string
    accountId?: string
    email?: string
    expiresAt?: number
    authSource?: AuthSource
} {
    const source = raw?.tokens ?? raw ?? {}
    const accessToken = source.access_token || source.accessToken || source.OPENAI_API_KEY || source.api_key
    const refreshToken = source.refresh_token || source.refreshToken
    const idToken = source.id_token || source.idToken
    const accountId = source.account_id || source.accountId
    const email = source.email || raw?.email
    const expiresAt = parseExpiresAt(source.expires_at || source.expiresAt || source.expired || source.expiry)
    const rawSource = source.auth_source || raw?.auth_source
    const authSource = rawSource === "cli-proxy" || rawSource === "codex-cli" ? rawSource : undefined

    return { accessToken, refreshToken, idToken, accountId, email, expiresAt, authSource }
}

function deriveAccountIdFromFilename(filename: string): string {
    const base = filename.replace(/^codex-/, "").replace(/\.json$/i, "")
    return base || `codex-${Date.now()}`
}

function isJwtExpired(token: string): boolean {
    const expMs = getJwtExpiresAt(token)
    if (!expMs) {
        return false
    }
    return expMs <= Date.now() + 60_000
}

function sanitizeFileKey(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, "_")
}

function buildExpiredIso(expiresAt?: number): string | undefined {
    if (!expiresAt) return undefined
    try {
        return new Date(expiresAt).toISOString()
    } catch {
        return undefined
    }
}

function saveCodexProxyAuthFile(account: ProviderAccount, idToken?: string): void {
    const dir = expandHomePath(CODEX_PROXY_AUTH_DIR)
    ensurePrivateDir(dir)

    const key = sanitizeFileKey(account.email || account.id)
    const filePath = join(dir, `codex-${key}.json`)
    const payload = {
        access_token: account.accessToken,
        refresh_token: account.refreshToken,
        id_token: idToken,
        account_id: account.id,
        email: account.email,
        expired: buildExpiredIso(account.expiresAt),
        type: "codex",
        auth_source: account.authSource,
    }
    writePrivateFile(filePath, JSON.stringify(payload, null, 2))
}

function matchesIdentifier(value: string | undefined, identifiers: string[]): boolean {
    if (!value) return false
    const normalized = value.trim().toLowerCase()
    return identifiers.some(id => id && normalized === id.trim().toLowerCase())
}

export function removeCodexAuthArtifacts(identifiers: string[]): { removed: string[] } {
    const removed: string[] = []
    const normalizedIds = identifiers.filter(Boolean)
    if (normalizedIds.length === 0) return { removed }

    const authPath = expandHomePath(CODEX_AUTH_FILE)
    try {
        if (existsSync(authPath)) {
            const raw = JSON.parse(readFileSync(authPath, "utf-8"))
            const fields = extractCodexTokenFields(raw)
            if (matchesIdentifier(fields.accountId, normalizedIds) || matchesIdentifier(fields.email, normalizedIds)) {
                try {
                    Bun.file(authPath).delete()
                } catch {
                    // fallback for non-bun fs
                    try { require("fs").unlinkSync(authPath) } catch { }
                }
                removed.push(authPath)
            }
        }
    } catch {
        // ignore parse errors
    }

    const proxyDir = expandHomePath(CODEX_PROXY_AUTH_DIR)
    try {
        if (existsSync(proxyDir)) {
            const files = readdirSync(proxyDir).filter(file => file.startsWith("codex-") && file.endsWith(".json"))
            for (const file of files) {
                const filePath = join(proxyDir, file)
                try {
                    const raw = JSON.parse(readFileSync(filePath, "utf-8"))
                    const fields = extractCodexTokenFields(raw)
                    const filenameId = deriveAccountIdFromFilename(file)
                    if (
                        matchesIdentifier(fields.accountId, normalizedIds) ||
                        matchesIdentifier(fields.email, normalizedIds) ||
                        matchesIdentifier(filenameId, normalizedIds)
                    ) {
                        try {
                            Bun.file(filePath).delete()
                        } catch {
                            try { require("fs").unlinkSync(filePath) } catch { }
                        }
                        removed.push(filePath)
                    }
                } catch {
                    // ignore parse errors
                }
            }
        }
    } catch {
        // ignore fs errors
    }

    return { removed }
}

function lastNonEmptyLine(value: string): string | undefined {
    const lines = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    if (lines.length === 0) return undefined
    return lines[lines.length - 1]
}

function stripAnsi(input: string): string {
    return input.replace(/\x1B\[[0-9;]*[A-Za-z]/g, "")
}

function isLikelyDeviceCode(value: string): boolean {
    const cleaned = value.trim().replace(/[^A-Za-z0-9-]/g, "")
    if (cleaned.length < 6) return false
    const lower = cleaned.toLowerCase()
    if (["authorization", "authorize", "authorisation", "browser", "device", "token"].includes(lower)) {
        return false
    }
    if (!/[0-9]/.test(cleaned) && !/-/.test(cleaned)) {
        return false
    }
    return true
}

function extractCodexCliLoginHints(output: string): { verificationUri?: string; userCode?: string } {
    let verificationUri: string | undefined
    let userCode: string | undefined
    const sanitized = stripAnsi(output)

    const urlMatch = sanitized.match(/https?:\/\/[^\s)]+/i)
    if (urlMatch) {
        verificationUri = urlMatch[0]
    } else {
        const openaiMatch = sanitized.match(/\b(?:www\.)?openai\.com\/[^\s)]+/i)
        if (openaiMatch) {
            verificationUri = `https://${openaiMatch[0].replace(/^www\./i, "www.")}`
        }
    }

    const codeLineMatch = sanitized.match(/user\s*code[:\s]+([A-Z0-9-]{4,})/i)
    if (codeLineMatch && isLikelyDeviceCode(codeLineMatch[1])) {
        userCode = codeLineMatch[1]
    } else {
        const codeMatch = sanitized.match(/code[:\s]+([A-Z0-9-]{4,})/i)
        if (codeMatch && isLikelyDeviceCode(codeMatch[1])) {
            userCode = codeMatch[1]
        } else {
            const fallback = sanitized.match(/\b[A-Z0-9]{4,}-[A-Z0-9]{4,}\b/)
            if (fallback && isLikelyDeviceCode(fallback[0])) {
                userCode = fallback[0]
            }
        }
    }

    if (!userCode && verificationUri) {
        try {
            const parsedUrl = new URL(verificationUri)
            const queryCode =
                parsedUrl.searchParams.get("user_code") ||
                parsedUrl.searchParams.get("code") ||
                parsedUrl.searchParams.get("device_code")
            if (queryCode && isLikelyDeviceCode(queryCode)) {
                userCode = queryCode
            }
        } catch {
            // ignore URL parse errors
        }
    }

    return { verificationUri, userCode }
}

async function readProcessStream(
    stream: ReadableStream<Uint8Array> | null,
    onChunk: (text: string) => void
): Promise<void> {
    if (!stream) return
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (value) {
            onChunk(decoder.decode(value))
        }
    }
}

function updateCliSessionOutput(session: CodexCliLoginSession, chunk: string): void {
    session.output = (session.output + chunk).slice(-8000)
    const hints = extractCodexCliLoginHints(session.output)
    if (!session.verificationUri && hints.verificationUri) {
        session.verificationUri = hints.verificationUri
    }
    if (!session.userCode && hints.userCode) {
        session.userCode = hints.userCode
    }
}

export async function startCodexCliLogin(): Promise<{
    sessionId: string
    status: "pending" | "success" | "error"
    message?: string
    verificationUri?: string
    userCode?: string
}> {
    try {
        const binary = Bun.which("codex")
        if (!binary) {
            return {
                sessionId: crypto.randomUUID(),
                status: "error",
                message: "Codex CLI not found. Install codex and retry.",
            }
        }
        const scriptPath = Bun.which("script")

        for (const session of codexCliSessions.values()) {
            if (session.status === "pending") {
                try {
                    session.process.kill()
                } catch {
                    // ignore
                }
                session.status = "error"
                session.message = "Superseded by a new Codex login"
            }
        }

        const sessionId = crypto.randomUUID()
        const baseArgs = [binary, "login", "--device-auth"]
        const args = scriptPath
            ? (process.platform === "darwin"
                ? [scriptPath, "-q", "/dev/null", ...baseArgs]
                : [scriptPath, "-q", "/dev/null", "-c", baseArgs.join(" ")])
            : baseArgs
        const proc = Bun.spawn(args, {
            stdout: "pipe",
            stderr: "pipe",
            env: {
                ...process.env,
                TERM: process.env.TERM || "xterm-256color",
            },
        })

        const session: CodexCliLoginSession = {
            id: sessionId,
            status: "pending",
            output: "",
            createdAt: Date.now(),
            process: proc,
        }

        codexCliSessions.set(sessionId, session)

        void readProcessStream(proc.stdout, (chunk) => updateCliSessionOutput(session, chunk))
        void readProcessStream(proc.stderr, (chunk) => updateCliSessionOutput(session, chunk))

        void proc.exited.then((code) => {
            session.exitCode = code
            if (code === 0) {
                session.status = "success"
            } else {
                session.status = "error"
                const lastLine = lastNonEmptyLine(stripAnsi(session.output || ""))
                session.message = lastLine || `Codex CLI login exited with code ${code}`
            }
        })

        setTimeout(() => {
            if (session.status === "pending") {
                try {
                    session.process.kill()
                } catch {
                    // ignore
                }
                session.status = "error"
                session.message = "Codex CLI login timed out"
            }
        }, CODEX_CLI_LOGIN_TIMEOUT_MS)

        return {
            sessionId,
            status: session.status as "pending" | "success" | "error",
            message: session.message,
            verificationUri: session.verificationUri,
            userCode: session.userCode,
        }
    } catch (error) {
        return {
            sessionId: crypto.randomUUID(),
            status: "error",
            message: (error as Error).message,
        }
    }
}

export async function getCodexCliLoginStatus(sessionId: string): Promise<{
    status: "pending" | "success" | "error"
    message?: string
    verificationUri?: string
    userCode?: string
    accounts?: ProviderAccount[]
}> {
    const session = codexCliSessions.get(sessionId)
    if (!session) {
        return { status: "error", message: "Codex CLI session not found" }
    }

    if (session.status === "success" && !session.imported) {
        const result = await importCodexAuthSources()
        if (result.accounts.length === 0) {
            if (Date.now() - session.createdAt < 15_000) {
                return {
                    status: "pending",
                    message: "Waiting for Codex auth files...",
                    verificationUri: session.verificationUri,
                    userCode: session.userCode,
                }
            }
        }
        session.imported = true
        return {
            status: "success",
            message: result.accounts.length > 0 ? "Codex CLI login completed" : "Codex CLI login finished, no accounts found",
            verificationUri: session.verificationUri,
            userCode: session.userCode,
            accounts: result.accounts,
        }
    }

    return {
        status: session.status,
        message: session.message,
        verificationUri: session.verificationUri,
        userCode: session.userCode,
    }
}

function buildCodexAuthorizeUrl(port: number): {
    state: string
    authUrl: string
    fallbackUrl?: string
    redirectUri: string
    codeVerifier?: string
} {
    const state = crypto.randomUUID()
    const redirectUri = getCodexOAuthRedirectUri(port)
    const params = new URLSearchParams({
        client_id: CODEX_OAUTH_CONFIG.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: CODEX_OAUTH_CONFIG.scopes.join(" "),
        state,
        prompt: "login",
        id_token_add_organizations: "true",
        codex_cli_simplified_flow: "true",
    })

    const codeVerifier = CODEX_OAUTH_CONFIG.clientSecret ? undefined : generateCodeVerifier()
    if (codeVerifier) {
        params.set("code_challenge", generateCodeChallenge(codeVerifier))
        params.set("code_challenge_method", "S256")
    }

    const authUrl = `${CODEX_OAUTH_CONFIG.authorizeUrl}?${params.toString()}`
    const fallbackRedirectUri = `http://127.0.0.1:${port}${CODEX_OAUTH_CONFIG.callbackPath}`
    params.set("redirect_uri", fallbackRedirectUri)
    const fallbackUrl = `${CODEX_OAUTH_CONFIG.authorizeUrl}?${params.toString()}`

    return { state, authUrl, fallbackUrl, redirectUri, codeVerifier }
}

export async function importCodexAuthFile(): Promise<ProviderAccount | null> {
    const expandedPath = expandHomePath(CODEX_AUTH_FILE)
    try {
        const raw = JSON.parse(await Bun.file(expandedPath).text()) as any
        const fields = extractCodexTokenFields(raw)
        let accessToken = fields.accessToken
        let refreshToken = fields.refreshToken
        let expiresAt = fields.expiresAt
        if (!accessToken && !refreshToken) {
            return null
        }

        const idToken = fields.idToken
        const claims = idToken ? decodeJwt(idToken) : null
        const authSource = fields.authSource ?? "codex-cli"
        let email = fields.email || claims?.email
        let accountId = fields.accountId || claims?.sub
        const now = Date.now()
        if (!accessToken && refreshToken) {
            try {
                const refreshed = await refreshCodexAccessToken(refreshToken, "codex-cli")
                accessToken = refreshed.accessToken
                if (refreshed.refreshToken) {
                    refreshToken = refreshed.refreshToken
                }
                if (refreshed.expiresIn) {
                    expiresAt = now + refreshed.expiresIn * 1000
                }
            } catch (error) {
                consola.warn("Codex refresh failed during import:", safeErrorMessage(error))
                return null
            }
        }
        if (accessToken && isJwtExpired(accessToken) && refreshToken) {
            try {
                const refreshed = await refreshCodexAccessToken(refreshToken, "codex-cli")
                accessToken = refreshed.accessToken
                if (refreshed.refreshToken) {
                    refreshToken = refreshed.refreshToken
                }
                if (refreshed.expiresIn) {
                    expiresAt = now + refreshed.expiresIn * 1000
                }
            } catch (error) {
                consola.warn("Codex refresh failed during import:", safeErrorMessage(error))
                return null
            }
        }
        if (!accessToken) {
            return null
        }
        if (!expiresAt) {
            expiresAt = getJwtExpiresAt(accessToken)
        }
        if (!accountId) {
            accountId = email || `codex-${Date.now()}`
        }

        const account: ProviderAccount = {
            id: accountId,
            provider: "codex",
            email,
            accessToken,
            refreshToken,
            expiresAt,
            label: email || "Codex Account",
            authSource,
        }

        authStore.saveAccount(account)
        try {
            saveCodexProxyAuthFile(account, idToken)
        } catch (error) {
            consola.warn("Codex proxy auth save failed:", safeErrorMessage(error))
        }
        return account
    } catch (error) {
        consola.warn("Codex auth file import failed:", safeErrorMessage(error))
        return null
    }
}

export async function importCodexProxyAuthFiles(): Promise<ProviderAccount[]> {
    const expandedDir = expandHomePath(CODEX_PROXY_AUTH_DIR)
    if (!existsSync(expandedDir)) {
        return []
    }

    const files = readdirSync(expandedDir).filter(file => file.startsWith("codex-") && file.endsWith(".json"))
    const accounts = new Map<string, ProviderAccount>()

    for (const file of files) {
        try {
            const raw = JSON.parse(readFileSync(join(expandedDir, file), "utf-8")) as any
            const fields = extractCodexTokenFields(raw)
            let accessToken = fields.accessToken
            let refreshToken = fields.refreshToken
            let expiresAt = fields.expiresAt

            if (!accessToken && refreshToken) {
                try {
                    const refreshed = await refreshCodexAccessToken(refreshToken, "cli-proxy")
                    accessToken = refreshed.accessToken
                    if (refreshed.refreshToken) {
                        refreshToken = refreshed.refreshToken
                    }
                    if (refreshed.expiresIn) {
                        expiresAt = Date.now() + refreshed.expiresIn * 1000
                    }
                } catch (error) {
                    consola.warn(`Codex proxy refresh failed for ${file}:`, safeErrorMessage(error))
                    continue
                }
            }

            if (!accessToken) {
                continue
            }

            if (!expiresAt) {
                expiresAt = getJwtExpiresAt(accessToken)
            }

            const claims = fields.idToken ? decodeJwt(fields.idToken) : null
            const email = fields.email || claims?.email
            const accountId =
                fields.accountId ||
                claims?.sub ||
                email ||
                deriveAccountIdFromFilename(file)

            const account: ProviderAccount = {
                id: accountId,
                provider: "codex",
                email,
                accessToken,
                refreshToken,
                expiresAt,
                label: email || accountId,
                authSource: fields.authSource ?? "cli-proxy",
            }

            authStore.saveAccount(account)
            accounts.set(account.id, account)
        } catch (error) {
            consola.warn(`Codex proxy auth import failed for ${file}:`, safeErrorMessage(error))
        }
    }

    return Array.from(accounts.values())
}

export async function importCodexAuthSources(): Promise<{ accounts: ProviderAccount[]; sources: string[] }> {
    const sources: string[] = []
    const accounts = new Map<string, ProviderAccount>()

    const cliAccount = await importCodexAuthFile()
    if (cliAccount) {
        sources.push("codex-cli")
        accounts.set(cliAccount.id, cliAccount)
    }

    const proxyAccounts = await importCodexProxyAuthFiles()
    if (proxyAccounts.length > 0) {
        sources.push("cli-proxy")
        for (const account of proxyAccounts) {
            accounts.set(account.id, account)
        }
    }

    return { accounts: Array.from(accounts.values()), sources }
}

export function startCodexOAuthSession(): { state: string; authUrl: string; fallbackUrl?: string; expiresAt: number } {
    if (activeSession && Date.now() < activeSession.expiresAt) {
        return {
            state: activeSession.state,
            authUrl: activeSession.authUrl,
            fallbackUrl: activeSession.fallbackUrl,
            expiresAt: activeSession.expiresAt,
        }
    }

    callbackServer = ensureCodexCallbackServer()
    const port = callbackServerPort ?? CODEX_OAUTH_CONFIG.callbackPort

    const { state, authUrl, fallbackUrl, redirectUri, codeVerifier } = buildCodexAuthorizeUrl(port)
    activeSession = {
        state,
        authUrl,
        redirectUri,
        expiresAt: Date.now() + 5 * 60 * 1000,
        server: callbackServer,
        codeVerifier,
        fallbackUrl,
    }

    return { state, authUrl, fallbackUrl, expiresAt: activeSession.expiresAt }
}

export async function pollCodexOAuthSession(state: string): Promise<{
    status: "pending" | "success" | "error"
    message?: string
    account?: ProviderAccount
}> {
    if (!activeSession || activeSession.state !== state) {
        return { status: "error", message: "No active Codex session" }
    }

    if (Date.now() > activeSession.expiresAt) {
        activeSession = null
        return { status: "error", message: "Codex OAuth session expired" }
    }

    if (!activeSession.callback) {
        return { status: "pending" }
    }

    // Consume the callback before doing network or storage work.  This makes
    // polling one-shot and prevents a code from being replayed after a failed
    // exchange or a concurrent poll request.
    const session = activeSession
    const callback = session.callback!
    activeSession = null

    if (callback.error) {
        return { status: "error", message: sanitizeCodexOAuthError(callback.error) }
    }

    if (!callback.code || !isCodexOAuthStateValid(session.state, callback.state)) {
        return { status: "error", message: "Invalid OAuth callback" }
    }

    // Always use the redirect URI captured when the authorization URL was
    // generated.  `callback.redirectUri` is derived from an HTTP request and
    // is therefore untrusted, even when it points at loopback.
    const tokenResponse = await exchangeCodexCode(callback.code, session.redirectUri, session.codeVerifier)
    const claims = tokenResponse.idToken ? decodeJwt(tokenResponse.idToken) : null
    const email = claims?.email
    const accountId = claims?.sub || email || `codex-${Date.now()}`

    const account: ProviderAccount = {
        id: accountId,
        provider: "codex",
        email,
        accessToken: tokenResponse.accessToken,
        refreshToken: tokenResponse.refreshToken,
        expiresAt: tokenResponse.expiresIn ? Date.now() + tokenResponse.expiresIn * 1000 : undefined,
        label: email || "Codex Account",
        authSource: "codex-cli",
    }

    authStore.saveAccount(account)
    try {
        saveCodexProxyAuthFile(account, tokenResponse.idToken)
    } catch (error) {
        consola.warn("Codex proxy auth save failed:", safeErrorMessage(error))
    }
    activeSession = null

    return { status: "success", account }
}

export async function startCodexOAuthLogin(): Promise<ProviderAccount> {
    const state = crypto.randomUUID()
    const { server, port, waitForCallback } = await startOAuthCallbackServer(CODEX_OAUTH_CONFIG.callbackPort, state)
    const redirectUri = getCodexOAuthRedirectUri(port)

    const params = new URLSearchParams({
        client_id: CODEX_OAUTH_CONFIG.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: CODEX_OAUTH_CONFIG.scopes.join(" "),
        state,
        prompt: "login",
        id_token_add_organizations: "true",
        codex_cli_simplified_flow: "true",
    })

    const codeVerifier = CODEX_OAUTH_CONFIG.clientSecret ? undefined : generateCodeVerifier()
    if (codeVerifier) {
        params.set("code_challenge", generateCodeChallenge(codeVerifier))
        params.set("code_challenge_method", "S256")
    }

    const authUrl = `${CODEX_OAUTH_CONFIG.authorizeUrl}?${params.toString()}`
    consola.info("Codex OAuth callback server started")

    openBrowser(authUrl, { disabledEnv: "ANTI_API_OAUTH_NO_OPEN" })

    const result = await waitForCallback()
    server.stop()

    if (result.error) {
        throw new Error(sanitizeCodexOAuthError(result.error))
    }
    if (!result.code || !isCodexOAuthStateValid(state, result.state)) {
        throw new Error("Invalid OAuth callback state")
    }

    const tokenResponse = await exchangeCodexCode(result.code, redirectUri, codeVerifier)
    const claims = tokenResponse.idToken ? decodeJwt(tokenResponse.idToken) : null
    const email = claims?.email
    const accountId = claims?.sub || email || `codex-${Date.now()}`

    const account: ProviderAccount = {
        id: accountId,
        provider: "codex",
        email,
        accessToken: tokenResponse.accessToken,
        refreshToken: tokenResponse.refreshToken,
        expiresAt: tokenResponse.expiresIn ? Date.now() + tokenResponse.expiresIn * 1000 : undefined,
        label: email || "Codex Account",
        authSource: "codex-cli",
    }

    authStore.saveAccount(account)
    try {
        saveCodexProxyAuthFile(account, tokenResponse.idToken)
    } catch (error) {
        consola.warn("Codex proxy auth save failed:", safeErrorMessage(error))
    }
    return account
}

async function exchangeCodexCode(code: string, redirectUri: string, codeVerifier?: string): Promise<CodexTokens> {
    const params = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CODEX_OAUTH_CONFIG.clientId,
        code,
        redirect_uri: redirectUri,
    })
    if (CODEX_OAUTH_CONFIG.clientSecret) {
        params.set("client_secret", CODEX_OAUTH_CONFIG.clientSecret)
    }
    if (codeVerifier) {
        params.set("code_verifier", codeVerifier)
    }

    const response = await fetchJsonWithFallback(CODEX_OAUTH_CONFIG.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
    })

    if (response.status < 200 || response.status >= 300) {
        throw new Error(formatOAuthError(response.data, "Codex token exchange failed", response.status))
    }

    const data = (response.data || {}) as any
    const accessToken = data.access_token || data.accessToken
    if (!accessToken) {
        throw new Error("Codex token exchange failed: missing access token")
    }

    return {
        accessToken,
        refreshToken: data.refresh_token || data.refreshToken,
        expiresIn: data.expires_in,
        idToken: data.id_token || data.idToken,
    }
}

function generateCodeVerifier(): string {
    return base64Url(randomBytes(32))
}

function generateCodeChallenge(verifier: string): string {
    return base64Url(createHash("sha256").update(verifier).digest())
}

function base64Url(buffer: Buffer): string {
    return buffer
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "")
}

export async function refreshCodexAccessToken(
    refreshToken: string,
    authSource?: AuthSource
): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }> {
    const key = `${authSource || "codex"}:${refreshToken}`
    const existing = refreshLocks.get(key)
    if (existing) {
        return existing
    }

    const task = (async () => {
        try {
            if (authSource === "cli-proxy") {
                return await refreshCodexProxyAccessToken(refreshToken)
            }

            const params = new URLSearchParams({
                grant_type: "refresh_token",
                client_id: CODEX_OAUTH_CONFIG.clientId,
                refresh_token: refreshToken,
            })

            const response = await fetchJsonWithFallback(CODEX_OAUTH_CONFIG.tokenUrl, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: params.toString(),
            })

            if (response.status < 200 || response.status >= 300) {
                throw new Error(formatOAuthError(response.data, "Codex token refresh failed", response.status))
            }

            const data = (response.data || {}) as any
            const accessToken = data.access_token || data.accessToken
            if (!accessToken) {
                throw new Error("Codex token refresh failed: missing access token")
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

async function refreshCodexProxyAccessToken(
    refreshToken: string
): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }> {
    if (!ALLOW_THIRD_PARTY_CODEX_REFRESH || !CODEX_PROXY_REFRESH_URL) {
        throw new Error("Imported CLIProxy Codex credentials cannot be refreshed by default. Re-import a current token or use the normal Codex login flow.")
    }
    const target = new URL(CODEX_PROXY_REFRESH_URL)
    if (target.protocol !== "https:") {
        throw new Error("ANTI_API_CODEX_PROXY_REFRESH_URL must use HTTPS.")
    }
    consola.warn("Sending a Codex refresh token to an explicitly configured third-party host")

    const params = new URLSearchParams()
    params.set("refresh_token", refreshToken)
    const response = await fetchJsonWithFallback(target.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
    })

    if (response.status < 200 || response.status >= 300) {
        throw new Error(formatOAuthError(response.data, "Codex proxy token refresh failed", response.status))
    }
    const data = (response.data || {}) as Record<string, unknown>
    const accessToken = String(data.access_token || data.accessToken || "")
    if (!accessToken) throw new Error("Codex proxy token refresh failed: missing access token")
    const nextRefreshToken = data.refresh_token || data.refreshToken
    return {
        accessToken,
        refreshToken: nextRefreshToken ? String(nextRefreshToken) : undefined,
        expiresIn: typeof data.expires_in === "number" ? data.expires_in : undefined,
    }
}

export async function refreshCodexAccountIfNeeded(account: ProviderAccount): Promise<ProviderAccount> {
    const now = Date.now()
    if (!account.refreshToken) {
        return account
    }

    const hasAccessToken = !!account.accessToken
    const hasExpiry = typeof account.expiresAt === "number" && Number.isFinite(account.expiresAt)

    if (hasAccessToken && hasExpiry && account.expiresAt! > now + 60_000) {
        return account
    }

    if (hasAccessToken && !hasExpiry && !isJwtExpired(account.accessToken)) {
        return account
    }

    const refreshed = await refreshCodexAccessToken(account.refreshToken, account.authSource)
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
        if (jwtExpiry) {
            updated.expiresAt = jwtExpiry
        }
    }

    authStore.saveAccount(updated)
    return updated
}

type CodexOAuthProbe = {
    url: string
    ok?: boolean
    status?: number
    statusText?: string
    headers?: Record<string, string>
    bodyPreview?: string
    error?: string
    durationMs: number
}

function pickHeaders(headers: Headers, keys: string[]): Record<string, string> {
    const picked: Record<string, string> = {}
    for (const key of keys) {
        const value = headers.get(key)
        if (value) picked[key] = value
    }
    return picked
}

async function probeUrl(url: string): Promise<CodexOAuthProbe> {
    const start = Date.now()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)
    try {
        const response = await fetch(url, {
            redirect: "manual",
            signal: controller.signal,
            headers: {
                "User-Agent": "anti-api/1.0",
            },
        })
        clearTimeout(timeout)

        const headers = pickHeaders(response.headers, [
            "content-type",
            "content-length",
            "location",
            "server",
            "cf-ray",
            "cf-cache-status",
            "x-request-id",
            "date",
        ])

        let bodyPreview: string | undefined
        const contentType = response.headers.get("content-type") || ""
        if (contentType.includes("text/html") || contentType.includes("text/plain")) {
            const text = await response.text()
            bodyPreview = text.slice(0, 500)
        }

        return {
            url,
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            headers,
            bodyPreview,
            durationMs: Date.now() - start,
        }
    } catch (error) {
        clearTimeout(timeout)
        const err = error as { message?: string; code?: string; cause?: { code?: string; message?: string } }
        const code = err?.code || err?.cause?.code
        const message = err?.message || err?.cause?.message || String(error)
        return {
            url,
            error: code ? `${code}: ${message}` : message,
            durationMs: Date.now() - start,
        }
    }
}

export async function debugCodexOAuth(): Promise<{
    authUrl: string
    fallbackUrl?: string
    state: string
    redirectUri: string
    probes: { authorize: CodexOAuthProbe; openid: CodexOAuthProbe }
    timestamp: string
}> {
    const { authUrl, fallbackUrl, state, redirectUri } = buildCodexAuthorizeUrl(CODEX_OAUTH_CONFIG.callbackPort)
    const authorize = await probeUrl(authUrl)
    const openid = await probeUrl("https://auth.openai.com/.well-known/openid-configuration")
    return {
        authUrl,
        fallbackUrl,
        state,
        redirectUri,
        probes: { authorize, openid },
        timestamp: new Date().toISOString(),
    }
}

function startCodexCallbackServer(
    port: number,
    onResult: (result: CodexCallbackResult) => void,
    expectedState?: () => string | undefined
): any {
    let acceptedState: string | undefined
    return Bun.serve({
        // OAuth authorization codes must only be delivered to this local
        // process. Do not let Bun's default wildcard bind expose the callback
        // listener to the LAN or public interfaces.
        hostname: getCodexCallbackHostname(),
        port,
        fetch(req) {
            if (req.method !== "GET") {
                return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET" } })
            }

            let url: URL
            try {
                url = new URL(req.url)
            } catch {
                return new Response("Invalid callback URL", { status: 400 })
            }
            if (url.pathname !== CODEX_OAUTH_CONFIG.callbackPath) {
                return new Response("Not Found", { status: 404 })
            }

            const redirectUri = getSafeCodexRedirectUri(url, port)
            if (!redirectUri) {
                return new Response("Invalid callback host", { status: 400 })
            }

            const code = url.searchParams.get("code")
            const state = url.searchParams.get("state")
            const error = url.searchParams.get("error")

            // Bind the callback to the state that created this listener. A
            // callback with another state must not wake the waiting login or
            // overwrite a pending session.
            const expected = expectedState?.()
            if (!isCodexOAuthStateValid(expected, state || undefined)) {
                return new Response("Invalid OAuth callback state", {
                    status: 400,
                    headers: { "Cache-Control": "no-store" },
                })
            }
            if (acceptedState && isCodexOAuthStateValid(acceptedState, state || undefined)) {
                return new Response("OAuth callback already received", {
                    status: 409,
                    headers: { "Cache-Control": "no-store" },
                })
            }
            if (!code && !error) {
                return new Response("Missing OAuth callback result", {
                    status: 400,
                    headers: { "Cache-Control": "no-store" },
                })
            }

            acceptedState = state || undefined
            onResult({
                code: code || undefined,
                state: state || undefined,
                error: error || undefined,
                // Keep this field for callers that inspect the callback, but
                // it is never used for token exchange (see poll/login above).
                redirectUri: getCodexOAuthRedirectUri(port),
            })
            return new Response(`
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <title>Codex OAuth</title>
                        <style>
                            body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #000; color: #fff; }
                            h1 { font-size: 42px; }
                        </style>
                    </head>
                    <body>
                        <h1>Codex Connected</h1>
                        <p>You can close this window.</p>
                    </body>
                    </html>
                `, {
                headers: {
                    "Content-Type": "text/html; charset=utf-8",
                    "Cache-Control": "no-store",
                },
            })
        },
    })
}

export function getSafeCodexRedirectUri(url: URL, port: number): string | null {
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "")
    const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
    if (
        url.protocol !== "http:" ||
        !isLoopback ||
        url.port !== String(port) ||
        url.pathname !== CODEX_OAUTH_CONFIG.callbackPath ||
        url.username ||
        url.password
    ) {
        return null
    }
    // Canonicalize every accepted loopback spelling to the URI registered in
    // the OAuth client. This keeps callback request metadata out of token
    // exchange and avoids localhost/127.0.0.1 redirect mismatches.
    return getCodexOAuthRedirectUri(port)
}

function ensureCodexCallbackServer(): any {
    if (callbackServer) {
        return callbackServer
    }
    try {
        const startPort = CODEX_OAUTH_CONFIG.callbackPort
        const maxOffset = 10
        for (let offset = 0; offset <= maxOffset; offset++) {
            const port = startPort + offset
            try {
                callbackServer = startCodexCallbackServer(port, (result) => {
                    const session = activeSession
                    if (session && isCodexOAuthStateValid(session.state, result.state)) {
                        session.callback = { ...result, redirectUri: session.redirectUri }
                    }
                }, () => activeSession?.state)
                callbackServerPort = port
                break
            } catch (error) {
                if (offset >= maxOffset) {
                    throw error
                }
            }
        }
        return callbackServer
    } catch (error) {
        throw new Error(`Codex callback port ${CODEX_OAUTH_CONFIG.callbackPort} is in use (range ${CODEX_OAUTH_CONFIG.callbackPort}-${CODEX_OAUTH_CONFIG.callbackPort + 10}).`)
    }
}

async function startOAuthCallbackServer(port: number, expectedState: string): Promise<{
    server: any
    port: number
    waitForCallback: () => Promise<{ code?: string; state?: string; error?: string; redirectUri?: string }>
}> {
    let callbackResolve: ((result: { code?: string; state?: string; error?: string; redirectUri?: string }) => void) | null = null
    const callbackPromise = new Promise<{ code?: string; state?: string; error?: string; redirectUri?: string }>((res) => {
        callbackResolve = res
    })

    const startPort = port
    const maxOffset = 10
    let server: any = null
    let boundPort = startPort
    for (let offset = 0; offset <= maxOffset; offset++) {
        const candidate = startPort + offset
        try {
            server = startCodexCallbackServer(candidate, (result) => {
                if (callbackResolve) {
                    callbackResolve(result)
                }
            }, () => expectedState)
            boundPort = candidate
            break
        } catch (error) {
            if (offset >= maxOffset) {
                throw error
            }
        }
    }

    return {
        server,
        port: boundPort,
        waitForCallback: () => callbackPromise,
    }
}
