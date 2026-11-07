/**
 * OpenAI /v1/audio/transcriptions & /v1/audio/translations Handler
 */

import type { Context } from "hono"
import { createRoutedCompletion, RoutingError } from "~/services/routing/router"
import { RequestValidationError } from "~/lib/error"
import { parseBoundedJson } from "~/lib/request-body"
import { rateLimiter } from "~/lib/rate-limiter"

export const MAX_AUDIO_BYTES_PER_REQUEST = 25 * 1024 * 1024 // 25 MiB
export const DEFAULT_TRANSCRIPTION_MODEL = "gemini-flash"

export function resolveTranscriptionModel(requestedModel?: string): string {
    const trimmed = (requestedModel || "").trim()
    if (!trimmed || trimmed === "gemini-transcribe" || trimmed === "whisper-1" || trimmed === "whisper") {
        return DEFAULT_TRANSCRIPTION_MODEL
    }
    return trimmed
}

export function resolveAudioMimeType(declaredType?: string, fileName?: string): string {
    const clean = (declaredType || "").split(";")[0].trim().toLowerCase()
    if (clean.startsWith("audio/")) {
        if (clean === "audio/mpeg" || clean === "audio/mp3") return "audio/mp3"
        if (clean === "audio/wave" || clean === "audio/x-wav") return "audio/wav"
        if (clean === "audio/x-m4a") return "audio/m4a"
        return clean
    }
    if (clean === "video/mp4") return "audio/mp4"
    if (clean === "video/webm") return "audio/webm"

    const ext = (fileName || "").split(".").pop()?.toLowerCase()
    switch (ext) {
        case "mp3": return "audio/mp3"
        case "wav": return "audio/wav"
        case "m4a": return "audio/m4a"
        case "ogg":
        case "oga": return "audio/ogg"
        case "flac": return "audio/flac"
        case "aac": return "audio/aac"
        case "weba":
        case "webm": return "audio/webm"
        case "mp4": return "audio/mp4"
        default: return "audio/mp3"
    }
}

interface ParsedAudioRequest {
    base64Data: string
    mimeType: string
    model: string
    prompt?: string
    responseFormat: string
    language?: string
    temperature?: number
}

export async function extractAudioPayload(c: Context): Promise<ParsedAudioRequest> {
    const contentType = c.req.header("content-type") || ""

    let model = "gemini-transcribe"
    let prompt: string | undefined
    let responseFormat = "json"
    let language: string | undefined
    let temperature: number | undefined
    let base64Data = ""
    let mimeType = "audio/mp3"

    if (contentType.includes("multipart/form-data") || contentType.includes("application/x-www-form-urlencoded")) {
        const body = await c.req.parseBody()
        const file = body["file"]
        if (!file) {
            throw new RequestValidationError("Missing required 'file' parameter")
        }
        if (typeof body["model"] === "string" && body["model"].trim()) {
            model = body["model"].trim()
        }
        if (typeof body["prompt"] === "string") {
            prompt = body["prompt"]
        }
        if (typeof body["response_format"] === "string") {
            responseFormat = body["response_format"].toLowerCase()
        }
        if (typeof body["language"] === "string") {
            language = body["language"]
        }
        if (body["temperature"] !== undefined) {
            temperature = Number(body["temperature"])
        }

        if (typeof file === "object" && file !== null && typeof (file as any).arrayBuffer === "function") {
            const fileObj = file as any
            const buffer = Buffer.from(await fileObj.arrayBuffer())
            if (buffer.byteLength === 0) {
                throw new RequestValidationError("Uploaded audio file is empty")
            }
            if (buffer.byteLength > MAX_AUDIO_BYTES_PER_REQUEST) {
                throw new RequestValidationError(`Audio file exceeds limit of ${Math.floor(MAX_AUDIO_BYTES_PER_REQUEST / (1024 * 1024))} MiB`)
            }
            base64Data = buffer.toString("base64")
            mimeType = resolveAudioMimeType(fileObj.type, fileObj.name)
        } else if (typeof file === "string") {
            const cleaned = file.replace(/^data:[^;]+;base64,/, "").replace(/[\t\n\f\r ]/g, "")
            if (!cleaned) throw new RequestValidationError("Audio file data is empty")
            base64Data = cleaned
            mimeType = "audio/mp3"
        } else {
            throw new RequestValidationError("Invalid 'file' parameter in request")
        }
    } else {
        // application/json fallback
        const json = await parseBoundedJson<any>(c.req.raw)
        if (!json || typeof json !== "object") {
            throw new RequestValidationError("Invalid request body")
        }
        const fileData = json.file || json.audio || json.data
        if (!fileData || typeof fileData !== "string") {
            throw new RequestValidationError("Missing 'file' base64 data in JSON payload")
        }
        if (json.model && typeof json.model === "string") model = json.model
        if (json.prompt && typeof json.prompt === "string") prompt = json.prompt
        if (json.response_format && typeof json.response_format === "string") responseFormat = json.response_format.toLowerCase()
        if (json.language && typeof json.language === "string") language = json.language
        if (json.temperature !== undefined) temperature = Number(json.temperature)

        if (fileData.startsWith("data:")) {
            const sep = fileData.indexOf(",")
            if (sep !== -1) {
                const header = fileData.slice(0, sep)
                const match = header.match(/^data:(audio\/[A-Za-z0-9.+-]+);base64$/i)
                if (match) mimeType = match[1].toLowerCase()
                base64Data = fileData.slice(sep + 1).replace(/[\t\n\f\r ]/g, "")
            } else {
                base64Data = fileData.replace(/[\t\n\f\r ]/g, "")
            }
        } else {
            base64Data = fileData.replace(/[\t\n\f\r ]/g, "")
        }
        if (json.mime_type && typeof json.mime_type === "string") {
            mimeType = json.mime_type
        }
    }

    return {
        base64Data,
        mimeType,
        model,
        prompt,
        responseFormat,
        language,
        temperature,
    }
}

