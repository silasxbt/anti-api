/**
 * Auth 路由
 */

import { Hono } from "hono"
import { isAuthenticated, getUserInfo, setAuth, clearAuth, getAntigravityLoginUrl, loginWithAuthCode } from "~/services/antigravity/login"
import { accountManager } from "~/services/antigravity/account-manager"
import { state } from "~/lib/state"
import { authStore } from "~/services/auth/store"
import { debugCodexOAuth, importCodexAuthSources, startCodexCliLogin, getCodexCliLoginStatus } from "~/services/codex/oauth"
import { startCopilotDeviceFlow, pollCopilotSession, importCopilotAuthFiles } from "~/services/copilot/oauth"
import { getIdeAuthStatus, logoutIdeSession } from "~/services/antigravity/ide-switch"
import { importConfiguredZedAccount, ZedCredentialImportError } from "~/services/zed/oauth"
import { importKiroAuthSources } from "~/services/kiro/oauth"
import { runAccountDiagnostics } from "~/services/auth/diagnostics"
import { isLoopbackHost } from "~/lib/local-request"
import { safeErrorMessage } from "~/lib/redaction"
import { importAgyAuthSources, exchangeAuthCode, getAgyAuthStatus } from "~/services/antigravity/agy-auth"

export const authRouter = new Hono()

// 获取认证状态
authRouter.get("/status", (c) => {
    const userInfo = getUserInfo()
    accountManager.load()
    const antigravityAccounts = authStore.listAccounts("antigravity")
    const isAuthed = isAuthenticated() && antigravityAccounts.length > 0
    return c.json({
        authenticated: isAuthed,
        email: userInfo.email || (antigravityAccounts[0]?.email ?? null),
        name: userInfo.name || null,
        requiresReauth: !isAuthed,
    })
})

authRouter.get("/accounts", (c) => {
    accountManager.load()
    return c.json({
        accounts: {
            antigravity: authStore.listSummaries("antigravity"),
            codex: authStore.listSummaries("codex"),
            copilot: authStore.listSummaries("copilot"),
            zed: authStore.listSummaries("zed"),
            kiro: authStore.listSummaries("kiro"),
            grok: authStore.listSummaries("grok"),
        },
    })
})

// Credential export/import has been removed.
authRouter.get("/export", (c) => {
    return c.json({ success: false, error: "Credential bundle export/import has been removed." }, 410)
})

// Import credenziali da file JSON (trascinato da Web UI)
authRouter.post("/import", async (c) => {
    try {
        const payload = await c.req.json()
        const accountsToImport = Array.isArray(payload)
            ? payload
            : (Array.isArray(payload.accounts) ? payload.accounts : [payload])

        accountManager.load()
        let importedCount = 0
        let lastEmail = ""

        for (const item of accountsToImport) {
            const accessToken = item.accessToken || item.access_token || item.apiKey
            const refreshToken = item.refreshToken || item.refresh_token || ""
            const email = item.userEmail || item.email || item.login || item.id || "unknown"
            const name = item.userName || item.name || email.split("@")[0]
            const projectId = item.projectId || item.cloudaicompanionProject || "aicode-consumers"
            const expiresAt = item.expiresAt || item.expires_at || (Date.now() + 3600 * 1000)

            if (!accessToken && !refreshToken) continue

            const providerType = (item.provider || item.type || "").toLowerCase()
            if (providerType === "copilot" || providerType === "github-copilot") {
                const login = item.login || item.id || name
                authStore.saveAccount({
                    id: item.id || login,
                    provider: "copilot",
                    login,
                    label: item.label || item.displayName || login,
                    accessToken: accessToken || "",
                    refreshToken,
                    expiresAt,
                })
                lastEmail = login
                importedCount++
                continue
            }

            if (providerType === "codex" || providerType === "chatgpt") {
                const login = item.email || item.login || item.id || name
                authStore.saveAccount({
                    id: item.id || login,
                    provider: "codex",
                    email: item.email || login,
                    login,
                    label: item.label || item.displayName || login,
                    accessToken: accessToken || "",
                    refreshToken,
                    expiresAt,
                })
                lastEmail = login
                importedCount++
                continue
            }

            accountManager.addAccount({
                id: email || `account-${Date.now()}`,
                email,
                accessToken: accessToken || "",
                refreshToken: refreshToken || "",
                expiresAt,
                projectId,
            })
            if (!state.accessToken && accessToken) {
                setAuth(accessToken, refreshToken, email, name)
            }
            lastEmail = email
            importedCount++
        }

        if (importedCount === 0) {
            return c.json({ success: false, error: "Nessuna credenziale valida trovata nel file JSON." }, 400)
        }

        return c.json({
            success: true,
            imported: importedCount,
            email: lastEmail,
            message: `Importato con successo ${importedCount} account.`
        })
    } catch (e) {
        return c.json({ success: false, error: safeErrorMessage(e) || "Errore nella lettura del JSON" }, 400)
    }
})


