/**
 * Anti-API HTTP服务器
 */

import { Hono } from "hono"
import { readFileSync } from "fs"
import { join } from "path"
import consola from "consola"

import { messageRoutes } from "./routes/messages/route"
import { openaiRoutes } from "./routes/openai/route"
import { authRouter } from "./routes/auth/route"
import { remoteRouter } from "./routes/remote/route"
import { routingRouter } from "./routes/routing/route"
import { logsRouter } from "./routes/logs/route"
import { updatesRouter } from "./routes/updates/route"
import { AVAILABLE_MODELS } from "./lib/config"
import { getAggregatedQuota } from "./services/quota-aggregator"
import { initAuth, isAuthenticated } from "./services/antigravity/login"
import { accountManager } from "./services/antigravity/account-manager"
import { loadRoutingConfig } from "./services/routing/config"
import { getProviderModels } from "./services/routing/models"
import { importCodexAuthSources } from "./services/codex/oauth"
import { importGrokAuthSources } from "./services/grok/oauth"
import { loadSettings, saveSettings } from "./services/settings"
import { pingAccount } from "./services/ping"
import { summarizeUpstreamError, UpstreamError } from "./lib/error"
import { authStore } from "./services/auth/store"
import type { AuthProvider } from "./services/auth/types"
import { safeErrorMessage } from "./lib/redaction"

import { formatLogTime, getRequestLogContext, runWithRequestContext } from "./lib/logger"
import { initLogCapture, setLogCaptureEnabled } from "./lib/log-buffer"
import { getUsage, resetUsage } from "./services/usage-tracker"
import { getPublicDir } from "./lib/public-dir"

import {
    CONTROL_PLANE_COOKIE,
    extractControlPlaneBootstrapToken,
    extractControlPlaneToken,
    getControlPlaneToken,
    getPublicGatewayToken,
    extractPublicToken,
    isContainerControlPlaneEnabled,
    tokenMatches,
} from "./lib/public-access"
import { isLoopbackRequest } from "./lib/local-request"
import { resolveLogLevel } from "./lib/log-level"

export const server = new Hono()
const PROVIDERS: AuthProvider[] = ["antigravity", "codex", "copilot", "zed", "kiro", "grok"]

interface ModelListEntry {
    id: string
    name: string
    owned_by: string
}

initLogCapture()
setLogCaptureEnabled(loadSettings().captureLogs)
consola.level = resolveLogLevel()

// 中间件 - 请求日志 (只记录重要请求)
server.use(async (c, next) => {
    return await runWithRequestContext(async () => {
        await next()
        const status = c.res.status
        const reason = c.res.headers.get("X-Log-Reason") || undefined

        // Only log errors
        if (status >= 400) {
            const ctx = getRequestLogContext()
            const method = c.req.method
            const path = c.req.path
            const debugInfo = status >= 400 ? ` (${method} ${path}${reason ? ` - ${reason}` : ""})` : ""
            if (ctx.model && ctx.provider) {
                const providerNames: Record<string, string> = {
                    copilot: "GitHub Copilot",
                    codex: "ChatGPT Codex",
                    antigravity: "Antigravity",
                    zed: "Zed",
                    kiro: "Kiro",
                    grok: "Grok",
                }
                const providerName = providerNames[ctx.provider] || ctx.provider
                const accountPart = ctx.account ? ` >> ${ctx.account}` : ""
                const routePart = ctx.routeTag ? `•${ctx.routeTag}` : ""
                console.log(`[${formatLogTime()}] ${status}: from ${ctx.model} > ${providerName}${accountPart}${routePart}${debugInfo}`)
            } else {
                console.log(`[${formatLogTime()}] ${status}: ${reason || "error"}${debugInfo}`)
            }
        }
        // All successful requests are silent (detailed 200 logs are handled elsewhere)
    })
})
server.use(async (c, next) => {
    if (isContainerControlPlaneEnabled()) {
        const expectedToken = getControlPlaneToken()
        const bootstrapToken = extractControlPlaneBootstrapToken(c.req.raw)
        if (expectedToken && bootstrapToken && tokenMatches(expectedToken, bootstrapToken)) {
            c.header("Set-Cookie", `${CONTROL_PLANE_COOKIE}=${encodeURIComponent(expectedToken)}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Strict`)
            const cleanUrl = new URL(c.req.url)
            cleanUrl.searchParams.delete("control_token")
            return c.redirect(`${cleanUrl.pathname}${cleanUrl.search}`, 303)
        }
        if (!expectedToken || !tokenMatches(expectedToken, extractControlPlaneToken(c.req.raw))) {
            return c.json({ success: false, error: "A valid container control-plane token is required." }, expectedToken ? 401 : 503)
        }
    } else if (!isLoopbackRequest(c.req.raw)) {
        return c.json({ success: false, error: "The local control plane is only available through a loopback host and origin." }, 403)
    }
    await next()
})

