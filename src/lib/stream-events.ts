import {
    buildContentBlockStart,
    buildContentBlockStop,
    buildInputJsonDelta,
    buildMessageDelta,
    buildMessageStart,
    buildMessageStop,
    buildTextDelta,
    buildThinkingDelta,
    type CompletionUsage,
} from "~/lib/translator"

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "content_filter"

export interface StreamUsage extends CompletionUsage {
    reasoningTokens?: number
}

export type RoutedStreamEvent =
    | { type: "start"; model?: string }
    | { type: "thinking_delta"; text: string }
    | { type: "text_delta"; text: string }
    | {
          type: "tool_call"
          id: string
          name: string
          input: Record<string, unknown>
          rawArguments?: string
          thoughtSignature?: string
      }
    | { type: "finish"; stopReason: StopReason; usage?: Partial<StreamUsage> }

export function normalizeStopReason(reason?: string | null): StopReason {
    switch (reason) {
        case "tool_use":
        case "tool_calls":
            return "tool_use"
        case "max_tokens":
        case "length":
            return "max_tokens"
        case "content_filter":
            return "content_filter"
        case "end_turn":
        case "stop":
        default:
            return "end_turn"
    }
}

export interface BufferedCompletion {
    contentBlocks: Array<{
        type: string
        text?: string
        thinking?: string
        id?: string
        name?: string
        input?: any
        thought_signature?: string
        thoughtSignature?: string
    }>
    stopReason: string | null
    usage?: Partial<StreamUsage>
}

export function* completionToEvents(
    model: string,
    completion: BufferedCompletion
): Generator<RoutedStreamEvent, void, unknown> {
    yield { type: "start", model }
    for (const block of completion.contentBlocks || []) {
        if (block.type === "thinking") {
            const text = block.thinking || block.text || ""
            if (text) yield { type: "thinking_delta", text }
            continue
        }
        if (block.type === "tool_use") {
            yield {
                type: "tool_call",
                id: block.id || `tool_${crypto.randomUUID().slice(0, 8)}`,
                name: block.name || "tool",
                input: block.input || {},
                thoughtSignature: block.thought_signature || block.thoughtSignature,
            }
            continue
        }
        if (block.type === "text" && block.text !== undefined) {
            yield { type: "text_delta", text: block.text }
        }
    }
    yield {
        type: "finish",
        stopReason: normalizeStopReason(completion.stopReason),
        usage: completion.usage,
    }
}

export async function* formatAnthropicSse(
    events: AsyncIterable<RoutedStreamEvent> | Iterable<RoutedStreamEvent>,
    fallbackModel: string
): AsyncGenerator<string, void, unknown> {
    let started = false
    let blockIndex = 0
    let activeKind: "thinking" | "text" | null = null

    const closeActiveBlock = (): string | null => {
        if (!activeKind) return null
        const out = buildContentBlockStop(blockIndex)
        blockIndex++
        activeKind = null
        return out
    }

    for await (const event of events) {
        if (event.type === "start") {
            if (!started) {
                started = true
                yield buildMessageStart(event.model || fallbackModel)
            }
            continue
        }

        if (!started) {
            started = true
            yield buildMessageStart(fallbackModel)
        }

        if (event.type === "thinking_delta") {
            if (!event.text) continue
            if (activeKind !== "thinking") {
                const closed = closeActiveBlock()
                if (closed) yield closed
                yield buildContentBlockStart(blockIndex, "thinking")
                activeKind = "thinking"
            }
            yield buildThinkingDelta(blockIndex, event.text)
            continue
        }

        if (event.type === "text_delta") {
            if (activeKind !== "text") {
                const closed = closeActiveBlock()
                if (closed) yield closed
                yield buildContentBlockStart(blockIndex, "text")
                activeKind = "text"
            }
            if (event.text) {
                yield buildTextDelta(blockIndex, event.text)
            }
            continue
        }

        if (event.type === "tool_call") {
            const closed = closeActiveBlock()
            if (closed) yield closed
            yield buildContentBlockStart(blockIndex, "tool_use", {
                id: event.id,
                name: event.name,
                thoughtSignature: event.thoughtSignature,
            })
            const partialJson = event.rawArguments ?? (JSON.stringify(event.input ?? {}) || "{}")
            yield buildInputJsonDelta(blockIndex, partialJson)
            yield buildContentBlockStop(blockIndex)
            blockIndex++
            continue
        }

        if (event.type === "finish") {
            const closed = closeActiveBlock()
            if (closed) yield closed
            yield buildMessageDelta(
                event.stopReason,
                event.usage
                    ? {
                          inputTokens: event.usage.inputTokens ?? 0,
                          cacheReadTokens: event.usage.cacheReadTokens ?? 0,
                          outputTokens: event.usage.outputTokens ?? 0,
                      }
                    : undefined
            )
            yield buildMessageStop()
        }
    }
}
