/**
 * Protobuf Encoder for Language Server Communication
 * Based on reverse-engineered Antigravity request format
 */
import { getAntigravityIdeVersion } from "~/lib/antigravity-client"

export class ProtoEncoder {
    private buffer: number[] = []

    writeVarint(value: number): this {
        while (value > 0x7f) {
            this.buffer.push((value & 0x7f) | 0x80)
            value >>>= 7
        }
        this.buffer.push(value & 0x7f)
        return this
    }

    writeString(fieldNo: number, value: string | undefined): this {
        if (!value) return this
        const bytes = Buffer.from(value, "utf8")
        this.buffer.push((fieldNo << 3) | 2)
        this.writeVarint(bytes.length)
        this.buffer.push(...bytes)
        return this
    }

    writeBytes(fieldNo: number, data: number[] | Uint8Array): this {
        if (!data || data.length === 0) return this
        this.buffer.push((fieldNo << 3) | 2)
        this.writeVarint(data.length)
        this.buffer.push(...data)
        return this
    }

    writeMessage(fieldNo: number, encoder: ProtoEncoder): this {
        return this.writeBytes(fieldNo, [...encoder.finish()])
    }

    writeVarintField(fieldNo: number, value: number): this {
        this.buffer.push((fieldNo << 3) | 0)
        this.writeVarint(value)
        return this
    }

    finish(): Uint8Array {
        return new Uint8Array(this.buffer)
    }
}

/**
 * Antigravity Model Enum Values
 * Extracted from extension.js protobuf definitions (2024-12-24)
 */
export const MODEL_ENUM = {
    // Claude models
    CLAUDE_4_SONNET: 281,
    CLAUDE_4_SONNET_THINKING: 282,
    CLAUDE_4_OPUS: 290,
    CLAUDE_4_OPUS_THINKING: 291,
    CLAUDE_4_5_SONNET: 333,
    CLAUDE_4_5_SONNET_THINKING: 334,
    CLAUDE_4_5_HAIKU: 340,
    CLAUDE_4_5_HAIKU_THINKING: 341,

    // Gemini 2.5 models
    GEMINI_2_5_PRO: 246,
    GEMINI_2_5_FLASH: 312,

    // Gemini 3 models (代号)
    GEMINI_3_PRO_HIGH: 353,    // RIFTRUNNER_THINKING_HIGH
    GEMINI_3_PRO_LOW: 352,     // RIFTRUNNER_THINKING_LOW
    GEMINI_3_FLASH: 348,       // RIFTRUNNER
    GEMINI_3_PRO: 350,         // INFINITYJET

    // Gemini 4 Argon models (MODEL_PLACEHOLDER_M417..M419)
    GEMINI_4_ARGON_HIGH: 1417,
    GEMINI_4_ARGON_MEDIUM: 1418,
    GEMINI_4_ARGON_LOW: 1419,

    // GPT-OSS models
    GPT_OSS_120B_MEDIUM: 342,
} as const

/**
 * Map user-friendly model names to enum values
 */
