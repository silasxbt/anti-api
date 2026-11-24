/**
 * Per-provider subscription plan configuration.
 *
 * Some upstreams (GitHub Copilot) do not reliably expose the current plan through the
 * quota endpoint, so the plan is user-configurable from the dashboard and stored per account.
 * The plan is used to derive a shared per-pool budget ("tokens/USD per 1% quota") that every
 * account on the same plan uses, so same-plan accounts report identical limits.
 */

import type { AuthProvider } from "~/services/auth/types"

/** Selectable plan values per provider. Empty array = provider does not use plan-based budgeting. */
export const ACCOUNT_PLAN_OPTIONS: Record<AuthProvider, string[]> = {
    antigravity: ["free", "plus", "free_pro", "pro", "ultra"],
    copilot: ["free", "student", "pro", "pro_plus", "max", "business", "enterprise"],
    codex: [],
    zed: [],
    kiro: [],
    grok: [],
}

/** Effective default plan when an account has no explicit plan set (used for pooling + display). */
export const DEFAULT_PLAN: Record<AuthProvider, string> = {
    antigravity: "pro",
    copilot: "student",
    codex: "",
    zed: "",
    kiro: "",
    grok: "",
}

/** Resolve the effective plan for an account: explicit plan wins, else provider default. */
export function resolvePlan(provider: AuthProvider, explicitPlan?: string | null): string {
    const trimmed = (explicitPlan || "").trim().toLowerCase()
    if (trimmed) return trimmed
    return DEFAULT_PLAN[provider] || ""
}

/** Validate a user-supplied plan against the provider's allowed set. Returns the value or null. */
export function normalizePlanInput(provider: AuthProvider, input: unknown): string | null {
    if (input === undefined) return undefined as unknown as string | null
    if (input === null) return ""
    const v = String(input || "").trim().toLowerCase()
    const allowed = ACCOUNT_PLAN_OPTIONS[provider] || []
    if (v === "") return ""
    if (allowed.length === 0) return v // providers without plan options accept free-form (ignored downstream)
    return allowed.includes(v) ? v : null
}
