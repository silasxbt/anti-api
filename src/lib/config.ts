/**
 * Anti-API 配置
 * Antigravity API端点和模型映射
 */

// 默认端口
export const DEFAULT_PORT = 8964

// 支持的模型列表（用於/v1/models端點）
// 2026-11-10: 收斂為「真的能回傳內容」的模型（逐個 POST 實測）。
//   移除：claude-sonnet-4-6 / claude-opus-4-6-thinking（上游已下線，回 deprecation 訊息）、
//         gemini-3-flash-agent / gemini-3.5-flash-low / gemini-3.5-flash-extra-low（同上）、
//         chat_20706 / chat_23310 / tab_*_preview（上游內部/預覽項，400 無 routing）。
//   保留 quota 暫停的 gemini-2.5-pro / gpt-oss-120b-medium（429，11/15 額度重置後可恢復）。
// 此清單即 antigravity 在 /v1/models 的唯一來源；非 antigravity provider 須有已配置帳號才會列出。
export const AVAILABLE_MODELS = [
    // Auto-synced by ~/bin/anti-api-sync-models.py on 2026-11-26 04:13:31 — do not edit by hand.
    // (Live upstream catalog ∪ previously configured ids, probe-verified via :8964.)
    // Re-sync: run ~/bin/anti-api-sync-models.py
    { id: "claude-opus-5-5-high", name: "Claude Opus 5.5 (High)" },
    { id: "claude-opus-5-5-low", name: "Claude Opus 5.5 (Low)" },
    { id: "claude-opus-5-5-medium", name: "Claude Opus 5.5 (Medium)" },
    { id: "claude-sonnet-5-5-high", name: "Claude Sonnet 5.5 (High)" },
    { id: "claude-sonnet-5-5-low", name: "Claude Sonnet 5.5 (Low)" },
    { id: "claude-sonnet-5-5-medium", name: "Claude Sonnet 5.5 (Medium)" },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash (Lite)" },
    { id: "gemini-2.5-flash-thinking", name: "Gemini 2.5 Flash (Thinking)" },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { id: "gemini-3-flash", name: "Gemini 3 Flash" },
    { id: "gemini-3.1-flash-image", name: "Gemini 3.1 Flash (Image)" },
    { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash (Lite)" },
    { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash (Lite)" },
    { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
    { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
    { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
    { id: "gemini-3.8-flash-tiered", name: "Gemini 3.8 Flash (Tiered)" },
    { id: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" },
    { id: "gemini-4-argon-low", name: "Gemini 4 Argon (Low)" },
    { id: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)" },
    { id: "gemini-4-carbon-high", name: "gemini-4-carbon-high" },
    { id: "gemini-4-carbon-low", name: "gemini-4-carbon-low" },
    { id: "gemini-4-carbon-medium", name: "gemini-4-carbon-medium" },
    { id: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (High)" },
    { id: "gemini-4-hydrogen-low", name: "Gemini 4 Hydrogen (Low)" },
    { id: "gemini-4-hydrogen-medium", name: "Gemini 4 Hydrogen (Medium)" },
    { id: "gemini-4-hydrogen-sonar", name: "Gemini 4 Hydrogen (Sonar)" },
    { id: "gemini-4-hydrogen-xhigh", name: "Gemini 4 Hydrogen (XHigh)" },
    { id: "gemini-4-neon-high", name: "gemini-4-neon-high" },
    { id: "gemini-4-neon-low", name: "gemini-4-neon-low" },
    { id: "gemini-4-neon-medium", name: "gemini-4-neon-medium" },
    { id: "gemini-4-neon-xhigh", name: "gemini-4-neon-xhigh" },
    { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
    { id: "tab_flash_lite_preview", name: "tab_flash_lite_preview" },
    { id: "tab_jump_flash_lite_preview", name: "tab_jump_flash_lite_preview" },
]
