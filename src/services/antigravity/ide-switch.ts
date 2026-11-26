/**
 * Antigravity IDE 登出服务
 *
 * 功能：
 *   1. 优雅关闭 IDE 进程（SIGTERM → 等待退出，IDE 会在关闭时把内存状态回写到 DB）
 *   2. 清除 state.vscdb 中的认证记录
 *
 * 为什么需要先关闭 IDE：
 *   Antigravity 基于 Electron/VS Code，启动时把 state.vscdb 读入内存。
 *   运行期间在内存中操作，退出时才回写 DB。
 *   如果只清 DB 而不关 IDE，IDE 随后的写回会覆盖我们的删除。
 *
 * 设计原则：
 *   - 仅清理 IDE 会话认证，不影响 anti-api 自身的多账号存储
 *   - 使用 SIGTERM 优雅关闭 IDE（允许正常保存工作区状态）
 *   - macOS / Linux 跨平台兼容
 */

import { Database } from "bun:sqlite"
import { exec } from "node:child_process"
import { promisify } from "node:util"
import { homedir } from "node:os"
import { join } from "node:path"
import { existsSync } from "node:fs"
import consola from "consola"
import { safeErrorMessage } from "~/lib/redaction"

const execAsync = promisify(exec)

// Antigravity IDE 数据库路径
const DB_PATH_MACOS = join(
    homedir(),
    "Library/Application Support/Antigravity/User/globalStorage/state.vscdb"
)
const DB_PATH_LINUX = join(
    homedir(),
    ".config/Antigravity/User/globalStorage/state.vscdb"
)

// IDE 会话认证相关 key
//
// 认证链：
//   antigravityAuthStatus                      — 主认证状态（apiKey, email, name）
//   antigravityUnifiedStateSync.oauthToken     — USS 中的 OAuth token；IDE 启动时从此恢复认证
//   antigravityUnifiedStateSync.userStatus     — USS 中的用户状态 protobuf（含完整身份信息）
//
// 注意：不能删除 antigravityOnboarding，否则会触发完整的新手引导 wizard。
//       只清除以上 3 个 key 即可：扩展启动时会检测到无 token，
//       自动调用 setAuthStatus(null) + initialized=true，
//       标题栏会显示 "Log in" 按钮。
const IDE_AUTH_KEYS = [
    "antigravityAuthStatus",
    "antigravityUnifiedStateSync.oauthToken",
    "antigravityUnifiedStateSync.userStatus",
]

/**
 * 获取当前平台的 IDE 数据库路径
 */
function getIdeDbPath(): string {
    if (process.platform === "darwin") {
        return DB_PATH_MACOS
    }
    return DB_PATH_LINUX
}

export interface IdeAuthInfo {
    loggedIn: boolean
    email: string | null
    name: string | null
}

/**
 * 读取 IDE 当前登录状态（只读）
 */
export function getIdeAuthStatus(): IdeAuthInfo {
    const dbPath = getIdeDbPath()
    if (!existsSync(dbPath)) {
        return { loggedIn: false, email: null, name: null }
    }

    try {
        const db = new Database(dbPath, { readonly: true })
        const row = db.query(
            "SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus'"
        ).get() as { value: string } | null
        db.close()

        if (!row) {
            return { loggedIn: false, email: null, name: null }
        }

        const data = JSON.parse(row.value) as {
            apiKey?: string
            email?: string
            name?: string
        }

        if (!data.apiKey) {
            return { loggedIn: false, email: null, name: null }
        }

        return {
            loggedIn: true,
            email: data.email || null,
            name: data.name || null,
        }
    } catch (error) {
        consola.debug("Failed to read IDE auth status:", safeErrorMessage(error))
        return { loggedIn: false, email: null, name: null }
    }
}

/**
 * 检测 Antigravity IDE 进程是否在运行
 */
async function isIdeRunning(): Promise<boolean> {
    try {
        if (process.platform === "darwin") {
            const { stdout } = await execAsync('pgrep -f "Antigravity" 2>/dev/null || true')
            return stdout.trim().length > 0
        } else {
            const { stdout } = await execAsync('pgrep -f "antigravity" 2>/dev/null || true')
            return stdout.trim().length > 0
        }
    } catch {
        return false
    }
}

/**
 * 优雅关闭 Antigravity IDE 进程
 *
 * 发送 SIGTERM 让 IDE 正常退出（保存工作区 + 回写 DB），
 * 然后等待进程结束。
 *
 * @returns 是否成功关闭（IDE 没在运行也返回 true）
 */
async function gracefullyCloseIde(): Promise<{ closed: boolean; wasRunning: boolean; error?: string }> {
    const running = await isIdeRunning()
    if (!running) {
        return { closed: true, wasRunning: false }
    }

    try {
        // macOS: Antigravity.app 可以用 osascript 更优雅地关闭
        if (process.platform === "darwin") {
            await execAsync('osascript -e \'quit app "Antigravity"\' 2>/dev/null || true')
        } else {
            await execAsync('pkill -TERM -f "antigravity" 2>/dev/null || true')
        }

        // 等待进程退出（最多 15 秒）
        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 500))
            if (!(await isIdeRunning())) {
                // 进程已退出，再等 1 秒让 DB 文件刷新完毕
                await new Promise(r => setTimeout(r, 1000))
                return { closed: true, wasRunning: true }
            }
        }

        // 超时：进程未退出
        return {
            closed: false,
            wasRunning: true,
            error: "Antigravity IDE did not exit within 15 seconds. Try closing it manually.",
        }
    } catch (error) {
        return {
            closed: false,
            wasRunning: true,
            error: `Failed to close IDE: ${(error as Error).message}`,
        }
    }
}

export interface IdeLogoutResult {
    success: boolean
    previousEmail: string | null
    ideWasRunning: boolean
    error?: string
}

/**
 * 登出 IDE 会话
 *
 * 完整流程：关闭 IDE → 等待退出 → 清除 DB
 */
export async function logoutIdeSession(): Promise<IdeLogoutResult> {
    const dbPath = getIdeDbPath()

    if (!existsSync(dbPath)) {
        return {
            success: false,
            previousEmail: null,
            ideWasRunning: false,
            error: "Antigravity IDE database not found. Is Antigravity installed?",
        }
    }

    // 先读取当前登录的邮箱（在关闭 IDE 之前）
    const currentAuth = getIdeAuthStatus()

    // Step 1: 优雅关闭 IDE（让它把内存状态写回 DB）
    const closeResult = await gracefullyCloseIde()

    if (!closeResult.closed) {
        return {
            success: false,
            previousEmail: currentAuth.email,
            ideWasRunning: closeResult.wasRunning,
            error: closeResult.error,
        }
    }

    // Step 2: 清除 DB 中的认证记录
    try {
        const db = new Database(dbPath)

        for (const key of IDE_AUTH_KEYS) {
            db.run("DELETE FROM ItemTable WHERE key = ?", [key])
        }

        db.close()

        consola.success(
            currentAuth.email
                ? `IDE session logged out: ${currentAuth.email}`
                : "IDE session cleared"
        )

        return {
            success: true,
            previousEmail: currentAuth.email,
            ideWasRunning: closeResult.wasRunning,
        }
    } catch (error) {
        const msg = (error as Error).message
        return {
            success: false,
            previousEmail: currentAuth.email,
            ideWasRunning: closeResult.wasRunning,
            error: `Failed to clear IDE auth: ${msg}`,
        }
    }
}

