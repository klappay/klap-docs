# Charges

The core resource. A charge accumulates on-chain transfers toward a
target `amount` until either the target is met (`confirmed`) or
`expiresAt` passes first (`expired` with zero funds received,
`underpaid` with a partial amount). Every charge shares this exact same
state machine — the only real choices at creation are which `(token,
network)` pairs to accept and how long the checkout window should be.

## Creating a charge

::: code-group

```bash [cURL]
curl -X POST https://api.klappay.com/v1/charges \
  -H "Authorization: Bearer klap_live_..." \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 49.9,
    "acceptedPayments": [
      { "token": "USDC", "network": "base" },
      { "token": "USDC", "network": "optimism" },
      { "token": "USDT", "network": "base" }
    ],
    "expiresIn": 3600,
    "externalRef": "order_123",
    "source": "checkout",
    "metadata": { "plan": "pro" }
  }'
```

```ts [Node.js]
const charge = await klap.charges.create({
  amount: 49.9,
  acceptedPayments: [
    { token: 'USDC', network: 'base' },
    { token: 'USDC', network: 'optimism' },
    { token: 'USDT', network: 'base' },
  ],
  expiresIn: 3600, // seconds, required — 60 to 3600 (1 hour max)
  externalRef: 'order_123', // your own correlation id, optional
  source: 'checkout', // free-form label, optional
  metadata: { plan: 'pro' }, // optional
})
```

:::

