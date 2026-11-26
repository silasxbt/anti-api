# Security Policy

## Supported Version

Security fixes are applied to the current `main` branch and the latest release. Older releases may still contain behavior or documentation that has since been corrected.

## Reporting a Vulnerability

Use GitHub Private Vulnerability Reporting:

<https://github.com/silasxbt/anti-api/security/advisories/new>

Do not open a public issue containing access tokens, refresh tokens, OAuth codes or state values, cookies, account files, tunnel tokens, private prompts, or unredacted logs.

A useful report includes:

- Affected commit or version
- Affected route, file, or provider
- Reproduction steps using mock credentials whenever possible
- Expected and observed behavior
- Potential credential, filesystem, process, or network impact
- Suggested remediation, if known

## Security Boundaries

Anti-API is an independent, unofficial local interoperability proxy. Some provider integrations use CLI, web, or internal endpoints. Their presence does not represent provider authorization or endorsement, and compatibility can change without notice.

### Local control plane

The complete dashboard and management API are designed to bind to loopback. They include account, routing, logs, settings, tunnel, diagnostic, and update operations and must not be exposed through a public reverse proxy. Docker is the one explicit exception: its control-plane listener binds inside the container, but every request must present `ANTI_API_CONTROL_TOKEN` (as `Authorization: Bearer`, `x-api-key`, or the bootstrap cookie). Compose maps the port to host loopback only; if you publish it on a LAN or public interface, treat the token as the sole authentication boundary and use a long random value.

To open a Docker dashboard in a browser, visit a one-time local URL with
`?control_token=...`; Anti-API replaces it with an HttpOnly, SameSite cookie and
redirects to a clean URL. Never share that bootstrap URL or put it in a public
bookmark, proxy log, or screenshot.

### Public inference gateway

Remote access uses a separate inference-only gateway and requires `ANTI_API_PUBLIC_TOKEN`. It exposes only supported message/chat, model-list, and minimal health routes. Query-string tokens are not accepted. Tunnels are third-party services and move traffic outside the local trust boundary.

### Credentials

Credential import is explicit by default and can copy access and refresh tokens from another CLI or IDE into `~/.anti-api`. On POSIX systems, Anti-API attempts to use `0700` directories and `0600` credential files. Files remain plaintext and must be protected by the host account and filesystem. Windows permissions are subject to the user's account and filesystem ACLs.

External CLI/IDE credential stores are not modified by default. Deleting an account from Anti-API deletes only Anti-API's copy. Review every secret-scanning alert individually; a public installed-application identifier is not the same as a confidential secret, but public visibility alone does not establish authorization to reuse it.

### TLS and third parties

OAuth, token, user-info, and quota requests verify TLS certificates by default. Install the correct enterprise CA rather than disabling verification. Codex credentials imported from a third-party proxy are not refreshed through a third-party endpoint unless the operator explicitly enables that behavior and configures an HTTPS URL.

### Filesystem and process actions

IDE logout, source updates, and tunnel processes have material side effects. They require local access and explicit confirmation where destructive. Anti-API does not automatically download ngrok and only terminates tunnel processes that it started.
