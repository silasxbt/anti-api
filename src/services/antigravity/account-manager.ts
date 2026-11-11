/**
 * 多账号管理器
 * 支持多个 Google 账号，当一个账号配额耗尽时自动切换
 */

import { state } from "~/lib/state"
import { refreshAccessToken, getProjectID } from "./oauth"
import { generateMockProjectId } from "./project-id"
import * as fs from "fs"
import * as path from "path"
import consola from "consola"
import { authStore } from "~/services/auth/store"
import { parseRetryDelay } from "~/lib/retry"
import { MIN_REQUEST_INTERVAL_MS } from "~/lib/constants"
import { getDataDir } from "~/lib/data-dir"
import { tightenPrivateFile, writePrivateFile } from "~/lib/private-file"
import { safeErrorMessage } from "~/lib/redaction"
import { isCacheAwareRoutingEnabled } from "~/services/settings"
import { computeEffectiveTokenLoad } from "~/services/usage-tracker"
import {
    rankAccountCandidates,
    recordIntelligentDispatch,
    recordIntelligentTokenUsage,
} from "~/services/routing/intelligent-scorer"

type RateLimitReason =
    | "quota_exhausted"
    | "rate_limit_exceeded"
    | "model_capacity_exhausted"
    | "server_error"
    | "unknown"

function parseRateLimitReason(statusCode: number, errorText: string): RateLimitReason {
    if (statusCode !== 429) {
        if (statusCode >= 500) {
            return "server_error"
        }
        return "unknown"
    }

    const trimmed = errorText.trim()

    // 🆕 首先尝试解析 JSON 以获取精确的 reason
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
            const json = JSON.parse(trimmed)
            const details = json?.error?.details

            // 检查 details 中是否有明确的 reason
            if (Array.isArray(details)) {
                for (const detail of details) {
                    const reason = detail?.reason
                    if (typeof reason === "string") {
                        if (reason === "QUOTA_EXHAUSTED") return "quota_exhausted"
                        if (reason === "RATE_LIMIT_EXCEEDED") return "rate_limit_exceeded"
                        if (reason === "MODEL_CAPACITY_EXHAUSTED") return "model_capacity_exhausted"
                    }
                }
            }

            // 检查 message 中的关键词
            const message = json?.error?.message
            if (typeof message === "string") {
                const msgLower = message.toLowerCase()
                // 🆕 proj-1 风格：优先检查 rate limit 关键词
                if (msgLower.includes("per minute") || msgLower.includes("rate limit") || msgLower.includes("too many requests")) {
                    return "rate_limit_exceeded"
                }
            }

            // 🆕 RESOURCE_EXHAUSTED 状态但没有明确的 QUOTA_EXHAUSTED detail
            // 默认假设是速率限制而非配额耗尽
            const status = json?.error?.status
            if (status === "RESOURCE_EXHAUSTED") {
                return "rate_limit_exceeded"
            }
        } catch {
            // ignore JSON parse errors
        }
    }

    const lower = errorText.toLowerCase()
    // 🆕 proj-1 风格：优先检查 rate limit 关键词
    if (lower.includes("per minute") || lower.includes("rate limit") || lower.includes("too many requests")) {
        return "rate_limit_exceeded"
    }
    if (lower.includes("model_capacity") || lower.includes("capacity")) {
        return "model_capacity_exhausted"
    }
    // 只有明确包含 "quota" 关键词时才认为是配额耗尽
    if (lower.includes("quota")) {
        return "quota_exhausted"
    }
    // 🆕 "exhausted" without "quota" = assume rate limit (short-lived)
    if (lower.includes("exhausted")) {
        return "rate_limit_exceeded"
    }
    return "unknown"
}

