import { afterAll, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { summarizeUpstreamError, UpstreamError } from "../src/lib/error"
import {
    getZedCredentialsStatus,
    parseZedCredentialJson,
    ZED_CREDENTIALS_ENV,
    ZedCredentialImportError,
} from "../src/services/zed/oauth"

const root = mkdtempSync(join(tmpdir(), "anti-api-zed-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

test("Zed credential JSON accepts the documented fields and ignores extras", () => {
    expect(parseZedCredentialJson(JSON.stringify({
        type: "zed",
        id: "user-123",
        access_token: "token-456",
        ignored: "value",
    }))).toEqual({ id: "user-123", accessToken: "token-456" })
})

test("Zed credential JSON rejects malformed or non-Zed records", () => {
    expect(() => parseZedCredentialJson("not-json")).toThrow(ZedCredentialImportError)
    expect(() => parseZedCredentialJson(JSON.stringify({ type: "other", id: "u", access_token: "t" }))).toThrow(ZedCredentialImportError)
    expect(() => parseZedCredentialJson(JSON.stringify({ type: "zed", id: "u" }))).toThrow(ZedCredentialImportError)
})

test("credential status checks an absolute owner-only file", () => {
    const path = join(root, "zed.json")
    writeFileSync(path, JSON.stringify({ type: "zed", id: "u", access_token: "t" }), { mode: 0o600 })
    chmodSync(path, 0o600)
    expect(getZedCredentialsStatus({ [ZED_CREDENTIALS_ENV]: path })).toBe("ready")

    if (process.platform !== "win32") {
        chmodSync(path, 0o644)
        expect(getZedCredentialsStatus({ [ZED_CREDENTIALS_ENV]: path })).toBe("invalid")
        chmodSync(path, 0o600)
        const linkPath = join(root, "zed-link.json")
        symlinkSync(path, linkPath)
        expect(getZedCredentialsStatus({ [ZED_CREDENTIALS_ENV]: linkPath })).toBe("invalid")
    }
    expect(getZedCredentialsStatus({ [ZED_CREDENTIALS_ENV]: "relative.json" })).toBe("invalid")
    expect(getZedCredentialsStatus({})).toBe("not_configured")
})

test("diagnostics does not depend on macOS Zed or shell utilities", () => {
    const source = readFileSync(new URL("../src/services/auth/diagnostics.ts", import.meta.url), "utf8")
    expect(source).not.toContain("/Applications/Zed.app")
    expect(source).not.toContain("security find-internet-password")
    expect(source).not.toContain("/bin/zsh")
    expect(source).not.toContain("lsof")

    const chat = readFileSync(new URL("../src/services/zed/chat.ts", import.meta.url), "utf8")
    expect(chat).not.toContain("http://localhost:3000")
    expect(chat).not.toContain("https://staging.zed.dev")
})

test("Zed authorization failures tell the user how to re-import credentials", () => {
    const expected = "Zed authorization is no longer valid for this account. Update the configured credentials file, then re-import the account."
    expect(summarizeUpstreamError(new UpstreamError("zed", 401, "upstream response"))).toEqual({ message: expected })
    expect(summarizeUpstreamError(new UpstreamError("zed", 403, "upstream response"))).toEqual({ message: expected })
})