// 登录（触发 OAuth 或设置 token）
authRouter.post("/login", async (c) => {
    try {
        // 尝试解析 body，如果为空则触发 OAuth
        let body: {
            accessToken?: string
            refreshToken?: string
            code?: string
            redirectUri?: string
            email?: string
            name?: string
            provider?: string
            force?: boolean
            path?: string
            paths?: string[]
            profileArn?: string
            region?: string
            apiRegion?: string
            projectId?: string
            proxy?: string
            label?: string
        } = {}
        try {
            const text = await c.req.text()
            if (text && text.trim()) {
                body = JSON.parse(text)
            }
        } catch {
            // body 为空或无效 JSON
        }

        const provider = (body.provider || "antigravity").toLowerCase()
        const forceInteractive = body.force === true

        if (provider === "copilot") {
            if (!forceInteractive) {
                const imported = importCopilotAuthFiles()
                if (imported.length > 0) {
                    return c.json({
                        success: true,
                        status: "success",
                        provider: "copilot",
                        source: "import",
                        login: imported[0].login,
                    })
                }
            }
            const session = await startCopilotDeviceFlow()
            return c.json({
                success: true,
                status: "pending",
                provider: "copilot",
                device_code: session.deviceCode,
                user_code: session.userCode,
                verification_uri: session.verificationUri,
                interval: session.interval,
            })
        }

        if (provider === "codex") {
            if (forceInteractive) {
                // 使用浏览器 OAuth 登录获取完整权限的 token
                try {
                    const { startCodexOAuthLogin } = await import("~/services/codex/oauth")
                    const account = await startCodexOAuthLogin()
                    return c.json({
                        success: true,
                        provider: "codex",
                        status: "success",
                        source: "browser-oauth",
                        account: {
                            id: account.id,
                            email: account.email,
                            source: account.authSource,
                        },
                    })
                } catch (error) {
                    return c.json({ success: false, error: safeErrorMessage(error) }, 400)
                }
            }

            const result = await importCodexAuthSources()
            if (result.accounts.length > 0) {
                return c.json({
                    success: true,
                    provider: "codex",
                    status: "success",
                    source: "import",
                    count: result.accounts.length,
                    sources: result.sources,
                    accounts: result.accounts.map(account => ({
                        id: account.id,
                        email: account.email,
                        source: account.authSource,
                    })),
                })
            }
            return c.json({
                success: false,
                error: "Codex auth files not found. Use force=true to login via browser.",
            }, 400)
        }

        if (provider === "zed") {
            let account
            try {
                account = await importConfiguredZedAccount()
            } catch (error) {
                if (error instanceof ZedCredentialImportError) {
                    return c.json({ success: false, error: safeErrorMessage(error) }, 400)
                }
                throw error
            }
            return c.json({
                success: true,
                provider: "zed",
                status: "success",
                source: "configured-file",
                account: {
                    id: account.id,
                    login: account.login,
                    label: account.label,
                    source: account.authSource,
                },
            })
        }

        if (provider === "kiro") {
            const result = await importKiroAuthSources({
                paths: [
                    ...(Array.isArray(body.paths) ? body.paths : []),
                    ...(body.path ? [body.path] : []),
                ],
                refreshToken: body.refreshToken,
                profileArn: body.profileArn,
                region: body.region,
                apiRegion: body.apiRegion,
            })
            if (result.accounts.length === 0) {
                return c.json({
                    success: false,
                    error: "Kiro credentials not found. Sign in with Kiro IDE or run kiro-cli login, then retry.",
                }, 400)
            }
            return c.json({
                success: true,
                provider: "kiro",
                status: "success",
                source: "import",
                count: result.accounts.length,
                sources: result.sources,
                accounts: result.accounts.map(account => ({
                    id: account.id,
                    label: account.label,
                    source: account.authSource,
                })),
                account: {
                    id: result.accounts[0].id,
                    label: result.accounts[0].label,
                    source: result.accounts[0].authSource,
                },
            })
        }

        // 默认 Antigravity
        if (body.code) {
            const exchangeResult = await loginWithAuthCode(body.code, (body as any).redirectUri)
            if (exchangeResult.success) {
                return c.json({
                    success: true,
                    authenticated: true,
                    provider: "antigravity",
                    status: "success",
                    email: exchangeResult.email,
                })
            } else {
                return c.json({ success: false, error: exchangeResult.error }, 400)
            }
        }

        if (!body.accessToken) {
            // Base flow for Docker & remote server: return Google OAuth authorization link
            return c.json({
                success: true,
                status: "pending",
                provider: "antigravity",
                auth_url: getAntigravityLoginUrl(),
                instructions: "Open auth_url in your browser, sign in with Google, and copy the authorization code to complete login.",
            })
        }

        const email = body.email || (body as any).userEmail
        const name = body.name || (body as any).userName
        const projectId = body.projectId || (body as any).cloudaicompanionProject || state.cloudaicompanionProject

        setAuth(body.accessToken, body.refreshToken, email, name)
        accountManager.load()
        accountManager.addAccount({
            id: email || `account-${Date.now()}`,
            email: email || "unknown",
            accessToken: body.accessToken,
            refreshToken: body.refreshToken || "",
            expiresAt: state.tokenExpiresAt || 0,
            projectId,
        })
        return c.json({
            success: true,
            authenticated: true,
            provider: "antigravity",
            email: email,
            name: name,
        })
    } catch {
        return c.json({ error: "Authentication request failed. Check provider setup and retry." }, 500)
    }
})