function defaultRateLimitMs(reason: RateLimitReason, failures: number): number {
    switch (reason) {
        case "quota_exhausted": {
            // [智能限流] 根据连续失败次数动态调整锁定时间
            // 第1次: 60s, 第2次: 5min, 第3次: 30min, 第4次+: 2h
            if (failures <= 1) {
                consola.warn("Detected quota exhausted (QUOTA_EXHAUSTED), 1st failure, lock for 60s")
                return 60_000
            }
            if (failures === 2) {
                consola.warn("Detected quota exhausted (QUOTA_EXHAUSTED), 2nd consecutive failure, lock for 5 minutes")
                return 5 * 60_000
            }
            if (failures === 3) {
                consola.warn("Detected quota exhausted (QUOTA_EXHAUSTED), 3rd consecutive failure, lock for 30 minutes")
                return 30 * 60_000
            }
            consola.warn(`Detected quota exhausted (QUOTA_EXHAUSTED), ${failures} consecutive failures, lock for 2 hours`)
            return 2 * 60 * 60_000
        }
        case "rate_limit_exceeded":
            // 速率限制：通常是短暂的，使用较短的默认值（30秒）
            return 30_000
        case "model_capacity_exhausted":
            // 模型容量耗尽：服务端暂时无可用 GPU 实例
            // 这是临时性问题，使用较短的重试时间（15秒）
            consola.warn("Detected model capacity exhausted (MODEL_CAPACITY_EXHAUSTED), retrying in 15s")
            return 15_000
        case "server_error":
            // 服务器错误：执行"软避让"，默认锁定 20 秒
            consola.warn("Detected 5xx error, backing off for 20s...")
            return 20_000
        default:
            // 未知原因：使用中等默认值（60秒）
            return 60_000
    }
}

const RESET_TIME_BUFFER_MS = 2000
const DEFAULT_ACCOUNT_LOCK_WAIT_TIMEOUT_MS = 45_000

function getAccountLockWaitTimeoutMs(): number {
    const raw = Number(process.env.ANTI_API_ACCOUNT_LOCK_WAIT_TIMEOUT_MS || DEFAULT_ACCOUNT_LOCK_WAIT_TIMEOUT_MS)
    if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_ACCOUNT_LOCK_WAIT_TIMEOUT_MS
    return Math.floor(raw)
}

export interface Account {
    id: string
    email: string
    accessToken: string
    refreshToken: string
    expiresAt: number
    projectId: string | null
    proxy?: string
    label?: string
    plan?: string
    // 限流状态
    rateLimitedUntil: number | null
    consecutiveFailures: number
}

export interface ActiveAccountCredentials {
    accessToken: string
    projectId: string
    email: string
    accountId: string
    proxy?: string
}

class AccountManager {
    private accounts: Map<string, Account> = new Map()
    private dataFile: string
    private loaded = false
    // 🆕 60秒账号锁定：记录最近使用的账号（匹配 proj-1 的 last_used_account）
    private lastUsedAccount: { accountId: string; timestamp: number } | null = null
    // 🆕 粘性账户队列：失败的账户移到队尾，避免反复 429
    private accountQueue: string[] = []
    // 🆕 账号并发控制（同一账号同一时刻只处理一个请求）
    private inFlightAccounts = new Set<string>()
    private inFlightStartedAt = new Map<string, number>()
    private accountLocks = new Map<string, Promise<void>>()
    private lastCallByAccount = new Map<string, number>()
    // 🆕 Cache-Aware Session Routing
    private sessionAccountMap = new Map<string, { accountId: string; lastSeen: number }>()
    private accountEstimatedTokens = new Map<string, number>()

    constructor() {
        this.dataFile = path.join(getDataDir(), "accounts.json")
    }

    private ensureLoaded(): void {
        if (!this.loaded) {
            this.load()
        }
    }

    private syncAccountToAuthStore(account: Account): void {
        authStore.saveAccount({
            id: account.id,
            provider: "antigravity",
            email: account.email,
            accessToken: account.accessToken,
            refreshToken: account.refreshToken,
            expiresAt: account.expiresAt,
            projectId: account.projectId || undefined,
            proxy: account.proxy || undefined,
            label: account.label || account.email,
            plan: account.plan,
        })
    }

