# Recipients

Trusted, pre-registered payout addresses — the only thing a charge's
[`splitRecipients`](/charges#splitrecipients) can route a slice of a
payment to.

## Overview

A recipient is an address — EVM (`0x...`, including Arc) or TRON (`T...`)
— that you register once, ahead of time, so a charge can reference it by
`id` instead of by raw address. Recipients are pre-registered so a leaked `charges:write` key can never route a slice of a payment to an unvetted address: `charges:write` alone can never do that. Registering a new
destination needs the separate `recipients:write` scope, and using an
already-registered one in a split needs `charges:split_write` on top of
`charges:write`. A single key is never issued both (see
[Authentication](/authentication#scopes)).

A recipient's `id` (`rc_...`) is what a split references; the `address`
is what ends up on-chain. Both are scoped to the key's organization and
environment — a `test` recipient can't be used from a `live` key.

## Registering a recipient

::: code-group

```bash [cURL]
curl -X POST https://api.klappay.com/v1/recipients \
  -H "Authorization: Bearer klap_live_..." \
  -H "Content-Type: application/json" \
  -d '{
    "address": "0x1111111111111111111111111111111111111111",
    "label": "sales rep"
  }'
```

```ts [Node.js]
import { createRecipientsClient } from '@klappay/node/recipients'

const recipients = createRecipientsClient({ baseUrl: '...', apiKey: '...' })

const recipient = await recipients.create({
  address: '0x1111111111111111111111111111111111111111',
  label: 'sales rep', // optional, your own bookkeeping — never interpreted
})

console.log(recipient.id) // rc_... — this is what a charge split references
```

:::

[→ Try `POST /recipients` in the API Playground](https://api.klappay.com/#tag/recipients/POST/recipients)

Requires `recipients:write`. `label` is optional, 1–64 characters, and
never interpreted. `create()` is an **idempotent upsert** keyed on
`address`: registering an address that's already known just updates its
`label` and, if it had been revoked, un-revokes it — so you can call it
again without first checking whether the recipient exists. It also
**resets `payout` to `false`** every time, whatever it was before, so
`recipients:write` can never grant *or preserve* a payout approval by
itself (see [`payout`](#payout-eligibility-for-an-api-key) below).

The response is a `Recipient`:

```json
{
  "id": "rc_abc123",
  "environment": "live",
  "address": "0x1111111111111111111111111111111111111111",
  "label": "sales rep",
  "payout": false,
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

## Listing recipients

::: code-group

```bash [cURL]
curl "https://api.klappay.com/v1/recipients?limit=20" \
  -H "Authorization: Bearer klap_live_..."
```

```ts [Node.js]
const page = await recipients.list({ limit: 20 })
// page.data, page.nextCursor, page.hasMore

for await (const recipient of recipients.listAll()) {
  console.log(recipient.id)
}
```

:::

[→ Try `GET /recipients` in the API Playground](https://api.klappay.com/#tag/recipients/GET/recipients)

Requires `recipients:read`. Returns your organization's **non-revoked**
recipients for the calling key's environment, newest first, with the same
cursor pagination as [`GET /charges`](/charges#listing-charges): `limit`
is 1–100 (default 20), and `{ data, nextCursor, hasMore }` comes back —
feed `nextCursor` in as `cursor` until `hasMore` is `false`. An
environment with no registered recipients gets an empty `data` array, not
an error. `listAll()` is an async generator that walks every page for
you.

## Revoking a recipient

::: code-group

```bash [cURL]
curl -X DELETE https://api.klappay.com/v1/recipients/rc_abc123 \
  -H "Authorization: Bearer klap_live_..."
```

```ts [Node.js]
await recipients.revoke('rc_abc123')
```

:::

[→ Try `DELETE /recipients/{id}` in the API Playground](https://api.klappay.com/#tag/recipients/DELETE/recipients/{id})

Requires `recipients:write` and answers `204` with no body. A revoked
recipient can no longer be referenced by a *new* split. Charges that
already referenced it are **unaffected**: the address was resolved and
frozen into the charge at creation, it isn't a live reference to the
`Recipient`.

Revoking is **not idempotent**. A second call fails with `404
recipient_not_found` — the same error, deliberately indistinguishable
from, an id that never existed. Don't treat a repeated `revoke()` as a
safe no-op:

```ts
import { KlapApiError } from '@klappay/node'

try {
  await recipients.revoke('rc_abc123')
} catch (err) {
  if (err instanceof KlapApiError && err.code === 'recipient_not_found') {
    // already revoked, or this id never existed — the API doesn't
    // distinguish the two, so neither can you from this error alone
  } else {
    throw err
  }
}
```

A recipient currently flagged `payout: true` can only be revoked with
`recipients:manage_payout`, not plain `recipients:write`. A
`recipients:write`-only key attempting it gets the same `404
recipient_not_found` as for a nonexistent id, so it can't even confirm
that such a recipient exists. See below for why this is gated.

## `payout`: eligibility for an API key

`recipient.payout` is unrelated to using a recipient in a split — every
non-revoked recipient is already usable there. It controls something
narrower: whether the address is *eligible to become an API key's own
`payoutAddress`*, the destination that merchant's own charges settle to.

::: code-group

```bash [cURL]
curl -X PATCH https://api.klappay.com/v1/recipients/rc_abc123 \
  -H "Authorization: Bearer klap_live_..." \
  -H "Content-Type: application/json" \
  -d '{ "payout": true }'
```

```ts [Node.js]
await recipients.setPayout('rc_abc123', true)

// and to turn it back off:
await recipients.setPayout('rc_abc123', false)
```

:::

[→ Try `PATCH /recipients/{id}` in the API Playground](https://api.klappay.com/#tag/recipients/PATCH/recipients/{id})

Requires `recipients:manage_payout`, deliberately stricter than
`recipients:write`. It's meant to be held only by a key that has already
gone through its own out-of-band approval for that specific action —
never a merchant-facing or third-party integration key.

Two consequences follow from keeping "usable in a split" separate from
"payout-eligible":

- **Revoking a `payout: true` recipient invalidates every API key whose
  `payoutAddress` matches it**, on that key's very next request
  (`401 payout_address_revoked`). It's gated on `payout: true` and not on
  any revoked recipient because a `payoutAddress` is public (it's the
  first entry in the on-chain split): if the weaker `recipients:write`
  were enough, one integration key could permanently lock out another by
  registering and then revoking its address. That's also why revoking such
  a recipient needs `recipients:manage_payout`.
- **Setting `payout: true` does not unset it on any other recipient.**
  There's no single-payout-target invariant: several recipients can hold
  `payout: true` at once, and flagging a new one has no effect on the
  others. If you expect "set payout here" to behave like a single default
  payment method, that's wrong here; clear the old one yourself with an
  explicit `setPayout(oldId, false)`.

## Using a recipient in a charge split

Pass the recipient's `id` — never its address — in the charge's
`splitRecipients`:

```ts
const charge = await klap.charges.create({
  amount: 49.9,
  acceptedPayments: [{ token: 'USDC', network: 'base' }],
  expiresIn: 3600,
  splitRecipients: [{ recipientId: recipient.id, percent: 10, label: 'sales rep' }],
})

console.log(charge.splitRecipients)
// [{ address: '0x1111...1111', percent: 10, label: 'sales rep' }]
```

Request and response differ on purpose: you submit a `recipientId`
(something you can only reference, never invent) and read back the
resolved `address`, so you can see where the money went without a second
lookup. The full semantics — `percent` is of your own net share, at most
5 entries, frozen at creation, `charges:split_write` required — live in
[`splitRecipients`](/charges#splitrecipients). A `recipientId` that
doesn't resolve (wrong id, wrong environment, or revoked) fails the whole
`POST /charges` with `422 recipient_not_found_in_split`.

## Error codes

| Code | Status | Meaning |
|---|---|---|
| `recipient_not_found` | 404 | No such recipient in your organization and environment, or it exists but is payout-eligible and the key lacks `recipients:manage_payout` to revoke it. Also what a second `DELETE` returns. |
| `recipient_not_found_in_split` | 422 | A `splitRecipients[].recipientId` on `POST /charges` didn't resolve: wrong id, wrong environment, or revoked. |
| `insufficient_scope` | 403 | The key lacks the `recipients:read`/`recipients:write`/`recipients:manage_payout` scope the action needs. |
| `conflicting_api_key_scopes` | 403 | The key holds both `charges:split_write` and a recipient-registration scope, which is never allowed; rejected before the route runs. |

See [Errors](/errors) for the shared error envelope.

## Types

```ts
import {
  CreateRecipientSchema,
  RecipientSchema,
  PaginatedRecipientsSchema,
  SetRecipientPayoutSchema,
} from '@klappay/types'

CreateRecipientSchema.parse({
  address: '0x1111111111111111111111111111111111111111',
  label: 'supplier',
})

SetRecipientPayoutSchema.parse({ payout: true })
```

`CreateRecipientSchema` / `CreateRecipientInput` is the body of `POST
/recipients` (`CreateRecipientRequest` is the pre-parse type) —
`address` is an EVM `0x...` or TRON `T...` address, `label` an optional
1–64 character string. `RecipientSchema` / `Recipient` is the shape shown
above, and `PaginatedRecipientsSchema` / `PaginatedRecipients` is `GET
/recipients`'s `{ data, nextCursor, hasMore }` response.
`SetRecipientPayoutSchema` / `SetRecipientPayoutInput` is `PATCH
/recipients/{id}`'s `{ payout: boolean }` body. On the charge side,
`SplitRecipientInputSchema` (request: `recipientId`, `percent`, optional
`label`) and `SplitRecipientSchema` (response: resolved `address`,
`percent`, optional `label`) are documented under
[`splitRecipients`](/charges#splitrecipients).

## Standalone client

`klap.recipients` is also available on its own, without the full client,
for a smaller bundle:

```ts
import { createRecipientsClient } from '@klappay/node/recipients'

const recipients = createRecipientsClient({ baseUrl: '...', apiKey: '...' })
```

`baseUrl` and `apiKey` are optional and fall back to `KLAP_BASE_URL` and
`KLAP_RECIPIENTS_API_KEY` if omitted (see
[Getting started](/getting-started)). See
[Tree-shaking](/sdk/tree-shaking) for the rest of the subpaths.

## See also

- [Charges](/charges#splitrecipients) — `splitRecipients` request and
  response semantics.
- [Authentication](/authentication#scopes) — the `recipients:*` and
  `charges:split_write` scopes, and why they're never combined on one
  key.
- [Errors](/errors) — the error envelope and `KlapApiError`.
