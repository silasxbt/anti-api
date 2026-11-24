import { describe, expect, test } from "bun:test"
import { RequestValidationError } from "~/lib/error"
import { completionToEvents, type BufferedCompletion, type RoutedStreamEvent } from "~/lib/stream-events"
import { validateResponsesRequest } from "~/lib/validation"
import { MAX_MESSAGES_PER_REQUEST, MAX_TOOLS_PER_REQUEST } from "~/lib/constants"
import {
    completionToResponseObject,
    eventsToResponsesSse,
    extractResponsesPromptText,
    extractResponsesReasoningEffort,
    generateResponseId,
    responsesToRoutedInput,
} from "~/routes/responses/translator"
import type { ResponsesCreateRequest } from "~/routes/responses/types"

function parseSseFrames(chunks: string[]): Array<{ event: string; data: any }> {
    const raw = chunks.join("")
    const frames: Array<{ event: string; data: any }> = []
    for (const block of raw.split("\n\n")) {
        const trimmed = block.trim()
        if (!trimmed) continue
        let eventName = ""
        let dataStr = ""
        for (const line of trimmed.split("\n")) {
            if (line.startsWith("event: ")) {
                eventName = line.slice(7).trim()
            } else if (line.startsWith("data: ")) {
                dataStr = line.slice(6).trim()
            }
        }
        if (eventName && dataStr) {
            frames.push({ event: eventName, data: JSON.parse(dataStr) })
        }
    }
    return frames
}

describe("OpenAI Responses API validation (validateResponsesRequest)", () => {
    test("accepts valid string input and array input requests", () => {
        expect(
            validateResponsesRequest({
                model: "gpt-5",
                input: "Hello world",
            })
        ).toEqual({ valid: true })

        expect(
            validateResponsesRequest({
                model: "claude-sonnet-4-5",
                instructions: "Be concise",
                input: [{ type: "message", role: "user", content: "Hi" }],
                max_output_tokens: 1024,
                temperature: 0.7,
                stream: true,
                tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
            })
        ).toEqual({ valid: true })
    })

    test("rejects invalid model, empty input, or out-of-range options", () => {
        expect(validateResponsesRequest(null).valid).toBe(false)
        expect(validateResponsesRequest({ input: "hi" }).valid).toBe(false)
        expect(validateResponsesRequest({ model: "gpt-5", input: "" }).valid).toBe(false)
        expect(validateResponsesRequest({ model: "gpt-5", input: [] }).valid).toBe(false)
        expect(validateResponsesRequest({ model: "gpt-5", input: [null] }).valid).toBe(false)
        expect(
            validateResponsesRequest({
                model: "gpt-5",
                input: Array.from({ length: MAX_MESSAGES_PER_REQUEST + 1 }, () => ({ role: "user", content: "x" })),
            }).valid
        ).toBe(false)
        expect(
            validateResponsesRequest({
                model: "gpt-5",
                input: "hi",
                instructions: 123,
            }).valid
        ).toBe(false)
        expect(
            validateResponsesRequest({
                model: "gpt-5",
                input: "hi",
                max_output_tokens: 0,
            }).valid
        ).toBe(false)
        expect(
            validateResponsesRequest({
                model: "gpt-5",
                input: "hi",
                temperature: 3,
            }).valid
        ).toBe(false)
        expect(
            validateResponsesRequest({
                model: "gpt-5",
                input: "hi",
                stream: "yes",
            }).valid
        ).toBe(false)
        expect(
            validateResponsesRequest({
                model: "gpt-5",
                input: "hi",
                tools: Array.from({ length: MAX_TOOLS_PER_REQUEST + 1 }, () => ({ type: "function", name: "t" })),
            }).valid
        ).toBe(false)
    })
})

