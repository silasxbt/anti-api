# Anti-API Development Guide

## Overview
Anti-API proxies Antigravity's internal AI models as an Anthropic-compatible API.

## Key Files

- `src/main.ts` - CLI entry point
- `src/server.ts` - Hono HTTP server setup
- `src/services/antigravity/chat.ts` - Core chat logic
- `src/proto/encoder.ts` - Protobuf encoding with model selection
- Antigravity requests use the provider API directly; the old local
  language-server port discovery path is intentionally not part of the runtime.

## Model Selection

Models are specified via `model` parameter in requests. See `MODEL_ENUM` in `encoder.ts` for supported values.

## API Compatibility

Supports `/v1/messages`, `/v1beta/messages`, and `/messages` endpoints for maximum compatibility.

## Running

```bash
bun run src/main.ts start       # Default port 8964
bun run src/main.ts start -v    # Verbose logging
```

## Providers

Hosted providers are wired through `src/services/routing/router.ts` (dispatch),
`src/services/routing/models.ts` (model registry) and `src/services/auth`
(account store / types). Current providers: `antigravity`, `codex`, `copilot`,
`zed`, `kiro`, `grok`.

### Grok (xAI)

- Reverse proxy: `https://cli-chat-proxy.grok.com/v1/responses` (OpenAI Responses API).
- Required headers: `x-grok-client-version`, `x-grok-client-identifier`.
- Credentials can be imported from the local Grok CLI session (`~/.grok/auth.json`)
  after explicit user action; no standalone login flow is provided. Provider policy,
  quota, and account-enforcement decisions still apply.
- Exposed models: `grok-build` (panel label **Xbuild**, maps to the real
  **Grok 4.3** model) and `grok-composer-2.5-fast` (Composer 2.5 Fast).
- Code: `src/services/grok/oauth.ts`, `src/services/grok/chat.ts`.

## Maintenance Notes

- **Review every secret-scanning alert individually.** For an OAuth installed-app
  identifier, verify from provider documentation whether it is intentionally public
  and whether reuse is permitted. Record the source, scope, authorization basis, and
  review result. Never commit personal credentials or confidential client secrets;
  remove and rotate any value whose confidentiality or authorization is uncertain.
