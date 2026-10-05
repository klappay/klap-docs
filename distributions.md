# Distributions

A **distribution** is the payout leg of a charge — the on-chain step
where funds already confirmed as received get moved out to the
merchant. Every charge address is a split contract (0xSplits or an
equivalent, depending on the network — see below); once a payment
is detected, Klap calls that split's `distribute()` function to
route the balance to its configured recipients (the merchant, plus
Klap's own fee recipient). "Pending" means a split has a confirmed
payout sitting at its address but `distribute()` hasn't been called
yet; "settled" means it has, and the funds have actually moved — the
same transition reflected on the charge itself as
`settlementStatus: 'completed'` (see [Charges](/charges)).

Which contract that actually is depends on the distribution's
`network`: the official 0xSplits v2.2 deployment on every EVM network
(`base`, `optimism`, `polygon`, `ethereum`, `arbitrum`, `avalanche`,
`bnb`, `arc`), and a separate, non-EVM contract on `tron`. Branch on
`NETWORK_FAMILIES` from `@klappay/types` (`'evm-official'` or `'tron'`)
rather than assuming one ABI or address format for every network — see
[Networks & tokens](/networks#network).

One Arc-specific caveat if you run your own keeper: USDC is Arc's
native gas token, so call `distribute()` with USDC's ERC-20 address, not
the native-token sentinel (`0xEeee…`). A native-sentinel call still
pays every recipient correctly, but Klap may not attribute that payout
to the distribution, so it can stay pending and the charge's
`settlementStatus` may never reach `'completed'`.

The reason this needs its own resource at all: the split's
`distribute()` is **permissionless** — anyone can call it, not just
Klap, and whoever does earns a small `distributorFeePercent` cut of
the balance for doing so. Klap's own worker races to claim every
split automatically, typically well inside the 5-minute grace period
before it's even discoverable here, but during that window a
third-party keeper can beat it and claim the reward instead.
`GET /distributions/pending` and `GET /distributions/pending/events`
are the feed that makes currently-claimable splits discoverable.

**This resource is for keepers/bots, not a typical merchant
integration** — ignore it entirely unless you're specifically building
or running one. If you only care about *your own* payout status as a
merchant, track it on the charge itself via `settlementStatus`/
`waitForSettlement()`, not here — see [Charges](/charges).

## Listing pending distributions

::: code-group

```bash [cURL]
curl https://api.klappay.com/v1/distributions/pending?limit=20 \
  -H "Authorization: Bearer klap_live_..."
```

```ts [Node.js]
const page = await klap.distributions.list({ limit: 20 })
// page.data, page.nextCursor, page.hasMore
```

:::

[→ Try `GET /distributions/pending` in the API Playground](https://api.klappay.com/#tag/distributions/GET/distributions/pending)

`GET /distributions/pending` — query params `limit` (1–100, default
20) and `cursor`. Rate limited to 20 requests/min per IP, same as the
events endpoint below (both share the `/v1/distributions/*` bucket) —
a keeper polling this on a tight loop instead of using the event
stream will hit `429 rate_limited` quickly, which is itself a nudge
toward the stream being the right primary transport and this endpoint
the bootstrap/backfill path.

Cursor-paginated, same shape and semantics as every other list
endpoint (`GET /charges`, etc.) — pass the previous response's
`nextCursor` back verbatim as `cursor` to fetch the next page (never
construct or parse it yourself, its shape isn't part of the public
contract), and stop once `hasMore` is `false`. There's no fixed row
cap: during an anomalous backlog (e.g. a pile-up of
still-claimable rows) keep following `nextCursor` instead of
assuming everything fits in one page. Page through everything
automatically with `listAll()`:

```ts
for await (const d of klap.distributions.listAll()) {
  console.log(d.splitAddress, d.network, d.token, d.estimatedRewardAmount)
}
```

A malformed or expired `cursor` is `400 invalid_cursor`, not a silent
empty page.

### The `PendingDistribution` shape

Each entry (`PendingDistributionSchema`/`PendingDistribution` in
`@klappay/types`) is a snapshot of one split, in the calling key's own
environment, with a confirmed payout still inside its 5-minute grace
period:

```ts
import { PendingDistributionSchema, type PendingDistribution } from '@klappay/types'

const distribution: PendingDistribution = PendingDistributionSchema.parse({
  splitAddress: '0x1111111111111111111111111111111111111111',
  network: 'base',
  token: 'USDC',
  recipients: [
    { address: '0x2222222222222222222222222222222222222222', percentAllocation: 99 },
    { address: '0x3333333333333333333333333333333333333333', percentAllocation: 1 },
  ],
  distributorFeePercent: 0.1,
  estimatedRewardAmount: 0.001,
  availableSince: '2026-07-28T23:45:52.382Z',
  graceEndsAt: '2026-07-28T23:50:52.382Z',
})
```

| Field | Notes |
|---|---|
| `splitAddress` | The on-chain split address to call `distribute()` on — a `0x` address on EVM networks (including `arc`), a Base58 `T...` address on `tron`. |
| `network`/`token` | Which chain and stablecoin the split holds — same `network`/`token` enums as everywhere else in the API; see [Networks & tokens](/networks) for the current support matrix, including the BNB Chain caveat (its `USDC` and `USDT` are Binance-Peg with 18 decimals, not native Circle/Tether deployments — read the split's token decimals from `getTokenDeployment`, not a hardcoded 6). |
| `recipients` | The **exact** array to pass to `distribute()` — the split contract only stores a hash of the recipient config on-chain, so the caller must supply the identical array to prove it matches. Always present, never a partial/reconstructed version. |
| `distributorFeePercent` | Cut of the split balance paid to whoever calls `distribute()` first (e.g. `0.1` = 0.1%). Frozen at charge creation — same value for every distribution today, but not guaranteed to stay a constant forever. |
| `estimatedRewardAmount` | An **estimate**, from the amount Klap detected on-chain — not a live balance read. Always read the split's real balance yourself before submitting a transaction, the same way Klap's own settlement worker does; a stale estimate is harmless, never a reason to skip that check. |
| `availableSince` | When this distribution entered its grace period. |
| `graceEndsAt` | When Klap's own worker may claim it. Calling `distribute()` after this timestamp is still possible but increasingly likely to lose the race. |

The response envelope (`PaginatedPendingDistributionsSchema`):
`{ data: PendingDistribution[], hasMore: boolean, nextCursor: string | null }`.

## Live stream of pending distributions

::: code-group

```bash [cURL]
curl https://api.klappay.com/v1/distributions/pending/events \
  -H "Authorization: Bearer klap_live_..." \
  -H "Accept: text/event-stream"
```

```ts [Node.js]
for await (const event of klap.distributions.streamPending()) {
  if (event.type === 'distribution.available') {
    console.log('new:', event.distribution.splitAddress)
  } else {
    console.log('claimed:', event.splitAddress)
  }
}
```

:::

[→ Try `GET /distributions/pending/events` in the API Playground](https://api.klappay.com/#tag/distributions/GET/distributions/pending/events)

`GET /distributions/pending/events` — Server-Sent Events, scoped to
the calling key's own environment. See [Real-time (SSE)](/realtime)
for the general stream mechanics (heartbeat, close conditions, why SSE
over polling) shared with `GET /charges/{id}/events` and
`GET /webhooks/listen` — this section covers only what's specific to
distributions. Rate limited to 20 requests/min per IP for the initial
connection (same bucket as the listing endpoint above); once
connected, a separate cap of 503 `sse_capacity` applies if too many
concurrent streams are already open — see [Real-time](/realtime)'s
"Limits" section for the per-key concurrent-stream ceiling this shares
with every other SSE endpoint.

Each event (`PendingDistributionEventSchema`) is a discriminated union
on `type`:

- **`distribution.available`** — a new distribution entered its grace
  period, or re-entered it after a failed claim attempt. Carries the
  full `distribution` (`PendingDistribution`, fully typed).
- **`distribution.claimed`** — no longer claimable, settled by anyone
  including Klap's own worker. Carries only the `splitAddress` —
  and fires the moment a claim is *started*, not only once it
  finishes, so a keeper stops racing an attempt already in flight. If
  that attempt then fails and is rescheduled, `distribution.available`
  fires again with a refreshed `graceEndsAt`.

```ts
import { PendingDistributionEventSchema, type PendingDistributionEvent } from '@klappay/types'

const event: PendingDistributionEvent = PendingDistributionEventSchema.parse(
  JSON.parse(sseEventData),
)
```

**Ordering matters.** By default the stream sends no initial snapshot —
open it *before* calling `list()`/`GET /distributions/pending`, then
treat both that snapshot response and every event received (before or
after it resolves) as an idempotent add/remove against one local
`Map<splitAddress, PendingDistribution>`. Opening the stream *after*
the snapshot call instead leaves a real, if small, gap where a delta
between the two requests is never delivered.

### Self-contained connection with `limit`

Pass `?limit=` (validated by `ListenPendingDistributionsQuerySchema`,
up to `PAGINATION_LIMIT_MAX`/100, default `0`) to skip the
connect-then-list dance above — the server sends up to that many
currently-claimable distributions as synthetic `distribution.available`
events right after connecting, then continues with live deltas, all
over one connection:

```ts
import { ListenPendingDistributionsQuerySchema } from '@klappay/types'

// GET /v1/distributions/pending/events?limit=50
ListenPendingDistributionsQuerySchema.parse({ limit: '50' }) // { limit: 50 }
```

```ts
for await (const event of klap.distributions.streamPending(undefined, 50)) {
  // ...
}
```

There's no ordering footgun here either — the subscription opens
before the snapshot query runs internally, so nothing published in
between is lost. But this snapshot isn't a full page: no cursor, so if
more than `limit` are claimable at connect time the excess is simply
not sent. Reach for `list()`/`listAll()` directly instead if you need
a complete listing during an anomalous backlog. Omitting `limit` (or
passing `0`) keeps the original two-step behavior above unchanged.

## Authentication and environment scoping

Both endpoints require the same API key used everywhere else
(`Authorization: Bearer klap_live_...`/`klap_test_...`;
`401 missing_api_key`/`invalid_api_key` otherwise). A `test` key only
ever sees `test` distributions, `live` only `live` — there's no
`environment` field on either schema above, since the connection is
already scoped by whichever key opened it.

## SDK access

`klap.distributions` — also available standalone as
`createDistributionsClient` from `@klappay/node/distributions` (see
[Tree-shaking](/sdk/tree-shaking)). Requires an `apiKey`.

## See also

- [Charges](/charges) — `settlementStatus`/`waitForSettlement()`, the
  per-charge view of this same settle-the-payout process, for tracking
  your own payout as a merchant instead of running a keeper.
- [Real-time (SSE)](/realtime) — the streaming mechanism
  `GET /distributions/pending/events` shares with charge status
  updates and webhook delivery: heartbeat, close conditions, and the
  per-key concurrent-stream limit.