    private hydrateFromAuthStore(accountId?: string): void {
        const fromStore = accountId
            ? [authStore.getAccount("antigravity", accountId)].filter(Boolean)
            : authStore.listAccounts("antigravity")

        for (const stored of fromStore) {
            if (!stored || this.accounts.has(stored.id)) continue
            this.accounts.set(stored.id, {
                id: stored.id,
                email: stored.email || stored.login || stored.id,
                accessToken: stored.accessToken,
                refreshToken: stored.refreshToken || "",
                expiresAt: stored.expiresAt || 0,
                projectId: stored.projectId || null,
                proxy: stored.proxy || undefined,
                label: stored.label || undefined,
                plan: stored.plan,
                rateLimitedUntil: null,
                consecutiveFailures: 0,
            })
        }
    }

    /**
     * 加载账号列表
     */
    load(): void {
        try {
            if (fs.existsSync(this.dataFile)) {
                tightenPrivateFile(this.dataFile)
                const data = JSON.parse(fs.readFileSync(this.dataFile, "utf-8"))
                if (Array.isArray(data.accounts)) {
                    for (const acc of data.accounts) {
                        const account: Account = {
                            ...acc,
                            proxy: acc.proxy || undefined,
                            label: acc.label || undefined,
                            rateLimitedUntil: null,
                            consecutiveFailures: 0,
                        }
                        this.accounts.set(acc.id, account)
                        this.syncAccountToAuthStore(account)
                    }
                }
            }
        } catch (e) {
            consola.warn("Failed to load accounts:", safeErrorMessage(e))
        }

        if (this.accounts.size === 0) {
            this.hydrateFromAuthStore()
        }

        // 如果没有已保存的账号，从 state 迁移当前账号
        if (this.accounts.size === 0 && state.accessToken && state.refreshToken) {
            const id = state.userEmail || "default"
            this.accounts.set(id, {
                id,
                email: state.userEmail || "unknown",
                accessToken: state.accessToken,
                refreshToken: state.refreshToken,
                expiresAt: state.tokenExpiresAt || 0,
                projectId: state.cloudaicompanionProject,
                rateLimitedUntil: null,
                consecutiveFailures: 0,
            })
        }

        // 🆕 确保干净启动：清除上次使用的账号记录
        this.lastUsedAccount = null

        this.loaded = true
    }

    /**
     * 保存账号列表
     */
    save(): void {
        try {
            const accounts = Array.from(this.accounts.values()).map(acc => ({
                id: acc.id,
                email: acc.email,
                accessToken: acc.accessToken,
                refreshToken: acc.refreshToken,
                expiresAt: acc.expiresAt,
                projectId: acc.projectId,
                proxy: acc.proxy,
                label: acc.label,
                plan: acc.plan,
            }))
            writePrivateFile(this.dataFile, JSON.stringify({ accounts }, null, 2))
        } catch (e) {
            consola.warn("Failed to save accounts:", safeErrorMessage(e))
        }
    }

    /**
     * 添加账号
     */
    addAccount(account: Omit<Account, "rateLimitedUntil" | "consecutiveFailures">): void {
        const stored: Account = {
            ...account,
            rateLimitedUntil: null,
            consecutiveFailures: 0,
        }
        this.accounts.set(account.id, stored)
        // 🆕 添加到队列末尾
        if (!this.accountQueue.includes(account.id)) {
            this.accountQueue.push(account.id)
        }
        this.save()
        this.syncAccountToAuthStore(stored)
    }

