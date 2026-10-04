# Real-time (SSE)

## Overview

Two endpoints push state changes live over Server-Sent Events instead
of making you poll for them: `GET /v1/charges/{id}/events` (see
[Charges](/charges)) and `GET /v1/distributions/pending/events` (see
[Distributions](/distributions)). A third, `GET /v1/webhooks/listen`,
streams your organization's whole webhook-delivery feed and is
documented on [Webhooks](/webhooks) — all three share the exact
mechanics on this page, each just projecting a different payload onto
the same stream (a `Charge`, a pending distribution, a webhook
delivery). All three require the same `Authorization: Bearer <key>`
auth as the rest of `/v1/*`.

The reason to reach for this over polling isn't just convenience —
it's latency and load. A poll loop has a floor: whatever interval you
pick, you're paying for requests that mostly come back unchanged, and
you're always up to one interval late learning about the one that
didn't. SSE has neither problem, because the stream is driven by the
exact same code path that triggers every other side effect of a status
change (webhook dispatch, etc.) — there's no separate timer generating
these events, so you find out the moment the server does, and an idle
charge costs nothing beyond one open connection.

That includes changes that originate outside the request that opened
the stream, such as a charge expiring on a schedule or a distribution
settling: changes from any source reach your open stream exactly like
one triggered by an inline API call would.

## Consuming a stream

This is the raw mechanism — what `waitForConfirmation()`,
`waitForSettlement()`, `waitFor()` (see [Charges](/charges)), and
`streamPending()` (see [Distributions](/distributions)) do under the
hood in the Node.js SDK. Reach for those typed wrappers first; read on
if you're consuming the stream directly — a non-Node client, or custom
logic beyond what the wait-helpers cover.

::: code-group

```bash [cURL]
curl https://api.klappay.com/v1/charges/ch_abc123/events \
  -H "Authorization: Bearer klap_live_..." \
  -H "Accept: text/event-stream"
```

```ts [Node.js]
// What waitForConfirmation()/waitFor() do internally, minus the
// polling fallback and typed resolve/reject logic layered on top.
const res = await fetch('https://api.klappay.com/v1/charges/ch_abc123/events', {
  headers: {
    Authorization: `Bearer ${process.env.KLAP_API_KEY}`,
    Accept: 'text/event-stream',
  },
})

const reader = res.body!.getReader()
const decoder = new TextDecoder()
let buffer = ''

while (true) {
  const { done, value } = await reader.read()
  if (done) break
  buffer += decoder.decode(value, { stream: true })

  let boundary: number
  while ((boundary = buffer.indexOf('\n\n')) !== -1) {
    const frame = buffer.slice(0, boundary)
    buffer = buffer.slice(boundary + 2)
    if (frame.startsWith(':')) continue // heartbeat comment — not a payload

    const data = frame
      .split('\n')
      .find((line) => line.startsWith('data: '))
      ?.slice('data: '.length)
    if (!data) continue

    const charge = JSON.parse(data)
    console.log(charge.status, charge.settlementStatus)
  }
}
```

:::

Every frame is a plain `event: <type>` / `data: <JSON>` pair —
`event: charge` carrying a full `Charge` on the charges endpoint,
`event: distribution` carrying a discriminated-union payload on the
distributions endpoint (see [Distributions](/distributions) for its
exact shape and the `?limit=` connect-time snapshot option). Any
standard `EventSource`-compatible client can consume either.

### `event: confirmation_progress`

The charges stream carries a second event type alongside `event:
charge`. Once a transfer has been detected but hasn't yet reached its
network's required confirmation depth, `event: confirmation_progress`
fires with `{ network, blocksSeen, blocksRequired, percent }` — enough
to render a real progress bar during the wait instead of an
indeterminate spinner. It stops once the transfer is credited, which
`event: charge` announces on its own.

