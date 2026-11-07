/**
 * Audio routes (/v1/audio/transcriptions & /v1/audio/translations)
 */

import { Hono } from "hono"
import { forwardError } from "~/lib/error"
import { handleTranscription, handleTranslation } from "./handler"

export const audioRoutes = new Hono()

audioRoutes.post("/transcriptions", async (c) => {
    try {
        return await handleTranscription(c)
    } catch (error) {
        return await forwardError(c, error)
    }
})

audioRoutes.post("/translations", async (c) => {
    try {
        return await handleTranslation(c)
    } catch (error) {
        return await forwardError(c, error)
    }
})
