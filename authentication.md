# Authentication

## Overview

Klap has exactly one auth scheme: API keys, sent as a bearer token
on every request. There's no session cookie, no OAuth flow, no
separate "publishable" key safe for client-side use the way Stripe has
— a `klap_live_...`/`klap_test_...` key is a secret, same class as a
database password. Never embed one in browser JS, a mobile app, or any
code a user's device can inspect (view-source, devtools, decompiling
the app all extract it trivially). Charges must always be created from
a trusted backend holding the key server-side; if you need to show
live status in a browser, have your backend relay it (see
[Real-time status](/realtime)) instead of shipping the key itself.

Treat the whole `klap_live_<...>`/`klap_test_<...>` string as an opaque
bearer token and send it as-is; there's nothing in it for you to parse
or validate.

## Getting a key

Keys are created and managed from your dashboard at
[app.klappay.com](https://app.klappay.com) — sign up, then generate a
`klap_live_...` and/or `klap_test_...` key per environment. There's no
API endpoint for creating a key yourself; this is a one-time dashboard
step per environment, not something your integration code does at
runtime.

## Sending your API key

Every authenticated request needs an `Authorization: Bearer` header
carrying the full key, prefix included.

::: code-group

```bash [cURL]
curl https://api.klappay.com/v1/networks \
  -H "Authorization: Bearer klap_live_..."
```

```ts [Node.js]
import { createClient } from '@klappay/node'

const klap = createClient({
  baseUrl: 'https://api.klappay.com/v1',
  apiKey: process.env.KLAP_API_KEY, // klap_live_... or klap_test_...
})

const health = await klap.health.check()
```

:::

An invalid, malformed, or revoked key gets `401 invalid_api_key`. A
key that's valid but lacks a scope a route requires gets a separate
`403 insufficient_scope` instead — two different failure classes worth
branching on separately in your own error handling: the first means
"fix the key you're sending," the second means "ask for a
differently-scoped key." `GET /health` is the one route that needs no
key at all, useful as an uptime check that doesn't burn a real request
against your key's rate limits. See [Errors](/errors) for the full
error envelope both classes share.

## Scopes

Independent of environment (`live`/`test`) and of which account a key
belongs to, a key also carries a fixed set of **scopes** — what it's
allowed to *do*. Before scopes existed, any valid key could call every
authenticated route; scopes let you hand out a key that's safe to give
to a CI pipeline, a read-only internal dashboard, or a single-purpose
integration, without granting it the full range of what your account
can do.

The full vocabulary is a closed set of 14 strings, exported as
`ApiKeyScopeSchema` / `ApiKeyScope` from `@klappay/types` — validate
against it rather than hand-rolling the list, so a future scope
addition doesn't need a second place to update:

```ts
import { ApiKeyScopeSchema, API_KEY_SCOPES, type ApiKeyScope } from '@klappay/types'

ApiKeyScopeSchema.parse('charges:write') // 'charges:write'
API_KEY_SCOPES // readonly array of every valid scope string
```

| Scope | Grants |
|---|---|
| `charges:read` | `GET /charges`, `GET /charges/{id}`, `/timeline`, `/events`, `/qrcode` |
| `charges:write` | `POST /charges` |
| `charges:split_write` | Required **in addition to** `charges:write` whenever a `POST /charges` request includes `splitRecipients` — a key without it creates ordinary charges but can never redirect any part of a payout, even to an already-registered recipient |
| `webhooks:read` | `GET /webhooks`, `GET /webhooks/{id}/deliveries`, `GET /webhooks/listen` |
| `webhooks:write` | `POST /webhooks`, `DELETE /webhooks/{id}`, retrying a delivery |
| `webhooks:manage_secret` | `POST /webhooks/{id}/rotate-secret` — kept separate from `webhooks:write` since it returns a new plaintext secret, the single highest-trust action on this resource |
| `metrics:read` | `POST /metrics/query`, every `resource` (`charges`, `transactions`, `distributions`) |
| `metrics:charges:read` | `POST /metrics/query` with `resource: 'charges'` only |
| `metrics:transactions:read` | `POST /metrics/query` with `resource: 'transactions'` only |
| `metrics:distributions:read` | `POST /metrics/query` with `resource: 'distributions'` only |
| `sandbox:trigger` | `POST /sandbox/charges/{id}/trigger` — kept independent of `charges:write` even though both mutate charge state; simulating a state transition and creating a real charge are different capabilities |
| `recipients:read` | `GET /recipients` |
| `recipients:write` | `POST /recipients`, `DELETE /recipients/{id}` — registers or revokes a recipient (an address eligible to be *referenced* by `recipientId` in a split); doesn't by itself make it eligible to become a key's `payoutAddress`, and can't revoke a `payout: true` recipient |
| `recipients:manage_payout` | `PATCH /recipients/{id}` only — marks a recipient payout-eligible, and is required to revoke one that is. Meant for a key that already went through its own out-of-band approval, never a merchant-facing or third-party integration key. Revoking a `payout: true` recipient also stops any API key whose `payoutAddress` matches it from authenticating (`401 payout_address_revoked`) on its next request |

`metrics:read` and the three narrower `metrics:*:read` scopes aren't
mutually exclusive alternatives — a key can hold either, or both. A
key with only `metrics:charges:read` can query `charges` metrics but
gets `403 insufficient_scope` querying `transactions`/`distributions`;
a key with `metrics:read` can query all three regardless of which
narrower scopes it also has.

`charges:split_write` and `recipients:write`/`recipients:manage_payout`
are mutually exclusive: no key can hold `charges:split_write` together with
either recipient-registration scope, and a key that does is rejected
outright with `403 conflicting_api_key_scopes` before any route runs
(`CONFLICTING_SCOPE_PAIRS`/`findConflictingScopes` are exported from
`@klappay/types` so a key-minting UI can refuse the combination up front).
The ability to *register* a recipient and the ability to *route a split to
one* must live on separate keys; otherwise a single leaked key could add a
new address and immediately send money to it, which defeats the point of
requiring recipients to be pre-registered. See
[Recipients](/recipients).

Two authenticated routes check no scope at all: `GET /networks`
(identical response for every key in an environment, nothing
tenant-specific to protect) and `GET /distributions/pending`/
`/pending/events` (a cross-tenant public feed by design — on-chain
`distribute()` is permissionless, so this endpoint grants no
capability that isn't already open to anyone). Both still require a
valid, unrevoked, environment-matched key — they just skip the scope
check. `scopes` is otherwise a required part of every key: an empty
scope set (`[]`) still authenticates fine, it just can't pass any
scope check, so every scoped route on it returns `403`.

Ask for a key scoped to only what a given integration needs rather
than reusing a full-access key everywhere — a `charges:read`-only key,
for example, can't create charges or touch webhooks even if it leaks,
so treat narrowly-scoped keys as meaningfully lower-risk to hand to a
lower-trust integration (a CI job, a third-party analytics tool)
even though a scoped key is still a bearer secret, not a safe-to-embed
publishable token.

## Environments

The prefix on the key — `klap_live_` or `klap_test_` — is the *only*
thing that determines which environment a request runs against. There
is no `environment` field to pass on the request body or as a query
param, and no single key that can act as both: a `live` key and a
`test` key are two distinct keys, not one key with a switchable mode.

- A `test` key can only ever read or write `test`-environment
  charges/webhooks — never a `live` one, even under the same account.
  Calling a `live`-only route, or reaching for a `live` charge's id
  with a `test` key, fails the same way a wrong-tenant request would,
  not with a special "wrong environment" error.
- `test` keys unlock [Sandbox](/sandbox)'s trigger endpoint
  (`POST /sandbox/charges/{id}/trigger`) — manually push a charge
  through any state transition (confirm, partially pay, overpay,
  expire, underpay, settle, fail settlement) with no real on-chain
  transfer and no gas spent. `live` keys don't have access to this
  route at all; there's no way to accidentally trigger a fake event
  against real money.
- Everything else about the API — request/response shapes, error
  format, rate limiting, scopes — behaves identically in both
  environments. Building and testing an integration against a `test`
  key end-to-end, then swapping in a `live` key for production, should
  require no code changes beyond the key itself.

See [Sandbox](/sandbox) for the full set of triggerable events and how
to drive them.

## Rotation and revocation

Keys don't expire on a fixed lifetime — a key is valid until it's
explicitly revoked, not until some expiry date passes. That makes
revocation, not expiry, the mechanism you actually rely on for taking
a compromised key out of service.

**Signing-key rotation** on Klap's side needs no action from you: your
key keeps working exactly as it did before, with no cutover or redeploy.

**Revocation** is the lever you control, from your dashboard. Once you
revoke a key:

- It's checked on **every** request, so revocation takes effect
  immediately — there's no cache window or propagation delay to wait
  out. The very next request sent with a revoked key gets
  `401 invalid_api_key`, whether that request lands one second or one
  month after you revoked it.
- Any request already in flight (accepted and being processed by the
  time you hit revoke) is unaffected — auth is checked once, at the
  start of the request, not re-checked partway through. Revocation
  stops the *next* request from being accepted, not an already-running
  one from finishing.
- Revoking a key is final — there's no "unrevoke." If you revoked the
  wrong key, or need the same access restored, generate a new key with
  the same scopes rather than expecting the old one to come back.
- Revoking one key never affects any other key on your account,
  including other keys in the same environment. Keys are independent
  credentials, not shared instances of one underlying secret.

Rotate proactively — generate a new key, deploy it, then revoke the
old one — rather than waiting for a suspected leak; a key with a long
operational history is also a key that's had more chances to end up
somewhere it shouldn't (a committed `.env`, a log line, an error
report). Rotating this way costs zero downtime: both keys work
simultaneously while you switch over, so there's no window where your
integration is left holding a key that doesn't authenticate yet.

## See also

- [Getting started](/getting-started) — installing the SDK, creating a
  client, and your first charge.
- [Errors](/errors) — the full error envelope behind `401`/`403`, and
  every other status code the API returns.
- [Sandbox](/sandbox) — everything a `test` key unlocks, and how to
  drive a charge through every event without real on-chain activity.
