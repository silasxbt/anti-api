import { test, expect, mock, beforeAll, afterAll } from "bun:test"
import { UpstreamError } from "~/lib/error"
import type { RoutingConfig } from "~/services/routing/config"

const quotaErrorBody = JSON.stringify({
    error: {
        code: 429,
        message: "Quota exhausted",
        status: "RESOURCE_EXHAUSTED",
        details: [
            {
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                reason: "QUOTA_EXHAUSTED",
                domain: "cloudcode-pa.googleapis.com",
                metadata: { model: "claude-opus-4-5-thinking" },
            },
        ],
    },
})

function makeQuotaError(): UpstreamError {
    return new UpstreamError("antigravity", 429, quotaErrorBody)
}

function makeModelMismatchError(): UpstreamError {
    return new UpstreamError("antigravity", 404, "model-account mismatch")
}

let scenario: "none" | "head-exhausted" | "probe-head" | "stream-wrap" = "head-exhausted"
const callOrder: string[] = []
const callCounts = new Map<string, number>()
let rateLimitAll = false
const routingConfig: RoutingConfig = {
    version: 2,
    updatedAt: new Date().toISOString(),
    flows: [
        {
            id: "flow-head",
            name: "flow-head",
            entries: [
                { id: "e1", provider: "antigravity", accountId: "acc1", modelId: "claude-opus-4-5-thinking", label: "Opus 1" },
                { id: "e2", provider: "antigravity", accountId: "acc2", modelId: "claude-opus-4-5-thinking", label: "Opus 2" },
                { id: "e3", provider: "antigravity", accountId: "acc3", modelId: "claude-opus-4-5-thinking", label: "Opus 3" },
            ],
        },
        {
            id: "flow-probe",
            name: "flow-probe",
            entries: [
                { id: "p1", provider: "antigravity", accountId: "b1", modelId: "claude-opus-4-5-thinking", label: "Opus 1" },
                { id: "p2", provider: "antigravity", accountId: "b2", modelId: "claude-opus-4-5-thinking", label: "Opus 2" },
                { id: "p3", provider: "antigravity", accountId: "b3", modelId: "claude-opus-4-5-thinking", label: "Opus 3" },
            ],
        },
        {
            id: "flow-rate-limit",
            name: "flow-rate-limit",
            entries: [
                { id: "r1", provider: "antigravity", accountId: "r1", modelId: "claude-opus-4-5-thinking", label: "Opus 1" },
                { id: "r2", provider: "antigravity", accountId: "r2", modelId: "claude-opus-4-5-thinking", label: "Opus 2" },
            ],
        },
        {
            id: "flow-stream-wrap",
            name: "flow-stream-wrap",
            entries: [
                { id: "s1", provider: "antigravity", accountId: "s1", modelId: "claude-opus-4-5-thinking", label: "Opus 1" },
                { id: "s2", provider: "antigravity", accountId: "s2", modelId: "claude-opus-4-5-thinking", label: "Opus 2" },
                { id: "s3", provider: "antigravity", accountId: "s3", modelId: "claude-opus-4-5-thinking", label: "Opus 3" },
            ],
        },
    ],
    accountRouting: { smartSwitch: false, routes: [] },
}

function resetTracking(resetCounts: boolean) {
    callOrder.length = 0
    if (resetCounts) {
        callCounts.clear()
    }
}