// 启动时自动加载已保存的认证
initAuth()
accountManager.load()

// Optional startup imports are explicit because they read and copy credentials from other tools.
if (process.env.ANTI_API_IMPORT_CODEX_ON_START === "1") {
    importCodexAuthSources().then(result => {
        if (result.accounts.length > 0) {
            consola.success(`Codex: Imported ${result.accounts.length} account(s) from ${result.sources.join(", ")}`)
        }
    }).catch(() => undefined)
}

if (process.env.ANTI_API_IMPORT_GROK_ON_START === "1") {
    importGrokAuthSources().then(result => {
        if (result.accounts.length > 0) {
            consola.success(`Grok: Imported ${result.accounts.length} account(s) from ${result.sources.join(", ")}`)
        }
    }).catch(() => undefined)
}

// 根路径 - 重定向到配额面板
server.get("/", (c) => c.redirect("/quota"))

// 浏览器 favicon 请求直接返回空响应，避免触发 404 日志
server.get("/favicon.ico", (c) => c.body(null, 204))

// Auth 路由
server.route("/auth", authRouter)

// Remote 隧道控制路由
server.route("/remote", remoteRouter)

// Routing 配置路由
server.route("/routing", routingRouter)

// Logs
server.route("/logs", logsRouter)

// Updates
server.route("/updates", updatesRouter)

// Remote 控制页面 - HTML
server.get("/remote-panel", async (c) => {
    try {
        const htmlPath = join(getPublicDir(import.meta.dir), "remote.html")
        const html = readFileSync(htmlPath, "utf-8")
        return c.html(html)
    } catch (error) {
        return c.text("Remote panel not found", 404)
    }
})

// 获取公网IP
server.get("/remote/public-ip", async (c) => {
    try {
        const res = await fetch("https://api.ipify.org?format=json")
        const data = await res.json() as { ip: string }
        return c.json({ ip: data.ip })
    } catch (error) {
        return c.json({ error: "Failed to get IP" }, 500)
    }
})

// Settings API - 获取设置
server.get("/settings", (c) => {
    return c.json(loadSettings())
})

// Settings API - 保存设置
server.post("/settings", async (c) => {
    const body = await c.req.json()
    const updated = saveSettings(body)
    setLogCaptureEnabled(updated.captureLogs)
    return c.json(updated)
})

// Credential bundle export/import has been removed.
server.get("/bundle/export", (c) => {
    return c.json({ success: false, error: "Credential bundle export/import has been removed." }, 410)
})

server.post("/bundle/import", (c) => {
    return c.json({ success: false, error: "Credential bundle export/import has been removed." }, 410)
})

server.get("/usage", (c) => {
    return c.json(getUsage())
})

server.post("/usage/reset", (c) => {
    resetUsage()
    return c.json({ success: true })
})

// OpenAI 兼容端点
server.route("/v1/chat/completions", openaiRoutes)

// Anthropic兼容端点
server.route("/v1/messages", messageRoutes)

// 同时支持 v1beta (某些 GUI 工具使用)
server.route("/v1beta/messages", messageRoutes)

// 无前缀版本 for GUI tools
server.route("/messages", messageRoutes)

