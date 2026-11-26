/**
 * Antigravity OAuth 配置和工具函数
 * 基于 CLIProxyAPI 的实现
 */

import { state } from "~/lib/state"
import { getAntigravityUserAgent } from "~/lib/antigravity-client"
import { createHash, randomBytes } from "node:crypto"

// OAuth 配置（来自 CLIProxyAPI）
export const OAUTH_CONFIG = {
    clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
    clientSecret: "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",
    callbackPort: 51121,
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userInfoUrl: "https://www.googleapis.com/oauth2/v1/userinfo?alt=json",
    projectUrl: "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    scopes: [
        "https://www.googleapis.com/auth/cloud-platform",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
        "https://www.googleapis.com/auth/cclog",
        "https://www.googleapis.com/auth/experimentsandconfigs",
    ],
}

export interface OAuthCallbackServerOptions {
    hostname?: string
    port?: number
    fixedPort?: boolean
    expectedState?: string
}

type OAuthPkceSession = {
    codeVerifier: string
    expiresAt: number
}

const OAUTH_PKCE_SESSION_TTL_MS = 5 * 60 * 1000
const oauthPkceSessions = new Map<string, OAuthPkceSession>()

function useDockerCallbackRelay(): boolean {
    return process.env.ANTI_API_DOCKER_OAUTH_CALLBACK === "1"
}

/**
 * A configured loopback redirect must be bound exactly; silently falling back
 * to the next port would produce a redirect URL that can never complete.
 * Public callbacks are intentionally rejected. PKCE binds the authorization
 * code to this process, but it does not make a public clear-text callback safe.
 */
export function resolveOAuthCallbackServerOptions(redirectUrl?: string): OAuthCallbackServerOptions {
    if (!redirectUrl) return { hostname: useDockerCallbackRelay() ? "0.0.0.0" : "127.0.0.1" }

    let redirect: URL
    try {
        redirect = new URL(redirectUrl)
    } catch {
        throw new Error("ANTI_API_OAUTH_REDIRECT_URL must be a valid http:// URL ending in /oauth-callback.")
    }
    if (redirect.protocol !== "http:" || redirect.pathname !== "/oauth-callback" || redirect.username || redirect.password) {
        throw new Error("ANTI_API_OAUTH_REDIRECT_URL must be an http:// URL ending in /oauth-callback without credentials.")
    }

    const port = Number(redirect.port || "80")
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("ANTI_API_OAUTH_REDIRECT_URL must use a valid callback port.")
    }

    const hostname = redirect.hostname.toLowerCase()
    const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1"
    if (!isLoopback) {
        throw new Error("ANTI_API_OAUTH_REDIRECT_URL must use a loopback host. Use SSH port forwarding for a remote server.")
    }
    if (useDockerCallbackRelay() && (hostname === "[::1]" || hostname === "::1")) {
        throw new Error("Docker OAuth callbacks must use http://localhost or http://127.0.0.1.")
    }
    const loopbackHostname = useDockerCallbackRelay()
        ? "0.0.0.0"
        : (hostname === "[::1]" || hostname === "::1" ? "::1" : "127.0.0.1")
    return {
        hostname: loopbackHostname,
        port,
        fixedPort: true,
    }
}

/** Return the exact loopback redirect URI served by the default callback listener. */
export function getAntigravityOAuthRedirectUri(port: number, configuredRedirect?: string): string {
    return configuredRedirect || `http://127.0.0.1:${port}/oauth-callback`
}

/**
 * 生成随机 state 用于 CSRF 保护
 */
export function generateState(): string {
    return crypto.randomUUID()
}

function base64Url(value: Buffer): string {
    return value.toString("base64url")
}

/** Generate an in-memory PKCE verifier for one OAuth attempt. */
export function generateCodeVerifier(): string {
    return base64Url(randomBytes(32))
}

export function generateCodeChallenge(verifier: string): string {
    return base64Url(createHash("sha256").update(verifier).digest())
}

