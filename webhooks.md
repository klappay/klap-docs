# Webhooks

Outbound notifications — Klap pushes events to a URL you register,
instead of you polling for state changes. Every event belongs to
exactly one of two categories: **`payments`**, the 8 events that track a
charge through its lifecycle, and **`webhooks`**, 3 meta-events about
the health of your own webhook endpoint (so you can notice a broken
integration without polling `GET /webhooks/{id}/deliveries` yourself).
Both categories share one delivery engine, one signing scheme, one
retry schedule, and one SSRF guard on the registered URL — there's no
separate code path for "payment events" vs. "meta events."

Delivery is **at-least-once, not exactly-once**: a delivery that times
out or errors after your endpoint already processed it (a slow response
right at the edge of the 8s timeout, for instance) gets retried anyway,
so your handler will occasionally see the same `id` twice. Design
handlers to be idempotent on the payload's `id`, and always verify the
signature before trusting anything in the body — the endpoint you
register is a public HTTPS URL, and anyone who finds it can send a
structurally valid POST to it. Signature verification is what
distinguishes a real Klap delivery from that.

The charge events themselves are driven by Klap's own on-chain
transfer detection running underneath `POST /v1/charges` — fast enough
that `charge.confirmed` is typically observable within the same block
window a transfer lands in. That detection machinery is an internal
implementation detail, not something you configure; everything on this
page is about receiving what it produces, not building it.

## Subscribing

::: code-group

```bash [cURL]
curl https://api.klappay.com/v1/webhooks \
  -X POST \
  -H "Authorization: Bearer klap_live_..." \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-server.com/webhooks/klap",
    "eventCategories": ["payments"]
  }'
```

```ts [Node.js]
const webhook = await klap.webhooks.create({
  url: 'https://your-server.com/webhooks/klap',
  eventCategories: ['payments'],
})

console.log(webhook.secret) // whsec_... — returned in full ONLY this once, store it now
```

:::