This exists only on the live stream. It is not part of `GET
/v1/charges/{id}`, so a client on the SDK's polling fallback never sees
it — treat it as an enhancement to the waiting experience, never as the
signal that decides whether a charge was paid. The same payload is also
returned by [`POST /charges/{id}/check`](/charges#forcing-an-on-chain-re-check)
as `confirmationProgress`, which is how a poll-only client can still
approximate it.

In the Node.js SDK there are two ways in. The wait helpers take an
`onConfirmationProgress` callback:

```ts
await charge.waitForConfirmation({
  onConfirmationProgress: (p) => console.log(`${p.network}: ${p.percent}%`),
})
```

Or consume both event types on one connection with `watchEvents()`,
discriminating the union with the exported type guards:

```ts
import { isChargeEvent, isConfirmationProgressEvent } from '@klappay/node'

for await (const event of klap.charges.watchEvents('ch_abc123')) {
  if (isChargeEvent(event)) {
    console.log(event.data.status, event.data.settlementStatus)
  } else if (isConfirmationProgressEvent(event)) {
    console.log(event.data.network, event.data.percent)
  }
}
```

`watch()` is the same stream filtered down to `Charge` updates only —
reach for `watchEvents()` when you want the progress events too.

**Browsers' built-in `EventSource` can't set the `Authorization` header
this endpoint requires** — that's why the example above uses `fetch`
with a manually-parsed body instead of `new EventSource(...)`. If you
need this in browser code, consume the stream from your own backend
and relay it to the frontend over a connection you control (another
SSE stream, a WebSocket, whatever fits your stack) rather than pointing
a browser `EventSource` at the Klap API directly.

## Stream lifecycle

1. **Connect** — the current state is sent immediately as the first
   event, before waiting for anything to change. (Distributions is the
   one exception by default — see [Distributions](/distributions) for
   why its stream sends no initial snapshot unless you pass `?limit=`.)
2. **Push** — every subsequent change is sent as it happens, with no
   fixed interval to wait out.
3. **Heartbeat** — a `: ping` comment-only line every 30s, solely to
   keep the connection alive through proxies and load balancers that
   time out idle connections. It carries no data — consuming code
   should skip comment lines (anything starting with `:`), not treat
   them as a payload, exactly like the `if (frame.startsWith(':'))
   continue` above.
4. **Close** — the stream ends on whichever comes first:
   - the resource reaches a terminal state — for a charge, `expired`,
     or `confirmed`/`underpaid` with `settlementStatus` resolved (see
     [Charges](/charges)); for a distribution, it's removed from the
     feed once claimed, not the stream itself closing;
   - a belt-and-suspenders timeout past the resource's own natural
     deadline (a charge's `expiresAt` plus a short grace window), in
     case a terminal-state event is ever missed;
   - the client disconnects.

There's no `Last-Event-ID` replay on reconnect — a dropped and
reopened stream starts from "current state as of now," not a
gap-filled replay of whatever happened while you were disconnected.
For charges this is self-healing, because reconnecting re-sends the
current state as the first event per the **Connect** step above; for a
delta-only feed like distributions, that's exactly why
[Distributions](/distributions) recommends treating both the list
snapshot and every event as an idempotent add/remove against one local
map, rather than trusting the stream never to have a gap.

## Limitations

**Backpressure.** Each API key may hold at most 20 concurrent SSE
streams across every authenticated SSE endpoint (`/charges/{id}/events`,
`/distributions/pending/events`, `/webhooks/listen` alike), so one noisy
key can't crowd out the rest of your integration. Past that cap, a new
connection attempt gets `503 sse_capacity` rather than queueing. This is
independent of the general `/v1/*` rate limiter, which caps request
*rate*, not concurrent open *connections*, and wouldn't catch a backlog
of idle streams at all. Sizing follows from the intended use: one stream
per resource a caller is actively watching in real time, not a way to
hold open thousands of idle long-lived subscriptions. If your integration
needs to watch many resources at once (bulk reconciliation, an internal
dashboard), prefer listing with a cursor/`since` filter instead and
reserve SSE for the handful a user is actively waiting on.

**No sticky sessions.** Any connection receives every update, so there is
no reconnect-to-a-specific-host workaround and no sticky-session
requirement on your load balancer.

**Polling fallback.** If a stream can't be opened at all, or drops and
a reconnect doesn't come back cleanly, that's a permanently missed
window under the no-replay behavior described above — which is why the
Node.js SDK doesn't rely on the stream alone. `waitForConfirmation()`
and friends open the stream first but transparently fall back to
polling `GET /charges/{id}` for the remainder of the timeout budget if
the stream fails, with backoff — see [Charges](/charges) for the exact
`pollIntervalMs`/`timeoutMs` semantics. If you're consuming the raw
stream yourself outside the SDK, you're responsible for the equivalent
fallback: treat a stream that won't (re)connect as a signal to poll the
resource directly, not as a reason to retry the stream indefinitely.

## See also

- [Charges](/charges) — `waitForConfirmation()`, `waitForSettlement()`,
  and `waitFor()`, the typed Node.js SDK wrappers around
  `/charges/{id}/events`.
- [Distributions](/distributions) — `streamPending()`, the equivalent
  wrapper around `/distributions/pending/events`, plus the connect-time
  `?limit=` snapshot option and the idempotent add/remove pattern for
  its delta-only feed.
