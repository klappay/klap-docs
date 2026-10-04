---
layout: home

hero:
  name: Klap
  text: Non-custodial crypto payments
  tagline: 'Keep Liquidity Always Permissionless. A merchant creates a charge, the payer sends funds directly to a predicted on-chain address, Klap detects and distributes it — without ever holding the money itself. This site covers the REST API, the Node.js SDK, and the TypeScript types together, by resource.'
  image:
    src: /logo.png
    alt: Klap
  actions:
    - theme: brand
      text: How it works
      link: /how-it-works
    - theme: alt
      text: Getting started
      link: /getting-started
    - theme: alt
      text: API Playground
      link: https://api.klappay.com/

features:
  - title: How it works
    details: The core model — predicted addresses, detection vs. settlement, why there's no refund API. Read this first.
    link: /how-it-works
  - title: Charges
    details: Create a charge, accept multiple token/network pairs, wait for confirmation and settlement over SSE, list and audit.
    link: /charges
  - title: Webhooks
    details: Subscribe to charge and delivery events, verify inbound signatures, manage retries and rotation.
    link: /webhooks
  - title: Sandbox
    details: Trigger any charge event on demand — test your integration end to end without waiting for real on-chain activity.
    link: /sandbox
  - title: Metrics
    details: Query business metrics live — volume, fees, settlement — with no separate snapshot table to go stale.
    link: /metrics
  - title: Distributions
    details: Pending payout splits and their live event stream.
    link: /distributions
  - title: Recipients
    details: Register trusted payout addresses once, then reference them by id in a charge split — no raw address ever rides a charge request.
    link: /recipients
  - title: Networks & tokens
    details: The current token/network matrix your API key can accept, read live instead of hardcoded.
    link: /networks
  - title: Authentication
    details: API keys, scopes, key rotation and revocation.
    link: /authentication
  - title: Real-time (SSE)
    details: Live charge status without polling — how the stream works, and the polling fallback.
    link: /realtime
  - title: Errors
    details: The typed error hierarchy across the REST API and the Node.js SDK.
    link: /errors
---

## What this is

One doc, organized by resource — not three separate sites for the API,
the Node.js SDK, and `@klappay/types`. Every resource page below covers
all three together: the concept, the REST endpoints, the SDK methods,
and the types, so you don't have to cross-reference three tabs to build
one integration.

For the interactive request builder (try-it, auth, generated curl), use
the [API Playground](https://api.klappay.com/) — that stays a separate
tool on purpose, this site is for reading, not for firing live requests.

Not sure where to start? [How it works](/how-it-works) covers the
non-custodial model in 5 minutes, [Getting started](/getting-started)
covers installing the SDK and creating your first charge, and [Build a
checkout flow](/guides/checkout-flow) walks the whole thing end to end —
charge, hosted checkout, webhook, confirmation.