authRouter.get("/copilot/status", async (c) => {
    const deviceCode = c.req.query("device_code")
    if (!deviceCode) {
        return c.json({ success: false, error: "device_code required" }, 400)
    }
    const session = await pollCopilotSession(deviceCode)
    return c.json({
        success: session.status !== "error",
        status: session.status,
        message: session.message,
        account: session.account ? {
            id: session.account.id,
            login: session.account.login,
            email: session.account.email,
        } : undefined,
    })
})

authRouter.get("/codex/status", async (c) => {
    const sessionId = c.req.query("session_id")
    if (!sessionId) {
        return c.json({ success: false, error: "session_id required" }, 400)
    }
    const result = await getCodexCliLoginStatus(sessionId)
    return c.json({
        success: result.status !== "error",
        status: result.status,
        message: result.message,
        verification_uri: result.verificationUri,
        user_code: result.userCode,
        accounts: result.accounts?.map(account => ({
            id: account.id,
            email: account.email,
            source: account.authSource,
        })),
    })
})

authRouter.get("/codex/debug", async (c) => {
    try {
        const result = await debugCodexOAuth()
        return c.json({ success: true, ...result })
    } catch (error) {
        return c.json({ success: false, error: safeErrorMessage(error) }, 500)
    }
})

authRouter.get("/diagnostics", async (c) => {
    if (!isLoopbackHost(c.req.header("host"))) {
        return c.json({ success: false, error: "Diagnostics is only available from localhost." }, 403)
    }
    try {
        const report = await runAccountDiagnostics()
        return c.json({ success: true, ...report })
    } catch (error) {
        return c.json({ success: false, error: safeErrorMessage(error) }, 500)
    }
})

// 登出
authRouter.post("/logout", (c) => {
    clearAuth()
    return c.json({ success: true, authenticated: false })
})

// ====== IDE 登出 ======

// 查看 IDE / agy 当前登录状态
authRouter.get("/ide/status", async (c) => {
    const agyStatus = await getAgyAuthStatus()
    if (agyStatus.loggedIn) {
        return c.json({
            loggedIn: true,
            email: agyStatus.email,
            name: agyStatus.email?.split("@")[0] || null,
            source: "agy",
        })
    }
    const status = getIdeAuthStatus()
    return c.json(status)
})

// 登出 IDE 账号（关闭 IDE + 清除认证）
authRouter.post("/ide/logout", async (c) => {
    try {
        const body: { confirm?: string } = await c.req.json<{ confirm?: string }>().catch(() => ({}))
        if (body.confirm !== "CLOSE_IDE_AND_CLEAR_AUTH") {
            return c.json({
                success: false,
                error: "Confirmation required. This closes Antigravity and removes its authentication keys from state.vscdb.",
                requiredConfirmation: "CLOSE_IDE_AND_CLEAR_AUTH",
            }, 400)
        }
        const result = await logoutIdeSession()
        return c.json(result)
    } catch (error) {
        return c.json({ success: false, error: safeErrorMessage(error) }, 500)
    }
})

// ====== Antigravity CLI (agy) ======

authRouter.get("/agy/status", async (c) => {
    return c.json(await getAgyAuthStatus())
})

authRouter.post("/agy/import", async (c) => {
    return c.json(await importAgyAuthSources())
})

