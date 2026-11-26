import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { randomUUID } from "crypto"
import consola from "consola"
import type { AuthProvider } from "~/services/auth/types"
import { isHiddenCodexModel } from "./models"
import { getDataDir } from "~/lib/data-dir"
import { safeErrorMessage } from "~/lib/redaction"

export interface RoutingEntry {
    id: string
    provider: AuthProvider
    accountId: string
    modelId: string
    label: string
    accountLabel?: string
}

export interface AccountRoutingEntry {
    id: string
    provider: AuthProvider
    accountId: string
    label?: string
    accountLabel?: string
}

export interface AccountRoutingRoute {
    id: string
    modelId: string
    entries: AccountRoutingEntry[]
}

export interface AccountRoutingConfig {
    smartSwitch: boolean
    routes: AccountRoutingRoute[]
}

export interface RoutingFlow {
    id: string
    name: string
    entries: RoutingEntry[]
}

export interface RoutingConfig {
    version: number
    updatedAt: string
    flows: RoutingFlow[]
    activeFlowId?: string  // When set, all requests use this flow
    accountRouting?: AccountRoutingConfig
}

const ROUTING_FILE = join(getDataDir(), "routing.json")
const CURRENT_VERSION = 2

function ensureDir(): void {
    const dir = getDataDir()
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
    }
}

function normalizeEntry(entry: RoutingEntry): RoutingEntry | null {
    if (entry.provider === "codex" && isHiddenCodexModel(entry.modelId)) {
        return null
    }
    return {
        ...entry,
        id: entry.id || randomUUID(),
        label: entry.label || `${entry.provider}:${entry.modelId}`,
    }
}

function normalizeAccountEntry(entry: AccountRoutingEntry): AccountRoutingEntry {
    return {
        ...entry,
        id: entry.id || randomUUID(),
    }
}

function normalizeAccountRoute(route: Partial<AccountRoutingRoute>, index: number): AccountRoutingRoute | null {
    const modelId = (route.modelId || "").trim()
    if (modelId && isHiddenCodexModel(modelId)) {
        return null
    }
    const entries = Array.isArray(route.entries) ? route.entries.map(normalizeAccountEntry) : []

    return {
        id: route.id || randomUUID(),
        modelId,
        entries,
    }
}

function normalizeFlow(flow: Partial<RoutingFlow>, index: number): RoutingFlow {
    const name = (flow.name || `Flow ${index + 1}`).trim()
    const entries = Array.isArray(flow.entries)
        ? flow.entries.map(normalizeEntry).filter((entry): entry is RoutingEntry => !!entry)
        : []

    return {
        id: flow.id || randomUUID(),
        name: name || `Flow ${index + 1}`,
        entries,
    }
}

function normalizeConfig(raw: Partial<RoutingConfig> & { entries?: RoutingEntry[] }): RoutingConfig {
    const updatedAt = raw.updatedAt || new Date().toISOString()
    const accountRouting: AccountRoutingConfig = {
        smartSwitch: raw.accountRouting?.smartSwitch ?? false,
        routes: Array.isArray(raw.accountRouting?.routes)
            ? raw.accountRouting!.routes
                .map((route, index) => normalizeAccountRoute(route, index))
                .filter((route): route is AccountRoutingRoute => !!route)
            : [],
    }

    if (Array.isArray(raw.flows)) {
        const flows = raw.flows.flatMap((flow, index) => {
            const rawEntries = Array.isArray(flow.entries) ? flow.entries : []
            const normalized = normalizeFlow(flow, index)
            if (rawEntries.length > 0 && normalized.entries.length === 0) {
                return []
            }
            return [normalized]
        })
        const activeFlowId = flows.some(flow => flow.id === raw.activeFlowId)
            ? raw.activeFlowId
            : undefined
        return {
            version: raw.version || CURRENT_VERSION,
            updatedAt,
            flows,
            activeFlowId,
            accountRouting,
        }
    }

    if (Array.isArray(raw.entries)) {
        const legacyEntries = raw.entries
            .map(normalizeEntry)
            .filter((entry): entry is RoutingEntry => !!entry)
        return {
            version: CURRENT_VERSION,
            updatedAt,
            flows: legacyEntries.length
                ? [{ id: randomUUID(), name: "default", entries: legacyEntries }]
                : [],
            accountRouting,
        }
    }

    return { version: CURRENT_VERSION, updatedAt, flows: [], accountRouting }
}

export function loadRoutingConfig(): RoutingConfig {
    try {
        if (!existsSync(ROUTING_FILE)) {
            return { version: CURRENT_VERSION, updatedAt: new Date().toISOString(), flows: [], accountRouting: { smartSwitch: false, routes: [] } }
        }
        const raw = JSON.parse(readFileSync(ROUTING_FILE, "utf-8")) as Partial<RoutingConfig> & {
            entries?: RoutingEntry[]
        }
        return normalizeConfig(raw)
    } catch (error) {
        consola.warn("Failed to load routing config:", safeErrorMessage(error))
        return { version: CURRENT_VERSION, updatedAt: new Date().toISOString(), flows: [], accountRouting: { smartSwitch: false, routes: [] } }
    }
}

export function saveRoutingConfig(
    flows: RoutingFlow[],
    activeFlowId?: string,
    accountRouting?: AccountRoutingConfig
): RoutingConfig {
    ensureDir()
    // Preserve existing activeFlowId if not explicitly provided
    const existing = loadRoutingConfig()
    const config: RoutingConfig = {
        version: CURRENT_VERSION,
        updatedAt: new Date().toISOString(),
        flows: flows.map((flow, index) => normalizeFlow(flow, index)),
        activeFlowId: activeFlowId !== undefined ? activeFlowId : existing.activeFlowId,
        accountRouting: accountRouting !== undefined ? accountRouting : existing.accountRouting,
    }
    writeFileSync(ROUTING_FILE, JSON.stringify(config, null, 2))
    return config
}

export function setActiveFlow(flowId: string | null): RoutingConfig {
    const config = loadRoutingConfig()
    config.activeFlowId = flowId || undefined
    config.updatedAt = new Date().toISOString()
    writeFileSync(ROUTING_FILE, JSON.stringify(config, null, 2))
    return config
}