[→ Try `POST /webhooks` in the API Playground](https://api.klappay.com/#tag/webhooks/POST/webhooks)

The body is `CreateWebhookSchema` (`@klappay/types`). At least one of
`events` or `eventCategories` is required — a `.refine()` on the schema
enforces it, not just documentation, so omitting both is a `400` before
any URL validation even runs. Three ways to select what you receive,
combinable:

```ts
// individual events
await klap.webhooks.create({ url, events: ['charge.confirmed', 'charge.overpaid'] })

// a whole category — new events added to it later arrive automatically,
// no need to touch the subscription again
await klap.webhooks.create({ url, eventCategories: ['payments'] })

// everything, minus explicit exclusions
await klap.webhooks.create({ url, events: ['*'], excludeEvents: ['charge.expired'] })
```

- **`events`** — up to 12 individual event types, or `"*"` for every
  event (combine with `excludeEvents` to opt back out of specific ones
  under the wildcard).
- **`eventCategories`** — up to 2 (`'payments'` and/or `'webhooks'`).
  The subscription rule itself is persisted, not expanded into a frozen
  list of event types at creation time — matching happens per-dispatch
  against the live rule, so a category subscription created today
  automatically starts receiving any event type added to that category
  later, with nothing for you to update.
- **`excludeEvents`** — opt back out of specific events even under a
  `"*"` or category subscription.
- **`url`** — max 2048 chars, must be HTTPS, and must resolve to a
  public address. Private/internal IPs are rejected at creation *and*
  re-checked before every single delivery attempt (the same address
  could resolve differently later via DNS rebinding), which is also why
  a delivery never follows a redirect — both are the same SSRF guard,
  applied at the one place all deliveries funnel through.

`environment` (`'live' | 'test' | null`) is set automatically from
whichever API key's environment created the webhook — there's no
request field for it, and it can't be chosen or changed afterward.
Every `payments` and `webhooks`-category event also carries an
environment (a charge event carries the charge's own; a delivery-health
event carries the environment of the webhook it's about), and is only
delivered to a webhook whose `environment` matches — a `test`-key
webhook never receives a real `live` charge event, and a `live`-key
webhook never receives a sandbox-triggered one. `environment: null`
means the webhook predates this field and keeps receiving both, same as
always. Register one webhook per environment (two different API keys)
if `test` and `live` traffic should land on different endpoints or
handlers.

Creating requires the `webhooks:write` scope. Registering more than 20
active webhooks for one organization is rejected outright — `422
webhook_limit_reached` — a hard cap, not a soft warning; delete an
unused one first if you're at the limit.

The response — `Webhook` — is the **only** place `secret` (the HMAC
signing key, `whsec_...`) is ever returned in full. Every later
`GET /webhooks` returns `hint` instead: a truncated, safe-to-display
form (e.g. `whsec_...ab12`) on the same shape minus `secret`. If a
secret leaks, rotate it (see "Managing webhooks" below) rather than
deleting and recreating the webhook — deleting loses the id and the
delivery history.

## The full event vocabulary

Every event Klap can send is one `WebhookEventTypeSchema` value,
built from two sub-enums (`ChargeWebhookEventTypeSchema` for `payments`,
`WebhookDeliveryEventTypeSchema` for `webhooks`) — `EVENT_CATEGORY_MAP`
is the single source of truth mapping one to the other, generated from the enums rather than hand-duplicated, so every event belongs to exactly one category.

### `charge.*` — `payments` category

Every one of these carries the full `Charge` object as `data`.

| Event | Fires when |
|---|---|
| `charge.created` | The charge was created. |
| `charge.partially_paid` | Cumulative transfers cover part, not all, of the target amount. |
| `charge.confirmed` | Cumulative transfers meet or exceed the target amount — the payment was **detected on-chain**. |
| `charge.overpaid` | Fires *alongside* `confirmed`/`partially_paid` whenever the cumulative amount exceeds the target — an additional signal, never a standalone state. |
| `charge.expired` | A `pending` charge passed its deadline with zero transfers received. |
| `charge.underpaid` | A `partially_paid` charge passed its deadline still short of the full amount. |
| `charge.settled` | The payout to the merchant's wallet actually completed on-chain. |
| `charge.settlement_failed` | Klap's own payout attempt failed and its retries were exhausted (the charge is still watched — a later out-of-band settlement still fires `settled`). |
| `charge.escrow_released` | An [escrow charge](/charges#releasing-or-refunding-an-escrow)'s balance was released on-chain to the split address, where normal distribution takes over. |
| `charge.escrow_refunded` | An [escrow charge](/charges#releasing-or-refunding-an-escrow)'s balance was sent back on-chain to the address that funded it. No distribution follows. |

`confirmed` vs. `settled` is a real distinction, not two names for the
same thing: `confirmed` means the payment was detected on-chain,
`settled` means the merchant's wallet actually received the funds — a
separate, later step (`Charge.settlementStatus`, see
[Charges](/charges)). Subscribe to `confirmed` if you only need "will I
get paid," or `settled` if you need "has the money actually arrived."

### `webhook.*` — `webhooks` category

Meta-events about the health of your own registered endpoint — data is
`{ webhookId, url, failureRatio? }` for all three (`failureRatio` only
on `endpoint_unhealthy`).

| Event | Fires when |
|---|---|
| `webhook.delivery_failed` | One specific delivery exhausted all 5 retry attempts. |
| `webhook.delivery_recovered` | A delivery to a webhook previously marked unhealthy just succeeded. |
| `webhook.endpoint_unhealthy` | A webhook's trailing-24h failure ratio crosses 20% — fired once per unhealthy streak, not re-fired on every subsequent failure. |

These three never generate further meta-events about their own delivery
outcome — a webhook subscribed to the `webhooks` category that itself
starts failing doesn't produce an endless
delivery-failed-about-delivery-failed stream. They're also excluded
from the 24h failure-ratio calculation itself, so a self-referential
failure pattern can't compound a webhook's own unhealthy determination.

There's no sandbox trigger for these three — they're derived from real
delivery attempts, not something you'd need to fabricate; see
"Testing" below.

### The payload envelope

Every delivery's body — `WebhookPayloadSchema` / `WebhookPayload` — is
the same four-field shape regardless of event:

```ts
{ id: string, event: WebhookEventType, createdAt: string, data: unknown }
```

`data` is typed `unknown` at the schema level on purpose — its real
shape depends on `event`, which one flat schema can't express, and
Klap controls both producer and consumer of this shape, so a
per-event runtime schema for `data` wasn't worth the ongoing
maintenance cost. `id` is also sent as the `X-Klappay-Delivery` header —
this is the value to dedupe on if you want protection against
at-least-once redelivery beyond what idempotent handling already gives
you.

For the *typed* version, `TypedWebhookPayload` (`@klappay/types`) is a
discriminated union over `event` — same pattern as Stripe's
`Event.data.object` — so `data` narrows automatically in a `switch`/`if`
on `event`, no cast needed:

```ts
import type { TypedWebhookPayload } from '@klappay/types'

function handle(payload: TypedWebhookPayload) {
  if (payload.event === 'charge.confirmed') {
    payload.data.amountReceived // typed as Charge
  } else if (payload.event === 'webhook.endpoint_unhealthy') {
    payload.data.failureRatio // typed as WebhookHealthEventData
  }
}
```

`WebhookEventDataMap` is the underlying `{ event: dataShape }` mapping
this is built from — every `charge.*` event's `data` is a full `Charge`;
every `webhook.*` event's `data` is the small `WebhookHealthEventData`
shape above.

## Verifying and parsing an inbound webhook

**Always verify the signature before trusting a webhook payload** —
your endpoint is a public URL, and anyone who can reach it can send a
structurally-valid request otherwise.

Every delivery carries three headers:

| Header | Value |
|---|---|
| `X-Klappay-Signature` | `t=<unix timestamp>,v1=<hmac>` |
| `X-Klappay-Event` | The event type, e.g. `charge.confirmed` |
| `X-Klappay-Delivery` | The delivery's `id`, same value as the body's `id` |

The signature is `HMAC-SHA256` over `${timestamp}.${rawBody}` — Stripe-
style, not just the raw body — computed with the webhook's own secret.
Signing the timestamp alongside the body is what makes replay
protection possible at all: a signature over the body alone would let
anyone who captured one legitimate delivery (a leaked proxy log, a
compromised intermediary) re-POST the exact same body+signature
indefinitely and have it validate as new. Binding the timestamp in
means a captured delivery only replays successfully within whatever
tolerance window the verifier enforces.

### Node.js — `@klappay/node`

```ts
import { WebhookTimestampToleranceError } from '@klappay/node'

app.post('/webhooks/klap', (req, res) => {
  try {
    const event = klap.webhooks.constructEvent(
      req.rawBody, // the raw, unparsed request body string — not req.body
      req.headers['x-klappay-signature'],
      process.env.KLAP_WEBHOOK_SECRET,
    )

    switch (event.event) {
      case 'charge.settled':
        // event.data is a fully-typed Charge
        break
      case 'webhook.endpoint_unhealthy':
        // event.data is { webhookId, url, failureRatio } — TypeScript
        // already knows this here, no cast needed
        break
    }

    res.sendStatus(200)
  } catch (err) {
    if (err instanceof WebhookTimestampToleranceError) {
      // validly signed, but too old — likely a replay of a captured delivery
      res.sendStatus(400)
      return
    }
    // InvalidWebhookSignatureError — reject, don't process
    res.sendStatus(400)
  }
})
```

`constructEvent(rawBody, signatureHeader, secret, options?)` does three
things in one call: verifies the HMAC with a timing-safe comparison
(never implement this comparison yourself with `===` — timing attacks
against a naive string compare are a real risk), checks the delivery is
recent (`options.toleranceSeconds`, default `300` — 5 minutes), and
parses the body into `TypedWebhookPayload`. It throws
`InvalidWebhookSignatureError` if the HMAC doesn't match, or
`WebhookTimestampToleranceError` if the HMAC is valid but the timestamp
falls outside the tolerance window — a strong signal of a replayed
delivery, worth handling distinctly from an outright invalid signature.

If you only want the boolean check without parsing (note: HMAC only,
this does **not** check timestamp tolerance):

```ts
const isValid = klap.webhooks.verifySignature(rawBody, signatureHeader, secret)
```

**Getting the raw body**: most Node frameworks parse the request body
into an object before your handler runs, which is too late — the
signature is computed over the exact raw bytes, not a re-serialized
object that may differ in whitespace or key order. In Express, mount
`express.raw({ type: 'application/json' })` on this specific route
(not `express.json()`), or capture the raw body in middleware ahead of
the JSON parser.

### Verifying without the Node SDK

The scheme is plain HMAC-SHA256, so any language can implement it in a
few lines:

1. Split the `X-Klappay-Signature` header on `,` and pull out `t=` and
   `v1=`.
2. Compute `HMAC-SHA256(secret, "${t}.${rawBody}")`, hex-encoded.
3. Compare the result to `v1` with a **constant-time** comparison
   (`crypto.timingSafeEqual` in Node, `hmac.compare_digest` in Python,
   `hash_equals` in PHP — never a plain `==`/`===`).
4. Separately, check that `t` is within your tolerance window (5
   minutes is a reasonable default) of the current time. This is a
   distinct check from step 3 — a valid HMAC on an old timestamp is
   still a rejection, since the timestamp only closes the replay gap if
   something actually checks its age.
5. Only after both checks pass, parse `rawBody` as JSON into the
   envelope shape (`{ id, event, createdAt, data }`).

The tolerance window mitigates replay but isn't a guarantee — a replay
sent *within* the window still passes both checks. For
belt-and-suspenders protection against that narrower case, deduplicate
by the payload's own `id` on your side, especially for a handler whose
effect isn't naturally idempotent (e.g. incrementing a counter rather
than an upsert keyed on `id`).

## Managing webhooks

```ts
const webhooks = await klap.webhooks.list()
await klap.webhooks.delete(webhookId)

const rotated = await klap.webhooks.rotateSecret(webhookId)
console.log(rotated.secret) // a fresh whsec_... — the old one stops verifying immediately

const page = await klap.webhooks.listDeliveries(webhookId)
// page.data, page.nextCursor, page.hasMore — status, HTTP response code, attempt count

for await (const delivery of klap.webhooks.listAllDeliveries(webhookId)) {
  console.log(delivery.id, delivery.status)
}

await klap.webhooks.retryDelivery(webhookId, deliveryId)
// immediately retries a specific delivery, regardless of its normal retry schedule
```

| Method | Path (→ open in Playground) | Scope | Notes |
|---|---|---|---|
| `GET` | [`/webhooks`](https://api.klappay.com/#tag/webhooks/GET/webhooks) | `webhooks:read` | Lists the caller key's webhooks, `hint` instead of `secret`. Stays **unpaginated** — it's hard-capped at 20 per org, so a page wouldn't buy you anything. |
| `DELETE` | [`/webhooks/{id}`](https://api.klappay.com/#tag/webhooks/DELETE/webhooks/{id}) | `webhooks:write` | Stops future deliveries. Past delivery history is kept and still queryable afterward. `404 webhook_not_found` if the id doesn't exist (or belongs to the wrong environment — see below). |
| `POST` | [`/webhooks/{id}/rotate-secret`](https://api.klappay.com/#tag/webhooks/POST/webhooks/{id}/rotate-secret) | `webhooks:manage_secret` | Generates a fresh secret, replacing the old one immediately — no further delivery validates against the old one. Returns the new secret exactly once, same as creation. Kept as its own scope, separate from `webhooks:write`, since it's the highest-trust action on this resource (it returns a plaintext secret). |
| `GET` | [`/webhooks/{id}/deliveries`](https://api.klappay.com/#tag/webhooks/GET/webhooks/{id}/deliveries) | `webhooks:read` | Delivery attempts, newest first: `status` (`pending`/`delivered`/`failed`), `attempts`, `responseCode` (`null` means every attempt failed to connect at all, not just a non-2xx), `nextRetryAt`, `deliveredAt`. Cursor-paginated, `limit` 1–100 (default 20). |
| `POST` | [`/webhooks/{id}/deliveries/{deliveryId}/retry`](https://api.klappay.com/#tag/webhooks/POST/webhooks/{id}/deliveries/{deliveryId}/retry) | `webhooks:write` | Immediately attempts redelivery, regardless of the normal retry schedule or whether retries were already exhausted. Returns `202` and doesn't wait for the attempt to finish — poll `GET .../deliveries` for the outcome. |

Both endpoints and the underlying management methods are scoped by
`environment` the same way delivery is: a `test`-key call can only see
or act on `test`-environment (or legacy `null`-environment) webhooks,
never a tenant's `live` ones, and vice versa — the same rule that
governs which webhook an event is delivered to also governs who can
manage it.

`listDeliveries()`/`GET /webhooks/{id}/deliveries` use the same shared
`{ limit, cursor }` → `{ data, nextCursor, hasMore }` cursor-pagination
shape as every other list endpoint in the API — see
[Charges — Listing and pagination](/charges#listing-charges) for
the pattern in full; always pass the previous response's `nextCursor`
back verbatim rather than constructing one, and stop once `hasMore` is
`false`. `listAllDeliveries()` pages through automatically if you'd
rather not manage the cursor yourself.

### Delivery mechanics, briefly

`POST` to your `url`, `Content-Type: application/json`, an 8s timeout
per attempt, no redirect following. A 2xx response marks the delivery
`delivered`; anything else — including a timeout or connection error —
schedules a retry on a fixed schedule: `0, 5min, 30min, 2h, 24h` after
the first attempt, 5 attempts total spanning roughly 24 hours. After
the 5th failed attempt the delivery becomes `failed` and stops
retrying automatically — `webhook.delivery_failed` fires at that point
if you're subscribed to it, and `POST .../retry` is how you push it
again manually once your endpoint is back.

## Testing

Trigger any `payments`-category event on a `test`-environment charge
without a real on-chain transfer — see [Sandbox](/sandbox) for the full
mechanism (`POST /sandbox/charges/{id}/trigger`, or the typed
`klap.sandbox.confirm()`/`.partiallyPay()`/etc. wrappers). For
receiving those triggered events on `localhost` without deploying a
public endpoint or registering a real webhook, [`GET
/webhooks/listen`](https://api.klappay.com/#tag/webhooks/GET/webhooks/listen)
opens a live Server-Sent Events stream of everything your organization
dispatches — this is what `@klappay/cli`'s `klap listen --forward-to`
consumes; see [Real-time status](/realtime) for the stream mechanics.
To exercise just your handler's signature verification and payload
parsing with no login at all, `klap webhooks trigger <event>` signs a
fake webhook and delivers it straight to your local URL (full details at
[cli.klappay.com](https://cli.klappay.com)).

## See also

- [Charges](/charges) — the `Charge` shape carried by every `charge.*`
  event's `data`, and the cursor-pagination pattern deliveries share.
- [Sandbox](/sandbox) — triggering any charge event without a real
  on-chain transfer.
- [Errors](/errors) — the full error code reference, including
  `InvalidWebhookSignatureError`/`WebhookTimestampToleranceError` and
  the REST error codes referenced above.
- [Real-time status (SSE)](/realtime) — `GET /webhooks/listen`'s stream
  mechanics, shared with the charge- and distribution-event streams.