export async function handleTranscription(c: Context): Promise<Response> {
    await rateLimiter.wait()
    const { base64Data, mimeType, model, prompt, responseFormat, language } = await extractAudioPayload(c)

    const instructionParts = [
        "You are an expert speech-to-text transcription system.",
        "Your task is to transcribe the spoken words in the audio accurately and verbatim.",
        "Return ONLY the transcription. Do not include any explanations, introductions, conclusions, or conversational commentary.",
    ]

    if (language) {
        instructionParts.push(`The audio language is ${language}.`)
    }
    if (prompt) {
        instructionParts.push(`Context or vocabulary hint: ${prompt}`)
    }
    if (responseFormat === "srt") {
        instructionParts.push("Format the transcription strictly as SubRip (.srt) subtitles with sequential numbers and accurate timestamps (hh:mm:ss,ms --> hh:mm:ss,ms).")
    } else if (responseFormat === "vtt") {
        instructionParts.push("Format the transcription strictly as WebVTT format starting with WEBVTT followed by timestamps (hh:mm:ss.ms --> hh:mm:ss.ms).")
    }

    const systemPrompt = instructionParts.join(" ")
    const routedModel = resolveTranscriptionModel(model)

    let result
    try {
        result = await createRoutedCompletion({
            model: routedModel,
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "audio",
                            source: {
                                type: "base64",
                                media_type: mimeType,
                                data: base64Data,
                            },
                        },
                        {
                            type: "text",
                            text: systemPrompt,
                        },
                    ],
                },
            ],
            maxTokens: 8192,
            signal: c.req.raw.signal,
        })
    } catch (error) {
        if (error instanceof RoutingError) {
            return c.json({ error: { type: "invalid_request_error", message: error.message } }, error.status as any)
        }
        throw error
    }

    let textContent = ""
    for (const block of result.contentBlocks) {
        if (block.type === "text") {
            textContent += block.text || ""
        }
    }
    textContent = textContent.trim()

    if (responseFormat === "text") {
        return c.text(textContent)
    }
    if (responseFormat === "srt") {
        return c.text(textContent, 200, { "Content-Type": "application/x-subrip; charset=utf-8" })
    }
    if (responseFormat === "vtt") {
        return c.text(textContent, 200, { "Content-Type": "text/vtt; charset=utf-8" })
    }
    if (responseFormat === "verbose_json") {
        return c.json({
            task: "transcribe",
            language: language || "auto",
            duration: 0,
            text: textContent,
            segments: [],
        })
    }

    return c.json({ text: textContent })
}

export async function handleTranslation(c: Context): Promise<Response> {
    await rateLimiter.wait()
    const { base64Data, mimeType, model, prompt, responseFormat } = await extractAudioPayload(c)

    const instructionParts = [
        "You are an expert speech-to-text translation system.",
        "Your task is to transcribe and translate the spoken audio into English accurately and verbatim.",
        "Return ONLY the English translated text. Do not include any explanations, introductions, conclusions, or conversational commentary.",
    ]

    if (prompt) {
        instructionParts.push(`Context or vocabulary hint: ${prompt}`)
    }
    if (responseFormat === "srt") {
        instructionParts.push("Format the translation strictly as SubRip (.srt) subtitles with sequential numbers and accurate timestamps (hh:mm:ss,ms --> hh:mm:ss,ms).")
    } else if (responseFormat === "vtt") {
        instructionParts.push("Format the translation strictly as WebVTT format starting with WEBVTT followed by timestamps (hh:mm:ss.ms --> hh:mm:ss.ms).")
    }

    const systemPrompt = instructionParts.join(" ")
    const routedModel = resolveTranscriptionModel(model)

    let result
    try {
        result = await createRoutedCompletion({
            model: routedModel,
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "audio",
                            source: {
                                type: "base64",
                                media_type: mimeType,
                                data: base64Data,
                            },
                        },
                        {
                            type: "text",
                            text: systemPrompt,
                        },
                    ],
                },
            ],
            maxTokens: 8192,
            signal: c.req.raw.signal,
        })
    } catch (error) {
        if (error instanceof RoutingError) {
            return c.json({ error: { type: "invalid_request_error", message: error.message } }, error.status as any)
        }
        throw error
    }

    let textContent = ""
    for (const block of result.contentBlocks) {
        if (block.type === "text") {
            textContent += block.text || ""
        }
    }
    textContent = textContent.trim()

    if (responseFormat === "text") {
        return c.text(textContent)
    }
    if (responseFormat === "srt") {
        return c.text(textContent, 200, { "Content-Type": "application/x-subrip; charset=utf-8" })
    }
    if (responseFormat === "vtt") {
        return c.text(textContent, 200, { "Content-Type": "text/vtt; charset=utf-8" })
    }
    if (responseFormat === "verbose_json") {
        return c.json({
            task: "translate",
            language: "en",
            duration: 0,
            text: textContent,
            segments: [],
        })
    }

    return c.json({ text: textContent })
}