// 模型列表处理函数 - 兼容 OpenAI 和 Anthropic 格式
const modelsHandler = (c: any) => {
    const now = new Date().toISOString()
    const routingConfig = loadRoutingConfig()
    const routeModels: ModelListEntry[] = (routingConfig.flows || []).map(flow => ({
        id: flow.name,
        name: `Route: ${flow.name}`,
        owned_by: "routing",
    }))
    // antigravity 只用 curated 靜態清單（baseModels / AVAILABLE_MODELS）：
    // 動態 sync 會把已下線 / 無 routing 的死模型（claude-5.5-*、tab_*_preview…）帶回清單。
    // 其它 provider 只在「已配置帳號」時才列出，避免暴露無帳號可路由的死 endpoint。
    const providerModels: ModelListEntry[] = PROVIDERS.flatMap((provider) => {
        if (provider === "antigravity") return []
        let accounts: { id?: string }[] = []
        try {
            accounts = authStore.listAccounts(provider) || []
        } catch {
            accounts = []
        }
        if (accounts.length === 0) return []
        return getProviderModels(provider).map(model => ({
            id: model.id,
            name: model.label,
            owned_by: provider,
        }))
    })
    const seen = new Set<string>()
    const baseModels: ModelListEntry[] = AVAILABLE_MODELS.map(model => ({
        id: model.id,
        name: model.name,
        owned_by: "antigravity",
    }))
    const models = [...baseModels, ...providerModels, ...routeModels].filter(model => {
        if (seen.has(model.id)) return false
        seen.add(model.id)
        return true
    })

    return c.json({
        object: "list",
        data: models.map(m => ({
            id: m.id,
            type: "model",           // Anthropic format
            object: "model",         // OpenAI format
            created_at: now,         // Anthropic format (RFC 3339)
            created: Date.now(),     // OpenAI format (unix timestamp)
            owned_by: m.owned_by,
            display_name: m.name,
        })),
        has_more: false,
        first_id: models[0]?.id,
        last_id: models[models.length - 1]?.id,
    })
}

// 模型列表端点
server.get("/v1/models", modelsHandler)
server.get("/v1beta/models", modelsHandler)
server.get("/models", modelsHandler)  // 无前缀版本 for GUI tools

// 配额面板 - HTML Dashboard
server.get("/quota", async (c) => {
    try {
        const htmlPath = join(getPublicDir(import.meta.dir), "quota.html")
        const html = readFileSync(htmlPath, "utf-8")
        return c.html(html)
    } catch (error) {
        return c.text("Quota dashboard not found", 404)
    }
})

// 配额数据 - JSON API
server.get("/quota/json", async (c) => {
    try {
        const snapshot = await getAggregatedQuota()
        return c.json(snapshot)
    } catch (error) {
        return c.json({ error: "Failed to fetch quota" }, 500)
    }
})

// Ping model availability for a specific account
server.post("/accounts/ping", async (c) => {
    let body: { provider?: string; accountId?: string; modelId?: string } = {}
    try {
        body = await c.req.json()
    } catch {
        body = {}
    }

    const provider = (body.provider || "").toLowerCase()
    const accountId = body.accountId || ""
    const modelId = body.modelId

    if (!provider || !accountId) {
        return c.json({ success: false, error: "provider and accountId are required" }, 400)
    }
    if (!PROVIDERS.includes(provider as AuthProvider)) {
        return c.json({ success: false, error: "Unsupported provider" }, 400)
    }

    try {
        const result = await pingAccount(provider as any, accountId, modelId)
        return c.json({
            success: true,
            provider,
            accountId,
            modelId: result.modelId,
            latencyMs: result.latencyMs,
        })
    } catch (error) {
        if (error instanceof UpstreamError) {
            const summary = summarizeUpstreamError(error)
            return c.json({
                success: false,
                provider,
                accountId,
                modelId: modelId || null,
                status: error.status,
                reason: summary.reason || null,
                error: summary.message,
            })
        }
        return c.json({
            success: false,
            provider,
            accountId,
            modelId: modelId || null,
            error: safeErrorMessage(error),
        })
    }
})

