#!/usr/bin/env bun
/**
 * Anti-API 入口
 * 将Antigravity内置大模型暴露为Anthropic兼容API
 */

import { defineCommand, runMain } from "citty"
import consola from "consola"

import { server, publicServer } from "./server"
import { getControlPlaneToken, getPublicGatewayHost, getPublicGatewayPort, getPublicGatewayToken, isContainerControlPlaneEnabled } from "./lib/public-access"
import { isLoopbackAddress } from "./lib/local-request"
import { setupAntigravityToken } from "./lib/token"
import { state } from "./lib/state"
import { initAuth, isAuthenticated, saveAuth, startOAuthLogin } from "./services/antigravity/login"
import { getProjectID } from "./services/antigravity/oauth"
import { accountManager } from "./services/antigravity/account-manager"
import { getSetting } from "./services/settings"
import { logoutIdeSession, getIdeAuthStatus } from "./services/antigravity/ide-switch"
import { openBrowser } from "./lib/open-browser"
import { LOG_LEVELS, resolveLogLevel } from "./lib/log-level"
import { startAntigravityIdeVersionUpdater } from "./lib/antigravity-client"
import { safeErrorMessage } from "./lib/redaction"

function getLocalHost(): string {
    const host = process.env.ANTI_API_HOST?.trim() || "127.0.0.1"
    if (!isLoopbackAddress(host)) {
        if (isContainerControlPlaneEnabled() && host === "0.0.0.0" && getControlPlaneToken()) {
            return host
        }
        if (isContainerControlPlaneEnabled() && host === "0.0.0.0") {
            throw new Error("ANTI_API_CONTROL_TOKEN is required when the container control plane listens on 0.0.0.0")
        }
        throw new Error("ANTI_API_HOST must be a loopback address. Use ANTI_API_PUBLIC_HOST/PORT/TOKEN for LAN or tunnel inference.")
    }
    return host
}

function startPublicGateway(localPort: number): { port: number; stop: () => void } | null {
    const token = getPublicGatewayToken()
    if (!token) return null

    const port = getPublicGatewayPort(localPort)
    const serverInstance = Bun.serve({
        fetch: publicServer.fetch,
        hostname: getPublicGatewayHost(),
        port,
        idleTimeout: 120,
    })
    consola.info(`Public inference gateway: http://${getPublicGatewayHost()}:${port}`)
    return { port, stop: () => serverInstance.stop(true) }
}

const start = defineCommand({
    meta: {
        name: "start",
        description: "启动Anti-API服务器",
    },
    args: {
        port: {
            type: "string",
            default: "8964",
            description: "监听端口",
            alias: "p",
        },
        verbose: {
            type: "boolean",
            default: false,
            description: "详细日志",
            alias: "v",
        },
    },
    async run({ args }) {
        state.port = parseInt(args.port, 10)
        const logLevel = resolveLogLevel(process.env, args.verbose)
        state.verbose = logLevel >= LOG_LEVELS.debug
        consola.level = logLevel
        startAntigravityIdeVersionUpdater()

        // 尝试加载已保存的 OAuth 认证
        initAuth()

        // Reading another application's IDE token is opt-in.
        if (!state.accessToken && process.env.ANTI_API_IMPORT_ANTIGRAVITY_IDE_ON_START === "1") {
            consola.info("OAuth auth not found; importing the local Antigravity IDE token by explicit configuration...")
            try {
                await setupAntigravityToken()
            } catch (error) {
                consola.debug("Failed to read token from IDE:", safeErrorMessage(error))
            }
        }

        // 刷新 Project ID（用于 cloudcode-pa 正确计费/配额）
        if (state.accessToken) {
            try {
                const projectId = await getProjectID(state.accessToken)
                if (projectId && projectId !== state.cloudaicompanionProject) {
                    state.cloudaicompanionProject = projectId
                    saveAuth()
                    consola.success(`Project ID refreshed: ${projectId}`)
                }
            } catch (error) {
                consola.debug("Project ID refresh failed:", safeErrorMessage(error))
            }
        }

        // 打印启动 banner
        const { logStartup, logStartupSuccess } = await import("./lib/logger")
        logStartup(state.port)

        // The complete control plane is loopback-only.
        Bun.serve({
            fetch: server.fetch,
            hostname: getLocalHost(),
            port: state.port,
            idleTimeout: 120,
        })
        startPublicGateway(state.port)

        logStartupSuccess(state.port)

        // 根据设置决定是否自动打开面板
        if (getSetting("autoOpenDashboard")) {
            openBrowser(`http://localhost:${state.port}/quota`)
        }

        // 根据设置决定是否自动启动 ngrok（延迟 3 秒确保服务就绪）
        if (getSetting("autoNgrok")) {
            setTimeout(async () => {
                const { startNgrok } = await import("./services/tunnel-manager")
                try {
                    const result = await startNgrok(state.port)
                    if (result.url) {
                        consola.success(`ngrok tunnel: ${result.url}`)
                    } else if (result.error) {
                        consola.warn(`ngrok: ${safeErrorMessage(result.error)}`)
                    }
                } catch (error) {
                    consola.warn("ngrok startup failed:", safeErrorMessage(error))
                }
            }, 3000)
        }
    },
})

