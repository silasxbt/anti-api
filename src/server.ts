/**
 * Anti-API HTTP服务器
 */

import { Hono } from "hono"
import { readFileSync } from "fs"
import { join } from "path"
import consola from "consola"

import { messageRoutes } from "./routes/messages/route"
import { openaiRoutes } from "./routes/openai/route"
import { audioRoutes } from "./routes/audio/route"
import { authRouter } from "./routes/auth/route"
import { remoteRouter } from "./routes/remote/route"
import { routingRouter, syncProviderModels } from "./routes/routing/route"
import { logsRouter } from "./routes/logs/route"
import { updatesRouter } from "./routes/updates/route"
import { getAggregatedQuota } from "./services/quota-aggregator"
import { initAuth, isAuthenticated } from "./services/antigravity/login"
import { accountManager } from "./services/antigravity/account-manager"
import { loadRoutingConfig, saveRoutingConfig, isSeparateThinkingModelsEnabled } from "./services/routing/config"
import { quotaPoolForModel, type QuotaPool } from "./lib/model-catalog"
import { getProviderModels, isVariantModelId } from "./services/routing/models"
import { importCodexAuthSources } from "./services/codex/oauth"
import { importGrokAuthSources } from "./services/grok/oauth"
import { importAgyAuthSources } from "./services/antigravity/agy-auth"
import { loadSettings, saveSettings } from "./services/settings"
import { pingAccount } from "./services/ping"
import { summarizeUpstreamError, UpstreamError } from "./lib/error"
import { authStore } from "./services/auth/store"
import { ACCOUNT_PLAN_OPTIONS } from "./lib/account-plans"
import { AUTH_PROVIDERS, PROVIDER_DISPLAY_NAMES, type AuthProvider } from "./services/auth/types"
import { safeErrorMessage } from "./lib/redaction"

import { formatLogTime, getRequestLogContext, runWithRequestContext } from "./lib/logger"
import { initLogCapture, setLogCaptureEnabled } from "./lib/log-buffer"
import { getUsage, resetUsage } from "./services/usage-tracker"
import { getPricingStatus, refreshModelPricing } from "./services/model-pricing"
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
import { dispatchOAuthCallback } from "./services/antigravity/oauth"

export const server = new Hono()
const PROVIDERS = AUTH_PROVIDERS

interface ModelListEntry {
    id: string
    name: string
    owned_by: string
}

initLogCapture()
setLogCaptureEnabled(loadSettings().captureLogs)
consola.level = resolveLogLevel()

// CORS is granted only to the inference API. The control plane (auth, settings, logs, ...)
// is same-origin only so other web pages cannot drive it.
const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, HEAD",
    "Access-Control-Allow-Headers": "*",
}
const INFERENCE_PATH_PREFIXES = ["/v1/", "/v1beta/", "/messages", "/models", "/embeddings", "/responses"]

function isInferencePath(path: string): boolean {
    return INFERENCE_PATH_PREFIXES.some(prefix => path === prefix.replace(/\/$/, "") || path.startsWith(prefix))
}

server.use("*", async (c, next) => {
    if (!isInferencePath(c.req.path)) return await next()
    if (c.req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: { ...CORS_HEADERS, "Access-Control-Max-Age": "86400" } })
    }
    await next()
    for (const [name, value] of Object.entries(CORS_HEADERS)) c.res.headers.set(name, value)
})
type CallbackTone = "success" | "error" | "warning"
const CALLBACK_TONE_COLORS: Record<CallbackTone, string> = { success: "#22c55e", error: "#ef4444", warning: "#eab308" }

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!))
}

