import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs"
import { isAbsolute } from "node:path"
import { authStore } from "~/services/auth/store"
import type { ProviderAccount } from "~/services/auth/types"
import { fetchZedAuthenticatedUser } from "./chat"

export const ZED_CREDENTIALS_ENV = "ANTI_API_ZED_CREDENTIALS_FILE"
export const ZED_SERVER_URL = "https://zed.dev"
export const MAX_ZED_CREDENTIAL_FILE_BYTES = 64 * 1024

const MAX_CREDENTIAL_FIELD_LENGTH = 16 * 1024
const SAFE_IMPORT_ERROR = `Set ${ZED_CREDENTIALS_ENV} to an absolute, owner-only Zed credential JSON file.`

export class ZedCredentialImportError extends Error {
    constructor() {
        super(SAFE_IMPORT_ERROR)
        this.name = "ZedCredentialImportError"
    }
}

export interface ZedCredentialFields {
    id: string
    accessToken: string
}

function invalidCredentials(): never {
    throw new ZedCredentialImportError()
}

export function getZedCredentialsFilePath(
    env: Record<string, string | undefined> = process.env
): string | undefined {
    const configured = env[ZED_CREDENTIALS_ENV]?.trim()
    return configured || undefined
}

/** Parse only the documented fields; unknown fields are intentionally ignored. */
export function parseZedCredentialJson(raw: string): ZedCredentialFields {
    if (Buffer.byteLength(raw, "utf8") > MAX_ZED_CREDENTIAL_FILE_BYTES) {
        return invalidCredentials()
    }

    let value: unknown
    try {
        value = JSON.parse(raw)
    } catch {
        return invalidCredentials()
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return invalidCredentials()
    }

    const record = value as Record<string, unknown>
    const id = typeof record.id === "string" ? record.id.trim() : ""
    const accessToken = typeof record.access_token === "string" ? record.access_token.trim() : ""
    if (
        record.type !== "zed" ||
        !id ||
        !accessToken ||
        id.length > MAX_CREDENTIAL_FIELD_LENGTH ||
        accessToken.length > MAX_CREDENTIAL_FIELD_LENGTH
    ) {
        return invalidCredentials()
    }
    return { id, accessToken }
}

function readCredentialFile(path: string): ZedCredentialFields {
    if (!isAbsolute(path)) {
        return invalidCredentials()
    }

    let descriptor: number | undefined
    try {
        // Reject links before opening on every platform, and use O_NOFOLLOW on
        // Unix so a link cannot be introduced between the check and the read.
        if (lstatSync(path).isSymbolicLink()) {
            return invalidCredentials()
        }
        const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW)
        descriptor = openSync(path, flags)
        const stat = fstatSync(descriptor)
        if (!stat.isFile() || stat.size > MAX_ZED_CREDENTIAL_FILE_BYTES) {
            return invalidCredentials()
        }
        if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
            return invalidCredentials()
        }
        return parseZedCredentialJson(readFileSync(descriptor, "utf8"))
    } catch {
        return invalidCredentials()
    } finally {
        if (descriptor !== undefined) closeSync(descriptor)
    }
}

/**
 * Returns a non-sensitive status for the diagnostics panel. It never includes
 * the configured path or credential contents in the response.
 */
export function getZedCredentialsStatus(
    env: Record<string, string | undefined> = process.env
): "not_configured" | "ready" | "invalid" {
    const path = getZedCredentialsFilePath(env)
    if (!path) return "not_configured"
    try {
        readCredentialFile(path)
        return "ready"
    } catch {
        return "invalid"
    }
}

export async function importConfiguredZedAccount(): Promise<ProviderAccount> {
    const path = getZedCredentialsFilePath()
    if (!path) {
        throw new ZedCredentialImportError()
    }

    const { id: userId, accessToken } = readCredentialFile(path)
    let profile: Awaited<ReturnType<typeof fetchZedAuthenticatedUser>>
    try {
        // Keep the upstream host fixed; request data cannot override the server URL.
        profile = await fetchZedAuthenticatedUser(userId, accessToken)
    } catch {
        // Do not echo upstream response bodies or credentials through the auth route.
        throw new ZedCredentialImportError()
    }

    const account: ProviderAccount = {
        id: String(profile.user.id),
        provider: "zed",
        login: profile.user.github_login,
        label: profile.user.name || profile.user.github_login,
        accessToken,
        organizationId: profile.organizations?.[0]?.id,
        serverUrl: ZED_SERVER_URL,
        authSource: "zed-credentials-file",
    }

    try {
        authStore.saveAccount(account)
    } catch {
        // Keep filesystem details (which can contain the source path) out of
        // the HTTP response and application logs.
        throw new ZedCredentialImportError()
    }
    return account
}

// Kept as a source-compatible alias for integrations that used the old name;
// it now has the same explicit-file behavior and never probes local app state.
export const importZedLocalAccount = importConfiguredZedAccount