function pruneExpiredOAuthPkceSessions(now = Date.now()): void {
    for (const [oauthState, session] of oauthPkceSessions) {
        if (session.expiresAt <= now) oauthPkceSessions.delete(oauthState)
    }
}

/**
 * Create the short-lived, process-local state/verifier pair for one login.
 * The verifier is consumed only after that exact state has returned.
 */
export function createOAuthPkceSession(): { state: string; codeVerifier: string } {
    pruneExpiredOAuthPkceSessions()

    let oauthState = generateState()
    while (oauthPkceSessions.has(oauthState)) oauthState = generateState()

    const codeVerifier = generateCodeVerifier()
    oauthPkceSessions.set(oauthState, {
        codeVerifier,
        expiresAt: Date.now() + OAUTH_PKCE_SESSION_TTL_MS,
    })
    return { state: oauthState, codeVerifier }
}

/** Consume an OAuth verifier once so an authorization code cannot be replayed. */
export function consumeOAuthPkceVerifier(oauthState: string): string | null {
    const session = oauthPkceSessions.get(oauthState)
    oauthPkceSessions.delete(oauthState)
    if (!session || session.expiresAt <= Date.now()) return null
    return session.codeVerifier
}

/** Remove an abandoned login session after an error, timeout, or cancellation. */
export function discardOAuthPkceSession(oauthState: string): void {
    oauthPkceSessions.delete(oauthState)
}

/**
 * 生成 OAuth 授权 URL
 */
export function generateAuthURL(redirectUri: string, state: string, codeVerifier: string): string {
    const params = new URLSearchParams({
        client_id: OAUTH_CONFIG.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: OAUTH_CONFIG.scopes.join(" "),
        access_type: "offline",
        prompt: "consent",
        state,
    })
    params.set("code_challenge", generateCodeChallenge(codeVerifier))
    params.set("code_challenge_method", "S256")
    return `${OAUTH_CONFIG.authUrl}?${params.toString()}`
}

/**
 * 交换 authorization code 获取 tokens
 */
export async function exchangeCode(code: string, redirectUri: string, codeVerifier: string): Promise<{
    accessToken: string
    refreshToken: string
    expiresIn: number
}> {
    const params = new URLSearchParams({
        code,
        client_id: OAUTH_CONFIG.clientId,
        client_secret: OAUTH_CONFIG.clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
    })
    params.set("code_verifier", codeVerifier)

    const response = await fetchJson(OAUTH_CONFIG.tokenUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
    })

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`Token exchange failed (${response.status}).`)
    }

    const data = response.data as {
        access_token: string
        refresh_token: string
        expires_in: number
    }

    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresIn: data.expires_in,
    }
}

/**
 * 获取用户信息（从 Google API）
 */
export async function fetchUserInfo(accessToken: string): Promise<{ email: string }> {
    const response = await fetchJson(OAUTH_CONFIG.userInfoUrl, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
    })

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`Failed to get user info: ${response.status}`)
    }

    return response.data as { email: string }
}

/**
 * 获取 Antigravity Project ID
 */
export async function getProjectID(accessToken: string): Promise<string | null> {
    try {
        const response = await fetchJson(OAUTH_CONFIG.projectUrl, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
                "User-Agent": getAntigravityUserAgent(),
            },
            body: JSON.stringify({
                metadata: {
                    ideType: "ANTIGRAVITY",
                },
            }),
        })

        if (response.status < 200 || response.status >= 300) {
            return null
        }

        const data = response.data as { cloudaicompanionProject?: string }
        return data.cloudaicompanionProject || null
    } catch {
        return null
    }
}

/**
 * 刷新 access token
 */
