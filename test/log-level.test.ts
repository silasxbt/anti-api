import { expect, test } from "bun:test"
import { LOG_LEVELS, resolveLogLevel } from "../src/lib/log-level"

test("log level defaults to errors and accepts named levels", () => {
    expect(resolveLogLevel({})).toBe(LOG_LEVELS.error)
    expect(resolveLogLevel({ ANTI_API_LOG_LEVEL: "silent" })).toBe(LOG_LEVELS.silent)
    expect(resolveLogLevel({ ANTI_API_LOG_LEVEL: "warn" })).toBe(LOG_LEVELS.warn)
    expect(resolveLogLevel({ ANTI_API_LOG_LEVEL: "DEBUG" })).toBe(LOG_LEVELS.debug)
})

test("debug aliases and CLI verbose enable debug logging", () => {
    expect(resolveLogLevel({ ANTI_API_DEBUG: "1" })).toBe(LOG_LEVELS.debug)
    expect(resolveLogLevel({ ANTI_API_VERBOSE: "true" })).toBe(LOG_LEVELS.debug)
    expect(resolveLogLevel({ ANTI_API_LOG_LEVEL: "error" }, true)).toBe(LOG_LEVELS.debug)
})
