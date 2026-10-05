# Build a checkout flow

The five pieces from [Charges](/charges), [Webhooks](/webhooks), and
[How it works](/how-it-works), assembled into the flow most
integrations actually build: create a charge, send the payer to pay it,
and mark the order paid once it resolves — without polling.

## What the payer sees

Using Klap's hosted checkout (`charge.checkoutUrl`) means you don't
build any of this UI yourself. It's a mockup below, not a live
screenshot, but it's the real layout: the amount, a method picker if
the charge accepts more than one `(token, network)` pair, the QR code
for whichever one is selected, and a status badge that updates live
over the same SSE stream covered in [Real-time status](/realtime) — no
refresh needed once the payer sends the transfer.

<div style="border:1px solid var(--vp-c-divider);border-radius:12px;padding:24px;max-width:320px;margin:24px auto;background:var(--vp-c-bg-soft);">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
    <strong>Pay $49.90</strong>
    <span style="font-size:11px;color:var(--vp-c-text-2);border:1px solid var(--vp-c-divider);border-radius:999px;padding:3px 9px;">Waiting for payment</span>
  </div>
  <div style="display:flex;gap:6px;margin-bottom:16px;">
    <span style="font-size:11px;padding:4px 9px;border-radius:6px;background:var(--vp-c-bg-elv);border:1px solid var(--vp-c-divider);">USDC · Base</span>
    <span style="font-size:11px;padding:4px 9px;border-radius:6px;color:var(--vp-c-text-3);border:1px solid var(--vp-c-divider);">USDT · Base</span>
  </div>
  <svg width="100%" height="180" viewBox="0 0 200 200" style="display:block;margin:0 auto 16px;background:#fff;border-radius:6px;">
    <g fill="#000">
      <rect x="10" y="10" width="50" height="50"/><rect x="20" y="20" width="30" height="30" fill="#fff"/><rect x="30" y="30" width="10" height="10"/>
      <rect x="140" y="10" width="50" height="50"/><rect x="150" y="20" width="30" height="30" fill="#fff"/><rect x="160" y="30" width="10" height="10"/>
      <rect x="10" y="140" width="50" height="50"/><rect x="20" y="150" width="30" height="30" fill="#fff"/><rect x="30" y="160" width="10" height="10"/>
      <rect x="80" y="20" width="10" height="10"/><rect x="100" y="20" width="10" height="10"/><rect x="70" y="40" width="10" height="10"/>
      <rect x="90" y="50" width="10" height="10"/><rect x="110" y="60" width="10" height="10"/><rect x="70" y="70" width="10" height="10"/>
      <rect x="90" y="80" width="10" height="10"/><rect x="130" y="80" width="10" height="10"/><rect x="150" y="90" width="10" height="10"/>
      <rect x="170" y="100" width="10" height="10"/><rect x="80" y="100" width="10" height="10"/><rect x="100" y="110" width="10" height="10"/>
      <rect x="120" y="120" width="10" height="10"/><rect x="70" y="130" width="10" height="10"/><rect x="90" y="140" width="10" height="10"/>
      <rect x="110" y="150" width="10" height="10"/><rect x="130" y="160" width="10" height="10"/><rect x="150" y="170" width="10" height="10"/>
      <rect x="170" y="140" width="10" height="10"/><rect x="140" y="170" width="10" height="10"/>
    </g>
  </svg>
  <div style="text-align:center;font-size:11px;color:var(--vp-c-text-3);word-break:break-all;">0x1111…1111</div>
</div>
<p style="text-align:center;font-size:13px;color:var(--vp-c-text-2);margin-top:-8px;">Illustrative mockup, not a live screenshot — real layout, placeholder data.</p>

If `checkoutUrl` comes back `null`, or you'd rather build your own
UI, skip straight to building your own UI from `address`/
`acceptedPayments` — steps 2 onward below don't change.

## 1. Create the charge

Tie it to your own order with `externalRef`, and set `redirectUrl` so
the payer lands back on your site once it resolves:

```ts
const charge = await klap.charges.create({
  amount: order.total,
  acceptedPayments: [{ token: 'USDC', network: 'base' }],
  expiresIn: 1800, // 30 minutes
  externalRef: order.id, // your own id — this is what ties the webhook back to this order
  redirectUrl: `https://your-site.com/orders/${order.id}/thank-you`,
})

await db.orders.update(order.id, { chargeId: charge.id, status: 'awaiting_payment' })
```

## 2. Send the payer to checkout

```ts
res.redirect(charge.checkoutUrl)
```

That's the entire frontend for this flow — the checkout page, the QR
code, the live status, all served by Klap.

## 3. Register a webhook (once, not per-charge)

A one-time setup step, not something you do per order — see
[Webhooks](/webhooks) for the full subscription options:

```ts
await klap.webhooks.create({
  url: 'https://your-site.com/webhooks/klap',
  events: ['charge.confirmed', 'charge.expired', 'charge.underpaid'],
})
```

`charge.confirmed` is "the payer paid" — usually the signal to fulfill
the order. If you specifically need "the money is in my wallet," not
just "the payer paid," subscribe to `charge.settled` instead (or in
addition) — see [How it works](/how-it-works#settlement-settlementstatus)
for why those are two different moments.

## 4. Handle the webhook

Always verify the signature — this endpoint is a public URL:

```ts
app.post('/webhooks/klap', (req, res) => {
  try {
    const event = klap.webhooks.constructEvent(
      req.rawBody,
      req.headers['x-klappay-signature'],
      process.env.KLAP_WEBHOOK_SECRET,
    )

    if (event.event === 'charge.confirmed') {
      // event.data.externalRef is the order.id you set in step 1
      db.orders.update(event.data.externalRef, { status: 'paid' })
    } else if (event.event === 'charge.expired' || event.event === 'charge.underpaid') {
      db.orders.update(event.data.externalRef, { status: 'payment_failed' })
    }

    res.sendStatus(200)
  } catch {
    res.sendStatus(400) // invalid signature — reject, don't process
  }
})
```

Delivery is at-least-once — this handler needs to be safe to run twice
on the same `event.id` (an upsert-style `update`, like above, already
is; an operation like "increment a counter" would need its own dedupe).
See [Webhooks](/webhooks) for the full delivery/retry mechanics.

### No public endpoint yet?

If you're building this locally and don't have a public URL to
register, skip webhooks for now and `await
charge.waitForConfirmation()` in the same request/job that created the
charge instead — see [Charges](/charges#observing-a-charge-until-it-resolves).
Switch to the webhook once you deploy somewhere reachable; the two
aren't mutually exclusive; production integrations often use both:
webhooks for correctness (never miss an event, even across a restart)
and `waitForConfirmation()`/`waitFor()` where you already have an
open request/job you're waiting on.

## Testing before going live

Run this whole flow with a `test` key — real testnet, no real money —
and use [Sandbox](/sandbox) to force a charge straight to `confirmed`,
`underpaid`, or `expired` on demand, instead of waiting for real
transfers, so you can verify the webhook handler and both branches of
the order-status update above without round-tripping actual on-chain
activity.

## See also

- [How it works](/how-it-works) — the model behind `checkoutUrl` and
  the confirmed/settled distinction.
- [Charges](/charges) — the full resource, including `waitForSettlement()`.
- [Webhooks](/webhooks) — the full event vocabulary and signature scheme.
- [Sandbox](/sandbox) — triggering every event this guide's webhook
  handler needs to cover.
