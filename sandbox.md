# Sandbox

Test your integration end to end — any charge state transition, any
webhook, any partial/over/underpayment scenario — without waiting for a
real on-chain transfer or a real block time. The testnets
`test`-environment charges actually settle on still take real block
time to confirm a real transfer; sandbox triggers skip that entirely,
pushing a charge straight to the target state and dispatching the exact
webhook/SSE update a real payment would have produced.

Scoping is enforced on **both** sides of the request, not just one:
the API key must be `test`-environment (`klap_test_...`) *and* carry the
`sandbox:trigger` scope, and the charge being triggered must itself be
`test`-environment. A `live` key gets `403 forbidden` outright — sandbox
triggers aren't reachable from `live` at all, scope or no scope. A
`test` key missing the scope gets `403 insufficient_scope`. A `test` key
that's otherwise entitled but pointed at a `live` charge (not possible
within one organization's own charges, but the check exists regardless)
gets `403 charge_not_test_environment`. Nothing here ever touches the
blockchain: `charge.settled`/`charge.settlement_failed` simulate the
payout outcome directly instead of calling the real distribution path,
so a sandbox run never spends real gas, even on testnet.

## Triggering an event

One REST primitive backs everything: `POST
/sandbox/charges/{id}/trigger`, which can push a `test` charge into
**any** state transition. The matching webhook fires and any open SSE
stream updates exactly as it would for a real payment — your handler
code can't tell the difference from the outside.

::: code-group

```bash [cURL]
curl -X POST https://api.klappay.com/v1/sandbox/charges/ch_abc123/trigger \
  -H "Authorization: Bearer klap_test_..." \
  -H "Content-Type: application/json" \
  -d '{ "event": "charge.confirmed" }'
```

```ts [Node.js]
const charge = await klap.charges.create({
  amount: 10,
  acceptedPayments: [{ token: 'USDC', network: 'base' }],
  expiresIn: 3600,
})

// instead of waiting for a real on-chain transfer:
await klap.sandbox.confirm(charge.id)
```

:::

[→ Try `POST /sandbox/charges/{id}/trigger` in the API Playground](https://api.klappay.com/#tag/sandbox/POST/sandbox/charges/{id}/trigger)

The response is the full updated `Charge` object — same shape as `GET
/charges/{id}` — so you can assert on `status`, `amountReceived`, etc.
directly off the trigger call instead of re-fetching.

`event` is required, `amount` is optional and only meaningful for two
of the seven triggerable events:

| Method | REST `event` | `amount` |
|---|---|---|
| `klap.sandbox.confirm(chargeId)` | `charge.confirmed` | — full payment |
| `klap.sandbox.partiallyPay(chargeId, amount?)` | `charge.partially_paid` | optional, must be less than the charge amount — defaults to half of it |
| `klap.sandbox.overpay(chargeId, amount?)` | `charge.overpaid` | optional, must be greater than the charge amount — defaults to 1.5x it |
| `klap.sandbox.expire(chargeId)` | `charge.expired` | — expired with zero payment |
| `klap.sandbox.underpay(chargeId)` | `charge.underpaid` | — expired after a partial payment (trigger `partiallyPay` first) |
| `klap.sandbox.settle(chargeId)` | `charge.settled` | — payout completed |
| `klap.sandbox.failSettlement(chargeId)` | `charge.settlement_failed` | — payout failed |
| `klap.sandbox.trigger(chargeId, event, amount?)` | any of the above | the general form the named methods call internally |

When `amount` applies, it's bound by the same ceiling as everywhere else in the API (up to 6 decimal places,
`0 < amount ≤ 999_999_999_999`,
exclusive of zero) — passing an out-of-range or wrong-direction amount
(e.g. more than the charge total for `partially_paid`, or less than it
for `overpaid`) is `400 invalid_amount`, not a silently-clamped value.
It's ignored for every other event.

