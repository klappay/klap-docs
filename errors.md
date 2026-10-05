# Errors

Every non-2xx REST response, and every SDK method that can fail, uses
one consistent shape — this page is the cross-cutting reference for
both, since every resource can fail this way.

## REST API

### The error envelope

```json
{
  "error": {
    "code": "validation_error",
    "message": "amount must be positive",
    "param": "amount"
  }
}
```

- `code` — a stable, machine-readable identifier. Safe to branch on in
  code. It's a plain `string`, not a fixed enum — the set of codes is
  per-endpoint, and the [API Playground](https://api.klappay.com/) is
  the authoritative source for exactly which codes a given endpoint can
  return (every response in its spec names the real code(s)).
- `message` — human-readable, safe to log or show a developer. Not
  meant to be shown to end users verbatim.
- `param` — which request field the error refers to, when applicable
  (omitted for errors that aren't about one specific field).

### Codes you'll actually see

Pulled straight from the live OpenAPI spec, grouped by what triggers
them — not an exhaustive list of every endpoint, but the shapes that
repeat across the API:

| Code | When |
|---|---|
| `validation_error` | Request body/query failed schema validation (bad shape, out-of-range value). |
| `missing_api_key` / `invalid_api_key` | No `Authorization` header, or the key doesn't parse/verify. |
| `insufficient_scope` | The key is valid but missing the scope the endpoint needs (e.g. `charges:write`) — see [Authentication](/authentication). |
| `invalid_cursor` | A pagination `cursor` that wasn't returned verbatim from a previous response. |
| `rate_limited` | Exceeded a rate limit (e.g. 20 req/min on `/distributions/*`, 60 req/min on `/metrics/*`). |
| `charge_not_found` / `webhook_not_found` / `delivery_not_found` | The `{id}` in the path doesn't exist (or doesn't belong to your organization). |
| `recipient_not_found` | A `DELETE`/`PATCH /recipients/{id}` on an id that doesn't exist for your organization and environment — or one that's payout-eligible when the key lacks `recipients:manage_payout`. A second `DELETE` returns it too — see [Recipients](/recipients#revoking-a-recipient). |
| `recipient_not_found_in_split` | A `splitRecipients[].recipientId` on `POST /charges` didn't resolve (wrong id, wrong environment, or revoked) — see [`splitRecipients`](/charges#splitrecipients). |
| `conflicting_api_key_scopes` | The key holds `charges:split_write` together with `recipients:write`/`recipients:manage_payout`, which is never allowed — see [Authentication](/authentication#scopes). |
| `swap_test_environment_unsupported` / `swap_unavailable` / `swap_quote_failed` | `POST /charges/{id}/quote`: `test` charges can't swap at all (422), swap isn't available on the deployment (503), or the upstream quote failed, often for liquidity (503, safe to retry) — see [swap-to-pay](/charges#paying-with-another-token-swap-to-pay). |
| `token_not_supported` | An `acceptedPayments` pair has no deployed contract for your key's `environment` — see [Networks & tokens](/networks). |
| `idempotency_key_reused` | Same `idempotencyKey`, different request body — see [Charges](/charges). |
| `charge_not_payable` | Charge is already `confirmed`/`expired`/`underpaid` — no longer accepting payment. |
| `escrow_already_released` / `escrow_already_refunded` | An [escrow charge](/charges#releasing-or-refunding-an-escrow) already moved its balance. Release and refund are mutually exclusive and each charge gets exactly one of them. |
| `payment_pair_required` / `payment_pair_not_accepted` | QR code request needs `token`/`network` disambiguation (charge accepts more than one pair) or named a pair the charge doesn't accept. |
| `environment_mismatch` | A `live` key querying `test` data (or vice versa) via a filter param. |
| `invalid_webhook_url` / `insecure_webhook_url` / `unresolvable_webhook_url` / `unsafe_webhook_url` | The webhook `url` isn't a valid HTTPS URL resolving to a public address — Klap refuses to register a webhook pointed at `localhost`/private IP ranges. |
| `webhook_limit_reached` | Hit the per-organization cap on active webhooks. |
| `invalid_trigger_state` | Sandbox: the charge isn't in a state that event can fire from. |
| `charge_not_test_environment` | Sandbox: trying to trigger an event on a `live`-environment charge (only `test` charges can be simulated). |
| `rpc_unavailable` / `sse_capacity` | Transient infrastructure error (blockchain RPC unreachable, too many concurrent SSE streams) — safe to retry shortly, not a request problem. |

### Rate limits

Limiters stack — a request can be rejected by whichever one it hits
first — all fixed per-minute windows:

- **100 requests/minute per source IP**, on every `/v1/*` request —
  including unauthenticated ones like `GET /health`. Keyed off the
  request's IP, not the API key, so multiple keys called from behind
  the same IP (a shared NAT, a proxy) share this budget.
- **100 requests/minute per organization**, also per IP-limit-independent,
  for every authenticated route (`/charges`, `/webhooks`, `/sandbox`,
  `/distributions`, `/networks`, `/metrics`, `/recipients`) — this is the one that
  actually matters once you're past initial integration, since it
  follows your tenant regardless of which key or IP is calling.
- **`/distributions/*` additionally gets a tighter 20 requests/minute,
  and `/metrics/*` 60 requests/minute**, both per organization — so
  they're the first thing you'll hit if you're polling either route on
  a tight loop, well before the 100/min organization limit above even
  comes into play.

There's **no `X-RateLimit-Remaining`-style header** on any response today
— nothing to poll to see how close you are before hitting `429`. The only
signal is the `Retry-After` header (seconds) on a `429 rate_limited`
response itself, so build retry/backoff around that rather than trying to
stay under a budget you can't observe in advance. A batch job hitting
`/metrics/query` or `/distributions/pending` in a tight loop is the most
likely place to hit this in practice — pace those deliberately rather
than firing requests back-to-back.

## Node.js SDK

The SDK throws, it doesn't return `{ ok, error }` unions — use
`try`/`catch` and check the error's class (or `instanceof`) to decide
what happened.

### `KlapApiError`

Thrown for any non-2xx response from the API — wraps the envelope above
one-to-one.

```ts
import { KlapApiError } from '@klappay/node'

try {
  await klap.charges.create({
    amount: -5,
    acceptedPayments: [{ token: 'USDC', network: 'base' }],
    expiresIn: 3600,
  })
} catch (err) {
  if (err instanceof KlapApiError) {
    console.log(err.status) // HTTP status, e.g. 400
    console.log(err.code) // stable code, e.g. 'validation_error'
    console.log(err.message) // human-readable, not for end users
    console.log(err.param) // which field, when applicable
  }
}
```

### Errors from `waitForConfirmation()` / `waitForSettlement()`

These reject instead of resolving with a charge you'd have to inspect —
see [Charges](/charges) for the full behavior.

| Error | Thrown when |
|---|---|
| `ChargeExpiredError` | `waitForConfirmation()` — `status` reached `expired` (nobody paid before `expiresAt`). |
| `ChargeUnderpaidError` | `waitForConfirmation()` — `status` reached `underpaid` (partial payment, then `expiresAt` passed). |
| `SettlementFailedError` | `waitForSettlement()` — `settlementStatus` reached `failed` (retries exhausted; rare, contact support). |
| `WaitTimeoutError` | Either method — `timeoutMs` elapsed before a terminal state was reached. |

Each carries a `chargeId` property; `WaitTimeoutError` also carries the
configured `timeoutMs`.

```ts
import { ChargeExpiredError, ChargeUnderpaidError, WaitTimeoutError } from '@klappay/node'

try {
  await charge.waitForConfirmation({ timeoutMs: 60_000 })
} catch (err) {
  if (err instanceof ChargeExpiredError) { /* nobody paid */ }
  else if (err instanceof ChargeUnderpaidError) { /* partial payment only */ }
  else if (err instanceof WaitTimeoutError) { /* still pending, check again later */ }
  else throw err
}
```

### Webhook verification errors

- **`InvalidWebhookSignatureError`** — thrown by
  `klap.webhooks.constructEvent()` when the signature doesn't match.
- **`WebhookTimestampToleranceError`** — thrown when the signature is
  valid but its timestamp falls outside the tolerance window (default
  300s) — a strong signal of a replayed delivery, distinct from a forged
  one. Carries `timestamp` (the delivery's own) and `toleranceSeconds`.

See [Webhooks](/webhooks)'s "Verifying and parsing an inbound webhook".

### `MissingCredentialError`

Thrown immediately, client-side, when you call a method that needs an
`apiKey` you didn't provide to `createClient()` — pass it there, or call
`klap.setApiKey()` first. Never reaches the network.

## Health check

`GET /health` — unauthenticated, for uptime monitoring. `status`
mirrors the HTTP status code (`error` and `503` together when the
database check fails), so a plain status-code-only check still catches
an outage without inspecting the JSON body.

```bash
curl https://api.klappay.com/v1/health
```

[→ Try `GET /health` in the API Playground](https://api.klappay.com/#tag/health/GET/health)

```json
{
  "status": "ok",
  "version": "0.1.0",
  "timestamp": "2026-08-11T12:00:00.000Z",
  "db": "ok"
}
```

Build monitoring on the HTTP status code (or `status`/`db`). The
response may carry additional operational fields beyond these; they're
not part of the integration contract, so don't alert or branch on them.

## Types

`ErrorPayloadSchema`/`ErrorPayload` and `HealthSchema`/`Health` from
`@klappay/types` mirror the shapes above exactly — import them if you
want to type a caught error or a health-check response without
redeclaring the shape yourself.

## See also

- [Charges](/charges) — the typed `waitFor*` rejections in context.
- [Webhooks](/webhooks) — signature verification and replay protection.
- [Authentication](/authentication) — scopes, and what
  `insufficient_scope` means for a given key.