/** Renders the small status page shown at the end of an OAuth callback. `bodyHtml` must already be escaped. */
function renderCallbackPage(opts: { title: string; heading: string; tone: CallbackTone; bodyHtml: string; redirect?: boolean }): string {
    const footer = opts.redirect
        ? `<p style="font-size:0.875rem;color:#a1a1aa;">Reindirizzamento alla dashboard...</p>
            <script>setTimeout(() => { window.location.href = '/quota'; }, 1500);</script>`
        : `<a href="/quota" style="color:#38bdf8;text-decoration:none;">Torna alla Dashboard</a>`
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${opts.title}</title></head>
<body style="font-family:system-ui,-apple-system,sans-serif;background:#18181b;color:#f4f4f5;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
  <div style="background:#27272a;padding:2rem;border-radius:12px;text-align:center;max-width:400px;box-shadow:0 10px 25px rgba(0,0,0,0.5);">
    <h2 style="color:${CALLBACK_TONE_COLORS[opts.tone]};margin-top:0;">${opts.heading}</h2>
    ${opts.bodyHtml}
    ${footer}
  </div>
</body></html>`
}

const callbackError = (message: string, heading = "Errore di accesso") =>
    renderCallbackPage({ title: "Anti-API Auth Error", heading, tone: "error", bodyHtml: `<p>${escapeHtml(message)}</p>` })

// OAuth 回调端点 - 允许通过主端口/反向代理直接接收 OAuth 回调，无需额外暴露回调端口
server.get("/oauth-callback", async (c) => {
    const code = c.req.query("code")
    const state = c.req.query("state")
    const error = c.req.query("error")

    if (error) return c.html(callbackError(error, "Accesso non riuscito"))

    if (dispatchOAuthCallback(code, state, error)) {
        return c.html(renderCallbackPage({
            title: "Anti-API Auth Success",
            heading: "✅ Accesso completato",
            tone: "success",
            bodyHtml: "<p>Account OAuth connesso ad Anti-API.</p>",
            redirect: true,
        }))
    }

    if (code) {
        try {
            const { loginWithAuthCode } = await import("./services/antigravity/login")
            const host = c.req.header("host")
            const redirectUri = host ? `http://${host}/oauth-callback` : undefined
            const result = await loginWithAuthCode(code, redirectUri)
            if (!result.success) return c.html(callbackError(result.error || "Scambio del codice non riuscito."))
            return c.html(renderCallbackPage({
                title: "Anti-API Auth Success",
                heading: "✅ Accesso completato",
                tone: "success",
                bodyHtml: `<p>Account Google <strong>${escapeHtml(result.email || "")}</strong> connesso con successo ad Anti-API.</p>`,
                redirect: true,
            }))
        } catch (err: any) {
            return c.html(callbackError(err.message || "Errore sconosciuto"))
        }
    }

    return c.html(renderCallbackPage({
        title: "Anti-API Auth Callback",
        heading: "Callback Ricevuto",
        tone: "warning",
        bodyHtml: "<p>Nessun codice fornito o sessione già completata.</p>",
    }))
})
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
            const debugInfo = ` (${method} ${path}${reason ? ` - ${reason}` : ""})`
            if (ctx.model && ctx.provider) {
                const providerName = PROVIDER_DISPLAY_NAMES[ctx.provider as AuthProvider] || ctx.provider
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
    // Exempt public health checks and OAuth callback
    const isHealthBootstrap = c.req.path === "/health" && isContainerControlPlaneEnabled() && !!extractControlPlaneBootstrapToken(c.req.raw)
    if (c.req.path === "/oauth-callback" || (c.req.path === "/health" && !isHealthBootstrap)) {
        return await next()
    }

    if (isContainerControlPlaneEnabled()) {
        const expectedToken = getControlPlaneToken()
        const bootstrapToken = extractControlPlaneBootstrapToken(c.req.raw)
        if (expectedToken && bootstrapToken && tokenMatches(expectedToken, bootstrapToken)) {
            const isHttps = c.req.header("x-forwarded-proto") === "https" || c.req.url.startsWith("https://")
            const secureFlag = isHttps ? "; Secure" : ""
            c.header("Set-Cookie", `${CONTROL_PLANE_COOKIE}=${encodeURIComponent(expectedToken)}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax${secureFlag}`)
            const cleanUrl = new URL(c.req.url)
            cleanUrl.searchParams.delete("control_token")
            return c.redirect(`${cleanUrl.pathname}${cleanUrl.search}`, 303)
        }
        if (!expectedToken || !tokenMatches(expectedToken, extractControlPlaneToken(c.req.raw))) {
            return c.json({ success: false, error: "A valid container control-plane token is required." }, expectedToken ? 401 : 503)
        }
    } else if (process.env.ANTI_API_BEHIND_REVERSE_PROXY === "1" || process.env.ANTI_API_TRUST_PROXY === "1") {
        // Reverse proxy mode: allow external host header
    } else if (!isLoopbackRequest(c.req.raw)) {
        return c.json({ success: false, error: "The local control plane is only available through a loopback host and origin." }, 403)
    }
    await next()
})