Every event also has a real precondition on the charge's *current*
state (e.g. `charge.underpaid` requires the charge to already be
`partially_paid`) — triggering one out of order is `422
invalid_trigger_state`, not a silent no-op. `charge.overpaid` isn't a
standalone outcome — it always dispatches `charge.confirmed` alongside
it, matching what a real overpayment does on-chain. This is the only
sandbox trigger endpoint: webhook-delivery-health events
(`webhook.delivery_failed`, etc.) are derived from real delivery
attempts and have no simulated trigger of their own, and there's no
trigger for `charge.created` (a charge already exists by the time you
have an id to trigger against) or for `charge.escrow_released`/
`charge.escrow_refunded` — those are reached by actually calling
[release or refund](/charges#releasing-or-refunding-an-escrow) on a
`test`-environment escrow charge. A charge id that doesn't exist (or
belongs to a different organization) is `404 charge_not_found`.

On the types side, the request body is `SandboxTriggerSchema` /
`TriggerableChargeEvent` (`@klappay/types`) — `event` is derived with
`.exclude(['charge.created', 'charge.escrow_released',
'charge.escrow_refunded'])` from the same charge-event enum
[Webhooks](/webhooks) documents, not a second hand-maintained list, so a
future charge event added there is automatically included here with no
second place to remember to update:

```ts
import { SandboxTriggerSchema, type TriggerableChargeEvent } from '@klappay/types'

SandboxTriggerSchema.parse({ event: 'charge.confirmed' })
SandboxTriggerSchema.parse({ event: 'charge.partially_paid', amount: 20 })
```

`POST /sandbox/charges/{id}/trigger` is the only sandbox trigger.

## A full integration test

Combine a trigger with `charge.waitFor()` to test your own
webhook-handling code end-to-end, for any event, with no real money and
no waiting for real block times:

```ts
const charge = await klap.charges.create({
  amount: 10,
  acceptedPayments: [{ token: 'USDC', network: 'base' }],
  expiresIn: 3600,
})

const [confirmed] = await Promise.all([
  charge.waitFor('charge.confirmed', { timeoutMs: 15_000 }),
  klap.sandbox.confirm(charge.id),
])

expect(confirmed.status).toBe('confirmed')
expect(confirmed.amountReceived).toBe(10)
```

Or drive it through the full partial-payment lifecycle:

```ts
await klap.sandbox.partiallyPay(charge.id, 4)
await charge.waitFor('charge.partially_paid')

await klap.sandbox.underpay(charge.id)
const underpaid = await charge.waitFor('charge.underpaid')

expect(underpaid.amountReceived).toBe(4)
```

Note the `Promise.all` shape in the first example: `waitFor()` has to
be armed *before* (or at the same instant as) the trigger fires, since
it's listening for a state change that could otherwise happen before
the listener is attached. See
[Charges](/charges#observing-a-charge-until-it-resolves) for
`waitFor()`/`waitForConfirmation()`/`waitForSettlement()` in depth —
same wait engine, SSE-first with a polling fallback, used here and
against real payments alike.

## Testing your webhook handler without deploying anything

Pair sandbox triggers with `@klappay/cli`'s `klap listen --forward-to`
and `klap sandbox trigger` — drive any event from your terminal while
your own webhook handler, running on `localhost`, receives it with a
real signature, computed the same way a production delivery's would be.
See [`@klappay/cli`](https://www.npmjs.com/package/@klappay/cli)'s own
README for the full forwarding mechanism (it also has `klap webhooks
trigger <event>`, which signs and delivers a fake webhook locally without
logging in, and `klap charges watch <id>`, which tails a charge's status;
both documented at [cli.klappay.com](https://cli.klappay.com)), and [Webhooks](/webhooks) for
verifying that signature in your handler — sandbox-triggered deliveries
aren't exempt from signature verification, which is the point: your
handler is exercised exactly as it would be in production, deployed or
not.

The same triggers are available to an AI assistant through the
[MCP server](/mcp)'s `sandbox_trigger` tool ("mark that charge as
confirmed, then show me its timeline") — test environment only; it's
never registered against a live key.

## See also

- [Charges](/charges) — the state machine sandbox triggers move a
  charge through, and `waitFor()`/`waitForConfirmation()`.
- [Webhooks](/webhooks) — the full event vocabulary `event` draws from,
  and how to verify what a trigger dispatches as a real, signed webhook
  delivery.