export async function refreshAccessToken(refreshToken: string): Promise<{
    accessToken: string
    expiresIn: number
}> {
    const params = new URLSearchParams({
        client_id: OAUTH_CONFIG.clientId,
        client_secret: OAUTH_CONFIG.clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
    })

    const response = await fetchJson(OAUTH_CONFIG.tokenUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
    })

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`Token refresh failed (${response.status}).`)
    }

    const data = response.data as {
        access_token: string
        expires_in: number
    }

    return {
        accessToken: data.access_token,
        expiresIn: data.expires_in,
    }
}

/**
 * 获取访问令牌（如果过期则自动刷新）
 */
export async function getAccessToken(): Promise<string> {
    if (!state.accessToken) {
        throw new Error("Not authenticated. Please login first.")
    }

    // 检查 token 是否过期（提前 5 分钟刷新）
    const now = Date.now()
    const expiresAt = state.tokenExpiresAt || 0
    const needsRefresh = expiresAt > 0 && (now > expiresAt - 5 * 60 * 1000)

    if (needsRefresh && state.refreshToken) {
        try {
            const tokens = await refreshAccessToken(state.refreshToken)
            state.accessToken = tokens.accessToken
            state.antigravityToken = tokens.accessToken
            state.tokenExpiresAt = now + tokens.expiresIn * 1000

            // 保存刷新后的 token
            const { saveAuth } = await import("./login")
            saveAuth()

        } catch (error) {
            // 刷新失败时抛出错误，让用户重新登录
            throw new Error("Token expired and refresh failed. Please re-login.")
        }
    }

    return state.accessToken
}

type InsecureResponse = {
    status: number
    data: any
    text: string
}

export async function fetchJson(
    url: string,
    options: { method?: string; headers?: Record<string, string>; body?: string }
): Promise<{ status: number; data: any; text: string }> {
    const response = await fetch(url, {
        method: options.method,
        headers: { "User-Agent": "anti-api", ...(options.headers || {}) },
        body: options.body,
        signal: AbortSignal.timeout(10_000),
    })
    const text = await response.text()
    let data: any = null
    if (text) {
        try { data = JSON.parse(text) } catch { }
    }
    return { status: response.status, data, text }
}

/**
 * OAuth 回调服务器
 */
interface OAuthCallbackResult {
    code?: string
    state?: string
    error?: string
}

export function startOAuthCallbackServer(options: OAuthCallbackServerOptions = {}): Promise<{
    server: any
    port: number
    waitForCallback: () => Promise<OAuthCallbackResult>
}> {
    return new Promise((resolve, reject) => {
        let callbackResolve: ((result: OAuthCallbackResult) => void) | null = null
        const callbackPromise = new Promise<OAuthCallbackResult>((res) => {
            callbackResolve = res
        })

        const startPort = options.port || OAUTH_CONFIG.callbackPort
        const maxOffset = options.fixedPort ? 0 : 10
        const hostname = options.hostname || "127.0.0.1"
        let server: any = null
        let boundPort = startPort

        for (let offset = 0; offset <= maxOffset; offset++) {
            const port = startPort + offset
            try {
                server = Bun.serve({
                    hostname,
                    port,
                    fetch(req) {
                        const url = new URL(req.url)

                        if (url.pathname === "/oauth-callback") {
                            const code = url.searchParams.get("code")
                            const state = url.searchParams.get("state")
                            const error = url.searchParams.get("error")

                            if (options.expectedState && state !== options.expectedState) {
                                return new Response("Invalid OAuth callback.", { status: 400 })
                            }

                            if (callbackResolve) {
                                callbackResolve({ code: code || undefined, state: state || undefined, error: error || undefined })
                                callbackResolve = null
                            }

                            // Redirect to official success page
                            return Response.redirect("https://antigravity.google/auth-success", 302)
                        }

                        return new Response("Not Found", { status: 404 })
                    },
                })
                boundPort = port
                break
            } catch (error) {
                if (offset >= maxOffset) {
                    reject(error)
                    return
                }
            }
        }

        resolve({
            server,
            port: boundPort,
            waitForCallback: () => callbackPromise,
        })
    })
}