export function getModelEnumValue(modelName: string): number | undefined {
    const normalized = modelName.toLowerCase()
        .replace(/[- .]/g, "_")
        .replace(/gemini_3_1_pro/g, "gemini_3_pro")
        .replace(/gemini_3_[567]_flash/g, "gemini_3_flash")

    // Claude 4.5 Sonnet (with thinking)
    if (normalized.includes("sonnet_4_5") || normalized.includes("4_5_sonnet")) {
        if (normalized.includes("think")) {
            return MODEL_ENUM.CLAUDE_4_5_SONNET_THINKING
        }
        return MODEL_ENUM.CLAUDE_4_5_SONNET
    }

    // Claude 4.5 Haiku (with thinking)
    if (normalized.includes("haiku_4_5") || normalized.includes("4_5_haiku")) {
        if (normalized.includes("think")) {
            return MODEL_ENUM.CLAUDE_4_5_HAIKU_THINKING
        }
        return MODEL_ENUM.CLAUDE_4_5_HAIKU
    }

    // Claude Opus 4.5 (thinking)
    if (normalized.includes("opus_4_5") || normalized.includes("4_5_opus")) {
        // Opus 4.5 only has thinking version
        return MODEL_ENUM.CLAUDE_4_OPUS_THINKING
    }

    // Claude 4 Opus
    if (normalized.includes("opus_4") || normalized.includes("4_opus")) {
        if (normalized.includes("think")) {
            return MODEL_ENUM.CLAUDE_4_OPUS_THINKING
        }
        return MODEL_ENUM.CLAUDE_4_OPUS
    }

    // Claude 4 Sonnet
    if (normalized.includes("sonnet_4") || normalized.includes("4_sonnet")) {
        if (normalized.includes("think")) {
            return MODEL_ENUM.CLAUDE_4_SONNET_THINKING
        }
        return MODEL_ENUM.CLAUDE_4_SONNET
    }

    // Gemini 4 Argon (High/Medium/Low)
    if (normalized.includes("gemini_4_argon") || normalized.includes("argon")) {
        if (normalized.includes("high")) {
            return MODEL_ENUM.GEMINI_4_ARGON_HIGH
        }
        if (normalized.includes("low")) {
            return MODEL_ENUM.GEMINI_4_ARGON_LOW
        }
        return MODEL_ENUM.GEMINI_4_ARGON_MEDIUM
    }

    // Gemini 3.1 models use the same Antigravity enum families as Gemini 3.
    // Keep this check ahead of the Gemini 3 matcher because `gemini_3_1_*`
    // does not contain the contiguous `gemini_3_pro`/`gemini_3_flash` token.
    if (normalized.includes("gemini_3_1_pro")) {
        if (normalized.includes("high")) {
            return MODEL_ENUM.GEMINI_3_PRO_HIGH
        }
        if (normalized.includes("low")) {
            return MODEL_ENUM.GEMINI_3_PRO_LOW
        }
        return MODEL_ENUM.GEMINI_3_PRO
    }

    if (normalized.includes("gemini_3_1_flash")) {
        return MODEL_ENUM.GEMINI_3_FLASH
    }

    // Gemini 3 Pro (High/Low)
    if (normalized.includes("gemini_3_pro")) {
        if (normalized.includes("high")) {
            return MODEL_ENUM.GEMINI_3_PRO_HIGH
        }
        if (normalized.includes("low")) {
            return MODEL_ENUM.GEMINI_3_PRO_LOW
        }
        return MODEL_ENUM.GEMINI_3_PRO
    }

    // Gemini 3 Flash
    if (normalized.includes("gemini_3_flash")) {
        return MODEL_ENUM.GEMINI_3_FLASH
    }

    // 🆕 2026-10-02: gemini-3.8-flash-* 目前無法透過 enum 路徑使用。
    // 實測（上游原始回應，/tmp/antiapi-upstream-diag.log）：
    //   enum 348 (GEMINI_3_FLASH) → 404 NOT_FOUND "Requested entity was not found"
    //   undefined (cascade 自動選) → 429 RESOURCE_EXHAUSTED
    // 上游的 enum 表（從 agy 二進位 descriptor 解出）只有
    // RIFTRUNNER=348 / RIFTRUNNER_THINKING_LOW=352 / RIFTRUNNER_THINKING_HIGH=353
    // / INFINITYJET=350，沒有對應 3.8 的新值；3.8 目前只能由官方 agy 用字串
    // model ID 送出。保留映射位置，等上游 enum 更新後填入。
    if (normalized.includes("gemini_3_8_flash")) {
        return undefined
    }

    // Gemini 2.5 Pro
    if (normalized.includes("gemini_2_5_pro") || normalized.includes("gemini_25_pro")) {
        return MODEL_ENUM.GEMINI_2_5_PRO
    }

    // Gemini 2.5 Flash
    if (normalized.includes("gemini_2_5_flash") || normalized.includes("gemini_25_flash")) {
        return MODEL_ENUM.GEMINI_2_5_FLASH
    }

    // GPT-OSS 120B
    if (normalized.includes("gpt_oss") || normalized.includes("gptoss")) {
        return MODEL_ENUM.GPT_OSS_120B_MEDIUM
    }

    // Gemini 3 Flash - fallback check
    if (normalized.includes("3_flash") || normalized.includes("flash_3")) {
        return MODEL_ENUM.GEMINI_3_FLASH
    }

    // Default: no specific model (let Cascade choose)
    return undefined
}

/**
 * Encode a varint to bytes
 */
function encodeVarint(value: number): number[] {
    const bytes: number[] = []
    while (value > 0x7f) {
        bytes.push((value & 0x7f) | 0x80)
        value >>>= 7
    }
    bytes.push(value & 0x7f)
    return bytes
}

