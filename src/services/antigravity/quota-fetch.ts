import { fetchJson, getProjectID } from "./oauth"
import { generateMockProjectId } from "./project-id"
import { UpstreamError } from "~/lib/error"
import { getAntigravityUserAgent } from "~/lib/antigravity-client"

// 與 chat.ts 一致：優先連 daily 預發佈端點（新模型如 3.8 只在此出現），失敗回退正式端點
const ANTIGRAVITY_BASE_URLS = [
    "https://daily-cloudcode-pa.googleapis.com",
    "https://daily-cloudcode-pa.sandbox.googleapis.com",
    "https://cloudcode-pa.googleapis.com",
]
const USER_AGENT = getAntigravityUserAgent()

export type AntigravityModelInfo = {
    remainingFraction?: number
    resetTime?: string
}

export type AntigravityQuotaSummaryBucket = {
    bucketId?: string
    displayName?: string
    window?: string
    resetTime?: string
    description?: string
    remainingFraction?: number
}

export type AntigravityQuotaSummaryGroup = {
    displayName?: string
    description?: string
    buckets?: AntigravityQuotaSummaryBucket[]
}

export async function fetchAntigravityModels(
    accessToken: string,
    projectId?: string | null
): Promise<{ models: Record<string, AntigravityModelInfo>; projectId: string | null }> {
    const resolvedProjectId = projectId || await getProjectID(accessToken) || generateMockProjectId()
    const project = resolvedProjectId

    let lastError: unknown = null
    for (const baseUrl of ANTIGRAVITY_BASE_URLS) {
        try {
            const response = await fetchJson(`${baseUrl}/v1internal:fetchAvailableModels`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "Content-Type": "application/json",
                    "User-Agent": USER_AGENT,
                },
                body: JSON.stringify({ project }),
            })

            if (response.status < 200 || response.status >= 300) {
                throw new UpstreamError("antigravity", response.status, response.text)
            }

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
        } catch (err) {
            lastError = err
            continue
        }
    }
    throw lastError
}

export async function fetchAntigravityQuotaSummary(
    accessToken: string,
    projectId?: string | null
): Promise<{ groups: AntigravityQuotaSummaryGroup[]; projectId: string | null }> {
    const resolvedProjectId = projectId || await getProjectID(accessToken) || generateMockProjectId()
    const project = resolvedProjectId

    let lastError: unknown = null
    for (const baseUrl of ANTIGRAVITY_BASE_URLS) {
        try {
            const response = await fetchJson(`${baseUrl}/v1internal:retrieveUserQuotaSummary`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "Content-Type": "application/json",
                    "User-Agent": USER_AGENT,
                },
                body: JSON.stringify({ project }),
            })

            if (response.status < 200 || response.status >= 300) {
                throw new UpstreamError("antigravity", response.status, response.text)
            }

            const data = response.data as { groups?: AntigravityQuotaSummaryGroup[] }
            return {
                groups: Array.isArray(data.groups) ? data.groups : [],
                projectId: resolvedProjectId || null,
            }
        } catch (err) {
            lastError = err
            continue
        }
    }
    throw lastError
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
