import { fetchJson, getProjectID } from "./oauth"
import { generateMockProjectId } from "./project-id"
import { UpstreamError } from "~/lib/error"
import { getAntigravityUserAgent } from "~/lib/antigravity-client"

const CLOUD_CODE_BASE_URLS = [
    "https://daily-cloudcode-pa.googleapis.com",
    "https://cloudcode-pa.googleapis.com",
]
export type AntigravityModelInfo = {
    remainingFraction?: number
    resetTime?: string
}

export type AntigravityQuotaBucket = {
    bucketId: string
    displayName?: string
    window?: "weekly" | "5h" | string
    resetTime?: string
    description?: string
    remainingFraction?: number
    disabled?: boolean
}

export type AntigravityQuotaGroup = {
    displayName?: string
    description?: string
    buckets?: AntigravityQuotaBucket[]
}

export type AntigravityQuotaSummaryResponse = {
    groups?: AntigravityQuotaGroup[]
    description?: string
}

export async function fetchAntigravityQuotaSummary(
    accessToken: string,
    projectId?: string | null,
    proxy?: string
): Promise<AntigravityQuotaSummaryResponse> {
    const resolvedProjectId = projectId || await getProjectID(accessToken, proxy) || generateMockProjectId()
    const project = resolvedProjectId

    let lastError: any = null
    for (const baseUrl of CLOUD_CODE_BASE_URLS) {
        try {
            const response = await fetchJson(`${baseUrl}/v1internal:retrieveUserQuotaSummary`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "Content-Type": "application/json",
                    "User-Agent": getAntigravityUserAgent(),
                },
                body: JSON.stringify({ project }),
                proxy,
            })

            if (response.status >= 200 && response.status < 300) {
                return response.data as AntigravityQuotaSummaryResponse
            }
            lastError = new UpstreamError("antigravity", response.status, response.text)
        } catch (err) {
            lastError = err
        }
    }

    throw lastError || new Error("Failed to fetch Antigravity quota summary")
}

export async function fetchAntigravityModels(
    accessToken: string,
    projectId?: string | null,
    proxy?: string
): Promise<{ models: Record<string, AntigravityModelInfo>; projectId: string | null }> {
    const resolvedProjectId = projectId || await getProjectID(accessToken, proxy) || generateMockProjectId()
    const project = resolvedProjectId

    let lastError: any = null
    for (const baseUrl of CLOUD_CODE_BASE_URLS) {
        try {
            const response = await fetchJson(`${baseUrl}/v1internal:fetchAvailableModels`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "Content-Type": "application/json",
                    "User-Agent": getAntigravityUserAgent(),
                },
                body: JSON.stringify({ project }),
                proxy,
            })

            if (response.status >= 200 && response.status < 300) {
                const data = response.data as { models?: Record<string, { quotaInfo?: AntigravityModelInfo }> }

                const models: Record<string, AntigravityModelInfo> = {}
                for (const [name, info] of Object.entries(data.models || {})) {
                    models[name] = {
                        remainingFraction: info.quotaInfo?.remainingFraction ?? 0,
                        resetTime: info.quotaInfo?.resetTime,
                    }
                }

                return {
                    models,
                    projectId: resolvedProjectId || null,
                }
            }
            lastError = new UpstreamError("antigravity", response.status, response.text)
        } catch (err) {
            lastError = err
        }
    }

    throw lastError || new Error("Failed to fetch Antigravity models")
}

function toTimestamp(value: string): number | null {
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? ms : null
}

export function pickResetTime(
    models: Record<string, AntigravityModelInfo>,
    modelId?: string
): string | null {
    if (modelId) {
        const candidate = models[modelId]?.resetTime
        if (candidate && toTimestamp(candidate) !== null) {
            return candidate
        }
    }

    let best: { value: string; ms: number } | null = null
    for (const info of Object.values(models)) {
        if (!info?.resetTime) continue
        const ms = toTimestamp(info.resetTime)
        if (ms === null) continue
        if (!best || ms < best.ms) {
            best = { value: info.resetTime, ms }
        }
    }

    return best ? best.value : null
}