// 删除账号 - API（只清理 Anti-API 自己的账号和 routing 配置）
server.delete("/accounts/:id", async (c) => {
    const accountId = c.req.param("id")

    // 先尝试从 accountManager 删除 (antigravity 内存管理)
    let success = accountManager.removeAccount(accountId)

    // 如果 accountManager 找不到，尝试直接从 authStore 删除
    // 这覆盖了 token 过期或通过其他方式添加的账号
    if (!success) {
        // 尝试所有 provider 类型
        for (const provider of PROVIDERS) {
            if (authStore.deleteAccount(provider, accountId)) {
                success = true
                break
            }
        }
    }

    if (success) {
        // 同时清理 routing 配置中的该账号
        try {
            const { loadRoutingConfig, saveRoutingConfig } = require("./services/routing/config")
            const config = loadRoutingConfig()
            let removedCount = 0
            const cleanedFlows = config.flows.map((flow: any) => ({
                ...flow,
                entries: flow.entries.filter((entry: any) => {
                    if (entry.accountId === accountId) {
                        removedCount++
                        return false
                    }
                    return true
                })
            }))
            const cleanedAccountRouting = config.accountRouting ? {
                ...config.accountRouting,
                routes: config.accountRouting.routes.map((route: any) => ({
                    ...route,
                    entries: route.entries.filter((entry: any) => {
                        if (entry.accountId === accountId) {
                            removedCount++
                            return false
                        }
                        return true
                    })
                }))
            } : config.accountRouting
            if (removedCount > 0) {
                saveRoutingConfig(cleanedFlows, undefined, cleanedAccountRouting)
            }
        } catch (e) {
            console.error("Failed to cleanup routing config:", safeErrorMessage(e))
        }
        return c.json({
            success: true,
            message: `Account ${accountId} removed from Anti-API`,
            externalArtifactsPreserved: true,
        })
    }
    return c.json({ success: false, error: "Account not found" }, 404)
})

// 隧道状态 - 返回公共 URL
server.get("/tunnel/status", (c) => {
    const { state } = require("./lib/state")
    return c.json({
        active: !!state.publicUrl,
        url: state.publicUrl,
    })
})

// Embeddings 端点 - 占位（FlowDown 等客户端会请求）
server.post("/embeddings", (c) => c.json({
    error: { type: "not_supported", message: "Embeddings not supported" }
}, 501))
server.post("/v1/embeddings", (c) => c.json({
    error: { type: "not_supported", message: "Embeddings not supported" }
}, 501))

// Responses 端点 - 占位（OpenAI Responses API）
server.post("/responses", (c) => c.json({
    error: { type: "not_supported", message: "Responses API not supported" }
}, 501))
server.post("/v1/responses", (c) => c.json({
    error: { type: "not_supported", message: "Responses API not supported" }
}, 501))

// 健康检查
server.get("/health", (c) => c.json({
    status: "ok",
    authenticated: isAuthenticated(),
}))

export function createPublicServer(token: string | null = getPublicGatewayToken()): Hono {
    const app = new Hono()

    app.get("/health", (c) => c.json({ status: "ok" }))
    const publicPaths = [
        "/v1/chat/completions",
        "/v1/messages",
        "/v1beta/messages",
        "/messages",
        "/v1/models",
        "/v1beta/models",
        "/models",
    ]
    for (const path of publicPaths) {
        app.use(path, async (c, next) => {
            if (!token) {
                return c.json({ error: { type: "configuration_error", message: "Public inference is not configured." } }, 503)
            }
            const provided = extractPublicToken(c.req.raw)
            if (!tokenMatches(token, provided)) {
                return c.json({ error: { type: "authentication_error", message: "A valid public gateway token is required." } }, 401)
            }
            await next()
        })
    }

    app.route("/v1/chat/completions", openaiRoutes)
    app.route("/v1/messages", messageRoutes)
    app.route("/v1beta/messages", messageRoutes)
    app.route("/messages", messageRoutes)
    app.get("/v1/models", modelsHandler)
    app.get("/v1beta/models", modelsHandler)
    app.get("/models", modelsHandler)

    return app
}

export const publicServer = createPublicServer()
