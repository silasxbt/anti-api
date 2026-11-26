# Contributing

## Prerequisites

- Bun (latest stable)
- Rust toolchain when changing `rust-proxy`

## Setup

```bash
bun install
bun run src/main.ts start
```

The complete application is loopback-only by default. Do not expose its management port while testing. Use mock upstreams and test accounts that you own or are explicitly authorized to administer.

## Formatting

- Follow `.editorconfig` (4-space indent, LF, final newline).
- Keep changes focused; avoid reformat-only diffs.
- Match the existing TypeScript and Rust style.

## Security and Provider Boundaries

Contributions must not:

- Include personal access tokens, refresh tokens, cookies, account databases, confidential OAuth secrets, or logs containing them.
- Create accounts, aggregate free-tier allowances, evade rate limits or quotas, bypass provider enforcement, or hide an integration's authorization status.
- Add a silent TLS-verification bypass or automatic downgrade after a certificate error.
- Send credentials to a third-party host without an explicit opt-in, a user-configured HTTPS URL, and clear disclosure.
- Read, modify, or delete another application's credential store by default.
- Claim that a provider authorizes, endorses, or is unaffected by an integration without verifiable documentation.

A new provider or credential source must document the exact endpoints, credential scope, source paths, local storage, refresh behavior, revocation path, external side effects, and the contributor's authorization to test it. Prefer documented provider APIs and project-owned OAuth clients where available.

## Tests

```bash
bun test ./test --test-concurrency 1
bun x tsc --noEmit
bun run build
cargo test --manifest-path rust-proxy/Cargo.toml
```

Tests must not contact real providers, start public tunnels, modify real CLI/IDE credentials, or run the updater. Use temporary homes, fixtures, and mocked fetch implementations.

## Reporting Security Issues

Do not place credentials, private account data, or unredacted logs in a public issue. Use GitHub's private vulnerability reporting form at <https://github.com/silasxbt/anti-api/security/advisories/new>. See `SECURITY.md` for the expected report contents.
