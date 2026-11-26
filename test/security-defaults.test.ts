import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { ensurePrivateDir, tightenPrivateFile, writePrivateFile } from "../src/lib/private-file"
import { redactSensitiveText } from "../src/lib/redaction"

const root = mkdtempSync(join(tmpdir(), "anti-api-private-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

test("private file helper creates owner-only POSIX paths", () => {
    const dir = join(root, "data")
    const file = join(dir, "credential.json")
    ensurePrivateDir(dir)
    writePrivateFile(file, JSON.stringify({ token: "secret" }))
    expect(readFileSync(file, "utf8")).toContain("secret")
    if (process.platform !== "win32") {
        expect(statSync(dir).mode & 0o777).toBe(0o700)
        expect(statSync(file).mode & 0o777).toBe(0o600)
        writeFileSync(file, "wide", { mode: 0o644 })
        tightenPrivateFile(file)
        expect(statSync(file).mode & 0o777).toBe(0o600)
    }
})

test("redaction removes common credential material", () => {
    const original = 'Authorization: Bearer [密钥]\nrefresh_token=[密钥]\nemail=user@example.com\nurl=https://example.com/cb?code=abc&state=def'
    const redacted = redactSensitiveText(original)
    expect(redacted).not.toContain("abc.def.ghi")
    expect(redacted).not.toContain("refresh-secret")
    expect(redacted).not.toContain("code=abc")
    expect(redacted).not.toContain("state=def")
    expect(redacted).not.toContain("user@example.com")
    expect(redacted).toContain("[REDACTED]")
})

test("source contains secure defaults for high-risk credential paths", () => {
    const rootDir = join(import.meta.dir, "..")
    const dockerfile = readFileSync(join(rootDir, "Dockerfile"), "utf8")
    const codex = readFileSync(join(rootDir, "src/services/codex/oauth.ts"), "utf8")
    const kiro = readFileSync(join(rootDir, "src/services/kiro/oauth.ts"), "utf8")
    const antigravity = readFileSync(join(rootDir, "src/services/antigravity/oauth.ts"), "utf8")
    const copilot = readFileSync(join(rootDir, "src/services/copilot/oauth.ts"), "utf8")
    const quota = readFileSync(join(rootDir, "src/services/quota-aggregator.ts"), "utf8")

    expect(dockerfile).toContain("ENV ANTI_API_CONTAINER_CONTROL_PLANE=1")
    expect(dockerfile).toContain('test -n "$ANTI_API_CONTROL_TOKEN"')
    expect(codex).not.toContain("token.oaifree.com")
    expect(codex).toContain("ANTI_API_ALLOW_THIRD_PARTY_CODEX_REFRESH")
    expect(kiro).toContain('ANTI_API_KIRO_WRITEBACK !== "1"')
    expect(antigravity).not.toContain("rejectUnauthorized: false")
    expect(copilot).not.toContain("rejectUnauthorized: false")
    expect(quota).not.toContain("rejectUnauthorized: false")
})

test("diagnostic error responses use redacted messages", () => {
    const rootDir = join(import.meta.dir, "..")
    const authRoute = readFileSync(join(rootDir, "src/routes/auth/route.ts"), "utf8")

    expect(authRoute).toContain('import { safeErrorMessage } from "~/lib/redaction"')
    expect(authRoute).not.toContain('error: (error as Error).message')
    expect(authRoute).not.toContain('error: error.message')
})

test("remote controls mask saved tokens and require a public gateway token", () => {
    const rootDir = join(import.meta.dir, "..")
    const remoteRoute = readFileSync(join(rootDir, "src/routes/remote/route.ts"), "utf8")
    const tunnel = readFileSync(join(rootDir, "src/services/tunnel-manager.ts"), "utf8")
    const remotePage = readFileSync(join(rootDir, "public/remote.html"), "utf8")

    expect(remoteRoute).toContain("clearSavedNgrokAuthtoken")
    expect(tunnel).toContain("ngrokAuthtokenConfigured")
    expect(tunnel).toContain("ngrokAuthtokenMasked")
    expect(tunnel).toContain("getPublicGatewayToken")
    expect(tunnel).not.toContain("killall")
    expect(tunnel).not.toContain("ensureNgrokBinary")
    expect(remotePage).toContain('type="password" id="ngrok-authtoken"')
    expect(remotePage).toContain("clearAuthtoken")
    expect(remotePage).not.toContain("data.ngrokAuthtoken;")
})
