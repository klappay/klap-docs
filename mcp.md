# AI assistants (MCP)

## Overview

[`@klappay/mcp`](https://www.npmjs.com/package/@klappay/mcp) is an
open-source [Model Context Protocol](https://modelcontextprotocol.io)
server that lets an AI assistant — Claude Code, Claude Desktop, Cursor,
or any MCP client — call the Klap API on your behalf: look up a charge
and its timeline, check which webhook deliveries failed, run a metrics
query, or create a test charge and push it through the sandbox.

It runs **on your own machine**, started by the MCP client over stdio
with `npx`. Nothing is hosted by Klap: the server talks straight to
`https://api.klappay.com/v1` with your own API key, exactly like an
integration built on [`@klappay/node`](/getting-started) would — every
tool is a thin wrapper around one SDK method, so the same
[scopes](/authentication#scopes), rate limits and [errors](/errors)
apply.

This is different from [`llms.txt`](/getting-started#for-llms-and-agents):
`llms.txt` lets an agent *read* these docs; the MCP server lets it *act*
on your account. The source is at
[github.com/klappay/klap-mcp](https://github.com/klappay/klap-mcp) (MIT),
and its own reference lives at [mcp.klappay.com](https://mcp.klappay.com).

## Install

Requires Node.js 24+. Store the key once with the
[Klap CLI](https://cli.klappay.com) so it lives in `~/.klap/config.json`
(created with `0600` permissions) instead of in your MCP client's config
file, which is often synced, shared or committed:

```sh
npx @klappay/cli login --api-key - --base-url https://api.klappay.com/v1
```

Paste a `klap_test_...` key on stdin and press Ctrl-D — `--api-key -`
keeps it out of your shell history. A live key can be stored the same way
later; test and live keys sit in separate slots of the same file.

Then add **one server per environment**. Keeping test and live as
separate servers means the assistant always knows which one it's talking
to, and you can remove live without touching test.

::: code-group

```sh [Claude Code]
claude mcp add klap-test -- npx -y @klappay/mcp@1.0.0
claude mcp add klap-live -e KLAP_ENV=live -- npx -y @klappay/mcp@1.0.0
```

```json [Claude Desktop / Cursor]
{
  "mcpServers": {
    "klap-test": {
      "command": "npx",
      "args": ["-y", "@klappay/mcp@1.0.0"]
    },
    "klap-live": {
      "command": "npx",
      "args": ["-y", "@klappay/mcp@1.0.0"],
      "env": { "KLAP_ENV": "live" }
    }
  }
}
```

:::

Claude Desktop reads `claude_desktop_config.json`, Cursor reads
`~/.cursor/mcp.json` — same shape. Pin an exact version as above rather
than `@latest`: the server runs with your API key, so upgrade it on
purpose, after reading its changelog.

On startup the server prints one line to the client's MCP log —
`klap-mcp: test → api.klappay.com` — and never the key. If it refuses to
start, the same log has a one-line reason (see
[Configuration](#configuration)).

Then ask things like:

- "Which Klap environment are you connected to?"
- "Create a 25 USD test charge payable in USDC on Base, expiring in 15
  minutes."
- "Mark that charge as confirmed in the sandbox, then show me its
  timeline."
- "Which of my webhooks had failed deliveries this week?"

## Test vs. live

| | `test` (default) | `live` | `live` + `KLAP_MCP_ALLOW_LIVE_WRITES=1` |
|---|---|---|---|
| Read tools | yes | yes | yes |
| `charges_create`, `charges_check`, `webhooks_retry_delivery` | yes | no | yes |
| `sandbox_trigger` | yes | no | no |

**Live is read-only by default.** Write tools aren't hidden behind a
prompt or a confirmation — in live they're simply never registered, so
an assistant can't call them whatever it's told (including by text it
reads back from the API, like a charge's `metadata` or a webhook URL).
Only add `KLAP_MCP_ALLOW_LIVE_WRITES=1` (exactly `1`) if you really want
the assistant creating live charges or re-sending live webhook
deliveries.

A dedicated key with only the [scopes](/authentication#scopes) the
assistant needs — e.g. `charges:read` + `webhooks:read` +
`metrics:read` for a live, read-only server — caps what it can do at the
API itself, independently of the server's own rules.

## Tools

Every result is JSON carrying an `environment` field (`test`/`live`).
API responses are parsed through the published
[`@klappay/types`](/getting-started) schemas before the assistant sees
them: unknown fields are dropped, and a response that doesn't match
becomes an `unexpected_response` error instead of being passed through.

| Tool | SDK method | REST | Notes |
|---|---|---|---|
| `klap_status` | — | — | Returns `{ environment, host }`. No API call. |
| `charges_get` | `charges.get(id)` | `GET /charges/{id}` | `metadata` is left out unless `includeMetadata: true` — it's free-form merchant data that may hold customer details. See [Charges](/charges). |
| `charges_timeline` | `charges.getTimeline(id)` | `GET /charges/{id}/timeline` | See [Audit trail](/charges#audit-trail). |
| `webhooks_list` | `webhooks.list()` | `GET /webhooks` | Each `url` is reduced to origin + path (credentials, query string and fragment removed). Secrets are never returned, only the `hint`. |
| `webhooks_list_deliveries` | `webhooks.listDeliveries(id, page)` | `GET /webhooks/{id}/deliveries` | `limit` 1–100 (default 20), `cursor` from the previous page. |
| `networks_get` | `networks.get()` | `GET /networks` | The `(token, network)` pairs this environment accepts. See [Networks & tokens](/networks). |
| `metrics_query` | `metrics.query(query)` | `POST /metrics/query` | Takes a `MetricsQuery`. See [Metrics](/metrics). |
| `charges_create` | `charges.create(input)` | `POST /charges` | `CreateCharge` without `escrow` and `redirectUrl`. Pass `idempotencyKey` to make a retry safe — without it, every call creates a new charge. |
| `charges_check` | `charges.check(id, input?)` | `POST /charges/{id}/check` | Optional `txHash` + `network`. See [Forcing an on-chain re-check](/charges#forcing-an-on-chain-re-check). |
| `webhooks_retry_delivery` | `webhooks.retryDelivery(id, deliveryId)` | `POST /webhooks/{id}/deliveries/{deliveryId}/retry` | The receiving endpoint processes that event again. |
| `sandbox_trigger` | `sandbox.trigger(id, event, amount?)` | `POST /sandbox/charges/{id}/trigger` | `charge.confirmed`, `.partially_paid`, `.overpaid`, `.expired`, `.underpaid`, `.settled` or `.settlement_failed`. See [Sandbox](/sandbox). |

Ids are validated before any request is sent (`ch_...`, `wh_...`,
`ev_...`). A failed call returns `isError: true` with the API's own
`code`/`status`/`message` — the same codes listed in [Errors](/errors).

## Not exposed on purpose

| Not available | Why |
|---|---|
| Escrow release / refund | They move funds out of a charge — that stays a deliberate human action. See [Releasing or refunding an escrow](/charges#releasing-or-refunding-an-escrow). |
| Webhook create / delete / rotate secret | Pointing deliveries elsewhere, or rotating a secret, can silently break or redirect your integration. |
| Recipient changes | They decide where money goes. See [Recipients](/recipients). |
| Live event streams | A long-lived [SSE stream](/realtime) doesn't fit a request/response tool. |
| QR codes and swap quotes | Payer-facing features with no use to an assistant. |

For any of these, use the [Dashboard](https://app.klappay.com), the
[CLI](https://cli.klappay.com) or the SDK directly.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `KLAP_ENV` | `test` | `test` or `live`, exactly. Anything else refuses to start. |
| `KLAP_API_KEY` | unset | Use this key instead of `~/.klap/config.json`. Requires `KLAP_BASE_URL`; its prefix must match `KLAP_ENV`. |
| `KLAP_BASE_URL` | stored base URL | Required with `KLAP_API_KEY`. With a stored key it must equal the stored base URL. |
| `KLAP_MCP_ALLOW_LIVE_WRITES` | unset | Exactly `1` registers the live write tools. No effect in `test`. |

The server refuses to start, rather than guess, whenever the setup is
ambiguous: a `klap_live_` key with `KLAP_ENV` unset, a stored key paired
with a different `KLAP_BASE_URL` (a stored key is only ever sent to the
host it was stored with), or a plain `http://` base URL on anything but
`localhost`. Unlike the CLI, it never picks live on its own — if only a
live key is stored, set `KLAP_ENV=live`.

Passing `KLAP_API_KEY` + `KLAP_BASE_URL` directly in the client's `env`
works for CI or a throwaway setup, but puts the key in that config file;
prefer `klap login` on a workstation. The full list of refusals and how
to fix each is at
[mcp.klappay.com/configuration](https://mcp.klappay.com/configuration).

## See also

- [Authentication](/authentication) — key format, scopes, rotation and
  revocation; revoke the key the server uses the same way as any other.
- [Sandbox](/sandbox) — what `sandbox_trigger` does to a charge, and
  which events can't be triggered.
- [mcp.klappay.com](https://mcp.klappay.com) — the server's own docs,
  with [`llms-full.txt`](https://mcp.klappay.com/llms-full.txt).