    private deleteAccountById(id: string): boolean {
        if (!this.accounts.has(id)) return false
        this.accounts.delete(id)
        const idx = this.accountQueue.indexOf(id)
        if (idx !== -1) this.accountQueue.splice(idx, 1)
        this.inFlightAccounts.delete(id)
        this.inFlightStartedAt.delete(id)
        this.accountLocks.delete(id)
        this.lastCallByAccount.delete(id)
        this.save()
        authStore.deleteAccount("antigravity", id)
        return true
    }

    /**
     * 删除账号
     */
    removeAccount(accountIdOrEmail: string): boolean {
        if (this.deleteAccountById(accountIdOrEmail)) {
            return true
        }

        for (const [id, acc] of this.accounts) {
            if (acc.email === accountIdOrEmail) {
                return this.deleteAccountById(id)
            }
        }

        consola.warn(`Account not found: ${accountIdOrEmail}`)
        return false
    }

    /**
     * 获取账号数量
     */
    count(): number {
        return this.accounts.size
    }

    /**
     * 🆕 检查账号是否存在
     */
    hasAccount(accountId: string): boolean {
        this.ensureLoaded()
        return this.accounts.has(accountId)
    }

    /**
     * 获取账号详情
     */
    getAccount(accountId: string): Account | undefined {
        this.ensureLoaded()
        return this.accounts.get(accountId)
    }

    /**
     * 获取所有账号列表
     */
    getAllAccounts(): Account[] {
        this.ensureLoaded()
        return Array.from(this.accounts.values())
    }

    /**
     * 更新账号选项（egress proxy, label, projectId）
     */
    updateAccountOptions(
        accountId: string,
        options: { proxy?: string; label?: string; projectId?: string; plan?: string }
    ): boolean {
        this.ensureLoaded()
        const account = this.accounts.get(accountId)
        if (!account) return false
        if (options.proxy !== undefined) account.proxy = options.proxy.trim() || undefined
        if (options.label !== undefined) account.label = options.label.trim() || undefined
        if (options.projectId !== undefined) account.projectId = options.projectId.trim() || null
        if (options.plan !== undefined) account.plan = options.plan.trim().toLowerCase() || undefined
        this.save()
        this.syncAccountToAuthStore(account)
        return true
    }

    /**
     * 🆕 账号是否正在处理请求
     */
    isAccountInFlight(accountId: string): boolean {
        return this.inFlightAccounts.has(accountId)
    }

