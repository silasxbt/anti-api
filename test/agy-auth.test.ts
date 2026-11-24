import { expect, test } from "bun:test"
import { readAgyCredentials, getAgyAuthStatus, exchangeAuthCode } from "~/services/antigravity/agy-auth"
import { getAntigravityAuthUrl, cleanAuthCode } from "~/services/antigravity/oauth"
import { loginWithAuthCode, getAntigravityLoginUrl } from "~/services/antigravity/login"

test("getAgyAuthStatus returns valid structure", async () => {
    const status = await getAgyAuthStatus()
    expect(status).toHaveProperty("installed")
    expect(status).toHaveProperty("loggedIn")
    expect(typeof status.installed).toBe("boolean")
    expect(typeof status.loggedIn).toBe("boolean")
})

test("exchangeAuthCode rejects empty code", async () => {
    const result = await exchangeAuthCode("   ")
    expect(result.success).toBe(false)
    expect(result.error).toContain("cannot be empty")
})

test("getAntigravityLoginUrl generates zero-port OAuth URL with antigravity.google callback and PKCE", () => {
    const url = getAntigravityLoginUrl()
    expect(url).toContain("https://accounts.google.com/o/oauth2/v2/auth")
    expect(url).toContain("redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback")
    expect(url).toContain("code_challenge=")
    expect(url).toContain("code_challenge_method=S256")
    expect(url).toContain("app_domain=https%3A%2F%2Fantigravity.google")
    expect(url).toContain("response_type=code")
    expect(url).toContain("access_type=offline")
    expect(url).not.toContain("51121")
    expect(url).not.toContain("localhost")
})

test("cleanAuthCode extracts code from raw string and full callback URL", () => {
    expect(cleanAuthCode("4/0Abc123_xyz")).toBe("4/0Abc123_xyz")
    expect(cleanAuthCode("  4/0Abc123_xyz  ")).toBe("4/0Abc123_xyz")
    expect(cleanAuthCode("https://antigravity.google/oauth-callback?code=4%2F0Abc123_xyz&scope=email")).toBe("4/0Abc123_xyz")
})

test("loginWithAuthCode rejects empty code", async () => {
    const result = await loginWithAuthCode("   ")
    expect(result.success).toBe(false)
    expect(result.error).toContain("cannot be empty")
})
