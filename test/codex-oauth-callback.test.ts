import { expect, test } from "bun:test"
import {
    getCodexCallbackHostname,
    getCodexOAuthRedirectUri,
    getSafeCodexRedirectUri,
    isCodexOAuthStateValid,
    sanitizeCodexOAuthError,
} from "~/services/codex/oauth"

test("Codex callback uses a container relay only when explicitly enabled", () => {
    const previous = process.env.ANTI_API_DOCKER_OAUTH_CALLBACK
    try {
        delete process.env.ANTI_API_DOCKER_OAUTH_CALLBACK
        expect(getCodexCallbackHostname()).toBe("127.0.0.1")
        process.env.ANTI_API_DOCKER_OAUTH_CALLBACK = "1"
        expect(getCodexCallbackHostname()).toBe("0.0.0.0")
    } finally {
        if (previous === undefined) delete process.env.ANTI_API_DOCKER_OAUTH_CALLBACK
        else process.env.ANTI_API_DOCKER_OAUTH_CALLBACK = previous
    }
})

test("Codex OAuth callback redirect canonicalizes every loopback spelling", () => {
    const canonical = getCodexOAuthRedirectUri(1455)
    expect(getSafeCodexRedirectUri(new URL("http://localhost:1455/auth/callback"), 1455)).toBe(
        canonical
    )
    expect(getSafeCodexRedirectUri(new URL("http://127.0.0.1:1455/auth/callback"), 1455)).toBe(
        canonical
    )
    expect(getSafeCodexRedirectUri(new URL("http://[::1]:1455/auth/callback"), 1455)).toBe(
        canonical
    )
})

test("Codex OAuth state comparison is exact and bounded", () => {
    expect(isCodexOAuthStateValid("state-123", "state-123")).toBe(true)
    expect(isCodexOAuthStateValid("state-123", "state-124")).toBe(false)
    expect(isCodexOAuthStateValid("state-123", "state-123-extra")).toBe(false)
    expect(isCodexOAuthStateValid(undefined, "state-123")).toBe(false)
    expect(isCodexOAuthStateValid("x".repeat(513), "x".repeat(513))).toBe(false)
})

test("Codex OAuth callback errors are never reflected verbatim", () => {
    expect(sanitizeCodexOAuthError("access_denied")).toBe("Codex OAuth authorization failed (access_denied)")
    expect(sanitizeCodexOAuthError("token=secret\nSet-Cookie: leaked")).toBe("Codex OAuth authorization failed")
})

test("Codex OAuth callback redirect rejects spoofed hosts, paths, and credentials", () => {
    for (const value of [
        "http://192.168.1.20:1455/auth/callback",
        "http://evil.example:1455/auth/callback",
        "http://localhost:1455/wrong",
        "https://localhost:1455/auth/callback",
        "http://user:pass@localhost:1455/auth/callback",
        "http://localhost:1456/auth/callback",
    ]) {
        expect(getSafeCodexRedirectUri(new URL(value), 1455)).toBeNull()
    }
})
