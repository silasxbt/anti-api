/**
 * Antigravity CLI (agy) Authentication Service
 * 
 * Provides:
 * 1. Native credential import from Windows Credential Manager (gemini:antigravity) and CLI token files
 * 2. Zero-port code-based authentication flow (redirecting to https://antigravity.google/oauth-callback)
 */

import { spawn } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"
import { existsSync, readFileSync } from "node:fs"
import consola from "consola"
import { OAUTH_CONFIG, fetchJson, fetchUserInfo, getProjectID } from "./oauth"
import { accountManager } from "./account-manager"
import { authStore } from "~/services/auth/store"
import { generateMockProjectId } from "./project-id"
import { setAuth } from "./login"
import { safeErrorMessage } from "~/lib/redaction"

export interface AgyCredentials {
    accessToken: string
    refreshToken?: string
    expiresAt?: number
    email?: string
    name?: string
}

const PS_READ_CRED_SCRIPT = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class CredMan {
    [DllImport("Advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CredReadW(string target, int type, int reservedFlag, out IntPtr credentialPtr);
    [DllImport("Advapi32.dll", SetLastError = true)]
    public static extern void CredFree(IntPtr credentialPtr);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public int Flags;
        public int Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }
    public static string ReadCred(string target) {
        IntPtr credPtr;
        if (CredReadW(target, 1, 0, out credPtr)) {
            var cred = (CREDENTIAL)Marshal.PtrToStructure(credPtr, typeof(CREDENTIAL));
            byte[] bytes = new byte[cred.CredentialBlobSize];
            Marshal.Copy(cred.CredentialBlob, bytes, 0, cred.CredentialBlobSize);
            CredFree(credPtr);
            return System.Text.Encoding.UTF8.GetString(bytes);
        }
        return null;
    }
}
"@
[CredMan]::ReadCred("gemini:antigravity")
`

function readWin32Credential(): Promise<string | null> {
    return new Promise((resolve) => {
        try {
            const ps = spawn("powershell.exe", [
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                "[Console]::In.ReadToEnd() | Invoke-Expression",
            ])
            let stdout = ""
            ps.stdout.on("data", (d) => { stdout += d })
            ps.on("close", (code) => {
                if (code === 0 && stdout.trim()) {
                    resolve(stdout.trim())
                } else {
                    resolve(null)
                }
            })
            ps.on("error", () => resolve(null))
            ps.stdin.write(PS_READ_CRED_SCRIPT)
            ps.stdin.end()
        } catch {
            resolve(null)
        }
    })
}

function parseJwtEmail(idToken?: string): { email?: string; name?: string } {
    if (!idToken) return {}
    try {
        const parts = idToken.split(".")
        if (parts.length >= 2) {
            const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf-8"))
            return {
                email: payload.email,
                name: payload.name || payload.given_name,
            }
        }
    } catch {
        // ignore jwt decode errors
    }
    return {}
}

export async function readAgyCredentials(): Promise<AgyCredentials | null> {
    let rawJson: string | null = null

    if (process.platform === "win32") {
        rawJson = await readWin32Credential()
    }

    if (!rawJson) {
        const filePaths = [
            join(homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token"),
            join(homedir(), ".config", "antigravity", "antigravity-oauth-token"),
            join(homedir(), ".gemini", "antigravity-oauth-token"),
        ]
        for (const p of filePaths) {
            if (existsSync(p)) {
                try {
                    rawJson = readFileSync(p, "utf-8")
                    break
                } catch {
                    // continue search
                }
            }
        }
    }

    if (!rawJson) return null

    try {
        const parsed = JSON.parse(rawJson)
        const tokenObj = parsed.token || parsed
        const accessToken = tokenObj.access_token || parsed.access_token
        if (!accessToken) return null

        const refreshToken = tokenObj.refresh_token || parsed.refresh_token
        let expiresAt: number | undefined
        if (tokenObj.expiry) {
            expiresAt = Date.parse(tokenObj.expiry)
        } else if (tokenObj.expires_in) {
            expiresAt = Date.now() + tokenObj.expires_in * 1000
        }

        const jwtInfo = parseJwtEmail(parsed.id_token || tokenObj.id_token)

        return {
            accessToken,
            refreshToken,
            expiresAt: Number.isFinite(expiresAt) ? expiresAt : undefined,
            email: jwtInfo.email,
            name: jwtInfo.name,
        }
    } catch {
        return null
    }
}

export async function importAgyAuthSources(): Promise<{
    success: boolean
    imported: boolean
    email?: string
    error?: string
}> {
    try {
        const cred = await readAgyCredentials()
        if (!cred || !cred.accessToken) {
            return { success: false, imported: false, error: "No Antigravity CLI (agy) credentials found." }
        }

        let email = cred.email
        let name = cred.name
        if (!email) {
            try {
                const info = await fetchUserInfo(cred.accessToken)
                email = info.email
                name = info.email.split("@")[0]
            } catch {
                email = "agy-user"
            }
        }

        const projectId = await getProjectID(cred.accessToken) || generateMockProjectId()
        const id = email

        setAuth(cred.accessToken, cred.refreshToken, email, name)
        accountManager.load()
        accountManager.addAccount({
            id,
            email,
            accessToken: cred.accessToken,
            refreshToken: cred.refreshToken || "",
            expiresAt: cred.expiresAt || 0,
            projectId,
        })
        authStore.saveAccount({
            id,
            provider: "antigravity",
            email,
            accessToken: cred.accessToken,
            refreshToken: cred.refreshToken || "",
            expiresAt: cred.expiresAt || 0,
            projectId,
            label: email,
        })

        consola.success(`✓ Imported Antigravity credentials from agy: ${email}`)
        return { success: true, imported: true, email }
    } catch (err: any) {
        consola.warn("Failed to import agy auth:", safeErrorMessage(err))
        return { success: false, imported: false, error: safeErrorMessage(err) }
    }
}

export async function exchangeAuthCode(
    code: string,
    redirectUri?: string
): Promise<{ success: boolean; email?: string; error?: string }> {
    const { loginWithAuthCode } = await import("./login")
    return loginWithAuthCode(code, redirectUri)
}

export async function getAgyAuthStatus(): Promise<{
    installed: boolean
    loggedIn: boolean
    email: string | null
}> {
    const cred = await readAgyCredentials()
    if (!cred || !cred.accessToken) {
        return { installed: true, loggedIn: false, email: null }
    }
    return {
        installed: true,
        loggedIn: true,
        email: cred.email || null,
    }
}
