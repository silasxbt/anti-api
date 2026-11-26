export type BrowserOpenCommand = {
    command: string
    args: string[]
}

export type BrowserSpawn = (
    command: string[],
    options: { stdout: "ignore"; stderr: "ignore" }
) => unknown

export type OpenBrowserOptions = {
    disabledEnv?: string
    env?: Record<string, string | undefined>
    platform?: string
    spawn?: BrowserSpawn
}

export function getBrowserOpenCommand(url: string, platform: string = process.platform): BrowserOpenCommand {
    if (platform === "darwin") {
        return { command: "open", args: [url] }
    }
    if (platform === "win32") {
        return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] }
    }
    return { command: "xdg-open", args: [url] }
}

export function isBrowserOpenDisabled(
    disabledEnv = "ANTI_API_NO_OPEN",
    env: Record<string, string | undefined> = process.env
): boolean {
    return env[disabledEnv] === "1"
}

/**
 * Starts the platform's configured browser without invoking a shell.
 * Failure is intentionally non-fatal for containers and headless hosts.
 */
export function openBrowser(url: string, options: OpenBrowserOptions = {}): boolean {
    const disabledEnv = options.disabledEnv || "ANTI_API_NO_OPEN"
    const env = options.env || process.env
    if (isBrowserOpenDisabled(disabledEnv, env)) {
        return false
    }

    const { command, args } = getBrowserOpenCommand(url, options.platform || process.platform)
    const spawn = options.spawn || ((commandLine, spawnOptions) => Bun.spawn(commandLine, spawnOptions))
    try {
        spawn([command, ...args], { stdout: "ignore", stderr: "ignore" })
        return true
    } catch {
        return false
    }
}
