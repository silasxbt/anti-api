import consola from "consola"
import { readdirSync, readFileSync } from "fs"
import { authStore } from "~/services/auth/store"
import type { ProviderAccount } from "~/services/auth/types"
import { redactSensitiveText, safeErrorMessage } from "~/lib/redaction"

const DEFAULT_COPILOT_CLIENT_ID = "01ab8ac9400c4e429b23"
const COPILOT_CLIENT_ID = process.env.COPILOT_CLIENT_ID || DEFAULT_COPILOT_CLIENT_ID
const COPILOT_AUTH_DIR = "~/.cli-proxy-api"

const DEVICE_CODE_URL = "https://github.com/login/device/code"
const TOKEN_URL = "https://github.com/login/oauth/access_token"
const USER_URL = "https://api.github.com/user"

type JsonResponse = {
    status: number
    data: any
    text: string
}

async function fetchJsonWithFallback(
    url: string,
    options: { method?: string; headers?: Record<string, string>; body?: string }
): Promise<JsonResponse> {
    const response = await fetch(url, {
        method: options.method,
        headers: options.headers,
        body: options.body,
        signal: AbortSignal.timeout(10_000),
    })
    const text = await response.text()
    let data: any = null
    if (text) {
        try { data = JSON.parse(text) } catch { }
    }
    return { status: response.status, data, text }
}

export interface CopilotDeviceCode {
    deviceCode: string
    userCode: string
    verificationUri: string
    interval: number
    expiresIn: number
}

export interface CopilotAuthSession {
    deviceCode: string
    userCode: string
    verificationUri: string
    interval: number
    expiresAt: number
    status: "pending" | "success" | "error"
    message?: string
    account?: ProviderAccount
}

const sessions = new Map<string, CopilotAuthSession>()

export async function startCopilotDeviceFlow(): Promise<CopilotAuthSession> {
    const params = new URLSearchParams({
        client_id: COPILOT_CLIENT_ID,
        scope: "read:user",
    })

    const response = await fetchJsonWithFallback(DEVICE_CODE_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        },
        body: params.toString(),
    })

    const data = response.data as any
    if (response.status < 200 || response.status >= 300) {
        const reason = data?.error_description || data?.error || "Failed to start Copilot device flow"
        throw new Error(redactSensitiveText(String(reason)))
    }

    const session: CopilotAuthSession = {
        deviceCode: data.device_code,
        userCode: data.user_code,
        verificationUri: data.verification_uri,
        interval: data.interval || 5,
        expiresAt: Date.now() + (data.expires_in || 900) * 1000,
        status: "pending",
    }

    sessions.set(session.deviceCode, session)
    return session
}

export function importCopilotAuthFiles(): ProviderAccount[] {
    const homeDir = process.env.HOME || process.env.USERPROFILE || ""
    const expandedPath = COPILOT_AUTH_DIR.replace(/^~\//, `${homeDir}/`)
    try {
        const files = readdirSync(expandedPath).filter((file) => file.startsWith("github-copilot-") && file.endsWith(".json"))
        const accounts: ProviderAccount[] = []
        for (const file of files) {
            const raw = JSON.parse(readFileSync(`${expandedPath}/${file}`, "utf-8")) as any
            const accessToken = raw.access_token || raw.oauth_token
            if (!accessToken) continue
            const login = raw.username || raw.login || file.replace(/^github-copilot-/, "").replace(/\.json$/, "")
            const account: ProviderAccount = {
                id: login,
                provider: "copilot",
                login,
                email: raw.email || undefined,
                accessToken,
                label: login,
            }
            authStore.saveAccount(account)
            accounts.push(account)
        }
        return accounts
    } catch (error) {
        consola.warn("Copilot auth file import failed:", safeErrorMessage(error))
        return []
    }
}

export async function pollCopilotSession(deviceCode: string): Promise<CopilotAuthSession> {
    const session = sessions.get(deviceCode)
    if (!session) {
        throw new Error("Copilot session not found")
    }

    if (session.status !== "pending") {
        return session
    }

    if (Date.now() > session.expiresAt) {
        session.status = "error"
        session.message = "Device code expired"
        sessions.set(deviceCode, session)
        return session
    }

    const params = new URLSearchParams({
        client_id: COPILOT_CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    })

    const response = await fetchJsonWithFallback(TOKEN_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        },
        body: params.toString(),
    })

    const data = response.data as any

    if (data?.error === "authorization_pending") {
        return session
    }
    if (data?.error === "slow_down") {
        session.interval = Math.min(session.interval + 2, 15)
        sessions.set(deviceCode, session)
        return session
    }
    if (response.status < 200 || response.status >= 300 || data?.error) {
        session.status = "error"
        session.message = redactSensitiveText(String(data?.error_description || data?.error || "Copilot authorization failed"))
        sessions.set(deviceCode, session)
        return session
    }

    const accessToken = data.access_token as string
    const account = await fetchCopilotAccount(accessToken)

    if (!account) {
        session.status = "error"
        session.message = "Copilot login failed to fetch user profile"
        sessions.set(deviceCode, session)
        return session
    }

    authStore.saveAccount(account)

    session.status = "success"
    session.account = account
    sessions.set(deviceCode, session)
    return session
}

async function fetchCopilotAccount(accessToken: string): Promise<ProviderAccount | null> {
    try {
        const response = await fetchJsonWithFallback(USER_URL, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Accept": "application/vnd.github+json",
            },
        })

        const data = response.data as any
        if (response.status < 200 || response.status >= 300) {
            consola.warn(`Copilot user profile fetch failed (${response.status})`)
            return null
        }

        const login = data.login || "copilot-user"
        return {
            id: login,
            provider: "copilot",
            login,
            email: data.email || undefined,
            accessToken,
            label: data.login || "Copilot Account",
        }
    } catch (error) {
        consola.warn("Copilot user fetch error:", safeErrorMessage(error))
        return null
    }
}