describe("OpenAI Responses API translator (responsesToRoutedInput)", () => {
    test("generateResponseId uses resp_ prefix", () => {
        const id = generateResponseId()
        expect(id.startsWith("resp_")).toBe(true)
        expect(id.length).toBeGreaterThan(10)
    })

    test("extractResponsesReasoningEffort maps xhigh/high/medium/low", () => {
        expect(extractResponsesReasoningEffort({ model: "m", input: "x", reasoning: { effort: "xhigh" } })).toBe("high")
        expect(extractResponsesReasoningEffort({ model: "m", input: "x", reasoning: { effort: "high" } })).toBe("high")
        expect(extractResponsesReasoningEffort({ model: "m", input: "x", reasoning: { effort: "medium" } })).toBe("medium")
        expect(extractResponsesReasoningEffort({ model: "m", input: "x", reasoning: { effort: "low" } })).toBe("low")
        expect(extractResponsesReasoningEffort({ model: "m", input: "x", reasoning_effort: "xhigh" })).toBe("high")
        expect(extractResponsesReasoningEffort({ model: "m", input: "x" })).toBeUndefined()
    })

    test("extractResponsesPromptText finds the last user text", () => {
        expect(extractResponsesPromptText("direct string prompt")).toBe("direct string prompt")
        expect(
            extractResponsesPromptText([
                { type: "message", role: "user", content: "first question" },
                { type: "message", role: "assistant", content: "first answer" },
                {
                    type: "message",
                    role: "user",
                    content: [
                        { type: "input_text", text: "second" },
                        { type: "input_text", text: "question" },
                    ],
                },
                { type: "function_call_output", call_id: "call_1", output: "tool output" },
            ])
        ).toBe("second question")
    })

    test("converts string input, instructions, model effort mapping, tools, and tool_choice in 1 hop", () => {
        const payload: ResponsesCreateRequest = {
            model: "gemini-4-argon",
            instructions: "Follow system instructions strictly.",
            input: "Solve the equation.",
            max_output_tokens: 2048,
            reasoning: { effort: "xhigh" },
            tools: [
                {
                    type: "function",
                    name: "calc",
                    description: "Evaluate expression",
                    parameters: {
                        type: "object",
                        properties: { expr: { type: "string" } },
                    },
                },
            ],
            tool_choice: { type: "function", name: "calc" },
        }

        const routed = responsesToRoutedInput(payload)
        expect(routed.model).toBe("gemini-4-argon-high")
        expect(routed.reasoningEffort).toBe("high")
        expect(routed.maxTokens).toBe(2048)
        expect(routed.messages).toEqual([
            { role: "user", content: "Follow system instructions strictly." },
            { role: "user", content: "Solve the equation." },
        ])
        expect(routed.tools).toEqual([
            {
                name: "calc",
                description: "Evaluate expression",
                input_schema: {
                    type: "object",
                    properties: { expr: { type: "string" } },
                },
            },
        ])
        expect(routed.toolChoice).toEqual({ type: "tool", name: "calc" })
    })

    test("converts multi-turn items including function_call with thought_signature, function_call_output, images, and audio", () => {
        const payload: ResponsesCreateRequest = {
            model: "claude-sonnet-4-5",
            input: [
                {
                    type: "message",
                    role: "developer",
                    content: [{ type: "input_text", text: "Developer policy" }],
                },
                {
                    type: "message",
                    role: "user",
                    content: [
                        { type: "input_text", text: "Check this image and audio" },
                        { type: "input_image", image_url: "data:image/png;base64,AQID" },
                        { type: "input_image", image_url: "https://example.com/photo.png" },
                        { type: "input_audio", input_audio: { data: "AQID", format: "mp3" } },
                    ],
                },
                {
                    type: "reasoning",
                    id: "rs_prev",
                    summary: [{ type: "summary_text", text: "Thinking..." }],
                },
                {
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: "Calling weather tool" }],
                },
                {
                    type: "function_call",
                    call_id: "call_weather_1",
                    name: "get_weather",
                    arguments: '{"city":"Tokyo"}',
                    thought_signature: "sig_abc_999",
                },
                {
                    type: "function_call_output",
                    call_id: "call_weather_1",
                    output: { temp: 22, condition: "Sunny" },
                },
            ],
            tool_choice: "required",
        }

        const routed = responsesToRoutedInput(payload)
        expect(routed.toolChoice).toEqual({ type: "any" })
        expect(routed.messages).toHaveLength(4)

        expect(routed.messages[0]).toEqual({
            role: "user",
            content: [{ type: "text", text: "Developer policy" }],
        })

        expect(routed.messages[1]).toEqual({
            role: "user",
            content: [
                { type: "text", text: "Check this image and audio" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
                { type: "image", source: { type: "url", url: "https://example.com/photo.png" } },
                { type: "audio", source: { type: "base64", media_type: "audio/mp3", data: "AQID" } },
            ],
        })

        expect(routed.messages[2]).toEqual({
            role: "assistant",
            content: [
                { type: "text", text: "Calling weather tool" },
                {
                    type: "tool_use",
                    id: "call_weather_1",
                    name: "get_weather",
                    input: { city: "Tokyo" },
                    thought_signature: "sig_abc_999",
                    thoughtSignature: "sig_abc_999",
                } as any,
            ],
        })

        expect(routed.messages[3]).toEqual({
            role: "user",
            content: [
                {
                    type: "tool_result",
                    tool_use_id: "call_weather_1",
                    content: '{"temp":22,"condition":"Sunny"}',
                },
            ],
        })
    })

    test("rejects unsafe image schemes and malformed JSON arguments with RequestValidationError", () => {
        expect(() =>
            responsesToRoutedInput({
                model: "gpt-5",
                input: [
                    {
                        type: "message",
                        role: "user",
                        content: [{ type: "input_image", image_url: "file:///etc/passwd" }],
                    },
                ],
            })
        ).toThrow(RequestValidationError)

        expect(() =>
            responsesToRoutedInput({
                model: "gpt-5",
                input: [
                    {
                        type: "function_call",
                        call_id: "call_bad",
                        name: "lookup",
                        arguments: "{invalid json",
                    },
                ],
            })
        ).toThrow(RequestValidationError)
    })
})

