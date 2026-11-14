import { afterAll, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import { resolveAudioMimeType } from "~/routes/audio/handler"

let lastRoutedRequest: any = null
let mockResponseText = "Hello this is a transcription."

const realRouter = await import("~/services/routing/router")
mock.module("~/services/routing/router", () => ({
    ...realRouter,
    createRoutedCompletion: async (req: any) => {
        lastRoutedRequest = req
        return {
            contentBlocks: [{ type: "text", text: mockResponseText }],
            stopReason: "end_turn",
        }
    },
}))

const { audioRoutes } = await import("~/routes/audio/route")

afterAll(() => {
    mock.restore()
})

test("resolveAudioMimeType identifies mime types from extension and headers", () => {
    expect(resolveAudioMimeType("audio/mpeg", "test.mp3")).toBe("audio/mp3")
    expect(resolveAudioMimeType("audio/mp3", "test.mp3")).toBe("audio/mp3")
    expect(resolveAudioMimeType("audio/wav", "test.wav")).toBe("audio/wav")
    expect(resolveAudioMimeType("audio/x-wav", "test.wav")).toBe("audio/wav")
    expect(resolveAudioMimeType(undefined, "voice.m4a")).toBe("audio/m4a")
    expect(resolveAudioMimeType(undefined, "voice.ogg")).toBe("audio/ogg")
    expect(resolveAudioMimeType(undefined, "voice.flac")).toBe("audio/flac")
    expect(resolveAudioMimeType("video/mp4", "clip.mp4")).toBe("audio/mp4")
    expect(resolveAudioMimeType(undefined, "unknown.xyz")).toBe("audio/mp3")
})

test("/v1/audio/transcriptions handles multipart/form-data request", async () => {
    mockResponseText = "Hello this is a transcription."
    lastRoutedRequest = null

    const app = new Hono()
    app.route("/v1/audio", audioRoutes)

    const formData = new FormData()
    formData.append("file", new Blob(["fake-audio-bytes"], { type: "audio/mp3" }), "speech.mp3")
    formData.append("model", "gemini-transcribe")
    formData.append("language", "en")
    formData.append("prompt", "Some context")

    const res = await app.request("/v1/audio/transcriptions", {
        method: "POST",
        body: formData,
    })

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ text: "Hello this is a transcription." })

    expect(lastRoutedRequest).not.toBeNull()
    expect(lastRoutedRequest.model).toBe("gemini-flash") // dynamic flash model
    expect(lastRoutedRequest.messages[0].content[0].type).toBe("audio")
    expect(lastRoutedRequest.messages[0].content[0].source.media_type).toBe("audio/mp3")
    expect(lastRoutedRequest.messages[0].content[1].text).toContain("The audio language is en.")
    expect(lastRoutedRequest.messages[0].content[1].text).toContain("Context or vocabulary hint: Some context")
})

test("/v1/audio/transcriptions handles verbose_json and text response formats", async () => {
    mockResponseText = "Transcribed verbatim text."

    const app = new Hono()
    app.route("/v1/audio", audioRoutes)

    // Test verbose_json
    const formVerbose = new FormData()
    formVerbose.append("file", new Blob(["audio"], { type: "audio/wav" }), "test.wav")
    formVerbose.append("response_format", "verbose_json")
    formVerbose.append("language", "it")

    const resVerbose = await app.request("/v1/audio/transcriptions", {
        method: "POST",
        body: formVerbose,
    })
    expect(resVerbose.status).toBe(200)
    const jsonVerbose = await resVerbose.json()
    expect(jsonVerbose.task).toBe("transcribe")
    expect(jsonVerbose.language).toBe("it")
    expect(jsonVerbose.text).toBe("Transcribed verbatim text.")

    // Test text format
    const formText = new FormData()
    formText.append("file", new Blob(["audio"], { type: "audio/wav" }), "test.wav")
    formText.append("response_format", "text")

    const resText = await app.request("/v1/audio/transcriptions", {
        method: "POST",
        body: formText,
    })
    expect(resText.status).toBe(200)
    const text = await resText.text()
    expect(text).toBe("Transcribed verbatim text.")
})

test("/v1/audio/transcriptions handles JSON payload fallback", async () => {
    mockResponseText = "JSON audio transcription."

    const app = new Hono()
    app.route("/v1/audio", audioRoutes)

    const res = await app.request("/v1/audio/transcriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            file: "AQIDBAU=",
            mime_type: "audio/wav",
            model: "gemini-3.8-flash",
        }),
    })

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ text: "JSON audio transcription." })
})

test("/v1/audio/translations translates audio to English", async () => {
    mockResponseText = "English translation of audio."
    lastRoutedRequest = null

    const app = new Hono()
    app.route("/v1/audio", audioRoutes)

    const formData = new FormData()
    formData.append("file", new Blob(["audio"], { type: "audio/mp3" }), "italian.mp3")

    const res = await app.request("/v1/audio/translations", {
        method: "POST",
        body: formData,
    })

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ text: "English translation of audio." })
    expect(lastRoutedRequest.messages[0].content[1].text).toContain("translate the spoken audio into English")
})
