/**
 * OpenAI /v1/responses & /responses 路由
 */

import { Hono } from "hono"
import { forwardError } from "~/lib/error"
import { handleResponses } from "./handler"

export const responsesRoutes = new Hono()

responsesRoutes.post("/", async (c) => {
    try {
        return await handleResponses(c)
    } catch (error) {
        return await forwardError(c, error)
    }
})