describe("completionToResponseObject", () => {
    test("maps thinking, text, tool_use, and cached usage into a ResponseObject", () => {
        const payload: ResponsesCreateRequest = {
            model: "gemini-4-argon",
            input: "Check weather",
            instructions: "Be helpful",
        }
        const completion: BufferedCompletion = {
            contentBlocks: [
                { type: "thinking", thinking: "Need to call get_weather." },
                { type: "text", text: "Let me check that for you." },
                {
                    type: "tool_use",
                    id: "call_123",
                    name: "get_weather",
                    input: { location: "Paris" },
                    thought_signature: "sig_xyz",
                },
            ],
            stopReason: "tool_use",
            usage: {
                inputTokens: 100,
                cacheReadTokens: 40,
                outputTokens: 30,
                reasoningTokens: 12,
            },
        }

        const resp = completionToResponseObject(completion, {
            id: "resp_fixed123",
            model: "gemini-4-argon",
            createdAt: 1700000000,
            payload,
        })

        expect(resp.id).toBe("resp_fixed123")
        expect(resp.object).toBe("response")
        expect(resp.created_at).toBe(1700000000)
        expect(resp.status).toBe("completed")
        expect(resp.incomplete_details).toBeNull()
        expect(resp.output_text).toBe("Let me check that for you.")
        expect(resp.output).toHaveLength(3)

        expect(resp.output[0]).toMatchObject({
            type: "reasoning",
            status: "completed",
            summary: [{ type: "summary_text", text: "Need to call get_weather." }],
        })
        expect(resp.output[0].id.startsWith("rs_")).toBe(true)

        expect(resp.output[1]).toMatchObject({
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: "Let me check that for you.", annotations: [] }],
        })
        expect(resp.output[1].id.startsWith("msg_")).toBe(true)

        expect(resp.output[2]).toMatchObject({
            type: "function_call",
            status: "completed",
            call_id: "call_123",
            name: "get_weather",
            arguments: '{"location":"Paris"}',
            thought_signature: "sig_xyz",
        })
        expect(resp.output[2].id.startsWith("fc_")).toBe(true)

        expect(resp.usage).toEqual({
            input_tokens: 140,
            output_tokens: 30,
            total_tokens: 170,
            input_tokens_details: { cached_tokens: 40 },
            output_tokens_details: { reasoning_tokens: 12 },
        })
    })

    test("sets status incomplete and max_output_tokens reason when stopReason is max_tokens", () => {
        const payload: ResponsesCreateRequest = {
            model: "gpt-5",
            input: "Write a long story",
            max_output_tokens: 50,
        }
        const completion: BufferedCompletion = {
            contentBlocks: [{ type: "text", text: "Once upon a time..." }],
            stopReason: "max_tokens",
            usage: { inputTokens: 10, outputTokens: 50 },
        }

        const resp = completionToResponseObject(completion, {
            model: "gpt-5",
            payload,
        })

        expect(resp.status).toBe("incomplete")
        expect(resp.incomplete_details).toEqual({ reason: "max_output_tokens" })
        expect(resp.output[0]).toMatchObject({
            type: "message",
            status: "incomplete",
        })
    })
})