// 启动时自动加载已保存的认证
initAuth()
if (typeof accountManager?.load === "function") {
    accountManager.load()
}

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

if ((accountManager?.getAllAccounts?.()?.length ?? 0) === 0 || process.env.ANTI_API_IMPORT_AGY_ON_START === "1") {
    importAgyAuthSources().then(result => {
        if (result.success && result.imported) {
            consola.success(`Antigravity: Imported credentials from agy (${result.email})`)
        }
    }).catch(() => undefined)
}

// 根路径 - 重定向到配额面板
server.get("/", (c) => c.redirect("/quota"))

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

server.get("/usage/pricing", (c) => {
    return c.json(getPricingStatus())
})

// Pulls the latest per-model pricing from the online datasheet
server.post("/usage/pricing/refresh", async (c) => {
    const ok = await refreshModelPricing()
    return c.json({ success: ok, ...getPricingStatus() }, ok ? 200 : 502)
})

server.post("/usage/reset", (c) => {
    resetUsage()
    return c.json({ success: true })
})

// OpenAI 兼容端点
server.route("/v1/chat/completions", openaiRoutes)
server.route("/v1/audio", audioRoutes)
server.route("/audio", audioRoutes)

// Anthropic兼容端点
server.route("/v1/messages", messageRoutes)

// 同时支持 v1beta (某些 GUI 工具使用)
server.route("/v1beta/messages", messageRoutes)

// 无前缀版本 for GUI tools
server.route("/messages", messageRoutes)

function computeModelsCatalog() {
    const settings = loadSettings()
    const routingConfig = loadRoutingConfig()

    const routeModels: ModelListEntry[] = (routingConfig.flows || []).map(flow => ({
        id: flow.name,
        name: `Route: ${flow.name}`,
        owned_by: "routing",
    }))

    const activeProviderSet = new Set(
        PROVIDERS.filter(p => authStore.listAccounts(p).length > 0)
    )

    const targetProviders = (settings.onlyActiveProviders ?? true)
        ? PROVIDERS.filter(p => activeProviderSet.has(p))
        : PROVIDERS

    const separateThinking = settings.separateThinkingModels ?? isSeparateThinkingModelsEnabled()

    const providerModels: ModelListEntry[] = targetProviders.flatMap((provider) =>
        getProviderModels(provider, { includeAllVariants: separateThinking }).map(model => ({
            id: model.id,
            name: model.label,
            owned_by: provider,
        }))
    )

    const seen = new Set<string>()
    let models = [...providerModels, ...routeModels].filter(model => {
        if (seen.has(model.id)) return false
        seen.add(model.id)
        return true
    })

    if (activeProviderSet.has("antigravity")) {
        models.push({
            id: "gemini-transcribe",
            name: "Gemini Transcribe",
            owned_by: "antigravity",
        })
    }

    // Filter: separateThinkingModels (if false, drop any explicit thinking variants)
    if (!separateThinking) {
        models = models.filter(m => !isVariantModelId(m.id))
    }

    // Filter: disabledModels
    if (Array.isArray(settings.disabledModels) && settings.disabledModels.length > 0) {
        const disabledSet = new Set(settings.disabledModels)
        models = models.filter(m => !disabledSet.has(m.id))
    }

    return { models, settings, activeProviders: Array.from(activeProviderSet) }
}

