/**
 * Auth 路由
 */

import { Hono } from "hono"
import { isAuthenticated, getUserInfo, setAuth, clearAuth, startOAuthLogin } from "~/services/antigravity/login"
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

export const authRouter = new Hono()

// 获取认证状态
authRouter.get("/status", (c) => {
    const userInfo = getUserInfo()
    return c.json({
        authenticated: isAuthenticated(),
        email: userInfo.email,
        name: userInfo.name,
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

// Credential export/import has been removed.
authRouter.post("/import", (c) => {
    return c.json({ success: false, error: "Credential bundle export/import has been removed." }, 410)
})

// 登录（触发 OAuth 或设置 token）
authRouter.post("/login", async (c) => {
    try {
        // 尝试解析 body，如果为空则触发 OAuth
        let body: {
            accessToken?: string
            refreshToken?: string
            email?: string
            name?: string
            provider?: string
            force?: boolean
            path?: string
            paths?: string[]
            profileArn?: string
            region?: string
            apiRegion?: string
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
        if (!body.accessToken) {
            const result = await startOAuthLogin()
            if (result.success) {
                accountManager.load()
                if (state.accessToken && state.refreshToken) {
                    accountManager.addAccount({
                        id: state.userEmail || `account-${Date.now()}`,
                        email: state.userEmail || "unknown",
                        accessToken: state.accessToken,
                        refreshToken: state.refreshToken,
                        expiresAt: state.tokenExpiresAt || 0,
                        projectId: state.cloudaicompanionProject,
                    })
                }
                return c.json({
                    success: true,
                    authenticated: true,
                    provider: "antigravity",
                    email: result.email,
                })
            } else {
                return c.json({ success: false, error: result.error }, 400)
            }
        }

        setAuth(body.accessToken, body.refreshToken, body.email, body.name)
        accountManager.load()
        accountManager.addAccount({
            id: body.email || `account-${Date.now()}`,
            email: body.email || "unknown",
            accessToken: body.accessToken,
            refreshToken: body.refreshToken || "",
            expiresAt: state.tokenExpiresAt || 0,
            projectId: state.cloudaicompanionProject,
        })
        return c.json({
            success: true,
            authenticated: true,
            provider: "antigravity",
            email: body.email,
            name: body.name,
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

// 查看 IDE 当前登录状态
authRouter.get("/ide/status", (c) => {
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