[→ Try `POST /charges` in the API Playground](https://api.klappay.com/#tag/charges/POST/charges)

`amount` and `expiresIn` are both required — every charge has a target
amount and a fixed deadline; there's no default to fall back on.
`expiresIn` is capped at 3600 seconds (60 minutes), sized off the
slowest chain Klap supports (a safely-confirmed Ethereum mainnet
transfer can take up to ~15 minutes), leaving real margin for
payer-side delay on top of that.

`acceptedPayments` lets the payer choose which rail to actually use —
at least one `(token, network)` pair, up to 18 (2 tokens × 9 operational
networks — the schema's ceiling of distinct pairs, which grows when a
network is added; fewer are actually payable in any one environment,
see below). Every transfer on an
accepted pair is credited and sums toward the charge total —
`charge.paidWith` is an array of every distinct pair that has actually
contributed so far (empty until the first one arrives), so a charge
accepting both USDC and USDT can be confirmed by, say, $9 in USDC plus
$1 in USDT. A transfer on a pair that isn't in `acceptedPayments` is
still recorded but never credited. `token`/`network`/`environment`
combinations that aren't currently payable are rejected at creation
(`422 token_not_supported`, naming the first bad pair) — not every
token is available on every network and environment, and `tron`
currently accepts no payments at all (see [Networks & tokens](/networks)
for the live matrix; call `GET /networks` instead of hardcoding pairs
client-side).

An `acceptedPayments` list can only mix networks that share one split
factory — a charge predicts a single address up front and reuses it on
every network it accepts, which is only safe when they all derive it the
same way. In practice every EVM network (`arc` included) forms one
group and can be mixed freely; `tron` has its own split contract, so a
list mixing `tron` with any EVM network is rejected with
`400 validation_error` (`NETWORK_FAMILIES` in `@klappay/types` tells you
which family a network belongs to — see [Networks & tokens](/networks#network)).

**Idempotency**: if you don't pass `idempotencyKey`, the SDK generates
one for you automatically, making every `create()` call safe to retry
after a network failure or timeout — a retried request with the same
key returns the original charge unchanged instead of creating a
duplicate. Reusing a key with a *different* body is a `409
idempotency_key_reused` error, not a silent return of the original
charge.

`externalRef`/`source` are both free-form strings echoed on every
webhook payload — `source` is deliberately not a fixed enum, so a new
integration flow never needs a core change to use it.

`redirectUrl` — optional, only validated as a well-formed URL (Klap
never inspects what's at that destination) — is where the payer lands
after the charge resolves *if* you send them to Klap's own hosted
checkout page (see `checkoutUrl` below). It's ignored entirely if
you're not using the hosted checkout — building your own payment UI
from `address`/`acceptedPayments` means you control navigation
yourself, with no role for this field to play.

### Who pays the fee: `feePayer`

`feePayer` defaults to `'merchant'`: `amount` is exactly what you asked
for, and Klap's `feePercent` comes out of your own payout. `feePercent`
is 1% by default, but it's negotiable per company or commercial
proposal, so read it off each charge rather than hardcoding 1%. Set it to
`'payer'` and `amount` is grossed up at creation time so that, after the
same deduction, you still net the amount you originally requested — the
payer sees and sends the larger, fee-inclusive total.

::: code-group

```bash [cURL]
curl -X POST https://api.klappay.com/v1/charges \
  -H "Authorization: Bearer klap_live_..." \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 49.9,
    "acceptedPayments": [{ "token": "USDC", "network": "base" }],
    "expiresIn": 3600,
    "feePayer": "payer"
  }'
```

```ts [Node.js]
const charge = await klap.charges.create({
  amount: 49.9,
  acceptedPayments: [{ token: 'USDC', network: 'base' }],
  expiresIn: 3600,
  feePayer: 'payer',
})
```

:::

It's frozen at creation like every other fee input, and it doesn't
change how `feeAmount`/`merchantAmount` are computed on read — only what
`amount` was set to in the first place. Either way the charge comes back
carrying `feePercent`, `feeAmount`, and `merchantAmount`, so a price
breakdown never means reimplementing the fee math; `merchantAmount` is
always what actually lands in your payout.

### Splitting a slice to other recipients: `splitRecipients` {#splitrecipients}

Route a slice of the charge to up to 5 extra recipients (a supplier, or
whoever closed the sale) with `splitRecipients`. Each entry names a
`recipientId` (from [`POST /recipients`](/recipients), **not** a raw
address), a `percent`, and an optional `label` (1–64 characters, your own
bookkeeping, echoed back unchanged).

::: code-group

```bash [cURL]
curl -X POST https://api.klappay.com/v1/charges \
  -H "Authorization: Bearer klap_live_..." \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 49.9,
    "acceptedPayments": [{ "token": "USDC", "network": "base" }],
    "expiresIn": 3600,
    "splitRecipients": [
      { "recipientId": "rc_abc123", "percent": 10, "label": "sales rep" }
    ]
  }'
```

```ts [Node.js]
const charge = await klap.charges.create({
  amount: 49.9,
  acceptedPayments: [{ token: 'USDC', network: 'base' }],
  expiresIn: 3600,
  splitRecipients: [{ recipientId: 'rc_abc123', percent: 10, label: 'sales rep' }],
})

console.log(charge.splitRecipients)
// [{ address: '0x1111...1111', percent: 10, label: 'sales rep' }]
```

:::

**`percent` is a share of your own net amount (`100 - feePercent`), not of
the charge's gross `amount`.** Klap's fee is computed on the gross first
and is never diluted by how you divide what's left. The percents must fit
inside that share, otherwise the request is rejected with `422
split_recipients_exceed_available_percent`. The list is frozen at
creation like everything else that shapes the split address; it can't be
changed afterward.

Request and response differ on purpose: you submit a `recipientId`, and
`charge.splitRecipients` echoes back the resolved `address` of each entry
(an empty array when there are none), so reading the charge back tells you
where the money went without a second lookup. A `recipientId` that
doesn't resolve fails the request with `422 recipient_not_found_in_split`.

Requires the `charges:split_write` scope **in addition to**
`charges:write` — a key with only `charges:write` creates ordinary
charges but can never redirect part of a payout, even to an
already-registered recipient. See [Recipients](/recipients) for
registering them and [Authentication](/authentication#scopes) for the
scope model.

### Holding funds with `escrow`

Pass `escrow` and the charge stops paying out on confirmation. Funds
accumulate in a Safe dedicated to that charge and move only on a
signature from `escrow.releaserAddress` — either onward to the split
address ([release](#releasing-or-refunding-an-escrow)) or back to the
payer ([refund](#releasing-or-refunding-an-escrow)). The two are
mutually exclusive: an escrow charge only ever goes one way, once.

::: code-group

```bash [cURL]
curl -X POST https://api.klappay.com/v1/charges \
  -H "Authorization: Bearer klap_live_..." \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 49.9,
    "acceptedPayments": [{ "token": "USDC", "network": "base" }],
    "expiresIn": 3600,
    "escrow": { "releaserAddress": "0xabc1234567890123456789012345678901234567" }
  }'
```

```ts [Node.js]
const charge = await klap.charges.create({
  amount: 49.9,
  acceptedPayments: [{ token: 'USDC', network: 'base' }],
  expiresIn: 3600,
  escrow: { releaserAddress: '0xabc1234567890123456789012345678901234567' },
})
```

:::

`releaserAddress` is set once at creation and immutable after — it is
the only address ever authorized to move this charge's escrowed funds.
Omit it and it defaults to the API key's own `payoutAddress`, which is
the common case: the merchant releasing their own charge is usually the
same wallet they already get paid to. Pass one explicitly only when the
releaser is a different party, such as an operational key kept separate
from the payout wallet. Klap never holds a key with release authority
of its own — this is the same non-custodial guarantee as a normal
charge, with the settlement step gated on your signature instead of
happening automatically.

Escrow requires **every** network in `acceptedPayments` to be EVM — the
funds sit in a dedicated Safe, which doesn't exist on TRON and never
will (it isn't an EVM chain). `POST /charges` rejects `escrow` combined
with `tron` in `acceptedPayments` with `400 validation_error`; `arc` is
EVM-compatible and works.

Everything else works identically on an escrow charge —
`acceptedPayments`, `expiresIn`, `metadata`, `splitRecipients`. `escrow`
only changes how funds leave once they've arrived.

## Sending the payer to checkout

The fastest way to see what a payer actually experiences: every charge
gets a hosted checkout page for free, no frontend to build. Redirect to
`charge.checkoutUrl` right after creating it:

```ts
const charge = await klap.charges.create({
  amount: 49.9,
  acceptedPayments: [{ token: 'USDC', network: 'base' }],
  expiresIn: 3600,
  redirectUrl: 'https://your-site.com/thank-you', // where the payer lands once it resolves
})

console.log(charge.checkoutUrl)
// https://checkout.klappay.com/c/ch_abc123 — open this in a browser to
// see exactly what the payer sees: a method picker if acceptedPayments
// has more than one pair, the QR code for the chosen one, and the
// status updating live (over the same SSE stream as /realtime) with no
// refresh needed once they pay.
```

`checkoutUrl` is `null` if hosted checkout isn't enabled for your
account — in that case there's nothing
to redirect to, and you're expected to build the payment UI yourself
from `address`/`acceptedPayments` (see [Payment QR
codes](#payment-qr-codes) below for the piece that's still provided for
you either way). Ask to have hosted checkout enabled if you want a page
to point customers at without building one.

## The `Charge` shape

What every read returns (`GET /charges/{id}`, `GET /charges`, and every
webhook's `data` for a `charge.*` event):

| Field | Notes |
|---|---|
| `id` | Klap-generated id (`ch_...`). |
| `currency` | Always `USD` today — the only supported currency. |
| `feePayer` / `feePercent` / `feeAmount` / `merchantAmount` | Who covers Klap's fee (`'merchant'` default, or `'payer'`), the fee percent frozen at creation, `amount * feePercent / 100`, and `amount - feeAmount` — what you net once the payout settles. |
| `amount` | The requested target, set at creation, never changes. A legacy JSON number — see [Exact amounts](#exact-amounts) before doing arithmetic with it. |
| `amountExact` | `amount` as a decimal string (up to 6 fractional digits, no scientific notation). Optional for compatibility with older API versions. |
| `acceptedPayments` | Echoes exactly what was configured at creation; never changes afterward. |
| `paidWith` | Every distinct `(token, network)` pair that has actually contributed a credited transfer so far. `[]`, not `null`, until the first arrives. |
| `amountReceived` | Cumulative amount actually received on-chain. `null` until the first transfer. Can exceed `amount` — see `isOverpaid`. A legacy JSON number. |
| `amountReceivedExact` | `amountReceived` as a decimal string (up to 18 fractional digits, no scientific notation). `null` until the first transfer; can exceed `amountExact`. Optional for compatibility with older API versions. |
| `paymentUnavailable` | `true` while payment processing for this charge is temporarily paused — see [Payment temporarily unavailable](#payment-temporarily-unavailable). Optional for compatibility with older API versions. |
| `isOverpaid` | `true` once `amountReceived` exceeds `amount`. Klap never auto-refunds the difference (see "Can the difference be refunded?" below) — this field is how you detect it happened. |
| `status` | Payment progress from the payer's side only: `pending` → `partially_paid`/`confirmed` → (if it never fully pays) `expired`/`underpaid`. Every status is reached automatically — there's no merchant-initiated cancellation. |
| `settlementStatus` | `'pending' \| 'completed' \| 'failed' \| null`. A **separate** step from `status` — `status: confirmed` means the transfer was detected on-chain; `settlementStatus: completed` means the merchant's wallet actually has the funds. `null` means no payout has been attempted yet. |
| `settledAt` | When `settlementStatus` first reached `completed`. `null` otherwise. |
| `environment` | `live` or `test`, matching the API key used. `test` runs on each network's testnet where one exists (see [Networks & tokens](/networks)) — real on-chain activity, never real money. |
| `address` | The on-chain address the payer sends to, identical no matter which accepted pair they use. Predicted at creation; funds sent here go directly to the merchant. |
| `checkoutUrl` | Klap's hosted checkout page for this charge, if configured for your deployment. `null` otherwise — build your own UI from `address`/`acceptedPayments`. |
| `splitRecipients` | The resolved split, one `{ address, percent, label? }` per entry (`address`, not the `recipientId` you submitted). `[]` when none — see [`splitRecipients`](#splitrecipients). |
| `swapAlternatives` | The `{ token, network }` pairs a payer can pay with *instead* of an accepted token, via [swap-to-pay](#paying-with-another-token-swap-to-pay). Always `[]` on a `test` charge. |
| `txHash` | Hash of the most recent transfer detected for this charge. `null` until one is detected. |
| `externalRef` / `source` / `metadata` / `redirectUrl` | Echo whatever you set at creation; `null` when unset. |
| `apiKeyId` | Which of your API keys created the charge. `null` for charges created before this field existed. |
| `createdAt` / `expiresAt` / `confirmedAt` / `lastActivityAt` | ISO timestamps. `confirmedAt` is `null` until `status` first reaches `confirmed`; `lastActivityAt` is when a transfer was last credited (or `createdAt` if none yet). |
| `escrow` | `{ releaserAddress, releasedAt, refundedAt }` on an escrow charge, `null` otherwise — see [Holding funds with escrow](#holding-funds-with-escrow). |

### Exact amounts

`amount` and `amountReceived` are legacy JSON numbers, which can lose
precision. `amountExact` (up to 6 fractional digits, the target's own
precision) and `amountReceivedExact` (up to 18, matching what's actually
detected on-chain) carry the same values as decimal strings with no
scientific notation — prefer them for arithmetic and payment
preparation. Both are optional, only so responses from an older API
version still validate; fall back to the numeric field when absent.

The 18-digit ceiling exists because BNB Chain's USDC and USDT are
Binance-Peg tokens with 18 on-chain decimals (every other deployment
uses 6) — a charge paid on `bnb` is exactly the case where
`amountReceivedExact` carries more fractional digits than a JSON number
can hold. If you build transfers yourself, resolve a token's address and
decimals together with `getTokenDeployment` from `@klappay/types`
instead of assuming 6 (see [Networks & tokens](/networks#token)).

### Payment temporarily unavailable

`paymentUnavailable: true` means Klap has paused payment processing
for this charge. Its `status` and monetary fields keep showing where it
stood, but don't rely on them to fulfill an order, and don't ask the
payer for another transfer, until the flag clears. Check it before
rendering payment instructions, alongside `status` and
`settlementStatus`. The calls that would hand out payment details
refuse the same way: `GET /charges/{id}/qrcode` and `POST
/charges/{id}/quote` return `503 payment_temporarily_unavailable` for
such a charge, as does `POST /charges` for a payment method that is
paused at creation time. Treat it as retryable later, not as a
rejected request.

## Listing charges

::: code-group

```bash [cURL]
curl "https://api.klappay.com/v1/charges?status=confirmed&limit=20" \
  -H "Authorization: Bearer klap_live_..."
```

```ts [Node.js]
const page = await klap.charges.list({ status: 'confirmed', limit: 20 })
// page.data, page.nextCursor, page.hasMore

for await (const charge of klap.charges.listAll({ status: 'confirmed' })) {
  console.log(charge.id)
}
```

:::

[→ Try `GET /charges` in the API Playground](https://api.klappay.com/#tag/charges/GET/charges)

Cursor-paginated (`limit`/`cursor` → `{ data, nextCursor, hasMore }`) —
`since` filters on `createdAt`, not on when the status last changed, so
a poll-based recovery mechanism needs a `since` window at least as wide
as the `expiresIn` used at creation, or it can miss a status change;
pair polling with `GET /charges/{id}/events` for live updates instead
of relying on `since` alone. The Node SDK's `listAll()` is an async
generator that pages through everything automatically — every yielded
`charge` is the same live-wrapped object `create()`/`get()` return.

## Observing a charge until it resolves

This is the Node SDK's main reason to exist over calling the REST API
directly — payments aren't request/response, they have state, and
watching that state used to mean hand-rolling a polling loop yourself.

```ts
try {
  const confirmed = await charge.waitForConfirmation({ timeoutMs: 60 * 60_000 })
  console.log('Paid!', confirmed.amountReceived)
} catch (err) {
  // ChargeExpiredError | ChargeUnderpaidError | WaitTimeoutError — see /errors
}
```

`waitForConfirmation()` resolves **only** when `status` reaches
`confirmed`. Every other terminal outcome — `expired`, `underpaid`, or
the timeout elapsing first — **rejects** with a specific typed error
instead of resolving with a charge you'd have to inspect yourself.

**How it works**: opens a live event stream first (`GET
/charges/{id}/events`, Server-Sent Events — see [Real-time
status](/realtime)) and resolves as soon as the matching status change
is pushed. If the stream can't be opened or drops, the SDK transparently
falls back to polling `GET /charges/{id}` for the rest of the timeout
budget, with backoff — the public option names (`timeoutMs`,
`pollIntervalMs`, `onStatusChange`) are transport-agnostic on purpose.

[→ Try `GET /charges/{id}/events` in the API Playground](https://api.klappay.com/#tag/charges/GET/charges/{id}/events)

```ts
await charge.waitForConfirmation({
  timeoutMs: 3600_000, // default: 1 hour
  pollIntervalMs: 2000, // default: starts at 2s
  onStatusChange: (c) => console.log('now:', c.status), // fires on partially_paid too
})
```

### `waitForSettlement(options?)`

A **separate** wait, for a **separate** question: `status: confirmed`
means Klap detected the on-chain transfer, not that the money has
reached the merchant's wallet yet — that's `settlementStatus`, a
distinct, later step.

```ts
const confirmed = await charge.waitForConfirmation()
const settled = await confirmed.waitForSettlement({ timeoutMs: 10 * 60_000 })
```

Resolves when `settlementStatus === 'completed'`, rejects with
`SettlementFailedError` if it reaches `'failed'`, or `WaitTimeoutError`
on timeout.

### `waitFor(event, options?)`

The general form, for the other charge events beyond confirm/settle:

```ts
const partiallyPaid = await charge.waitFor('charge.partially_paid')
const expired = await charge.waitFor('charge.expired')
```

Same underlying engine (SSE-first, polling fallback) but simpler on
purpose: it only resolves on the specific event you asked for, and
never rejects with a typed error for a *different* terminal state —
pairs naturally with [Sandbox](/sandbox) triggers for integration
testing.

### Cancelling a wait

Same pattern as `fetch` — pass an `AbortSignal`, cancel with the
matching `AbortController`. Works on `waitForConfirmation()`/
`waitForSettlement()`/`waitFor()` alike; rejects with the signal's own
`reason` (an `AbortError` by default).

```ts
const controller = new AbortController()
cancelButton.onclick = () => controller.abort()

await charge.waitForConfirmation({ signal: controller.signal })
```

## Audit trail

```bash [cURL]
curl https://api.klappay.com/v1/charges/ch_abc123/timeline \
  -H "Authorization: Bearer klap_live_..."
```

[→ Try `GET /charges/{id}/timeline` in the API Playground](https://api.klappay.com/#tag/charges/GET/charges/{id}/timeline)

`GET /charges/{id}/timeline` (`getTimeline(id)` on the SDK) returns
every event recorded against a charge in chronological order — the
on-chain transaction detections, split-distribution events, and webhook
dispatch/delivery/failure events — useful for debugging one specific
payment without separate audit tooling.

## Payment QR codes

`GET /charges/{id}/qrcode` (`getQrCode(id, query?)` on the SDK) returns
a scannable [EIP-681](https://eips.ethereum.org/EIPS/eip-681) payment
QR code as raw SVG, generated on demand and never stored. Encodes the
charge's address and amount for one accepted pair — `query` (`{ token,
network }`) is required only when `acceptedPayments` has more than one
pair; with exactly one it's resolved automatically. Only available
while the charge can still be paid — a `confirmed`/`expired`/
`underpaid` charge returns `409 charge_not_payable` instead.

[→ Try `GET /charges/{id}/qrcode` in the API Playground](https://api.klappay.com/#tag/charges/GET/charges/{id}/qrcode)

## Paying with another token (swap-to-pay)

A charge only ever accepts the stablecoins in its own `acceptedPayments`,
but the payer often holds something else. `charge.swapAlternatives` lists
every `(token, network)` pair Klap trusts as swap input for that charge,
derived from the networks in `acceptedPayments`; a charge accepting USDC
on Base lists `ETH`, `BTC`, `LINK` and `CBETH` on Base, for instance.
It's a list of pairs rather than of tokens so the payer knows which chain
to send on, and because the same asset resolves to a different contract
per network (`BTC` is `cbBTC` on Base, `WBTC` on Optimism, `BTC.b` on
Avalanche). Pass an entry straight through as `inputToken`/`inputNetwork`
to `POST /charges/{id}/quote`.

::: code-group

```bash [cURL]
curl -X POST https://api.klappay.com/v1/charges/ch_abc123/quote \
  -H "Authorization: Bearer klap_live_..." \
  -H "Content-Type: application/json" \
  -d '{
    "inputToken": "ETH",
    "inputNetwork": "base",
    "takerAddress": "0x1111111111111111111111111111111111111111"
  }'
```

```ts [Node.js]
const quote = await klap.charges.getQuote('ch_abc123', {
  inputToken: 'ETH',
  inputNetwork: 'base',
  takerAddress: '0x1111111111111111111111111111111111111111', // the payer's own wallet
})
```

:::

[→ Try `POST /charges/{id}/quote` in the API Playground](https://api.klappay.com/#tag/charges/POST/charges/{id}/quote)

The swap is routed through [0x](https://0x.org)'s Swap API; Klap's
endpoint is a thin proxy that returns a firm quote and never touches the
payer's private key. The swap's output is delivered straight to the
charge's own `address`, so once the payer signs and submits
`quote.transaction`, the resulting USDC/USDT is detected and credited
exactly like any other transfer. Klap never sees or custodies the input
cryptocurrency, and nothing about detection or settlement changes.

**The merchant always receives the charge's full remaining amount**
(`quote.outputAmount`, i.e. `amount - amountReceived`), whatever the
payer sent. Klap charges the **payer** a separate fee on top
(`quote.fees.klappayFee`, in output-token units, separate from the
charge's own `feePercent`; read it off each quote rather than
hardcoding a rate), plus 0x's own protocol
fee when it applies (`quote.fees.zeroExFee`, `null` when the pair isn't
one 0x charges on). Both are already folded into `quote.inputAmount`
(the ceiling the payer must have available; any unused input is swapped
back and returned to the payer in the same transaction) and neither ever
reduces `outputAmount`. When the remaining balance can't be expressed in
the output token's smallest unit, the requested amount rounds up by that
unit, which can leave a tiny overpayment.

`outputAmount`, `inputAmount` and `fees.klappayFee`/`fees.zeroExFee` are
legacy JSON numbers. `outputAmountExact`, `inputAmountExact`,
`fees.klappayFeeExact` and `fees.zeroExFeeExact` carry the same values as
decimal strings (up to 18 fractional digits, no scientific notation;
`zeroExFeeExact` is `null` when no 0x fee applies). They're optional only
for compatibility with older API versions; prefer them for arithmetic.

**Two client-side flows, depending on `inputToken`:**

- **Native currency** (`ETH`, `BNB`, `POL`, `AVAX`): sign and send
  `quote.transaction` (`{ to, data, value }`) as-is. `quote.permit2` is
  `null`. `POL` replaced `MATIC` as Polygon's native ticker after its 2024
  migration; it's the same asset, but an integration that reads the
  literal `'MATIC'` off `swapAlternatives` or `inputToken` will break.
- **ERC-20** (`BTC`, `LINK`, plus chain-specific `ARB`, `OP`, `CBETH`):
  `quote.permit2` is an object. Sign that EIP-712 message first and
  append the signature to `quote.transaction.data` before sending. Check
  whether `permit2` is non-null rather than special-casing token names.

`AltTokenSchema` in `@klappay/types` is the closed set of swap inputs
(`ETH`, `BNB`, `POL`, `AVAX`, `BTC`, `LINK`, `ARB`, `OP`, `CBETH`), and
the per-network trust list decides which network supports which: `OP` only
on Optimism, `ARB` only on Arbitrum, `CBETH` only on Base, `BNB` is the
only input on BNB Chain, and Arc currently trusts only `BTC` (Circle's
own BTC-backed token). TRON has none. Always read `charge.swapAlternatives`
instead of hardcoding it.

`quote.expiresAt` is a rough guide for a UI countdown only. The price is
enforced on-chain by the swap transaction itself (a signed Permit2
deadline, or a minimum-output check on native sells), so submitting late
either reverts or is re-quoted, never silently executes at a stale rate.
Quotes aren't stored by Klap.

Constraints and errors:

- Requires `charges:write` (not just `charges:read`): each call fetches a
  live firm quote, so it's rate-limited
  **per charge**, on top of the general per-key limit (`429 rate_limited`).
- `422 swap_test_environment_unsupported` on every `test`-environment
  charge: 0x has no testnet support, so `swapAlternatives` is always empty
  there and no combination could succeed.
- `422 token_not_supported` when `inputToken`/`inputNetwork` isn't in the
  charge's `swapAlternatives`.
- `409 charge_not_payable` when the charge is already
  `confirmed`/`expired`/`underpaid`, or has no remaining balance.
- `503 payment_temporarily_unavailable` when `paymentUnavailable` is set
  on the charge or its payment method is paused — retry later, see
  [Payment temporarily unavailable](#payment-temporarily-unavailable).
- `503 swap_unavailable` when swap isn't available on the deployment, and
  `503 swap_quote_failed` when the upstream quote failed, often for
  insufficient liquidity (safe to retry, including with a different
  `inputToken`).
- `404 charge_not_found`, `403 insufficient_scope` and `401` as on any
  other route.

## Forcing an on-chain re-check

A charge normally updates itself — usually within about a minute of the
payment landing on-chain. `POST /charges/{id}/check` (`check(id, input?)` on the SDK)
skips that wait and re-runs the lookup immediately:

::: code-group

```bash [cURL]
curl -X POST https://api.klappay.com/v1/charges/ch_abc123/check \
  -H "Authorization: Bearer klap_live_..." \
  -H "Content-Type: application/json" \
  -d '{
    "txHash": "0x1234567890123456789012345678901234567890123456789012345678901234",
    "network": "base"
  }'
```

```ts [Node.js]
const charge = await klap.charges.check('ch_abc123', {
  txHash: '0x1234...',
  network: 'base',
})
```

:::

[→ Try `POST /charges/{id}/check` in the API Playground](https://api.klappay.com/#tag/charges/POST/charges/{id}/check)

The body is optional. With no `txHash`, Klap looks for
any matching transfer; pass `txHash` *and* `network` together (both or
neither) and it verifies that one transaction directly, so it resolves
faster. This is the
natural call to make right after your own frontend sends a wallet or
swap transaction and already knows the hash.

It never trusts the caller: the claim is re-verified with the same
independent on-chain lookup reconciliation already uses, and the charge
only changes state if a real matching transfer is found. Rate-limited to
once every 10 seconds per charge, shared across every caller — to follow
a payment to its resolution, use the [live stream](/realtime) rather
than polling this.

Two fields come back on the checked charge that a plain `GET` doesn't
carry:

- `transactionSender` — the checked transaction's own signer. This stays
  the payer's real wallet even when the payment routed through a swap or
  aggregator, unlike the credited transfer's sender, which in that case
  is a router or pool contract. Populated only when `txHash`/`network`
  was passed and a matching receipt was found; `null` otherwise.
- `confirmationProgress` — non-null while a detected transfer still
  hasn't reached its network's required confirmation depth, carrying
  `{ network, blocksSeen, blocksRequired, percent }`. It's the same
  payload the [`confirmation_progress` SSE event](/realtime) pushes
  live, so a "confirming payment" progress bar can be driven from either
  source; `null` once the transfer is credited.

## Releasing or refunding an escrow

An [escrow-configured charge](#holding-funds-with-escrow)
holds its funds in a dedicated Safe after confirmation instead of
distributing them. Two endpoints move that balance, and a charge can use
exactly one of them, exactly once:

| Endpoint | SDK | Where the money goes |
|---|---|---|
| `POST /charges/{id}/release` | `charges.release(id, input)` | The split address, which then distributes merchant/platform shares exactly as a non-escrow charge would |
| `POST /charges/{id}/refund` | `charges.refund(id, input)` | Back to the address that funded the charge — no distribution follows, the full balance goes to the payer |

::: code-group

```bash [cURL]
curl -X POST https://api.klappay.com/v1/charges/ch_abc123/release \
  -H "Authorization: Bearer klap_live_..." \
  -H "Content-Type: application/json" \
  -d '{ "signature": "0x…" }'
```

```ts [Node.js]
const released = await klap.charges.release('ch_abc123', {
  signature: '0x…',
})

// or, to send it back to the payer instead:
const refunded = await klap.charges.refund('ch_abc123', {
  signature: '0x…',
})
```

:::

`signature` must be a valid Safe transaction signature from the charge's
`escrow.releaserAddress`, authorizing a transfer of the escrow's **full
live balance** — the amount actually received, not whatever was fixed at
creation, since under- and overpayment both change it. The Safe contract
verifies the signature on-chain before anything moves; Klap never
takes it on faith and holds no key that could move the funds on its own.

Both require the `charges:write` scope. The second call always loses:
whichever ran first rejects the other with `409
escrow_already_released` or `409 escrow_already_refunded`. Other
failures to handle:

- `400 escrow_invalid_signature` — the signature doesn't authorize this
  transfer from `escrow.releaserAddress`.
- `409 escrow_release_in_progress` / `escrow_refund_in_progress` —
  another request for the same charge is still being processed; safe to
  retry shortly.
- `422 escrow_not_configured` (not an escrow charge),
  `escrow_nothing_to_release` / `escrow_nothing_to_refund` (zero
  balance), or `escrow_multiple_payment_pairs` (the payer paid across
  more than one `(token, network)` pair, which escrow doesn't support).
- `503 rpc_unavailable` or `503 payment_temporarily_unavailable` —
  transient; retry later (see [Payment temporarily
  unavailable](#payment-temporarily-unavailable)).

A completed
release fires `charge.escrow_released`, a completed refund fires
`charge.escrow_refunded` — see [Webhooks](/webhooks).

## Can an overpayment be refunded automatically?

Not on a normal charge, and it's structural rather than a matter of
effort. The charge address is an immutable on-chain split with the payer
never one of its recipients — there's no contract call that can send
funds back to them, and Klap never custodies the funds to refund
from in the first place. `amountReceived` (and `isOverpaid`) make an
over/underpayment visible so the merchant (or the product built on this
API) can decide the business remedy — that decision needs context this
API doesn't have.

An [escrow charge](#holding-funds-with-escrow)
is the deliberate exception, and a different mechanism rather than a
loophole in that one: its funds sit in a Safe that has not distributed
yet, so a signature from the releaser can still send the whole balance
back to the payer. That's an all-or-nothing return of an undistributed
balance, decided before settlement — not a partial refund of money that
has already been paid out.

## Types

`CreateChargeSchema` / `CreateChargeInput` (`@klappay/types`) is the
body of `POST /charges` — type a pre-parse request object as
`CreateChargeRequest` instead (`currency` optional there; the schema
defaults it to `"USD"`, the only currently-supported value):

```ts
import { CreateChargeSchema, type CreateChargeRequest } from '@klappay/types'

const request: CreateChargeRequest = {
  amount: 49.9,
  expiresIn: 1800,
  acceptedPayments: [{ token: 'USDC', network: 'base' }],
}

CreateChargeSchema.parse(request) // throws on anything invalid
```

`ChargeSchema` / `Charge` is the read shape documented in the table
above. `ListChargesSchema` / `ListChargesInput` is `GET /charges`'s
query params; `PaginatedChargesSchema` / `PaginatedCharges` is its
response (`{ data: Charge[], nextCursor: string | null, hasMore:
boolean }`) — the same shared cursor-pagination pattern every list
endpoint in this API uses (`PaginationQuerySchema` +
`paginatedSchema(itemSchema)`). `TimelineEventSchema` / `TimelineEvent`
is one entry from `GET /charges/{id}/timeline` — `type` is one of
`charge.created`/`charge.expired`/`transaction.detected`/
`split.distributed`/`webhook.dispatched`/`webhook.delivered`/
`webhook.failed`, and which other fields are present depends on `type`.
`TransactionSourceSchema` / `TransactionSource` (`'contract_watcher' |
'tron_watcher' | 'reconciliation_job' | 'sandbox'`) says how a transfer
was detected: `contract_watcher` means it was detected in real time on an
EVM network, `tron_watcher` means the same on TRON, `reconciliation_job`
means the periodic re-check caught it, and `sandbox` means it was
simulated in the sandbox environment.

`EscrowConfigSchema` / `EscrowConfig` is `create()`'s `escrow` field,
and `ChargeFeePayerSchema` / `ChargeFeePayer` is the `'merchant' |
'payer'` union behind `feePayer`. `ReleaseEscrowRequestSchema` /
`ReleaseEscrowRequest` and `RefundEscrowRequestSchema` /
`RefundEscrowRequest` are the bodies of `POST /charges/{id}/release`
and `POST /charges/{id}/refund` — both just `{ signature }`, kept as
two schemas because the two operations stay independently versionable.
`CheckChargeRequestSchema` / `CheckChargeRequest` is `POST
/charges/{id}/check`'s optional body, and `CheckChargeResponseSchema` is
its response: a `Charge` plus the `transactionSender` and
`confirmationProgress` fields a plain read doesn't carry.
`ConfirmationProgressSchema` / `ConfirmationProgress` is that progress
payload on its own — the same shape the `confirmation_progress` SSE
event pushes.

`SplitRecipientInputSchema` (`recipientId`, `percent`, optional `label`)
and `SplitRecipientSchema` (resolved `address`, `percent`, optional
`label`) are the request and response shapes of
[`splitRecipients`](#splitrecipients), capped at
`CHARGE_SPLIT_RECIPIENTS_MAX` (5). `CreateSwapQuoteSchema` /
`CreateSwapQuoteInput` is `POST /charges/{id}/quote`'s body
(`inputToken`, `inputNetwork`, `takerAddress`), `SwapQuoteSchema` /
`SwapQuote` its response, `AltTokenSchema` / `AltToken` the swap-input
vocabulary, and `SwapAlternativeSchema` / `SwapAlternative` one entry of
`charge.swapAlternatives`.

## See also

- [Webhooks](/webhooks) — the full `charge.*` event vocabulary and
  payload envelope.
- [Sandbox](/sandbox) — triggering any charge state transition without
  a real on-chain transfer, to test the flows above end-to-end.
- [Recipients](/recipients) — registering the addresses
  `splitRecipients` references.
- [Networks & tokens](/networks) — the live `(token, network)` matrix
  `acceptedPayments` validates against.
- [Real-time status](/realtime) — the SSE mechanism `waitForConfirmation()`
  and friends use under the hood.
