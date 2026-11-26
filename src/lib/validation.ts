/**
 * Input Validation Utility
 * Provides request validation for API security
 */

import {
    MAX_MESSAGES_PER_REQUEST,
    MAX_TOOLS_PER_REQUEST,
    MAX_MODEL_NAME_LENGTH,
    MAX_ACCOUNT_ID_LENGTH,
    MAX_TOKENS_LIMIT,
    MAX_SANITIZED_STRING_LENGTH,
} from "./constants"

export interface ValidationResult {
    valid: boolean
    error?: string
}

/**
 * Validate chat completion request body
 */
export function validateChatRequest(payload: any): ValidationResult {
    if (!payload || typeof payload !== "object") {
        return { valid: false, error: "Request body must be a JSON object" }
    }

    // Model validation
    if (!payload.model || typeof payload.model !== "string") {
        return { valid: false, error: "Model is required and must be a string" }
    }
    if (payload.model.length > MAX_MODEL_NAME_LENGTH) {
        return { valid: false, error: `Model name too long (max ${MAX_MODEL_NAME_LENGTH} characters)` }
    }

    // Messages validation
    if (!Array.isArray(payload.messages)) {
        return { valid: false, error: "Messages must be an array" }
    }
    if (payload.messages.length === 0) {
        return { valid: false, error: "Messages array cannot be empty" }
    }
    if (payload.messages.length > MAX_MESSAGES_PER_REQUEST) {
        return { valid: false, error: `Too many messages (max ${MAX_MESSAGES_PER_REQUEST})` }
    }

    for (let i = 0; i < payload.messages.length; i++) {
        const msg = payload.messages[i]
        if (!msg || typeof msg !== "object") {
            return { valid: false, error: `Message at index ${i} must be an object` }
        }
        if (!msg.role || typeof msg.role !== "string") {
            return { valid: false, error: `Message at index ${i} must have a role` }
        }
        const validRoles = ["system", "user", "assistant", "tool", "developer", "function"]
        if (!validRoles.includes(msg.role)) {
            return { valid: false, error: `Invalid role "${msg.role}" at index ${i}` }
        }
    }

    // Optional fields validation
    if (payload.max_tokens !== undefined) {
        if (typeof payload.max_tokens !== "number" || !Number.isFinite(payload.max_tokens) || payload.max_tokens <= 0) {
            return { valid: false, error: "max_tokens must be a positive number" }
        }
        if (payload.max_tokens > MAX_TOKENS_LIMIT) {
            return { valid: false, error: `max_tokens too large (max ${MAX_TOKENS_LIMIT})` }
        }
    }

    if (payload.temperature !== undefined) {
        if (typeof payload.temperature !== "number" || payload.temperature < 0 || payload.temperature > 2) {
            return { valid: false, error: "temperature must be a number between 0 and 2" }
        }
    }

    if (payload.stream !== undefined && typeof payload.stream !== "boolean") {
        return { valid: false, error: "stream must be a boolean" }
    }

    // Tools validation
    if (payload.tools !== undefined) {
        if (!Array.isArray(payload.tools)) {
            return { valid: false, error: "tools must be an array" }
        }
        if (payload.tools.length > MAX_TOOLS_PER_REQUEST) {
            return { valid: false, error: `Too many tools (max ${MAX_TOOLS_PER_REQUEST})` }
        }
    }

    return { valid: true }
}

/**
 * Validate Anthropic messages request body
 */
export function validateAnthropicRequest(payload: any): ValidationResult {
    if (!payload || typeof payload !== "object") {
        return { valid: false, error: "Request body must be a JSON object" }
    }

    // Model validation
    if (!payload.model || typeof payload.model !== "string") {
        return { valid: false, error: "Model is required and must be a string" }
    }
    if (payload.model.length > MAX_MODEL_NAME_LENGTH) {
        return { valid: false, error: `Model name too long (max ${MAX_MODEL_NAME_LENGTH} characters)` }
    }

    // Messages validation
    if (!Array.isArray(payload.messages)) {
        return { valid: false, error: "Messages must be an array" }
    }
    if (payload.messages.length === 0) {
        return { valid: false, error: "Messages array cannot be empty" }
    }
    if (payload.messages.length > MAX_MESSAGES_PER_REQUEST) {
        return { valid: false, error: `Too many messages (max ${MAX_MESSAGES_PER_REQUEST})` }
    }

    for (let i = 0; i < payload.messages.length; i++) {
        const msg = payload.messages[i]
        if (!msg || typeof msg !== "object") {
            return { valid: false, error: `Message at index ${i} must be an object` }
        }
        if (!msg.role || typeof msg.role !== "string") {
            return { valid: false, error: `Message at index ${i} must have a role` }
        }
    }

    // max_tokens validation (required for Anthropic)
    if (payload.max_tokens !== undefined) {
        if (typeof payload.max_tokens !== "number" || !Number.isFinite(payload.max_tokens) || payload.max_tokens <= 0) {
            return { valid: false, error: "max_tokens must be a positive number" }
        }
        if (payload.max_tokens > MAX_TOKENS_LIMIT) {
            return { valid: false, error: `max_tokens too large (max ${MAX_TOKENS_LIMIT})` }
        }
    }

    // Keep the Anthropic-compatible endpoint bounded by the same limits as the
    // OpenAI-compatible endpoint. This prevents an otherwise valid payload from
    // expanding memory/work in downstream provider conversions.
    if (payload.tools !== undefined) {
        if (!Array.isArray(payload.tools)) {
            return { valid: false, error: "tools must be an array" }
        }
        if (payload.tools.length > MAX_TOOLS_PER_REQUEST) {
            return { valid: false, error: `Too many tools (max ${MAX_TOOLS_PER_REQUEST})` }
        }
    }

    return { valid: true }
}

/**
 * Sanitize string input to prevent injection
 */
export function sanitizeString(input: string, maxLength: number = MAX_SANITIZED_STRING_LENGTH): string {
    if (typeof input !== "string") return ""
    return input.slice(0, maxLength)
}

/**
 * Validate account ID format
 */
export function validateAccountId(id: string): boolean {
    if (!id || typeof id !== "string") return false
    // Only allow alphanumeric, dash, underscore, @ and .
    return /^[a-zA-Z0-9@._-]+$/.test(id) && id.length <= MAX_ACCOUNT_ID_LENGTH
}
