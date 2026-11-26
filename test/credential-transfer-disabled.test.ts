import { afterAll, test, expect } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

const tempHome = mkdtempSync(join(tmpdir(), "anti-api-cred-disabled-"))
const tempDataDir = join(tempHome, ".anti-api")
mkdirSync(tempDataDir, { recursive: true })

const prevHome = process.env.HOME
const prevProfile = process.env.USERPROFILE
const prevDataDir = process.env.ANTI_API_DATA_DIR
const prevContainerControlPlane = process.env.ANTI_API_CONTAINER_CONTROL_PLANE
const prevControlToken = process.env.ANTI_API_CONTROL_TOKEN
process.env.HOME = tempHome
process.env.USERPROFILE = tempHome
process.env.ANTI_API_DATA_DIR = tempDataDir

const serverPromise = import(`../src/server.ts?${Date.now()}-${Math.random()}`).then(mod => mod.server)
const REMOVED_MESSAGE = "Credential bundle export/import has been removed."
const LOCAL_HEADERS = { host: "localhost:8964" }

afterAll(() => {
    rmSync(tempHome, { recursive: true, force: true })
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = prevProfile
    if (prevDataDir === undefined) delete process.env.ANTI_API_DATA_DIR
    else process.env.ANTI_API_DATA_DIR = prevDataDir
    if (prevContainerControlPlane === undefined) delete process.env.ANTI_API_CONTAINER_CONTROL_PLANE
    else process.env.ANTI_API_CONTAINER_CONTROL_PLANE = prevContainerControlPlane
    if (prevControlToken === undefined) delete process.env.ANTI_API_CONTROL_TOKEN
    else process.env.ANTI_API_CONTROL_TOKEN = prevControlToken
})

test("bundle export endpoint is disabled", async () => {
    const server = await serverPromise
    const res = await server.request("/bundle/export", { headers: LOCAL_HEADERS })
    expect(res.status).toBe(410)
    expect(await res.json()).toEqual({ success: false, error: REMOVED_MESSAGE })
})

test("bundle import endpoint is disabled", async () => {
    const server = await serverPromise
    const res = await server.request("/bundle/import", {
        method: "POST",
        headers: { ...LOCAL_HEADERS, "content-type": "application/json" },
        body: JSON.stringify({}),
    })
    expect(res.status).toBe(410)
    expect(await res.json()).toEqual({ success: false, error: REMOVED_MESSAGE })
})

test("auth export endpoint is disabled", async () => {
    const server = await serverPromise
    const res = await server.request("/auth/export", { headers: LOCAL_HEADERS })
    expect(res.status).toBe(410)
    expect(await res.json()).toEqual({ success: false, error: REMOVED_MESSAGE })
})

test("auth import endpoint is disabled", async () => {
    const server = await serverPromise
    const res = await server.request("/auth/import", {
        method: "POST",
        headers: { ...LOCAL_HEADERS, "content-type": "application/json" },
        body: JSON.stringify({ accounts: [] }),
    })
    expect(res.status).toBe(410)
    expect(await res.json()).toEqual({ success: false, error: REMOVED_MESSAGE })
})

test("auth status endpoint is still available", async () => {
    const server = await serverPromise
    const res = await server.request("/auth/status", { headers: LOCAL_HEADERS })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body.authenticated).toBe("boolean")
})

test("control plane does not grant CORS to arbitrary localhost ports", async () => {
    const server = await serverPromise
    const res = await server.request("/auth/status", {
        headers: { ...LOCAL_HEADERS, origin: "http://localhost:12345" },
    })
    expect(res.status).toBe(403)
    expect(res.headers.get("access-control-allow-origin")).toBeNull()
})

test("container control plane requires a token instead of trusting Host", async () => {
    const server = await serverPromise
    process.env.ANTI_API_CONTAINER_CONTROL_PLANE = "1"
    process.env.ANTI_API_CONTROL_TOKEN = "container-test-token"
    try {
        const denied = await server.request("/auth/status", { headers: { host: "localhost:8964" } })
        expect(denied.status).toBe(401)

        const allowed = await server.request("/auth/status", {
            headers: { host: "attacker.example", "x-api-key": "container-test-token" },
        })
        expect(allowed.status).toBe(200)

        const bootstrap = await server.request("/health?control_token=container-test-token", {
            headers: { host: "attacker.example" },
        })
        expect(bootstrap.status).toBe(303)
        expect(bootstrap.headers.get("location")).toBe("/health")
        expect(bootstrap.headers.get("set-cookie")).toContain("anti_api_control=")
    } finally {
        delete process.env.ANTI_API_CONTAINER_CONTROL_PLANE
        delete process.env.ANTI_API_CONTROL_TOKEN
    }
})

test("Zed import requires an explicit credential file", async () => {
    const server = await serverPromise
    const res = await server.request("/auth/login", {
        method: "POST",
        headers: { ...LOCAL_HEADERS, "content-type": "application/json" },
        body: JSON.stringify({ provider: "zed" }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error).toBe("Set ANTI_API_ZED_CREDENTIALS_FILE to an absolute, owner-only Zed credential JSON file.")
    expect(JSON.stringify(body)).not.toContain("token")
})

test("diagnostics endpoint rejects non-local hosts", async () => {
    const server = await serverPromise
    const res = await server.request("/auth/diagnostics", {
        headers: { host: "example.com" },
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({
        success: false,
        error: "The local control plane is only available through a loopback host and origin.",
    })
})

test("updates endpoint rejects non-local hosts", async () => {
    const server = await serverPromise
    const res = await server.request("/updates/check", {
        headers: { host: "example.com" },
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({
        success: false,
        error: "The local control plane is only available through a loopback host and origin.",
    })
})