/**
 * Build CascadeConfig with optional model selection
 * 
 * Original cascade_config (40 bytes):
 * 0a22 1204 2001 7001 6a0b 4204 1a02 3003 8a02 0208 027a 0308 f407 aa01 0208 0182 0202 0801 3a02 0801
 * 
 * Field 1 (planner_config): 34 bytes
 *   Field 2 (conversational): 4 bytes [0x20,0x01,0x70,0x01] = field4=1, field14=1
 *   Field 13: 11 bytes
 *   Field 15: 3 bytes
 *   Field 21: 2 bytes
 *   Field 32: 2 bytes
 * Field 7: 2 bytes [0x08,0x01]
 * 
 * To add plan_model (field 1), insert at start of conversational content
 */
export function buildCascadeConfig(modelEnumValue?: number): Uint8Array {
    // If no model specified, use default config
    if (!modelEnumValue) {
        return new Uint8Array([
            0x0a, 0x22, 0x12, 0x04, 0x20, 0x01, 0x70, 0x01, 0x6a, 0x0b, 0x42, 0x04,
            0x1a, 0x02, 0x30, 0x03, 0x8a, 0x02, 0x02, 0x08, 0x02, 0x7a, 0x03, 0x08,
            0xf4, 0x07, 0xaa, 0x01, 0x02, 0x08, 0x01, 0x82, 0x02, 0x02, 0x08, 0x01,
            0x3a, 0x02, 0x08, 0x01
        ])
    }

    // Encode plan_model field: field 1, wire type 0 (varint)
    const planModelField = [0x08, ...encodeVarint(modelEnumValue)]

    // Original conversational content: field4=1, field14=1
    const origConvContent = [0x20, 0x01, 0x70, 0x01]

    // New conversational content = plan_model + original
    const newConvContent = [...planModelField, ...origConvContent]

    // Other planner_config fields (field 13, 15, 21, 32)
    const otherPlannerFields = [
        0x6a, 0x0b, 0x42, 0x04, 0x1a, 0x02, 0x30, 0x03, 0x8a, 0x02, 0x02, 0x08, 0x02,
        0x7a, 0x03, 0x08, 0xf4, 0x07,
        0xaa, 0x01, 0x02, 0x08, 0x01,
        0x82, 0x02, 0x02, 0x08, 0x01
    ]

    // Build new planner_config content
    // Field 2 (conversational): tag=0x12, length, content
    const convFieldTag = 0x12
    const convLenBytes = encodeVarint(newConvContent.length)
    const newPlannerContent = [convFieldTag, ...convLenBytes, ...newConvContent, ...otherPlannerFields]

    // Build cascade_config
    // Field 1 (planner_config): tag=0x0a, length, content
    const plannerFieldTag = 0x0a
    const plannerLenBytes = encodeVarint(newPlannerContent.length)

    // Field 7: [0x3a, 0x02, 0x08, 0x01]
    const field7 = [0x3a, 0x02, 0x08, 0x01]

    return new Uint8Array([
        plannerFieldTag, ...plannerLenBytes, ...newPlannerContent,
        ...field7
    ])
}

// Keep legacy constant for backwards compatibility
export const DEFAULT_CASCADE_CONFIG = buildCascadeConfig()

export interface SendMessageOptions {
    cascadeId: string
    message: string
    apiKey: string
    model?: string
    ideName?: string
    ideVersion?: string
    extensionName?: string
    locale?: string
}

/**
 * Encode a SendUserCascadeMessageRequest
 */
export function encodeSendUserCascadeMessage(options: SendMessageOptions): Uint8Array {
    const {
        cascadeId,
        message,
        apiKey,
        model,
        ideName = "antigravity",
        ideVersion = getAntigravityIdeVersion(),
        extensionName = "antigravity",
        locale = "en"
    } = options

    // Get model enum value if specified
    const modelEnumValue = model ? getModelEnumValue(model) : undefined

    // Item message: field 1 = text
    const item = new ProtoEncoder()
    item.writeString(1, message)

    // Metadata message
    const metadata = new ProtoEncoder()
    metadata.writeString(1, ideName)
    metadata.writeString(3, apiKey)
    metadata.writeString(4, locale)
    metadata.writeString(7, ideVersion)
    metadata.writeString(12, extensionName)

    // Build cascade_config with model selection
    const cascadeConfig = buildCascadeConfig(modelEnumValue)

    // Full request
    const request = new ProtoEncoder()
    request.writeString(1, cascadeId)
    request.writeMessage(2, item)
    request.writeMessage(3, metadata)
    request.writeBytes(5, [...cascadeConfig])
    request.writeVarintField(11, 1)

    return request.finish()
}