mock.module("~/services/antigravity/chat", () => ({
    createChatCompletionWithOptions: async (_request: any, options: { accountId?: string }) => {
        const accountId = options?.accountId || "auto"
        callOrder.push(accountId)
        callCounts.set(accountId, (callCounts.get(accountId) ?? 0) + 1)

        if (scenario === "head-exhausted") {
            if (accountId === "acc1") throw makeQuotaError()
        }

        if (scenario === "probe-head") {
            if (accountId === "b1") throw makeQuotaError()
            if (accountId === "b2") {
                const count = callCounts.get(accountId) ?? 0
                if (count >= 2) throw makeQuotaError()
            }
        }

        return {
            contentBlocks: [{ type: "text", text: "ok" }],
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
        }
    },
    createChatCompletionStreamWithOptions: async function* (_request: any, options?: { accountId?: string }) {
        const accountId = options?.accountId || "auto"
        callOrder.push(accountId)
        const count = (callCounts.get(accountId) ?? 0) + 1
        callCounts.set(accountId, count)

        if (scenario === "stream-wrap") {
            if (accountId === "s1" && count === 1) throw makeModelMismatchError()
            if (accountId === "s2" && count >= 2) throw makeModelMismatchError()
            if (accountId === "s3") throw makeModelMismatchError()
        }
        yield ""
    },
}))

mock.module("~/services/antigravity/account-manager", () => ({
    accountManager: {
        hasAccount: () => true,
        isAccountRateLimited: () => rateLimitAll,
        isAccountInFlight: () => false,
        markRateLimitedFromError: async () => ({ reason: "quota_exhausted", durationMs: 60_000 }),
        clearAllRateLimits: () => { },
    },
}))

mock.module("~/services/routing/config", () => ({
    loadRoutingConfig: () => routingConfig,
}))

let createRoutedCompletion: (request: any) => Promise<any>
let createRoutedCompletionStream: (request: any) => AsyncGenerator<string, void, unknown>

beforeAll(async () => {
    const router = await import(`../src/services/routing/router.ts?${Date.now()}-${Math.random()}`)
    createRoutedCompletion = router.createRoutedCompletion
    createRoutedCompletionStream = router.createRoutedCompletionStream
})

afterAll(() => {
    mock.restore()
})

test("flow sticky skips exhausted head on subsequent requests", async () => {
    scenario = "head-exhausted"
    rateLimitAll = false
    resetTracking(true)

    await createRoutedCompletion({
        model: "flow-head",
        messages: [{ role: "user", content: "hi" }],
    })
    expect(callOrder).toEqual(["acc1", "acc2"])

    resetTracking(false)
    await createRoutedCompletion({
        model: "flow-head",
        messages: [{ role: "user", content: "hi again" }],
    })
    expect(callOrder).toEqual(["acc2"])
})

test("flow sticky probes head only when current account is exhausted", async () => {
    scenario = "probe-head"
    rateLimitAll = false
    resetTracking(true)

    await createRoutedCompletion({
        model: "flow-probe",
        messages: [{ role: "user", content: "start" }],
    })
    expect(callOrder).toEqual(["b1", "b2"])

    resetTracking(false)
    await createRoutedCompletion({
        model: "flow-probe",
        messages: [{ role: "user", content: "next" }],
    })
    expect(callOrder).toEqual(["b2", "b3"])

    resetTracking(false)
    await createRoutedCompletion({
        model: "flow-probe",
        messages: [{ role: "user", content: "again" }],
    })
    expect(callOrder).toEqual(["b3"])
})

test("flow sticky falls back to cursor when all entries are rate limited", async () => {
    scenario = "none"
    rateLimitAll = true
    resetTracking(true)

    await createRoutedCompletion({
        model: "flow-rate-limit",
        messages: [{ role: "user", content: "rate limit" }],
    })
    expect(callOrder).toEqual(["r1"])
})

test("flow sticky stream failover wraps around the sticky cursor", async () => {
    scenario = "stream-wrap"
    rateLimitAll = false
    resetTracking(true)

    const consume = async () => {
        const chunks: string[] = []
        for await (const chunk of createRoutedCompletionStream({
            model: "flow-stream-wrap",
            messages: [{ role: "user", content: "stream" }],
        })) {
            chunks.push(chunk)
        }
        return chunks
    }

    await consume()
    expect(callOrder).toEqual(["s1", "s2"])

    resetTracking(false)
    await consume()
    expect(callOrder).toEqual(["s2", "s3", "s1"])
})
