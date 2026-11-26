import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { state } from "~/lib/state"

type UpdateSource = "git" | "package-manager" | "packaged" | "unknown"
type UpdateStatus = "available" | "current" | "blocked" | "unknown"

export interface UpdateCheckResult {
    currentVersion: string
    latestVersion?: string
    currentCommit?: string
    remoteCommit?: string
    branch?: string
    source: UpdateSource
    status: UpdateStatus
    updateAvailable: boolean
    canApply: boolean
    message: string
    commandHint?: string
}

export interface UpdateApplyResult extends UpdateCheckResult {
    output: string
    restartScheduled: boolean
}

const REPO = "silasxbt/anti-api"
const COMMAND_TIMEOUT_MS = 45_000
const MAX_OUTPUT_LENGTH = 4000

function repoRoot(): string {
    return process.cwd()
}

function readCurrentVersion(): string {
    try {
        const data = JSON.parse(readFileSync(join(repoRoot(), "package.json"), "utf-8")) as { version?: string }
        return data.version || "0.0.0"
    } catch {
        return "0.0.0"
    }
}

function stripVersion(value?: string): string | undefined {
    return value?.trim().replace(/^v/i, "")
}

function compareVersions(a?: string, b?: string): number {
    const left = stripVersion(a)?.split(".").map(part => Number.parseInt(part, 10) || 0) || []
    const right = stripVersion(b)?.split(".").map(part => Number.parseInt(part, 10) || 0) || []
    for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
        const diff = (left[i] || 0) - (right[i] || 0)
        if (diff !== 0) return diff
    }
    return 0
}

function redactOutput(value: string): string {
    return value
        .replace(/(token|password|secret|authorization)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
        .slice(0, MAX_OUTPUT_LENGTH)
}

async function runCommand(command: string, args: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<{ ok: boolean; output: string }> {
    return new Promise((resolve) => {
        execFile(command, args, { cwd: repoRoot(), timeout: timeoutMs }, (error, stdout, stderr) => {
            const output = redactOutput(`${stdout || ""}${stderr ? `\n${stderr}` : ""}`.trim())
            resolve({ ok: !error, output })
        })
    })
}

async function getCommandOutput(command: string, args: string[]): Promise<string | undefined> {
    const result = await runCommand(command, args)
    return result.ok && result.output ? result.output.split("\n")[0]?.trim() : undefined
}

function getPackageManagerBlock(): { source: UpdateSource; message: string; commandHint?: string } | null {
    const manager = (process.env.ANTI_API_PACKAGE_MANAGER || "").toLowerCase()
    if (manager === "winget") {
        return { source: "package-manager", message: "This installation is managed by WinGet.", commandHint: "winget upgrade anti-api" }
    }
    if (manager === "docker") {
        return { source: "package-manager", message: "This installation is running in Docker.", commandHint: "docker compose up -d --build" }
    }
    if (process.env.ANTI_API_NO_SELF_UPDATE === "1") {
        return { source: "packaged", message: "Self-update is disabled for this installation." }
    }
    return null
}

async function fetchLatestVersion(): Promise<string | undefined> {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { "User-Agent": "anti-api-updater" },
    })
    if (!response.ok) return undefined
    const data = await response.json() as { tag_name?: string }
    return stripVersion(data.tag_name)
}

