import { expect, test } from "bun:test"
import { RequestValidationError } from "~/lib/error"
import { parseBoundedJson } from "~/lib/request-body"

test("bounded JSON parser accepts a complete JSON request", async () => {
    const request = new Request("http://localhost/test", {
        method: "POST",
        body: JSON.stringify({ model: "test" }),
    })
    await expect(parseBoundedJson<{ model: string }>(request, 64)).resolves.toEqual({ model: "test" })
})

test("bounded JSON parser rejects a declared oversized or invalid request body", async () => {
    const body = JSON.stringify({ model: "too-large" })
    const oversized = new Request("http://localhost/test", {
        method: "POST",
        headers: { "content-length": String(Buffer.byteLength(body)) },
        body,
    })
    await expect(parseBoundedJson(oversized, 8)).rejects.toBeInstanceOf(RequestValidationError)

    const malformed = new Request("http://localhost/test", { method: "POST", body: "{" })
    await expect(parseBoundedJson(malformed, 64)).rejects.toBeInstanceOf(RequestValidationError)
})
