import consola from "consola"
import https from "https"
import { authStore } from "~/services/auth/store"
import { UpstreamError } from "~/lib/error"
import type { ProviderAccount } from "~/services/auth/types"
import type { ClaudeMessage, ClaudeTool } from "~/lib/translator"
import { toOpenAIMessages, toOpenAITools } from "~/services/providers/openai-adapter"
import { createAbortError, isAbortError, throwIfAborted } from "~/lib/stream-cancellation"
import { safeErrorMessage } from "~/lib/redaction"

const COPILOT_INSECURE_TLS = process.env.ANTI_API_COPILOT_INSECURE_TLS === "1"
const COPILOT_INSECURE_AGENT = COPILOT_INSECURE_TLS ? new https.Agent({ rejectUnauthorized: false }) : undefined

export function isCopilotInsecureTlsEnabled(): boolean {
    return COPILOT_INSECURE_TLS
}

const COPILOT_COMPLETIONS_URL = "https://api.githubcopilot.com/chat/completions"
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token"
const COPILOT_MODELS_URL = "https://api.githubcopilot.com/models"

interface CopilotTokenResponse {
    token: string
    expires_at?: number
}

export interface CopilotModelInfo {
    id: string
    name?: string
    model_picker_enabled?: boolean
    vendor?: string
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>()
const modelsCache = new Map<string, { models: CopilotModelInfo[]; expiresAt: number }>()

function normalizeCopilotModels(models: CopilotModelInfo[]): CopilotModelInfo[] {
    const deduped = new Map<string, CopilotModelInfo>()

    for (const model of models) {
        const id = model?.id?.trim()
        if (!id) continue
        if (model.model_picker_enabled === false) continue
        if (deduped.has(id)) continue

        deduped.set(id, {
            ...model,
            id,
        })
    }

    return Array.from(deduped.values())
}

// Map internal model names to Copilot API compatible names
// Based on GitHub Copilot Pro supported models:
// Anthropic: claude-haiku-4.5, claude-opus-4.1, claude-opus-4.5, claude-sonnet-4, claude-sonnet-4.5
// OpenAI: gpt-4.1, gpt-4o, gpt-5, gpt-5-mini, gpt-5.1, gpt-5.1-codex, gpt-5.1-codex-max, gpt-5.2
// Google: gemini-2.5-pro, gemini-3-flash, gemini-3-pro
function mapCopilotModelName(model: string): string {
    const modelMappings: Record<string, string> = {
        // Claude models - map hyphenated to dotted format
        "claude-sonnet-4-5": "claude-sonnet-4.5",
        "claude-sonnet-4-5-thinking": "claude-sonnet-4.5", // No thinking variant in Copilot
        "claude-opus-4-5": "claude-opus-4.5",
        "claude-opus-4-5-thinking": "claude-opus-4.5",
        "claude-opus-4-1": "claude-opus-4.1",
        "claude-haiku-4-5": "claude-haiku-4.5",
        "claude-sonnet-4": "claude-sonnet-4",
        // GPT models
        "gpt-4.1": "gpt-4.1",
        "gpt-4.1-mini": "gpt-4.1-mini",
        "gpt-4o": "gpt-4o",
        "gpt-4o-mini": "gpt-4o-mini",
        "gpt-5": "gpt-5",
        "gpt-5-mini": "gpt-5-mini",
        "gpt-5.1": "gpt-5.1",
        "gpt-5.1-codex": "gpt-5.1-codex",
        "gpt-5.2": "gpt-5.2",
        // Gemini models
        "gemini-2.5-pro": "gemini-2.5-pro",
        "gemini-3-flash": "gemini-3-flash",
        "gemini-3-pro": "gemini-3-pro",
    }

    const mapped = modelMappings[model]
    if (mapped) {
        return mapped
    }
    return model
}

interface OpenAIResponse {
    choices: Array<{
        message?: { content?: string | null; tool_calls?: any[] }
        finish_reason?: string | null
    }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
}

export async function createCopilotCompletion(
    account: ProviderAccount,
    model: string,
    messages: ClaudeMessage[],
    tools?: ClaudeTool[],
    maxTokens?: number,
    signal?: AbortSignal
) {
    throwIfAborted(signal)
    const apiToken = await getCopilotApiToken(account, signal)

    // Fetch and log available models (first call will log, subsequent uses cache)
    await fetchCopilotModels(apiToken, signal)
    throwIfAborted(signal)

    // Map model name to Copilot-compatible format
    const mappedModel = mapCopilotModelName(model)

    const requestBody = {
        model: mappedModel,
        messages: toOpenAIMessages(messages),
        tools: toOpenAITools(tools),
        max_tokens: maxTokens,
    }

    const response = await fetchInsecureJson(COPILOT_COMPLETIONS_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiToken}`,
            "User-Agent": "anti-api/1.0",
            "Editor-Version": "vscode/1.95.0",
            "Editor-Plugin-Version": "copilot/1.300.0",
        },
        body: JSON.stringify(requestBody),
        signal,
    })

    if (response.status < 200 || response.status >= 300) {
        consola.error(`Copilot error ${response.status} for model ${mappedModel}`)
        throw new UpstreamError("copilot", response.status, response.text, undefined)
    }

    const data = response.data as OpenAIResponse
    const choice = data?.choices?.[0]
    const content = choice?.message?.content || ""
    const toolCalls = choice?.message?.tool_calls || []

    const contentBlocks = []
    if (toolCalls.length > 0) {
        for (const call of toolCalls) {
            contentBlocks.push({
                type: "tool_use" as const,
                id: call.id || `tool_${crypto.randomUUID().slice(0, 8)}`,
                name: call.function?.name || "tool",
                input: safeParse(call.function?.arguments),
            })
        }
    }
    if (content) {
        contentBlocks.push({ type: "text" as const, text: content })
    }

    authStore.markSuccess("copilot", account.id)

    return {
        contentBlocks,
        stopReason: toolCalls.length > 0 ? "tool_use" : mapFinishReason(choice?.finish_reason),
        usage: {
            inputTokens: data.usage?.prompt_tokens || 0,
            outputTokens: data.usage?.completion_tokens || 0,
        },
    }
}

export async function listCopilotModelsForAccount(account: ProviderAccount, signal?: AbortSignal): Promise<CopilotModelInfo[]> {
    const apiToken = await getCopilotApiToken(account, signal)
    return fetchCopilotModels(apiToken, signal)
}

async function getCopilotApiToken(account: ProviderAccount, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal)
    const cached = tokenCache.get(account.id)
    if (cached && cached.expiresAt > Date.now()) {
        return cached.token
    }

    const response = await fetchInsecureJson(COPILOT_TOKEN_URL, {
        method: "GET",
        headers: {
            Authorization: `Bearer ${account.accessToken}`,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        signal,
    })

    const data = response.data as CopilotTokenResponse
    if (response.status < 200 || response.status >= 300 || !data?.token) {
        throw new Error(`copilot:token:${response.status}`)
    }

    const expiresAt = data.expires_at ? data.expires_at * 1000 : Date.now() + 10 * 60 * 1000
    tokenCache.set(account.id, { token: data.token, expiresAt })
    return data.token
}

function safeParse(value: string | undefined): any {
    if (!value) return {}
    try {
        return JSON.parse(value)
    } catch (error) {
        consola.warn("Copilot tool args parse failed:", safeErrorMessage(error))
        return {}
    }
}

function mapFinishReason(reason?: string | null): string {
    if (!reason || reason === "stop") return "end_turn"
    if (reason === "length") return "max_tokens"
    if (reason === "tool_calls") return "tool_use"
    return reason
}

async function fetchCopilotModels(apiToken: string, signal?: AbortSignal): Promise<CopilotModelInfo[]> {
    throwIfAborted(signal)
    const cached = modelsCache.get(apiToken)
    if (cached && cached.expiresAt > Date.now()) {
        return cached.models
    }

    try {
        const response = await fetchInsecureJson(COPILOT_MODELS_URL, {
            method: "GET",
            headers: {
                Authorization: `Bearer ${apiToken}`,
                "Accept": "application/json",
                "User-Agent": "GithubCopilot/1.0",
                "Editor-Version": "vscode/1.100.0",
                "Editor-Plugin-Version": "copilot/1.300.0",
            },
            signal,
        })

        if (response.status < 200 || response.status >= 300) {
            consola.warn("Failed to fetch Copilot models:", response.status)
            return []
        }

        const data = response.data as { data: CopilotModelInfo[] }
        const models = normalizeCopilotModels(data?.data || [])

        modelsCache.set(apiToken, { models, expiresAt: Date.now() + 5 * 60 * 1000 })
        return models
    } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
            throw createAbortError()
        }
        consola.warn("Error fetching Copilot models:", safeErrorMessage(error))
        return []
    }
}

// Insecure JSON fetch using Node.js https module to bypass TLS certificate errors
type InsecureResponse = { status: number; data: any; text: string }

async function fetchInsecureJson(
    url: string,
    options: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }
): Promise<InsecureResponse> {
    throwIfAborted(options.signal)
    const target = new URL(url)
    const method = options.method || "GET"
    const headers = {
        "User-Agent": "anti-api/1.0",
        ...(options.headers || {}),
    }
    const agent = COPILOT_INSECURE_AGENT

    return new Promise((resolve, reject) => {
        let settled = false
        let req: ReturnType<typeof https.request>
        const cleanup = () => options.signal?.removeEventListener("abort", onAbort)
        const resolveOnce = (value: InsecureResponse) => {
            if (settled) return
            settled = true
            cleanup()
            resolve(value)
        }
        const rejectOnce = (error: unknown) => {
            if (settled) return
            settled = true
            cleanup()
            reject(error)
        }
        const onAbort = () => {
            if (settled) return
            req?.destroy()
            rejectOnce(createAbortError())
        }

        req = https.request(
            {
                protocol: target.protocol,
                hostname: target.hostname,
                port: target.port || 443,
                path: `${target.pathname}${target.search}`,
                method,
                headers,
                agent,
                rejectUnauthorized: agent ? false : true,
                timeout: 30000,
            },
            (res) => {
                let body = ""
                res.on("data", (chunk) => {
                    body += chunk
                })
                res.on("end", () => {
                    let data: any = null
                    if (body) {
                        try {
                            data = JSON.parse(body)
                        } catch {
                            data = null
                        }
                    }
                    resolveOnce({
                        status: res.statusCode || 0,
                        data,
                        text: body,
                    })
                })
            }
        )

        req.on("error", (error) => {
            if (options.signal?.aborted || isAbortError(error)) {
                rejectOnce(createAbortError())
                return
            }
            if (!COPILOT_INSECURE_TLS && /certificate|self signed/i.test(error.message)) {
                rejectOnce(new Error("Copilot TLS certificate error. Set ANTI_API_COPILOT_INSECURE_TLS=1 to bypass."))
                return
            }
            rejectOnce(error)
        })
        req.on("timeout", () => {
            req.destroy(new Error("Request timed out"))
        })

        if (options.signal) {
            if (options.signal.aborted) {
                onAbort()
                return
            }
            options.signal.addEventListener("abort", onAbort, { once: true })
        }

        if (options.body) {
            req.write(options.body)
        }
        req.end()
    })
}