// 模型列表处理函数 - 兼容 OpenAI 和 Anthropic 格式
const modelsHandler = async (c: any) => {
    // Pull the real per-account model lists online (TTL-throttled) before answering
    await syncProviderModels(Date.now(), 4000).catch(() => undefined)
    const now = new Date().toISOString()
    const { models } = computeModelsCatalog()

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

// API 仪表盘模型目录与实时状态
server.get("/api/models-catalog", async (c: any) => {
    await syncProviderModels(Date.now(), 4000).catch(() => undefined)
    const routingConfig = loadRoutingConfig()
    const settings = loadSettings()

    const activeProviderSet = new Set(
        PROVIDERS.filter(p => authStore.listAccounts(p).length > 0)
    )

    // All available models across providers
    const allProviders: ModelListEntry[] = PROVIDERS.flatMap(provider =>
        getProviderModels(provider, { includeAllVariants: true }).map(model => ({
            id: model.id,
            name: model.label,
            owned_by: provider,
        }))
    )
    const allRoutes: ModelListEntry[] = (routingConfig.flows || []).map(flow => ({
        id: flow.name,
        name: `Route: ${flow.name}`,
        owned_by: "routing",
    }))

    const quotaSnapshot = await getAggregatedQuota().catch(() => null)
    // Antigravity quota pools with no remaining quota on any account
    const exhaustedPools = new Set<QuotaPool>()
    const antigravityAccounts = (quotaSnapshot?.accounts || []).filter(a => a.provider === "antigravity")
    if (antigravityAccounts.length > 0) {
        const hasAvailableForBarPrefix = (prefix: string) => {
            return antigravityAccounts.some(acc => {
                const bars = (acc.bars || []).filter(b => b.key.startsWith(prefix))
                return bars.length === 0 || bars.every(b => (b.percentage ?? 0) > 0 && !b.disabled)
            })
        }
        for (const pool of ["claude_gpt", "gemini", "argon"] as const) {
            if (!hasAvailableForBarPrefix(pool)) exhaustedPools.add(pool)
        }
    }

    const seenAll = new Set<string>()
    const allAvailable = [...allProviders, ...allRoutes].filter(m => {
        if (seenAll.has(m.id)) return false
        seenAll.add(m.id)
        return true
    }).map(m => {
        const isProviderActive = m.owned_by === "routing" || activeProviderSet.has(m.owned_by as AuthProvider)
        const pool = m.owned_by === "antigravity" ? quotaPoolForModel(m.id) : null
        const isQuotaExhausted = pool !== null && exhaustedPools.has(pool)
        const isAvailable = isProviderActive && !isQuotaExhausted
        const isThinking = isVariantModelId(m.id)
        return {
            ...m,
            isThinking,
            isProviderActive,
            isAvailable,
        }
    })

    const { models: exposedModels } = computeModelsCatalog()
    const exposedIds = new Set(exposedModels.map(m => m.id))

    return c.json({
        allAvailable,
        exposedIds: Array.from(exposedIds),
        settings,
        activeProviders: Array.from(activeProviderSet),
    })
})

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

// 获取账号选项 (Egress Proxy, Label, Project ID)
server.get("/accounts/:id/options", (c) => {
    const accountId = c.req.param("id")
    const providerParam = c.req.query("provider") as AuthProvider | undefined

    // 优先检查 antigravity
    const agAcc = accountManager.getAccount(accountId)
    if (agAcc) {
        return c.json({
            success: true,
            account: {
                id: agAcc.id,
                provider: "antigravity",
                email: agAcc.email,
                displayName: agAcc.label || agAcc.email,
                label: agAcc.label || "",
                proxy: agAcc.proxy || "",
                projectId: agAcc.projectId || "",
                plan: agAcc.plan || "",
            }
        })
    }

    // 检查 authStore
    const providersToTry = providerParam ? [providerParam] : PROVIDERS
    for (const prov of providersToTry) {
        const acc = authStore.getAccount(prov, accountId)
        if (acc) {
            return c.json({
                success: true,
                account: {
                    id: acc.id,
                    provider: prov,
                    email: acc.email,
                    login: acc.login,
                    displayName: acc.label || acc.email || acc.login || acc.id,
                    label: acc.label || "",
                    proxy: acc.proxy || "",
                    projectId: acc.projectId || "",
                    plan: acc.plan || "",
                }
            })
        }
    }

    return c.json({ success: false, error: "Account not found" }, 404)
})

// 导出账号完整凭证 (JSON)
server.get("/accounts/:id/export", (c) => {
    const accountId = c.req.param("id")
    const providerParam = c.req.query("provider") as AuthProvider | undefined

    // 1. Antigravity 账号
    const agAcc = accountManager.getAccount(accountId)
    if (agAcc) {
        return c.json({
            success: true,
            account: {
                id: agAcc.id,
                provider: "antigravity",
                email: agAcc.email,
                displayName: agAcc.label || agAcc.email,
                label: agAcc.label || "",
                proxy: agAcc.proxy || "",
                projectId: agAcc.projectId || "",
                accessToken: agAcc.accessToken,
                refreshToken: agAcc.refreshToken,
                expiresAt: agAcc.expiresAt,
            }
        })
    }

    // 2. AuthStore 账号
    const providersToTry = providerParam ? [providerParam] : PROVIDERS
    for (const prov of providersToTry) {
        const acc = authStore.getAccount(prov, accountId)
        if (acc) {
            return c.json({
                success: true,
                account: {
                    ...acc,
                    provider: prov,
                    displayName: acc.label || acc.email || acc.login || acc.id,
                }
            })
        }
    }

    return c.json({ success: false, error: "Account not found" }, 404)
})

// 更新账号选项 (Egress Proxy, Label, Project ID)
const handleUpdateAccountOptions = async (c: any) => {
    const accountId = c.req.param("id")
    let body: { proxy?: string; label?: string; projectId?: string; provider?: string; plan?: string } = {}
    try {
        body = await c.req.json()
    } catch {
        body = {}
    }

    const { proxy, label, projectId, provider } = body
    const plan = body.plan !== undefined ? String(body.plan ?? "").trim().toLowerCase() : undefined
    // Validate against the known plan enums ("" clears the plan => provider default applies).
    if (plan !== undefined && plan !== "") {
        const allowedPlans = new Set<string>([
            ...ACCOUNT_PLAN_OPTIONS.antigravity,
            ...ACCOUNT_PLAN_OPTIONS.copilot,
        ])
        if (!allowedPlans.has(plan)) {
            return c.json({ success: false, error: `Unknown plan "${plan}". Allowed: ${[...allowedPlans].join(", ")}` }, 400)
        }
    }
    let updated = false
    let targetProvider = provider as AuthProvider | undefined

    if (!targetProvider || targetProvider === "antigravity") {
        if (accountManager.hasAccount(accountId)) {
            updated = accountManager.updateAccountOptions(accountId, { proxy, label, projectId, plan })
            targetProvider = "antigravity"
        }
    }

    if (!updated || targetProvider) {
        const providersToTry = targetProvider ? [targetProvider] : PROVIDERS
        for (const prov of providersToTry) {
            const res = authStore.updateAccountOptions(prov, accountId, { proxy, label, projectId, plan })
            if (res) {
                updated = true
                targetProvider = prov
                break
            }
        }
    }

    if (!updated) {
        return c.json({ success: false, error: `Account not found: ${accountId}` }, 404)
    }

    return c.json({
        success: true,
        accountId,
        provider: targetProvider,
        proxy: proxy !== undefined ? (proxy.trim() || null) : undefined,
        label: label !== undefined ? (label.trim() || null) : undefined,
        projectId: projectId !== undefined ? (projectId.trim() || null) : undefined,
        plan: plan !== undefined ? (plan || null) : undefined,
    })
}

server.patch("/accounts/:id/options", handleUpdateAccountOptions)
server.post("/accounts/:id/options", handleUpdateAccountOptions)

// 测试 Egress Proxy 连通性
server.post("/accounts/test-proxy", async (c) => {
    let body: { proxy?: string } = {}
    try {
        body = await c.req.json()
    } catch {
        body = {}
    }

    const proxy = (body.proxy || "").trim()
    if (!proxy) {
        return c.json({ success: false, error: "Proxy URL is required" }, 400)
    }

    try {
        const startTime = Date.now()
        // 测试请求外网 ip 查询 API
        const fetchInit: any = {
            headers: { "User-Agent": "anti-api/1.0" },
            signal: AbortSignal.timeout(10_000),
            proxy,
        }
        const res = await fetch("https://api.ipify.org?format=json", fetchInit)
        const latencyMs = Date.now() - startTime
        if (res.ok) {
            const data = await res.json().catch(() => ({})) as { ip?: string }
            return c.json({
                success: true,
                latencyMs,
                exitIp: data.ip || "unknown",
                message: `Proxy connected successfully (${latencyMs}ms, Exit IP: ${data.ip || "OK"})`
            })
        }
        return c.json({
            success: false,
            error: `Proxy returned HTTP ${res.status} ${res.statusText}`
        }, 400)
    } catch (e: any) {
        return c.json({
            success: false,
            error: e.message || "Failed to connect through proxy"
        }, 400)
    }
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
        "/v1/audio/transcriptions",
        "/v1/audio/translations",
        "/audio/transcriptions",
        "/audio/translations",
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
    app.route("/v1/audio", audioRoutes)
    app.route("/audio", audioRoutes)
    app.route("/v1/messages", messageRoutes)
    app.route("/v1beta/messages", messageRoutes)
    app.route("/messages", messageRoutes)
    app.get("/v1/models", modelsHandler)
    app.get("/v1beta/models", modelsHandler)
    app.get("/models", modelsHandler)

    return app
}

export const publicServer = createPublicServer()