    /**
     * 🆕 获取账号锁，确保同一账号串行处理
     */
    async acquireAccountLock(accountId: string): Promise<() => void> {
        this.ensureLoaded()
        const previous = this.accountLocks.get(accountId) || Promise.resolve()
        let resolveNext: () => void

        const next = new Promise<void>(resolve => {
            resolveNext = resolve
        })

        const tail = previous.then(() => next)
        this.accountLocks.set(accountId, tail)

        let waitTimedOut = false
        const waitTimeoutMs = getAccountLockWaitTimeoutMs()
        let timeoutId: ReturnType<typeof setTimeout> | null = null
        try {
            await Promise.race([
                previous,
                new Promise<void>(resolve => {
                    timeoutId = setTimeout(() => {
                        waitTimedOut = true
                        resolve()
                    }, waitTimeoutMs)
                }),
            ])
        } finally {
            if (timeoutId) clearTimeout(timeoutId)
        }

        if (waitTimedOut) {
            const startedAt = this.inFlightStartedAt.get(accountId)
            const holdMs = startedAt ? Date.now() - startedAt : null
            consola.warn(
                `[AccountLock] Wait timeout for ${accountId}; force-recovering stale lock${holdMs !== null ? ` (held ${Math.ceil(holdMs / 1000)}s)` : ""}`
            )
            this.inFlightAccounts.delete(accountId)
            this.inFlightStartedAt.delete(accountId)
            this.accountLocks.delete(accountId)
        }

        const lastCall = this.lastCallByAccount.get(accountId) || 0
        const elapsed = Date.now() - lastCall
        if (elapsed < MIN_REQUEST_INTERVAL_MS) {
            await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - elapsed))
        }
        this.lastCallByAccount.set(accountId, Date.now())

        this.inFlightAccounts.add(accountId)
        this.inFlightStartedAt.set(accountId, Date.now())

        let released = false
        return () => {
            if (released) return
            released = true
            this.inFlightAccounts.delete(accountId)
            this.inFlightStartedAt.delete(accountId)
            resolveNext!()
            if (this.accountLocks.get(accountId) === tail) {
                this.accountLocks.delete(accountId)
            }
        }
    }

    /**
     * 记录账号的 Token 消耗估算（用于负载均衡与 Intelligent/Cache-Aware 路由）
     */
    recordAccountUsage(
        accountId: string,
        uncachedInputOrTotalTokens: number,
        outputTokens?: number,
        cacheReadTokens: number = 0,
        modelName?: string
    ): void {
        if (!accountId) return
        if (typeof outputTokens === "number") {
            const effective = computeEffectiveTokenLoad(
                uncachedInputOrTotalTokens,
                outputTokens,
                cacheReadTokens,
                modelName
            )
            if (effective <= 0) return
            const current = this.accountEstimatedTokens.get(accountId) || 0
            this.accountEstimatedTokens.set(accountId, current + Math.round(effective))
            recordIntelligentTokenUsage("antigravity", accountId, {
                uncachedInputTokens: uncachedInputOrTotalTokens,
                outputTokens,
                cacheReadTokens,
                model: modelName,
            })
            return
        }
        if (!uncachedInputOrTotalTokens || uncachedInputOrTotalTokens <= 0) return
        const current = this.accountEstimatedTokens.get(accountId) || 0
        this.accountEstimatedTokens.set(accountId, current + uncachedInputOrTotalTokens)
        recordIntelligentTokenUsage("antigravity", accountId, uncachedInputOrTotalTokens)
    }

    /**
     * 获取账号的累计 Token 消耗估算
     */
    getAccountUsage(accountId: string): number {
        return this.accountEstimatedTokens.get(accountId) || 0
    }

    /**
     * 获取所有账号邮箱
     */
    getEmails(): string[] {
        return Array.from(this.accounts.values()).map(a => a.email)
    }

    /**
     * 标记账号为限流状态
     */
    markRateLimited(accountId: string, durationMs: number = 60000): void {
        const account = this.accounts.get(accountId)
        if (account) {
            account.rateLimitedUntil = Date.now() + durationMs
            account.consecutiveFailures++
            consola.warn(`Account ${account.email} rate limited for ${durationMs / 1000}s (failures: ${account.consecutiveFailures})`)
        }
    }

    /**
     * 根据错误信息标记账号限流
     */
    async markRateLimitedFromError(
        accountId: string,
        statusCode: number,
        errorText: string,
        retryAfterHeader?: string,
        _modelId?: string,
        options?: { maxDurationMs?: number }
    ): Promise<{ reason: RateLimitReason; durationMs: number } | null> {
        const account = this.accounts.get(accountId)
        if (!account) return null

        const reason = parseRateLimitReason(statusCode, errorText)
        const retryDelayMs = parseRetryDelay(errorText, retryAfterHeader)
        account.consecutiveFailures++

        let durationMs = 0
        let rateLimitedUntil: number | null = null

        // 🆕 proj-1 风格：不在每次 429 时检查配额（避免额外 API 调用消耗速率限制）
        // 如果没有明确的 retry delay，直接假设是速率限制并应用短暂退避
        if (retryDelayMs !== null) {
            durationMs = Math.max(retryDelayMs + 500, 2000)
            rateLimitedUntil = Date.now() + durationMs
        } else if (statusCode === 429) {
            durationMs = 10000 // 10 秒短暂退避（增加以避免快速重试）
            rateLimitedUntil = Date.now() + durationMs
        }

        if (!rateLimitedUntil) {
            durationMs = defaultRateLimitMs(reason, account.consecutiveFailures)
            rateLimitedUntil = Date.now() + durationMs
        }

        const maxDurationMs = options?.maxDurationMs
        if (maxDurationMs && reason !== "quota_exhausted" && durationMs > maxDurationMs) {
            durationMs = maxDurationMs
            rateLimitedUntil = Date.now() + durationMs
        }

        account.rateLimitedUntil = rateLimitedUntil
        consola.warn(
            `Account ${account.email} rate limited (${reason}) for ${Math.ceil(durationMs / 1000)}s (failures: ${account.consecutiveFailures})`
        )
        return { reason, durationMs }
    }

    /**
     * 标记账号成功
     */
    markSuccess(accountId: string): void {
        const account = this.accounts.get(accountId)
        if (account) {
            account.rateLimitedUntil = null
            account.consecutiveFailures = 0
        }
    }

    /**
     * 检查账号是否被限流
     */
    isAccountRateLimited(accountId: string): boolean {
        const account = this.accounts.get(accountId)
        if (!account) return false
        return account.rateLimitedUntil !== null && account.rateLimitedUntil > Date.now()
    }

    /**
     * 🆕 将失败的账户移到队尾（粘性账户策略）
     * 这样下次会优先使用队首的账户
     */
    moveToEndOfQueue(accountId: string): void {
        const index = this.accountQueue.indexOf(accountId)
        if (index !== -1) {
            this.accountQueue.splice(index, 1)
            this.accountQueue.push(accountId)
        }
    }

    /**
     * 🆕 确保账户队列已初始化
     */
    private ensureQueueInitialized(): void {
        if (this.accountQueue.length === 0 && this.accounts.size > 0) {
            this.accountQueue = Array.from(this.accounts.keys())
        }
    }

    /**
     * 🆕 乐观重置：清除所有账户的限流状态
     * 用于当所有账户都被限流但等待时间很短时，解决时序竞争条件
     */
    clearAllRateLimits(): void {
        let count = 0
        for (const account of this.accounts.values()) {
            if (account.rateLimitedUntil !== null) {
                account.rateLimitedUntil = null
                account.consecutiveFailures = 0
                count++
            }
        }
        if (count > 0) {
            consola.warn(`🔄 Optimistic reset: Cleared rate limits for ${count} account(s)`)
        }
    }

    /**
     * 🆕 获取所有账户中最短的限流等待时间（毫秒）
     * 返回 null 表示没有账户被限流
     */
    getMinRateLimitWait(): number | null {
        const now = Date.now()
        let minWait: number | null = null

        for (const account of this.accounts.values()) {
            if (account.rateLimitedUntil !== null && account.rateLimitedUntil > now) {
                const wait = account.rateLimitedUntil - now
                if (minWait === null || wait < minWait) {
                    minWait = wait
                }
            }
        }

        return minWait
    }

    private async prepareAccountCredentials(
        account: Account,
        options: { failOnRefreshError?: boolean; sessionKey?: string; modelName?: string; recordIntelligent?: boolean } = {}
    ): Promise<ActiveAccountCredentials | null> {
        const now = Date.now()
        if (account.expiresAt > 0 && now > account.expiresAt - 5 * 60 * 1000) {
            try {
                const tokens = await refreshAccessToken(account.refreshToken, account.proxy)
                account.accessToken = tokens.accessToken
                account.expiresAt = now + tokens.expiresIn * 1000
                if (!account.projectId) {
                    account.projectId = await getProjectID(account.accessToken, account.proxy)
                }
                this.save()
                this.syncAccountToAuthStore(account)
            } catch (e) {
                consola.warn(`Failed to refresh token for ${account.email}:`, safeErrorMessage(e))
                if (options.failOnRefreshError) {
                    account.rateLimitedUntil = now + 60000
                    return null
                }
            }
        }

        this.lastUsedAccount = { accountId: account.id, timestamp: Date.now() }
        if (options.sessionKey) {
            this.sessionAccountMap.set(options.sessionKey, { accountId: account.id, lastSeen: now })
        }
        if (options.recordIntelligent) {
            recordIntelligentDispatch("antigravity", account.id, options.sessionKey, options.modelName, now)
        }

        return {
            accessToken: account.accessToken,
            projectId: await this.ensureProjectId(account),
            email: account.email,
            accountId: account.id,
            proxy: account.proxy,
        }
    }

    /**
     * 获取下一个可用账号
     * 🆕 粘性策略：使用队列顺序，队首优先
     * 🆕 Intelligent (Cache + Quota + Reset-Time Aware) 路由：
     *    结合剩余配额、重置倒计时紧迫度（指数+线性混合公式）、Prompt 缓存亲和性与实时负载均衡选择最优账号
     */
    async getNextAvailableAccount(
        forceRotate: boolean = false,
        sessionKey?: string,
        isAccountEligible?: (accountId: string) => boolean,
        modelName?: string,
        messages?: unknown
    ): Promise<ActiveAccountCredentials | null> {
        this.ensureLoaded()
        if (this.accounts.size === 0) {
            this.hydrateFromAuthStore()
        }
        this.ensureQueueInitialized()

        const now = Date.now()
        if (this.accounts.size === 0) {
            return null
        }

        const isEligible = (id: string) => !isAccountEligible || isAccountEligible(id)

        // 🆕 Intelligent (Cache & Reset-Time Aware) 路由逻辑
        if (isCacheAwareRoutingEnabled()) {
            for (const [key, sess] of this.sessionAccountMap.entries()) {
                if (now - sess.lastSeen > 2 * 3600 * 1000) {
                    this.sessionAccountMap.delete(key)
                }
            }

            const availableCandidates = this.accountQueue
                .filter((id) => {
                    if (!isEligible(id)) return false
                    const account = this.accounts.get(id)
                    if (!account) return false
                    if (account.rateLimitedUntil && account.rateLimitedUntil > now) return false
                    return true
                })
                .map((accountId) => ({ provider: "antigravity" as const, accountId }))

            if (availableCandidates.length > 0) {
                const ranked = rankAccountCandidates(availableCandidates, {
                    model: modelName,
                    sessionKey,
                    forceRotate,
                    isInFlight: (id) => this.inFlightAccounts.has(id),
                    getConsecutiveFailures: (id) => this.accounts.get(id)?.consecutiveFailures || 0,
                    getTotalTokens: (id) => this.getAccountUsage(id),
                    messages,
                    now,
                })

                for (const item of ranked) {
                    const account = this.accounts.get(item.entry.accountId)
                    if (!account) continue
                    const prepared = await this.prepareAccountCredentials(account, {
                        failOnRefreshError: true,
                        sessionKey,
                        modelName,
                        recordIntelligent: true,
                    })
                    if (prepared) {
                        return prepared
                    }
                }
            }
        }

        // 🆕 是否存在空闲账号（避免选中正在处理的账号）
        const hasIdleAccount = this.accountQueue.some((id) => {
            if (!isEligible(id)) return false
            const account = this.accounts.get(id)
            if (!account) return false
            if (account.rateLimitedUntil && account.rateLimitedUntil > now) return false
            return !this.inFlightAccounts.has(id)
        })

        // 🆕 粘性策略：使用队列顺序，队首账户优先（未开启 Cache-Aware 或无 sessionKey 时的默认逻辑）
        if (!forceRotate && !isCacheAwareRoutingEnabled() && this.accountQueue.length > 0) {
            const firstId = this.accountQueue[0]
            const firstAccount = this.accounts.get(firstId)
            if (
                firstAccount &&
                isEligible(firstId) &&
                (!firstAccount.rateLimitedUntil || firstAccount.rateLimitedUntil <= now) &&
                !(hasIdleAccount && this.inFlightAccounts.has(firstId))
            ) {
                return this.prepareAccountCredentials(firstAccount)
            }
        }

        // 按队列顺序找第一个可用账户
        for (const accountId of this.accountQueue) {
            if (!isEligible(accountId)) continue
            const account = this.accounts.get(accountId)
            if (!account) continue

            if (account.rateLimitedUntil && account.rateLimitedUntil > now) {
                continue
            }
            if (hasIdleAccount && this.inFlightAccounts.has(accountId)) {
                continue
            }

            const prepared = await this.prepareAccountCredentials(account, { failOnRefreshError: true, sessionKey })
            if (prepared) {
                return prepared
            }
        }

        // 所有账号都被限流 - 找等待时间最短的
        const allAccounts = Array.from(this.accounts.values()).filter(acc => isEligible(acc.id))
        if (allAccounts.length === 0) {
            return null
        }

        let minWaitMs: number | null = null
        for (const acc of allAccounts) {
            if (!acc.rateLimitedUntil) {
                minWaitMs = 0
                break
            }
            const waitMs = Math.max(acc.rateLimitedUntil - now, 0)
            if (minWaitMs === null || waitMs < minWaitMs) {
                minWaitMs = waitMs
            }
        }

        if (minWaitMs !== null && minWaitMs <= 2000) {
            consola.warn(`All authorized accounts are rate limited; waiting ${Math.ceil(minWaitMs / 1000)}s before retry eligibility.`)
            await new Promise(resolve => setTimeout(resolve, minWaitMs + RESET_TIME_BUFFER_MS))
            const refreshed = allAccounts.find(acc => !acc.rateLimitedUntil || acc.rateLimitedUntil <= Date.now())
            if (refreshed) {
                return this.prepareAccountCredentials(refreshed, { sessionKey })
            }
        }

        consola.warn(`All accounts rate limited, min wait ${Math.ceil((minWaitMs || 0) / 1000)}s`)
        return null
    }

    /**
     * 按 ID 获取指定账号（并刷新 token）
     */
    async getAccountById(accountId: string): Promise<ActiveAccountCredentials | null> {
        this.ensureLoaded()
        if (!this.accounts.has(accountId)) {
            this.hydrateFromAuthStore(accountId)
        }
        const account = this.accounts.get(accountId)
        if (!account) return null

        const now = Date.now()
        if (account.rateLimitedUntil && account.rateLimitedUntil > now) {
            return null
        }

        return this.prepareAccountCredentials(account, { failOnRefreshError: true })
    }

    /**
     * Force refresh projectId for a specific account.
     * Useful when upstream returns NOT_FOUND for a stale project resource.
     */
    async refreshProjectId(accountId: string, accessTokenOverride?: string): Promise<string | null> {
        this.ensureLoaded()
        if (!this.accounts.has(accountId)) {
            this.hydrateFromAuthStore(accountId)
        }
        const account = this.accounts.get(accountId)
        if (!account) return null

        if (accessTokenOverride && accessTokenOverride.trim()) {
            account.accessToken = accessTokenOverride
        }

        let resolved = await getProjectID(account.accessToken)
        if (!resolved) {
            resolved = generateMockProjectId()
        }

        account.projectId = resolved
        this.save()
        this.syncAccountToAuthStore(account)
        return resolved
    }

    private async ensureProjectId(account: Account): Promise<string> {
        if (account.projectId && account.projectId !== "unknown") {
            return account.projectId
        }

        let resolved = await getProjectID(account.accessToken, account.proxy)
        if (!resolved) {
            resolved = generateMockProjectId()
            consola.warn(`Account ${account.email} missing project_id, using fallback ${resolved}`)
        }

        account.projectId = resolved
        this.save()
        this.syncAccountToAuthStore(account)
        return resolved
    }
}

// 全局单例
export const accountManager = new AccountManager()
