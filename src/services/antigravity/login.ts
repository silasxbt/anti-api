/**
 * Antigravity OAuth 登录服务
 * 完整的 OAuth 登录流程实现
 */

import { state } from "~/lib/state"
import { existsSync, readFileSync } from "fs"
import { join } from "path"
import consola from "consola"
import { tightenPrivateFile, writePrivateFile } from "~/lib/private-file"
import {
    startOAuthCallbackServer,
    resolveOAuthCallbackServerOptions,
    getAntigravityOAuthRedirectUri,
    createOAuthPkceSession,
    consumeOAuthPkceVerifier,
    discardOAuthPkceSession,
    generateAuthURL,
    exchangeCode,
    fetchUserInfo,
    getProjectID,
    refreshAccessToken,
    getAntigravityAuthUrl,
    cleanAuthCode,
    extractAuthCodeAndRedirectUri,
    ANTIGRAVITY_OAUTH_REDIRECT_URI,
} from "./oauth"
import { generateMockProjectId } from "./project-id"
import { ensureDataDir, getDataDir, getLegacyProjectDataDir } from "~/lib/data-dir"
import { openBrowser } from "~/lib/open-browser"
import { safeErrorMessage } from "~/lib/redaction"

const AUTH_FILE = join(getDataDir(), "auth.json")
const LEGACY_AUTH_FILE = join(getLegacyProjectDataDir(), "auth.json")

interface AuthData {
    accessToken: string
    refreshToken: string
    userEmail?: string
    userName?: string
    expiresAt?: number
    projectId?: string
}

function publicOAuthError(error: unknown): string {
    const message = error instanceof Error ? error.message : ""
    if (/^(Authentication timeout \(5 minutes\)|Missing code or state in callback|State mismatch - possible CSRF attack|Token exchange failed \(\d{3}\)\.|Failed to get user info: \d+|ANTI_API_OAUTH_REDIRECT_URL|OAuth callback port)/.test(message)) {
        return message
    }
    return "Authentication failed. Check the browser login and callback port, then retry."
}

/**
 * 初始化认证 - 从文件加载已保存的认证
 */
export function initAuth(): void {
    try {
        const source = existsSync(AUTH_FILE) ? AUTH_FILE : (existsSync(LEGACY_AUTH_FILE) ? LEGACY_AUTH_FILE : null)
        if (source) {
            tightenPrivateFile(source)
            const data = JSON.parse(readFileSync(source, "utf-8")) as AuthData
            if (data.accessToken) {
                state.accessToken = data.accessToken
                state.antigravityToken = data.accessToken
                state.refreshToken = data.refreshToken || null
                state.tokenExpiresAt = data.expiresAt || null
                state.userEmail = data.userEmail || null
                state.userName = data.userName || null
                state.cloudaicompanionProject = data.projectId || null
                if (source === LEGACY_AUTH_FILE && !existsSync(AUTH_FILE)) {
                    saveAuth()
                }
                consola.success("Loaded saved authentication")
            }
        }
    } catch (error) {
        consola.warn("Failed to load saved auth:", safeErrorMessage(error))
    }
}

/**
 * 保存认证到文件
 */
export function saveAuth(): void {
    try {
        ensureDataDir()

        const data: AuthData = {
            accessToken: state.accessToken!,
            refreshToken: state.refreshToken || "",
            expiresAt: state.tokenExpiresAt || undefined,
            userEmail: state.userEmail || undefined,
            userName: state.userName || undefined,
            projectId: state.cloudaicompanionProject || undefined,
        }

        writePrivateFile(AUTH_FILE, JSON.stringify(data, null, 2))
        consola.success("Authentication saved")
    } catch (error) {
        consola.error("Failed to save auth:", safeErrorMessage(error))
    }
}

/**
 * 清除认证
 */
export function clearAuth(): void {
    state.accessToken = null
    state.antigravityToken = null
    state.refreshToken = null
    state.userEmail = null
    state.userName = null
    state.cloudaicompanionProject = null

    try {
        if (existsSync(AUTH_FILE)) {
            writePrivateFile(AUTH_FILE, "{}")
        }
        if (existsSync(LEGACY_AUTH_FILE)) {
            writePrivateFile(LEGACY_AUTH_FILE, "{}")
        }
    } catch (error) {
        consola.warn("Failed to clear auth file:", safeErrorMessage(error))
    }
}

/**
 * 检查是否已认证
 */
export function isAuthenticated(): boolean {
    return !!state.accessToken
}

/**
 * 获取用户信息
 */
export function getUserInfo(): { email: string | null; name: string | null } {
    return {
        email: state.userEmail,
        name: state.userName,
    }
}

/**
 * 设置认证信息
 */
export function setAuth(accessToken: string, refreshToken?: string, email?: string, name?: string): void {
    state.accessToken = accessToken
    state.antigravityToken = accessToken
    state.refreshToken = refreshToken || null
    state.userEmail = email || null
    state.userName = name || null
    saveAuth()
}

export function getAntigravityLoginUrl(): string {
    return getAntigravityAuthUrl()
}

/**
 * 使用 Google 返回的授权码完成登录（零端口、支持 Docker/远程服务器）
 */
