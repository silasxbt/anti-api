import { CodeWhispererStreaming, AccessDeniedException, ThrottlingException, GenerateAssistantResponseCommand } from "@aws/codewhisperer-streaming-client"
import type { ChatMessage, ImageBlock, Tool, ToolResult, ToolUse } from "@aws/codewhisperer-streaming-client"
import { Origin, ChatTriggerType, ImageFormat, ToolResultStatus } from "@aws/codewhisperer-streaming-client"
import { NodeHttpHandler } from "@smithy/node-http-handler"
import https from "https"
import { RequestValidationError, UpstreamError } from "~/lib/error"
import { fetchRemoteImageAsBase64 } from "~/lib/remote-image"
import { createImageInputBudget, decodedBase64ImageBytes, type ImageInputBudget } from "~/lib/image-input"
import { authStore } from "~/services/auth/store"
import type { ProviderAccount } from "~/services/auth/types"
import type { ClaudeMessage, ClaudeTool, ContentBlock } from "~/lib/translator"
import { refreshKiroAccountIfNeeded, getKiroEndpoint, getKiroRegion } from "./oauth"

const KIRO_DEFAULT_MODEL = "auto"
const KIRO_COMPLETION_TIMEOUT_MS = 120_000

const KIRO_STATIC_MODELS = [
    { id: "auto", name: "Auto" },
    { id: "claude-opus-4.7", name: "Claude Opus 4.7" },
    { id: "claude-opus-4.6", name: "Claude Opus 4.6" },
    { id: "claude-opus-4.5", name: "Claude Opus 4.5" },
    { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
    { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
    { id: "claude-sonnet-4.0", name: "Claude Sonnet 4.0" },
    { id: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
    { id: "glm-5", name: "GLM-5" },
    { id: "deepseek-3.2", name: "DeepSeek 3.2" },
    { id: "minimax-m2.5", name: "MiniMax M2.5" },
    { id: "minimax-m2.1", name: "MiniMax M2.1" },
    { id: "qwen3-coder-next", name: "Qwen3 Coder Next" },
]

export interface KiroModelInfo {
    id: string
    name: string
}

function messageText(message: ClaudeMessage): string {
    if (typeof message.content === "string") return message.content
    return message.content
        .filter(block => block.type === "text")
        .map(block => block.text || "")
        .join("\n")
        .trim()
}

function toolResultsFromMessage(message: ClaudeMessage): ToolResult[] {
    if (typeof message.content === "string") return []
    return message.content
        .filter(block => block.type === "tool_result")
        .map(block => ({
            toolUseId: block.tool_use_id,
            content: [{ text: typeof block.content === "string" ? block.content : JSON.stringify(block.content || "") }],
            status: (block as any).is_error ? ToolResultStatus.ERROR : ToolResultStatus.SUCCESS,
        }))
}

function toolUsesFromMessage(message: ClaudeMessage): ToolUse[] | undefined {
    if (typeof message.content === "string") return undefined

    const toolUses: ToolUse[] = []
    for (const block of message.content) {
        if (block.type !== "tool_use") continue
        if (!block.id || !block.name) {
            throw new RequestValidationError("Kiro assistant tool_use blocks must include id and name")
        }
        toolUses.push({
            toolUseId: block.id,
            name: block.name,
            input: block.input ?? {},
        })
    }

    return toolUses.length > 0 ? toolUses : undefined
}

function getKiroImageFormat(mediaType: unknown): ImageFormat {
    if (typeof mediaType !== "string") {
        throw new RequestValidationError("Kiro image blocks must include a media type")
    }
    switch (mediaType.trim().toLowerCase().split(";", 1)[0]) {
        case "image/png":
            return ImageFormat.PNG
        case "image/jpeg":
        case "image/jpg":
            return ImageFormat.JPEG
        case "image/gif":
            return ImageFormat.GIF
        case "image/webp":
            return ImageFormat.WEBP
        default:
            throw new RequestValidationError("Kiro supports only PNG, JPEG, GIF, and WebP image blocks")
    }
}

function decodeKiroImage(data: unknown): Uint8Array {
    if (typeof data !== "string") {
        throw new RequestValidationError("Kiro image blocks must include base64 image data")
    }
    const normalized = data.replace(/\s/g, "")
    if (!normalized || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized)) {
        throw new RequestValidationError("Kiro image blocks must include valid base64 image data")
    }
    return new Uint8Array(Buffer.from(normalized, "base64"))
}

function createKiroImageBudget(messages: ClaudeMessage[]): ImageInputBudget {
    try {
        return createImageInputBudget(messages)
    } catch (error) {
        if (error instanceof RequestValidationError && error.message === "image source must include valid base64 data") {
            throw new RequestValidationError("Kiro image blocks must include valid base64 image data")
        }
        throw error
    }
}

type ImageConversionOptions = {
    signal?: AbortSignal
    imageBudget: ImageInputBudget
}

async function imagesFromMessage(message: ClaudeMessage, options: ImageConversionOptions): Promise<ImageBlock[] | undefined> {
    if (typeof message.content === "string") return undefined

    const images: ImageBlock[] = []
    for (const block of message.content) {
        if (block.type !== "image") continue
        if (!block.source) {
            throw new RequestValidationError("Kiro image blocks must include an image source")
        }

        let source: { media_type: string; data: string }
        if (block.source.type === "url") {
            if (options.imageBudget.remainingBytes <= 0) {
                throw new RequestValidationError("image inputs exceed the 16 MiB per-request limit")
            }
            source = await fetchRemoteImageAsBase64(block.source.url, {
                signal: options.signal,
                maxBytes: options.imageBudget.remainingBytes,
            })
            options.imageBudget.addFetchedBytes(decodedBase64ImageBytes(source.data, true))
        } else {
            source = block.source
        }
        images.push({
            format: getKiroImageFormat(source.media_type),
            source: { bytes: decodeKiroImage(source.data) },
        })
    }

    return images.length > 0 ? images : undefined
}

function hasImageBlocks(message: ClaudeMessage): boolean {
    return typeof message.content !== "string" && message.content.some(block => block.type === "image")
}

function toKiroTools(tools?: ClaudeTool[]): Tool[] | undefined {
    if (!tools || tools.length === 0) return undefined
    return tools.map(tool => ({
        toolSpecification: {
            name: tool.name,
            description: tool.description,
            inputSchema: { json: tool.input_schema || { type: "object", properties: {} } },
        },
    }))
}

export async function toKiroMessages(
    messages: ClaudeMessage[],
    tools?: ClaudeTool[],
    options: { signal?: AbortSignal; imageBudget?: ImageInputBudget } = {},
): Promise<{ history: ChatMessage[]; currentMessage: ChatMessage }> {
    const history: ChatMessage[] = []
    const allTools = toKiroTools(tools)
    const imageBudget = options.imageBudget ?? createKiroImageBudget(messages)
    const imageOptions = { signal: options.signal, imageBudget }

    for (const message of messages.slice(0, -1)) {
        if (message.role === "assistant") {
            if (hasImageBlocks(message)) {
                throw new RequestValidationError("Kiro only supports image blocks in user messages")
            }
            const toolUses = toolUsesFromMessage(message)
            history.push({
                assistantResponseMessage: {
                    content: messageText(message),
                    ...(toolUses ? { toolUses } : {}),
                },
            })
            continue
        }

        const toolResults = toolResultsFromMessage(message)
        const images = await imagesFromMessage(message, imageOptions)
        history.push({
            userInputMessage: {
                origin: Origin.AI_EDITOR,
                content: messageText(message) || "continue",
                ...(images ? { images } : {}),
                userInputMessageContext: {
                    editorState: {},
                    ...(toolResults.length > 0 ? { toolResults } : {}),
                    ...(allTools ? { tools: allTools } : {}),
                },
            },
        })
    }

    const latest = messages[messages.length - 1]
    const latestToolResults = latest ? toolResultsFromMessage(latest) : []
    if (latest?.role === "assistant" && hasImageBlocks(latest)) {
        throw new RequestValidationError("Kiro only supports image blocks in user messages")
    }
    const latestImages = latest?.role === "user" ? await imagesFromMessage(latest, imageOptions) : undefined
    return {
        history,
        currentMessage: {
            userInputMessage: {
                origin: Origin.AI_EDITOR,
                content: latest ? messageText(latest) || "continue" : "continue",
                ...(latestImages ? { images: latestImages } : {}),
                userInputMessageContext: {
                    editorState: {},
                    ...(latestToolResults.length > 0 ? { toolResults: latestToolResults } : {}),
                    ...(allTools ? { tools: allTools } : {}),
                },
                modelId: undefined,
            },
        },
    }
}

function safeParseJson(value: string): unknown {
    if (!value) return {}
    try {
        return JSON.parse(value)
    } catch {
        return {}
    }
}

function mapKiroError(error: unknown): never {
    const status = error instanceof AccessDeniedException ? 403 : error instanceof ThrottlingException ? 429 : 500
    const message = error instanceof Error ? error.message : String(error)
    throw new UpstreamError("kiro", status, message)
}

function createAbortError(): Error {
    const error = new Error("Kiro request aborted")
    error.name = "AbortError"
    return error
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw createAbortError()
}

function isAbortError(error: unknown): boolean {
    return !!error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError"
}

export function listKiroModelsForAccount(_account: ProviderAccount): Promise<KiroModelInfo[]> {
    return Promise.resolve(KIRO_STATIC_MODELS)
}

export async function createKiroCompletion(
    account: ProviderAccount,
    model: string,
    messages: ClaudeMessage[],
    tools?: ClaudeTool[],
    maxTokens?: number,
    signal?: AbortSignal
) {
    throwIfAborted(signal)
    const imageBudget = createKiroImageBudget(messages)
    const effectiveAccount = await refreshKiroAccountIfNeeded(account)
    throwIfAborted(signal)
    const client = new CodeWhispererStreaming({
        region: getKiroRegion(effectiveAccount),
        endpoint: getKiroEndpoint(effectiveAccount),
        token: { token: effectiveAccount.accessToken },
        maxAttempts: 1,
        requestHandler: new NodeHttpHandler({
            httpsAgent: new https.Agent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 20 }),
            requestTimeout: KIRO_COMPLETION_TIMEOUT_MS,
        }),
        customUserAgent: `KiroIDE ${process.env.ANTI_API_KIRO_VERSION || "0.0.0"} anti-api`,
    })

    const { history, currentMessage } = await toKiroMessages(messages, tools, { signal, imageBudget })
    throwIfAborted(signal)
    const modelId = model || KIRO_DEFAULT_MODEL
    try {
        const command = new GenerateAssistantResponseCommand({
            profileArn: effectiveAccount.projectId,
            conversationState: {
                conversationId: crypto.randomUUID(),
                history,
                currentMessage: {
                    userInputMessage: {
                        ...currentMessage.userInputMessage!,
                        modelId,
                    },
                },
                chatTriggerType: ChatTriggerType.MANUAL,
            },
            ...(maxTokens ? { additionalModelRequestFields: { max_tokens: maxTokens } } : {}),
        })
        const response = signal
            ? await client.send(command, { abortSignal: signal })
            : await client.send(command)
        throwIfAborted(signal)

        const contentBlocks: ContentBlock[] = []
        const toolInputs = new Map<string, { name: string; input: string }>()
        let text = ""

        if (!response.generateAssistantResponseResponse) {
            throw new UpstreamError("kiro", 502, "Kiro returned an empty response stream.")
        }

        for await (const event of response.generateAssistantResponseResponse) {
            throwIfAborted(signal)
            if (event.assistantResponseEvent?.content) {
                text += event.assistantResponseEvent.content
            }
            if (event.toolUseEvent?.toolUseId && event.toolUseEvent.name) {
                const current = toolInputs.get(event.toolUseEvent.toolUseId) || { name: event.toolUseEvent.name, input: "" }
                current.input += event.toolUseEvent.input || ""
                toolInputs.set(event.toolUseEvent.toolUseId, current)
                if (event.toolUseEvent.stop) {
                    contentBlocks.push({
                        type: "tool_use",
                        id: event.toolUseEvent.toolUseId,
                        name: current.name,
                        input: safeParseJson(current.input),
                    })
                    toolInputs.delete(event.toolUseEvent.toolUseId)
                }
            }
            if (event.error) {
                throw new UpstreamError("kiro", 500, event.error.message || "Kiro stream error")
            }
        }

        if (text) {
            contentBlocks.unshift({ type: "text", text })
        }
        for (const [id, tool] of toolInputs.entries()) {
            contentBlocks.push({ type: "tool_use", id, name: tool.name, input: safeParseJson(tool.input) })
        }

        throwIfAborted(signal)
        authStore.markSuccess("kiro", effectiveAccount.id)
        return {
            contentBlocks,
            stopReason: contentBlocks.some(block => block.type === "tool_use") ? "tool_use" : "end_turn",
            usage: {
                inputTokens: 0,
                outputTokens: 0,
            },
        }
    } catch (error) {
        if (signal?.aborted || isAbortError(error)) throw error
        if (error instanceof UpstreamError) throw error
        mapKiroError(error)
    }
}
