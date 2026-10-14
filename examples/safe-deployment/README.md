# Remnawave MCP: isolated review profile

This example targets Remnawave 3.4.5 and the local hardening patch. It is a stdio MCP process, not an HTTP server or a Telegram bot.

From the repository root, with Docker Compose installed:

```sh
docker compose -f examples/safe-deployment/compose.yaml --profile offline build offline-check
docker compose -f examples/safe-deployment/compose.yaml --profile offline run --rm --no-deps offline-check
```

The offline command needs no token and cannot reach a panel at runtime. Building still downloads dependencies and base images.

The optional `panel-read` profile is for a later, deliberate connection to a test panel. Create a separate API token with only these read scopes: `system:read`, `nodes:read`, `users:read`, `hwid-user-devices:read`, `bandwidth-stats:read`, `subscription-request-history:read`. Store the token in a local file outside Git, set `MCP_TOKEN_FILE` to its absolute path, and set `MCP_PANEL_URL` to the canonical HTTPS URL without `/api`, credentials, query or fragment.

```sh
docker compose -f examples/safe-deployment/compose.yaml --profile panel-read run --rm --no-deps -T mcp-stdio
```

An MCP client must launch that command and keep stdin/stdout connected. `docker compose up -d` in Portainer alone does not provide a usable remote MCP endpoint. The profile publishes no ports, mounts no Docker socket, and does not join the panel's network. Its bridge network allows outbound traffic; it is not an egress firewall.

Docker Compose file secrets are mounted files, not an encrypted secret vault. Protect their source files with host permissions. The patched server accepts `REMNAWAVE_API_TOKEN_FILE`, `REMNAWAVE_API_KEY_FILE`, `CF_ACCESS_CLIENT_SECRET_FILE` and `REMNAWAVE_PRIVACY_SALT_FILE`. Do not set both a variable and its `_FILE` alternative. The raw response limit is controlled by `REMNAWAVE_MAX_RESPONSE_BYTES` (default 5 MiB, minimum 1 byte). Redirects are refused: use the final panel URL.

GeoCheck and connection jobs are intentionally absent from this example's allowlist because they actively query nodes. All allowlisted reports still return panel-wide or customer data: do not expose this stdio instance directly to end customers. Tenant authorization must be implemented in the future gateway.

No deployment or live connection was performed while preparing this example.
