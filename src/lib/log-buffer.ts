import { format } from "util"
import { redactSensitiveText } from "./redaction"

export type LogLevel = "log" | "info" | "warn" | "error" | "debug"

export type LogEntry = {
    id: number
    ts: string
    level: LogLevel
    line: string
}

type LogListener = (entry: LogEntry) => void

const DEFAULT_MAX_LINES = 2000
const MAX_LINES = Math.max(100, Number.parseInt(process.env.ANTI_API_LOG_LINES || "", 10) || DEFAULT_MAX_LINES)

const buffer: LogEntry[] = []
const listeners = new Set<LogListener>()
let nextId = 1
let initialized = false
let captureEnabled = false

const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*[A-Za-z]/g

function appendLog(level: LogLevel, args: unknown[]): void {
    if (!captureEnabled) return
    const raw = redactSensitiveText(args.length ? format(...args) : "")
    const line = raw.replace(ANSI_ESCAPE_RE, "")
    const entry: LogEntry = {
        id: nextId++,
        ts: new Date().toISOString(),
        level,
        line,
    }
    buffer.push(entry)
    if (buffer.length > MAX_LINES) {
        buffer.splice(0, buffer.length - MAX_LINES)
    }
    for (const listener of listeners) {
        listener(entry)
    }
}

export function initLogCapture(): void {
    if (initialized) return
    initialized = true

    const original = {
        log: console.log.bind(console),
        info: console.info.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
        debug: console.debug.bind(console),
    }

    console.log = (...args: unknown[]) => {
        appendLog("log", args)
        original.log(...args)
    }
    console.info = (...args: unknown[]) => {
        appendLog("info", args)
        original.info(...args)
    }
    console.warn = (...args: unknown[]) => {
        appendLog("warn", args)
        original.warn(...args)
    }
    console.error = (...args: unknown[]) => {
        appendLog("error", args)
        original.error(...args)
    }
    console.debug = (...args: unknown[]) => {
        appendLog("debug", args)
        original.debug(...args)
    }
}

export function setLogCaptureEnabled(enabled: boolean): void {
    captureEnabled = enabled
    if (!enabled) {
        buffer.length = 0
    }
}

export function isLogCaptureEnabled(): boolean {
    return captureEnabled
}

export function getLogSnapshot(options?: { limit?: number; sinceId?: number }): {
    entries: LogEntry[]
    lastId: number
    maxLines: number
    enabled: boolean
} {
    if (!captureEnabled) {
        return { entries: [], lastId: 0, maxLines: MAX_LINES, enabled: false }
    }
    const limit = Math.min(Math.max(options?.limit || 500, 1), MAX_LINES)
    const sinceId = options?.sinceId || 0
    const entries = sinceId > 0
        ? buffer.filter(entry => entry.id > sinceId)
        : buffer.slice(-limit)
    const lastId = buffer.length ? buffer[buffer.length - 1].id : 0
    return { entries, lastId, maxLines: MAX_LINES, enabled: true }
}

export function subscribeLogs(listener: LogListener): () => void {
    listeners.add(listener)
    return () => {
        listeners.delete(listener)
    }
}
