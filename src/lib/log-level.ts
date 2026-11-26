const LOG_LEVELS = {
    silent: Number.NEGATIVE_INFINITY,
    // Consola uses level 0 for fatal/error and level 1 for warnings.
    error: 0,
    warn: 1,
    info: 3,
    debug: 4,
} as const

export { LOG_LEVELS }

export type AntiApiLogLevel = keyof typeof LOG_LEVELS

function isEnabled(value: string | undefined): boolean {
    return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes" || value?.toLowerCase() === "on"
}

export function resolveLogLevel(
    env: Record<string, string | undefined> = process.env,
    verbose = false
): number {
    if (verbose) {
        return LOG_LEVELS.debug
    }

    const configured = env.ANTI_API_LOG_LEVEL?.trim().toLowerCase()
    if (configured && configured in LOG_LEVELS) {
        return LOG_LEVELS[configured as AntiApiLogLevel]
    }

    if (isEnabled(env.ANTI_API_DEBUG) || isEnabled(env.ANTI_API_VERBOSE)) {
        return LOG_LEVELS.debug
    }

    return LOG_LEVELS.error
}
