import { afterEach, expect, test } from "bun:test"
import {
    consumeOAuthPkceVerifier,
    createOAuthPkceSession,
    discardOAuthPkceSession,
    exchangeCode,
    generateAuthURL,
    generateCodeChallenge,
    getAntigravityOAuthRedirectUri,
    resolveOAuthCallbackServerOptions,
} from "~/services/antigravity/oauth"

const previousDockerCallback = process.env.ANTI_API_DOCKER_OAUTH_CALLBACK

afterEach(() => {
    if (previousDockerCallback === undefined) delete process.env.ANTI_API_DOCKER_OAUTH_CALLBACK
    else process.env.ANTI_API_DOCKER_OAUTH_CALLBACK = previousDockerCallback
})

test("Antigravity OAuth uses loopback by default and preserves an IPv6 loopback callback", () => {
    expect(resolveOAuthCallbackServerOptions()).toEqual({ hostname: "127.0.0.1" })
    expect(getAntigravityOAuthRedirectUri(51121)).toBe("http://127.0.0.1:51121/oauth-callback")
    expect(resolveOAuthCallbackServerOptions("http://[::1]:51121/oauth-callback")).toEqual({
        hostname: "::1",
        port: 51121,
        fixedPort: true,
    })
})

test("Antigravity OAuth uses an S256 PKCE challenge when a verifier is supplied", () => {
    const verifier = "test-verifier"
    const url = new URL(generateAuthURL("http://127.0.0.1:51121/oauth-callback", "state", verifier))
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("code_challenge")).toBe(generateCodeChallenge(verifier))
})

test("Antigravity OAuth stores each verifier under its state and consumes it once", () => {
    const session = createOAuthPkceSession()
    expect(consumeOAuthPkceVerifier(`${session.state}-other`)).toBeNull()
    expect(consumeOAuthPkceVerifier(session.state)).toBe(session.codeVerifier)
    expect(consumeOAuthPkceVerifier(session.state)).toBeNull()
})

test("Antigravity token exchange submits the PKCE verifier", async () => {
    const session = createOAuthPkceSession()
    const originalFetch = globalThis.fetch
    let submittedVerifier: string | null = null
    try {
        globalThis.fetch = (async (_input, init) => {
            submittedVerifier = new URLSearchParams(String(init?.body || "")).get("code_verifier")
            return new Response(JSON.stringify({
                access_token: "test-access-token",
                refresh_token: "test-refresh-token",
                expires_in: 3600,
            }), { status: 200 })
        }) as typeof fetch

        await exchangeCode("test-code", "http://127.0.0.1:51121/oauth-callback", session.codeVerifier)
        expect(submittedVerifier).toBe(session.codeVerifier)
    } finally {
        globalThis.fetch = originalFetch
        discardOAuthPkceSession(session.state)
    }
})

test("Antigravity OAuth keeps explicit callbacks on loopback", () => {
    expect(resolveOAuthCallbackServerOptions("http://localhost:51121/oauth-callback")).toEqual({
        hostname: "127.0.0.1",
        port: 51121,
        fixedPort: true,
    })
    expect(() => resolveOAuthCallbackServerOptions("http://example.test:51121/oauth-callback")).toThrow()
})

test("Docker OAuth callback relay binds the container listener while keeping loopback redirects", () => {
    process.env.ANTI_API_DOCKER_OAUTH_CALLBACK = "1"
    expect(resolveOAuthCallbackServerOptions()).toEqual({ hostname: "0.0.0.0" })
    expect(resolveOAuthCallbackServerOptions("http://localhost:51121/oauth-callback")).toEqual({
        hostname: "0.0.0.0",
        port: 51121,
        fixedPort: true,
    })
    expect(() => resolveOAuthCallbackServerOptions("http://[::1]:51121/oauth-callback")).toThrow()
})

test("Antigravity OAuth rejects unsafe or incomplete callback overrides", () => {
    expect(() => resolveOAuthCallbackServerOptions("https://example.test:51121/oauth-callback")).toThrow()
    expect(() => resolveOAuthCallbackServerOptions("http://example.test/callback")).toThrow()
    expect(() => resolveOAuthCallbackServerOptions("http://user:pass@example.test:51121/oauth-callback")).toThrow()
})