async function gitInfo(fetchRemote: boolean): Promise<{
    isGit: boolean
    dirty: boolean
    branch?: string
    currentCommit?: string
    remoteCommit?: string
    fetchOutput?: string
}> {
    if (!existsSync(join(repoRoot(), ".git"))) return { isGit: false, dirty: false }
    const currentCommit = await getCommandOutput("git", ["rev-parse", "--short", "HEAD"])
    const branch = await getCommandOutput("git", ["branch", "--show-current"])
    const dirtyOutput = await getCommandOutput("git", ["status", "--porcelain"])
    let fetchOutput: string | undefined
    if (fetchRemote) {
        const fetch = await runCommand("git", ["fetch", "--tags", "--prune", "origin"], 60_000)
        fetchOutput = fetch.output
    }
    const upstream = await getCommandOutput("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
    const remoteRef = upstream || (branch ? `origin/${branch}` : "origin/main")
    const remoteCommit = await getCommandOutput("git", ["rev-parse", "--short", remoteRef])
    return {
        isGit: true,
        dirty: !!dirtyOutput,
        branch,
        currentCommit,
        remoteCommit,
        fetchOutput,
    }
}

export async function checkForUpdates(fetchRemote = true): Promise<UpdateCheckResult> {
    const currentVersion = readCurrentVersion()
    const block = getPackageManagerBlock()
    const latestVersion = await fetchLatestVersion().catch(() => undefined)
    if (block) {
        return {
            currentVersion,
            latestVersion,
            source: block.source,
            status: "blocked",
            updateAvailable: latestVersion ? compareVersions(latestVersion, currentVersion) > 0 : false,
            canApply: false,
            message: block.message,
            commandHint: block.commandHint,
        }
    }

    const git = await gitInfo(fetchRemote)
    if (!git.isGit) {
        return {
            currentVersion,
            latestVersion,
            source: "unknown",
            status: "blocked",
            updateAvailable: latestVersion ? compareVersions(latestVersion, currentVersion) > 0 : false,
            canApply: false,
            message: "This install is not a Git checkout. Automatic panel updates are not available.",
        }
    }

    const releaseAvailable = latestVersion ? compareVersions(latestVersion, currentVersion) > 0 : false
    const commitAvailable = !!git.currentCommit && !!git.remoteCommit && git.currentCommit !== git.remoteCommit
    const updateAvailable = releaseAvailable || commitAvailable
    const dirtyBlocked = git.dirty && updateAvailable

    return {
        currentVersion,
        latestVersion,
        currentCommit: git.currentCommit,
        remoteCommit: git.remoteCommit,
        branch: git.branch,
        source: "git",
        status: updateAvailable ? "available" : "current",
        updateAvailable,
        canApply: updateAvailable && !dirtyBlocked,
        message: dirtyBlocked
            ? "Local changes are present. Commit or stash them before applying updates."
            : updateAvailable
                ? "A newer version is available."
                : "Already up to date.",
        commandHint: dirtyBlocked ? "git status --short" : undefined,
    }
}

function scheduleRestart(): void {
    const port = String(state.port || 8964)
    const command = process.platform === "win32"
        ? `Start-Sleep -Seconds 1; Set-Location '${repoRoot().replace(/'/g, "''")}'; if (Test-Path '.\\start.bat') { .\\start.bat } else { bun run src/main.ts start --port ${port} }`
        : `sleep 1; cd ${JSON.stringify(repoRoot())}; ANTI_API_NO_OPEN=1 ${existsSync(join(repoRoot(), "start.command")) ? "./start.command" : `bun run src/main.ts start --port ${port}`}`
    const proc = process.platform === "win32"
        ? Bun.spawn(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], { stdout: "ignore", stderr: "ignore" })
        : Bun.spawn(["/bin/zsh", "-lc", command], { stdout: "ignore", stderr: "ignore" })
    proc.unref()
    setTimeout(() => process.exit(0), 500)
}

export async function applyUpdate(): Promise<UpdateApplyResult> {
    const before = await checkForUpdates(true)
    if (!before.canApply) {
        return { ...before, output: "", restartScheduled: false }
    }
    const pull = await runCommand("git", ["pull", "--ff-only", "--stat"], 120_000)
    if (!pull.ok) {
        return {
            ...before,
            status: "blocked",
            canApply: false,
            message: "Git update failed.",
            output: pull.output,
            restartScheduled: false,
        }
    }
    const install = await runCommand("bun", ["install", "--silent"], 120_000)
    const after = await checkForUpdates(false)
    scheduleRestart()
    return {
        ...after,
        status: install.ok ? after.status : "unknown",
        canApply: false,
        message: install.ok ? "Update applied. Restarting Anti-API..." : "Update applied, but dependency install failed. Restarting Anti-API...",
        output: [pull.output, install.output].filter(Boolean).join("\n\n"),
        restartScheduled: true,
    }
}
