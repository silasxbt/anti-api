/**
 * Anti-API Port Finder
 * 动态获取language_server的HTTPS端口和CSRF token
 * 
 * 关键发现：
 * - extension_server_port 是内部通信端口
 * - 实际的 HTTPS 端口由 --random_port 参数生成
 * - 需要通过 lsof 匹配 PID 来找到正确的 HTTPS 端口
 */

import { exec } from "node:child_process"
import { promisify } from "node:util"
import consola from "consola"

const execAsync = promisify(exec)

export interface LanguageServerInfo {
    port: number           // HTTPS 端口 (random_port)
    extensionPort: number  // 内部端口 (extension_server_port)
    csrfToken: string
    workspaceId: string
    pid: number
}

/**
 * 从进程列表获取language_server信息，并通过lsof找到HTTPS端口
 */
export async function getLanguageServerInfo(): Promise<LanguageServerInfo | null> {
    try {
        // Step 1: 获取 language_server 进程信息
        const { stdout: psOutput } = await execAsync(
            'ps aux | grep -E "language_server(_macos_arm)?" | grep -v grep | head -1'
        )

        if (!psOutput.trim()) {
            consola.warn("No running language_server process found")
            return null
        }

        // 解析 PID
        const pidMatch = psOutput.match(/^\S+\s+(\d+)/)
        if (!pidMatch) {
            consola.warn("Failed to parse language_server PID")
            return null
        }
        const pid = parseInt(pidMatch[1], 10)

        // 解析启动参数
        const extensionPortMatch = psOutput.match(/--extension_server_port\s+(\d+)/)
        const csrfMatch = psOutput.match(/--csrf_token\s+([a-f0-9-]+)/)
        const workspaceMatch = psOutput.match(/--workspace_id\s+(\S+)/)

        if (!extensionPortMatch || !csrfMatch) {
            consola.warn("Failed to parse language_server arguments")
            return null
        }

        const extensionPort = parseInt(extensionPortMatch[1], 10)
        const csrfToken = csrfMatch[1]
        const workspaceId = workspaceMatch?.[1] || "unknown"

        // Step 2: 通过 lsof 找到同一进程监听的 HTTPS 端口
        // HTTPS 端口会是另一个监听端口，不是 extension_server_port
        const { stdout: lsofOutput } = await execAsync(
            `lsof -nP -iTCP -sTCP:LISTEN -a -p ${pid} 2>/dev/null | grep LISTEN`
        )

        const lines = lsofOutput.trim().split("\n")
        let httpsPort = extensionPort // 默认使用 extension_port

        for (const line of lines) {
            // 格式: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
            // NAME 格式: localhost:50845 或 *:50845
            const portMatch = line.match(/:(\d+)\s+\(LISTEN\)/)
            if (portMatch) {
                const port = parseInt(portMatch[1], 10)
                // 选择不是 extension_server_port 的端口作为 HTTPS 端口
                if (port !== extensionPort) {
                    httpsPort = port
                    break
                }
            }
        }

        const info: LanguageServerInfo = {
            port: httpsPort,
            extensionPort: extensionPort,
            csrfToken: csrfToken,
            workspaceId: workspaceId,
            pid: pid,
        }

        return info

    } catch (error) {
        consola.error("Failed to get language_server info:", error)
        return null
    }
}

/**
 * 查找与指定工作目录匹配的language_server
 */
export async function findLanguageServerForWorkspace(
    workspacePath?: string
): Promise<LanguageServerInfo | null> {
    try {
        const { stdout: psOutput } = await execAsync(
            'ps aux | grep "language_server_macos_arm" | grep -v grep'
        )

        const lines = psOutput.trim().split("\n")

        for (const line of lines) {
            // 解析 PID 和参数
            const pidMatch = line.match(/^\S+\s+(\d+)/)
            const extensionPortMatch = line.match(/--extension_server_port\s+(\d+)/)
            const csrfMatch = line.match(/--csrf_token\s+([a-f0-9-]+)/)
            const workspaceMatch = line.match(/--workspace_id\s+(\S+)/)

            if (!pidMatch || !extensionPortMatch || !csrfMatch) continue

            const pid = parseInt(pidMatch[1], 10)
            const extensionPort = parseInt(extensionPortMatch[1], 10)
            const csrfToken = csrfMatch[1]
            const wsId = workspaceMatch?.[1] || "unknown"

            // 检查工作区匹配
            let isMatch = !workspacePath // 如果没指定工作区，匹配第一个
            if (workspacePath) {
                const normalizedPath = workspacePath.replace(/\//g, "_").replace(/^_/, "file_")
                isMatch = wsId.includes(normalizedPath) ||
                    normalizedPath.includes(wsId.replace("file_", ""))
            }

            if (isMatch) {
                // 找到 HTTPS 端口
                try {
                    const { stdout: lsofOutput } = await execAsync(
                        `lsof -nP -iTCP -sTCP:LISTEN -a -p ${pid} 2>/dev/null | grep LISTEN`
                    )

                    let httpsPort = extensionPort
                    for (const lsofLine of lsofOutput.trim().split("\n")) {
                        const portMatch = lsofLine.match(/:(\d+)\s+\(LISTEN\)/)
                        if (portMatch) {
                            const port = parseInt(portMatch[1], 10)
                            if (port !== extensionPort) {
                                httpsPort = port
                                break
                            }
                        }
                    }

                    return {
                        port: httpsPort,
                        extensionPort: extensionPort,
                        csrfToken: csrfToken,
                        workspaceId: wsId,
                        pid: pid,
                    }
                } catch {
                    // lsof 失败，使用 extension_port
                    return {
                        port: extensionPort,
                        extensionPort: extensionPort,
                        csrfToken: csrfToken,
                        workspaceId: wsId,
                        pid: pid,
                    }
                }
            }
        }

        // 没有匹配的，返回第一个
        return await getLanguageServerInfo()

    } catch (error) {
        consola.error("Failed to find language_server:", error)
        return null
    }
}
