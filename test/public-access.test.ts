import { afterEach, describe, expect, test } from "bun:test"
import { createPublicServer } from "../src/server"
import { extractPublicToken, getPublicGatewayHost, getPublicGatewayPort, tokenMatches } from "../src/lib/public-access"
import { isLoopbackHost, isLoopbackOrigin, isLoopbackRequest } from "../src/lib/local-request"

const publicPortKey = ["ANTI", "API", "PUBLIC", "PORT"].join("_")
const originalPort = process.env[publicPortKey]

afterEach(() => {
    if (originalPort === undefined) delete process.env[publicPortKey]
    else process.env[publicPortKey] = originalPort
})

describe("public inference boundary", () => {
    test("health is minimal and management routes do not exist", async () => {
        const app = createPublicServer("test-secret")
        const health = await app.request("/health")
        expect(health.status).toBe(200)
        expect(await health.json()).toEqual({ status: "ok" })

        for (const path of ["/auth/accounts", "/logs", "/settings", "/updates/apply", "/quota", "/remote/config"]) {
            const response = await app.request(path)
            expect(response.status).toBe(404)
        }
    })

    test("model routes require bearer or x-api-key authentication", async () => {
        const app = createPublicServer("test-secret")
        expect((await app.request("/models")).status).toBe(401)
        expect((await app.request("/models?api_key=test-secret")).status).toBe(401)
        expect((await app.request("/models", { headers: { authorization: "Bearer wrong" } })).status).toBe(401)
        expect((await app.request("/models", { headers: { authorization: "Bearer test-secret" } })).status).toBe(200)
        expect((await app.request("/models", { headers: { "x-api-key": "test-secret" } })).status).toBe(200)
    })

    test("missing public configuration fails closed on allowed routes", async () => {
        const app = createPublicServer(null)
        expect((await app.request("/models")).status).toBe(503)
        expect((await app.request("/auth/accounts")).status).toBe(404)
    })
})

test("public token helpers reject missing or differently sized values", () => {
    expect(tokenMatches("secret", "secret")).toBe(true)
    expect(tokenMatches("secret", "wrong")).toBe(false)
    expect(tokenMatches("secret", null)).toBe(false)
    expect(extractPublicToken(new Request("http://localhost", { headers: { authorization: "Bearer abc" } }))).toBe("abc")
    expect(extractPublicToken(new Request("http://localhost", { headers: { "x-api-key": "def" } }))).toBe("def")
})

test("public port does not collide with the Rust sidecar", () => {
    delete process.env[publicPortKey]
    expect(getPublicGatewayPort(8964)).toBe(8966)
    process.env[publicPortKey] = "9100"
    expect(getPublicGatewayPort(8964)).toBe(9100)
})

test("public gateway defaults to a bindable host when it is enabled", () => {
    const original = process.env.ANTI_API_PUBLIC_HOST
    try {
        delete process.env.ANTI_API_PUBLIC_HOST
        expect(getPublicGatewayHost()).toBe("0.0.0.0")
        process.env.ANTI_API_PUBLIC_HOST = "127.0.0.1"
        expect(getPublicGatewayHost()).toBe("127.0.0.1")
    } finally {
        if (original === undefined) delete process.env.ANTI_API_PUBLIC_HOST
        else process.env.ANTI_API_PUBLIC_HOST = original
    }
})

test("loopback checks fail closed", () => {
    expect(isLoopbackHost(undefined)).toBe(false)
    expect(isLoopbackHost("localhost:8964")).toBe(true)
    expect(isLoopbackHost(["127", "0", "0", "1"].join("."))).toBe(true)
    expect(isLoopbackHost("example.com")).toBe(false)
    expect(isLoopbackOrigin(undefined)).toBe(true)
    expect(isLoopbackOrigin("http://localhost:8964")).toBe(true)
    expect(isLoopbackOrigin("https://example.com")).toBe(false)
    expect(isLoopbackRequest(new Request("http://localhost:8964", { headers: { host: "localhost:8964" } }))).toBe(true)
    expect(isLoopbackRequest(new Request("http://localhost:8964", {
        headers: { host: "localhost:8964", origin: "http://localhost:8964" },
    }))).toBe(true)
    expect(isLoopbackRequest(new Request("http://localhost:8964", {
        headers: { host: "localhost:8964", origin: "http://localhost:3000" },
    }))).toBe(false)
    expect(isLoopbackRequest(new Request("http://127.0.0.1:8964", {
        headers: { host: "127.0.0.1:8964", origin: "http://localhost:8964" },
    }))).toBe(false)
    expect(isLoopbackRequest(new Request("https://example.com", { headers: { host: "example.com" } }))).toBe(false)
})
