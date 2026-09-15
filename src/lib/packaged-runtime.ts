export interface PackagedRuntimeDependencies {
    sidecarAvailable: boolean
    startSidecar: () => Promise<void>
    stopSidecar: () => void
    runCli: (rawArgs: string[]) => Promise<void>
    startupFailed?: () => boolean
}

const LONG_RUNNING_COMMANDS = new Set(["start", "remote"])

/**
 * Resolve the packaged command without treating option values as commands.
 * The packaged executable starts the local server when no command is supplied.
 */
export function getPackagedCommand(rawArgs: string[]): string {
    return rawArgs[0] || "start"
}

export function needsPackagedSidecar(rawArgs: string[]): boolean {
    return LONG_RUNNING_COMMANDS.has(getPackagedCommand(rawArgs))
}

/**
 * Run the packaged CLI while keeping the sidecar owned by long-running commands.
 * One-shot commands never start it. Startup errors always clean up a child that
 * was already spawned; successful servers leave cleanup to the signal handlers.
 */
export async function runPackagedRuntime(
    rawArgs: string[],
    dependencies: PackagedRuntimeDependencies
): Promise<void> {
    const args = rawArgs.length > 0 ? rawArgs : ["start"]
    const longRunning = needsPackagedSidecar(args)
    let sidecarStarted = false
    let keepSidecar = false

    try {
        if (dependencies.sidecarAvailable && longRunning) {
            await dependencies.startSidecar()
            sidecarStarted = true
        }

        await dependencies.runCli(args)
        keepSidecar = sidecarStarted && !(dependencies.startupFailed?.() ?? false)
    } finally {
        if (sidecarStarted && !keepSidecar) {
            dependencies.stopSidecar()
        }
    }
}
