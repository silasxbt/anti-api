import { expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

const repositoryRoot = join(import.meta.dir, "..")
const rustSource = readFileSync(join(repositoryRoot, "rust-proxy/src/main.rs"), "utf8")
const bridgeSource = readFileSync(join(repositoryRoot, "src/lib/rust-proxy.ts"), "utf8")

test("Rust sidecar requires and checks the process token before decoding the proxy body", () => {
    expect(rustSource).toContain('const SIDECAR_TOKEN_ENV: &str = "ANTI_API_SIDECAR_TOKEN"')
    expect(rustSource).toContain('const SIDECAR_TOKEN_HEADER: &str = "x-anti-api-sidecar-token"')
    expect(rustSource).toContain("if !has_valid_sidecar_token(request.headers(), &state.sidecar_token)")
    expect(rustSource).toContain("Json::<ProxyRequest>::from_request(request, &state).await")
    expect(rustSource.indexOf("has_valid_sidecar_token(request.headers()"))
        .toBeLessThan(rustSource.indexOf("Json::<ProxyRequest>::from_request(request"))
})

test("Rust sidecar remains loopback-only and has no permissive CORS layer", () => {
    expect(rustSource).toContain('format!("127.0.0.1:{}", LISTEN_PORT)')
    expect(rustSource).not.toContain("CorsLayer")
    expect(rustSource).not.toContain("allow_origin(Any)")
})

test("TypeScript generates one in-memory token for spawn and proxy requests", () => {
    expect(bridgeSource).toContain('const sidecarToken = randomBytes(32).toString("base64url")')
    expect(bridgeSource).toContain("[SIDECAR_TOKEN_ENV]: sidecarToken")
    expect(bridgeSource).toContain("[SIDECAR_TOKEN_HEADER]: sidecarToken")
    expect(bridgeSource).not.toMatch(/writeFile|Bun\.write/)
})

test("packaged runtime registers process-exit cleanup for direct CLI exits", () => {
    const source = readFileSync(join(import.meta.dir, "../src/packaged-main.ts"), "utf8")
    expect(source).toContain('process.on("exit"')
    expect(source).toContain("stopRustProxy()")
})