// 添加明确获授权管理的账号
const addAccount = defineCommand({
    meta: {
        name: "add-account",
        description: "添加本人拥有或获授权管理的 Google 账号",
    },
    async run() {
        consola.info("Adding an authorized account...")
        consola.info("Respect provider terms, Retry-After, and per-user or per-organization quota limits.")

        // 加载现有账号
        accountManager.load()
        const existingEmails = accountManager.getEmails()
        if (existingEmails.length > 0) {
            consola.info(`Existing accounts (${existingEmails.length}):`)
            existingEmails.forEach((email, i) => consola.info(`  ${i + 1}. ${email}`))
        }

        // 开始 OAuth 登录
        const result = await startOAuthLogin()
        if (result.success) {
            // 保存到账号管理器
            accountManager.addAccount({
                id: state.userEmail || `account-${Date.now()}`,
                email: state.userEmail || "unknown",
                accessToken: state.accessToken!,
                refreshToken: state.refreshToken!,
                expiresAt: state.tokenExpiresAt || 0,
                projectId: state.cloudaicompanionProject,
            })

            consola.success(`Account added: ${result.email}`)
            consola.info(`Anti-API now manages ${accountManager.count()} authorized account(s)`)
        } else {
            consola.error(`Failed to add account: ${safeErrorMessage(result.error)}`)
        }
    },
})

// 列出账号命令
const listAccounts = defineCommand({
    meta: {
        name: "accounts",
        description: "列出所有已添加的账号",
    },
    run() {
        accountManager.load()
        const emails = accountManager.getEmails()

        if (emails.length === 0) {
            consola.info("No accounts added yet")
            consola.info("Use 'bun run src/main.ts add-account' to add an account")
            return
        }

        consola.info(`Accounts (${emails.length}):`)
        emails.forEach((email, i) => {
            consola.info(`  ${i + 1}. ${email}`)
        })
    },
})

// Remote command: expose only the authenticated inference gateway.
const remote = defineCommand({
    meta: {
        name: "remote",
        description: "启动本地控制面和带认证的公共推理隧道",
    },
    args: {
        port: {
            type: "string",
            default: "8964",
            description: "本地控制面端口",
            alias: "p",
        },
    },
    async run({ args }) {
        if (!getPublicGatewayToken()) {
            consola.error("Set ANTI_API_PUBLIC_TOKEN before starting a public tunnel.")
            process.exitCode = 1
            return
        }

        state.port = parseInt(args.port, 10)
        const logLevel = resolveLogLevel()
        state.verbose = logLevel >= LOG_LEVELS.debug
        consola.level = logLevel
        startAntigravityIdeVersionUpdater()
        initAuth()

        Bun.serve({
            fetch: server.fetch,
            hostname: getLocalHost(),
            port: state.port,
            idleTimeout: 120,
        })
        const publicGateway = startPublicGateway(state.port)
        if (!publicGateway) {
            consola.error("Public inference gateway is not configured.")
            process.exitCode = 1
            return
        }

        consola.success(`Local dashboard: http://localhost:${state.port}/quota`)
        consola.info("Creating a third-party tunnel to the inference-only gateway...")
        const { startNgrok, stopNgrok } = await import("./services/tunnel-manager")
        const result = await startNgrok(state.port)
        if (!result.url) {
            consola.error(safeErrorMessage(result.error || "ngrok failed to start"))
            process.exitCode = 1
            return
        }

        state.publicUrl = result.url
        consola.box({
            title: "Anti-API public inference gateway",
            message: `API URL: ${result.url}/v1/messages\n\nThe dashboard and control-plane routes remain local-only. Clients must send ANTI_API_PUBLIC_TOKEN as a Bearer token or x-api-key.`,
            style: { borderColor: "green" },
        })

        process.on("SIGINT", () => {
            stopNgrok()
            publicGateway.stop()
            process.exit(0)
        })
    },
})

// IDE 登出命令
const logoutIde = defineCommand({
    meta: {
        name: "logout-ide",
        description: "登出 Antigravity IDE 当前账号（关闭 IDE + 清除认证）",
    },
    args: {
        yes: {
            type: "boolean",
            default: false,
            description: "确认关闭 IDE 并删除 state.vscdb 认证键",
            alias: "y",
        },
    },
    async run({ args }) {
        if (!args.yes) {
            consola.error("This action closes Antigravity and removes its authentication keys from state.vscdb. Re-run with --yes to confirm.")
            process.exitCode = 1
            return
        }
        // 显示当前 IDE 登录状态
        const current = getIdeAuthStatus()
        if (current.loggedIn) {
            consola.info(`Current IDE account: ${current.email} (${current.name})`)
        } else {
            consola.info("IDE is not logged in")
        }

        const result = await logoutIdeSession()

        if (!result.success) {
            consola.error(`Logout failed: ${safeErrorMessage(result.error)}`)
            process.exit(1)
        }

        if (result.previousEmail) {
            consola.success(`Logged out: ${result.previousEmail}`)
        } else {
            consola.success("IDE session cleared")
        }

        consola.info("Open Antigravity manually to sign in with a different account.")
    },
})

const main = defineCommand({
    meta: {
        name: "anti-api",
        description: "Antigravity API Proxy - 将Antigravity内置大模型暴露为Anthropic兼容API",
    },
    subCommands: { start, remote, "add-account": addAccount, accounts: listAccounts, "logout-ide": logoutIde },
})

export { main }

export async function runCli(rawArgs?: string[]): Promise<void> {
    await runMain(main, rawArgs ? { rawArgs } : undefined)
}

if (import.meta.main) {
    await runCli()
}