describe("eventsToResponsesSse", () => {
    test("emits full standard Responses SSE sequence for reasoning, message, and function_call", async () => {
        const payload: ResponsesCreateRequest = {
            model: "gemini-4-argon",
            input: "Run task",
        }
        const completion: BufferedCompletion = {
            contentBlocks: [
                { type: "thinking", thinking: "Step 1" },
                { type: "text", text: "Hello!" },
                {
                    type: "tool_use",
                    id: "call_99",
                    name: "run_cmd",
                    input: { cmd: "ls" },
                    thought_signature: "sig_stream_1",
                },
            ],
            stopReason: "tool_use",
            usage: { inputTokens: 20, cacheReadTokens: 5, outputTokens: 15 },
        }

        const chunks: string[] = []
        for await (const chunk of eventsToResponsesSse(completionToEvents("gemini-4-argon", completion), {
            id: "resp_stream_test",
            model: "gemini-4-argon",
            createdAt: 1700000100,
            payload,
        })) {
            chunks.push(chunk)
        }

        const frames = parseSseFrames(chunks)
        const eventNames = frames.map(f => f.event)

        expect(eventNames).toEqual([
            "response.created",
            "response.in_progress",
            // Reasoning item
            "response.output_item.added",
            "response.reasoning_summary_part.added",
            "response.reasoning_summary_text.delta",
            "response.reasoning_summary_text.done",
            "response.reasoning_summary_part.done",
            "response.output_item.done",
            // Message item
            "response.output_item.added",
            "response.content_part.added",
            "response.output_text.delta",
            "response.output_text.done",
            "response.content_part.done",
            "response.output_item.done",
            // Function call item
            "response.output_item.added",
            "response.function_call_arguments.delta",
            "response.function_call_arguments.done",
            "response.output_item.done",
            // Final completion
            "response.completed",
        ])

        // Check monotonic sequence_number
        frames.forEach((frame, idx) => {
            expect(frame.data.sequence_number).toBe(idx)
            expect(frame.data.type).toBe(frame.event)
        })

        const finalFrame = frames[frames.length - 1]
        expect(finalFrame.data.response.id).toBe("resp_stream_test")
        expect(finalFrame.data.response.status).toBe("completed")
        expect(finalFrame.data.response.output).toHaveLength(3)
        expect(finalFrame.data.response.output_text).toBe("Hello!")
        expect(finalFrame.data.response.usage).toEqual({
            input_tokens: 25,
            output_tokens: 15,
            total_tokens: 40,
            input_tokens_details: { cached_tokens: 5 },
            output_tokens_details: { reasoning_tokens: 0 },
        })
    })

    test("emits response.incomplete on max_tokens finish event", async () => {
        async function* mockEvents(): AsyncGenerator<RoutedStreamEvent, void, unknown> {
            yield { type: "start", model: "gpt-5" }
            yield { type: "text_delta", text: "Partial " }
            yield { type: "text_delta", text: "output" }
            yield { type: "finish", stopReason: "max_tokens", usage: { inputTokens: 10, outputTokens: 20 } }
        }

        const chunks: string[] = []
        for await (const chunk of eventsToResponsesSse(mockEvents(), {
            id: "resp_incomplete_test",
            model: "gpt-5",
            payload: { model: "gpt-5", input: "Hi" },
        })) {
            chunks.push(chunk)
        }

        const frames = parseSseFrames(chunks)
        const last = frames[frames.length - 1]
        expect(last.event).toBe("response.incomplete")
        expect(last.data.response.status).toBe("incomplete")
        expect(last.data.response.incomplete_details).toEqual({ reason: "max_output_tokens" })
        expect(last.data.response.output_text).toBe("Partial output")
        expect(last.data.response.output[0].status).toBe("incomplete")
    })
})