export async function loginWithAuthCode(rawCode: string, redirectUri?: string): Promise<{ success: boolean; email?: string; error?: string }> {
    try {
        const { code, redirectUri: resolvedUri } = extractAuthCodeAndRedirectUri(rawCode, redirectUri)
        if (!code) {
            return { success: false, error: "Authorization code cannot be empty" }
        }

        const tokens = await exchangeCode(code, resolvedUri)
        const userInfo = await fetchUserInfo(tokens.accessToken)
        const projectId = await getProjectID(tokens.accessToken)
        const resolvedProjectId = projectId || generateMockProjectId()

        state.accessToken = tokens.accessToken
        state.antigravityToken = tokens.accessToken
        state.refreshToken = tokens.refreshToken
        state.tokenExpiresAt = Date.now() + tokens.expiresIn * 1000
        state.userEmail = userInfo.email
        state.userName = userInfo.email.split("@")[0]
        state.cloudaicompanionProject = resolvedProjectId

        saveAuth()

        const { accountManager } = await import("./account-manager")
        const { authStore } = await import("~/services/auth/store")
        accountManager.load()
        accountManager.addAccount({
            id: userInfo.email,
            email: userInfo.email,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: Date.now() + tokens.expiresIn * 1000,
            projectId: resolvedProjectId,
        })
        authStore.saveAccount({
            id: userInfo.email,
            provider: "antigravity",
            email: userInfo.email,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: Date.now() + tokens.expiresIn * 1000,
            projectId: resolvedProjectId,
            label: userInfo.email,
        })

        consola.success(`✓ Login successful: ${userInfo.email}`)
        return { success: true, email: userInfo.email }
    } catch (error) {
        const message = error instanceof Error ? error.message : "Authentication failed."
        consola.error(`Code login failed: ${message}`)
        return { success: false, error: message }
    }
}

/**
 * 启动 OAuth 登录流程
 */
export async function startOAuthLogin(): Promise<{ success: boolean; error?: string; email?: string }> {
    let oauthServer: { stop: () => void } | null = null
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    let oauthState: string | null = null
    try {
        const oauthSession = createOAuthPkceSession()
        const loginState = oauthSession.state
        oauthState = loginState
        const configuredRedirect = process.env.ANTI_API_OAUTH_REDIRECT_URL?.trim()

        // 1. 启动回调服务器
        const { server, port, waitForCallback } = await startOAuthCallbackServer({
            ...resolveOAuthCallbackServerOptions(configuredRedirect),
            expectedState: loginState,
        })
        oauthServer = server

        // 2. 生成授权 URL
        const redirectUri = getAntigravityOAuthRedirectUri(port, configuredRedirect)
        const authUrl = generateAuthURL(redirectUri, loginState, oauthSession.codeVerifier)

        // 3. 打开浏览器
        consola.info(`Open this URL to login: ${authUrl}`)
        if (!openBrowser(authUrl, { disabledEnv: "ANTI_API_OAUTH_NO_OPEN" })) {
            consola.debug("Browser launch skipped or unavailable; open the URL above manually")
        }

        // 4. 等待回调（5分钟超时）
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error("Authentication timeout (5 minutes)")), 5 * 60 * 1000)
        })

        const callbackResult = await Promise.race([
            waitForCallback(),
            timeoutPromise,
        ])

        // 5. 关闭服务器
        server.stop()
        oauthServer = null

        // 6. 检查回调结果
        if (callbackResult.error) {
            return { success: false, error: publicOAuthError(new Error(callbackResult.error)) }
        }

        if (!callbackResult.code || !callbackResult.state) {
            return { success: false, error: "Missing code or state in callback" }
        }

        if (callbackResult.state !== loginState) {
            return { success: false, error: "State mismatch - possible CSRF attack" }
        }

        // 7. 交换 code 获取 tokens
        const codeVerifier = consumeOAuthPkceVerifier(loginState)
        if (!codeVerifier) {
            return { success: false, error: "OAuth session expired or already used" }
        }
        const tokens = await exchangeCode(callbackResult.code, redirectUri, codeVerifier)

        // 8. 获取用户信息
        const userInfo = await fetchUserInfo(tokens.accessToken)

        // 9. 获取 Project ID
        const projectId = await getProjectID(tokens.accessToken)
        const resolvedProjectId = projectId || generateMockProjectId()
        if (!projectId) {
            consola.warn(`No project ID returned, using fallback: ${resolvedProjectId}`)
        }

        // 10. 保存认证信息
        state.accessToken = tokens.accessToken
        state.antigravityToken = tokens.accessToken
        state.refreshToken = tokens.refreshToken
        state.tokenExpiresAt = Date.now() + tokens.expiresIn * 1000
        state.userEmail = userInfo.email
        state.userName = userInfo.email.split("@")[0]
        state.cloudaicompanionProject = resolvedProjectId

        saveAuth()

        consola.success(`✓ Login successful: ${userInfo.email}`)
        consola.success(`✓ Project ID: ${resolvedProjectId}`)

        return { success: true, email: userInfo.email }
    } catch (error) {
        const message = publicOAuthError(error)
        consola.error(`OAuth login failed: ${message}`)
        return { success: false, error: message }
    } finally {
        if (timeoutId) clearTimeout(timeoutId)
        if (oauthState) discardOAuthPkceSession(oauthState)
        if (oauthServer) {
            try {
                oauthServer.stop()
            } catch {
                // Best-effort cleanup for abandoned OAuth attempts
            }
        }
    }
}

/**
 * 刷新 access token
 */
export async function refreshToken(): Promise<boolean> {
    if (!state.refreshToken) {
        return false
    }

    try {
        const tokens = await refreshAccessToken(state.refreshToken)
        state.accessToken = tokens.accessToken
        state.antigravityToken = tokens.accessToken
        saveAuth()
        consola.success("Token refreshed successfully")
        return true
    } catch (error) {
        consola.error("Token refresh failed:", safeErrorMessage(error))
        return false
    }
}
