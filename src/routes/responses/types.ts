/**
 * OpenAI Responses API (/v1/responses) Type Definitions
 */

export type ResponsesRole = "user" | "assistant" | "system" | "developer"

export interface ResponsesInputTextPart {
    type: "input_text" | "text"
    text: string
}

export interface ResponsesOutputTextPart {
    type: "output_text"
    text: string
    annotations?: Array<Record<string, unknown>>
}

export interface ResponsesRefusalPart {
    type: "refusal"
    refusal: string
}

export interface ResponsesInputImagePart {
    type: "input_image" | "image_url"
    image_url?: string | { url: string; detail?: "auto" | "low" | "high" }
    file_id?: string
    detail?: "auto" | "low" | "high"
}

export interface ResponsesInputAudioPart {
    type: "input_audio" | "audio_url"
    input_audio?: {
        data: string
        format?: "wav" | "mp3" | string
    }
    audio_url?: string | { url: string }
    data?: string
    format?: "wav" | "mp3" | string
}

export interface ResponsesInputFilePart {
    type: "input_file"
    file_id?: string
    filename?: string
    file_data?: string
}

export type ResponsesContentPart =
    | ResponsesInputTextPart
    | ResponsesOutputTextPart
    | ResponsesRefusalPart
    | ResponsesInputImagePart
    | ResponsesInputAudioPart
    | ResponsesInputFilePart

export interface ResponsesMessageItem {
    type?: "message"
    id?: string
    status?: "in_progress" | "completed" | "incomplete"
    role: ResponsesRole
    content: string | ResponsesContentPart[]
}

export interface ResponsesFunctionCallItem {
    type: "function_call"
    id?: string
    status?: "in_progress" | "completed" | "incomplete"
    call_id: string
    name: string
    arguments: string
    thought_signature?: string
    thoughtSignature?: string
}

export interface ResponsesFunctionCallOutputItem {
    type: "function_call_output"
    id?: string
    status?: "in_progress" | "completed" | "incomplete"
    call_id: string
    output: string | ResponsesContentPart[] | Record<string, unknown>
}

export interface ResponsesReasoningSummaryPart {
    type: "summary_text"
    text: string
}

export interface ResponsesReasoningItem {
    type: "reasoning"
    id?: string
    status?: "in_progress" | "completed" | "incomplete"
    summary?: ResponsesReasoningSummaryPart[]
    encrypted_content?: string | null
}

export interface ResponsesItemReference {
    type: "item_reference"
    id: string
}

export type ResponsesInputItem =
    | ResponsesMessageItem
    | ResponsesFunctionCallItem
    | ResponsesFunctionCallOutputItem
    | ResponsesReasoningItem
    | ResponsesItemReference

export interface ResponsesFunctionTool {
    type: "function"
    name?: string
    description?: string
    parameters?: Record<string, unknown>
    strict?: boolean | null
    function?: {
        name: string
        description?: string
        parameters?: Record<string, unknown>
        strict?: boolean | null
    }
}

export interface ResponsesBuiltinTool {
    type: "web_search" | "web_search_preview" | "file_search" | "code_interpreter" | "computer_use_preview" | string
    [key: string]: unknown
}

export type ResponsesTool = ResponsesFunctionTool | ResponsesBuiltinTool

export type ResponsesToolChoice =
    | "auto"
    | "none"
    | "required"
    | {
          type: "function"
          name?: string
          function?: { name: string }
      }
    | {
          type: string
          name?: string
      }

export interface ResponsesReasoningConfig {
    effort?: "low" | "medium" | "high" | "xhigh" | "minimal" | "none" | string | null
    summary?: "auto" | "concise" | "detailed" | string | null
}

export interface ResponsesTextConfig {
    format?: {
        type: "text" | "json_object" | "json_schema"
        name?: string
        schema?: Record<string, unknown>
        strict?: boolean
        description?: string
    }
}

export interface ResponsesCreateRequest {
    model: string
    input: string | ResponsesInputItem[]
    instructions?: string | null
    stream?: boolean | null
    max_output_tokens?: number | null
    temperature?: number | null
    top_p?: number | null
    tools?: ResponsesTool[] | null
    tool_choice?: ResponsesToolChoice | null
    parallel_tool_calls?: boolean | null
    reasoning?: ResponsesReasoningConfig | null
    reasoning_effort?: "low" | "medium" | "high" | "xhigh" | string | null
    text?: ResponsesTextConfig | null
    metadata?: Record<string, string> | null
    store?: boolean | null
    user?: string | null
    previous_response_id?: string | null
    truncation?: "auto" | "disabled" | string | null
    include?: string[] | null
}

export interface ResponseOutputText {
    type: "output_text"
    text: string
    annotations: Array<Record<string, unknown>>
}

export interface ResponseOutputRefusal {
    type: "refusal"
    refusal: string
}

export type ResponseOutputContentPart = ResponseOutputText | ResponseOutputRefusal

export interface ResponseOutputMessageItem {
    id: string
    type: "message"
    status: "in_progress" | "completed" | "incomplete"
    role: "assistant"
    content: ResponseOutputContentPart[]
}

export interface ResponseOutputFunctionCallItem {
    id: string
    type: "function_call"
    status: "in_progress" | "completed" | "incomplete"
    call_id: string
    name: string
    arguments: string
    thought_signature?: string
}

export interface ResponseOutputReasoningItem {
    id: string
    type: "reasoning"
    status: "in_progress" | "completed" | "incomplete"
    summary: ResponsesReasoningSummaryPart[]
}

export type ResponseOutputItem =
    | ResponseOutputReasoningItem
    | ResponseOutputMessageItem
    | ResponseOutputFunctionCallItem

export interface ResponseUsage {
    input_tokens: number
    output_tokens: number
    total_tokens: number
    input_tokens_details: {
        cached_tokens: number
    }
    output_tokens_details: {
        reasoning_tokens: number
    }
}

export interface ResponseIncompleteDetails {
    reason: "max_output_tokens" | "content_filter" | string
}

export interface ResponseObject {
    id: string
    object: "response"
    created_at: number
    status: "in_progress" | "completed" | "incomplete" | "failed" | "cancelled"
    error: { code: string; message: string } | null
    incomplete_details: ResponseIncompleteDetails | null
    instructions: string | null
    max_output_tokens: number | null
    model: string
    output: ResponseOutputItem[]
    output_text: string
    parallel_tool_calls: boolean
    previous_response_id: string | null
    reasoning: {
        effort: string | null
        summary: string | null
    }
    store: boolean
    temperature: number
    text: {
        format: {
            type: string
            [key: string]: unknown
        }
    }
    tool_choice: ResponsesToolChoice
    tools: ResponsesTool[]
    top_p: number
    truncation: string
    usage: ResponseUsage | null
    user: string | null
    metadata: Record<string, string>
}
