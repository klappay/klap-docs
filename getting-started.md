# Getting started

Klap is a non-custodial crypto payments API — you get a unique
on-chain address per charge and never touch a private key or a hosted
balance. Two things you need before your first request:

- **An account and an API key** — sign up and generate keys from your
  dashboard at [app.klappay.com](https://app.klappay.com). Keys aren't
  self-serve through the API itself — creating one is a dashboard
  action, done once per environment: `klap_live_...` for production, or
  `klap_test_...` to run against real testnets (Base Sepolia and others) with no
  real money at risk. See [Authentication](/authentication) for how a
  key is scoped and what it's allowed to do; the short version, used
  everywhere below, is `Authorization: Bearer klap_live_...`.
- **A way to call the API.** Two options, and neither is "more
  official" than the other — pick based on your stack:
  - **`@klappay/node`**, the official Node.js SDK. It wraps every
    endpoint with typed methods and automatic idempotency keys, and —
    its real reason to exist over calling REST directly —
    `waitForConfirmation()`/`waitForSettlement()` methods that watch a
    charge's status for you instead of you hand-rolling a polling
    loop.
  - **Raw REST**, `https://api.klappay.com/v1`, callable from any
    language. Every response is plain JSON, and the OpenAPI document
    backing this site's API reference is publicly served at
    `/v1/openapi.json` if you want to generate a client for a
    language Klap doesn't ship an SDK for.

## Quickstart

```bash
npm install @klappay/node
```

(`@klappay/types` — the Zod schemas and TypeScript types every SDK
method is built from — comes along as a dependency automatically. You
don't need to install it separately just to use the SDK; see
[Type safety](#type-safety) below for when you would.)

Create a client, then create a charge. The cURL tab does exactly the
same thing with no SDK at all, side by side for comparison:

::: code-group
```ts [Node.js]
import { createClient } from '@klappay/node'

const klap = createClient({
  baseUrl: 'https://api.klappay.com/v1',
  apiKey: process.env.KLAP_API_KEY, // klap_live_... or klap_test_...
})

const charge = await klap.charges.create({
  amount: 49.9,
  acceptedPayments: [{ token: 'USDC', network: 'base' }],
  expiresIn: 3600, // seconds, required — up to 3600 (1 hour max)
})

console.log(charge.id, charge.address, charge.status) // 'pending'
```
```bash [cURL]
curl https://api.klappay.com/v1/charges \
  -X POST \
  -H "Authorization: Bearer $KLAP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 49.9,
    "acceptedPayments": [{ "token": "USDC", "network": "base" }],
    "expiresIn": 3600
  }'
```
:::

[→ Try `POST /charges` in the API Playground](https://api.klappay.com/#tag/charges/POST/charges)

Both calls create the identical resource: a `pending` charge with a
unique on-chain `address` the payer sends funds to. Funds go straight
to your own wallet — Klap never custodies them. `baseUrl` has no
built-in default in the SDK — always pass `https://api.klappay.com/v1`
explicitly; a required field that fails loudly if you forget it is
easier to catch than a silent default.

There's one thing the cURL version has to handle that the Node version
doesn't: retries. If a request like this times out or the connection
drops before you see a response, retrying it verbatim risks creating a
second charge for the same order. `klap.charges.create()` generates an
`idempotencyKey` for you automatically on every call, so a retry safely
returns the original charge unchanged instead of a duplicate. Calling
REST directly, pass your own `idempotencyKey` in the body (deriving it
from your own order id works well) to get the same guarantee — reusing
a key with a different request body is a `409`, not a silent return of
the original charge, so it only protects genuine retries.

What comes back from the SDK is more than the JSON, too: `charge` here
is a live object with `waitForConfirmation()`, `waitForSettlement()`,
and `refresh()` methods attached, so you can `await` the payment
resolving instead of writing a polling loop yourself. See
[Charges](/charges) for the full resource — creating, listing, and
watching a charge's status until it resolves, plus QR codes and the
per-charge event timeline.

## Type safety

```bash
npm install @klappay/types zod
```

`zod` is a peer dependency, not bundled — every schema `@klappay/types`
exports *is* a `zod` schema, so if your project already depends on
`zod` directly, you already have it.

`@klappay/types` is published as its own package, separate from the
SDK — both `@klappay/node` and your own code import from it, and the
SDK doesn't hand-maintain a parallel set of types that could drift; it
re-exports these directly. The package itself has no HTTP client and
no networking of any kind — it only describes shapes. Two things,
exported side by side for every resource:

- A **Zod schema** (`ChargeSchema`, `CreateChargeSchema`,
  `WebhookPayloadSchema`, ...) — validate data at runtime, not just
  satisfy the type checker.
- An **inferred TypeScript type** for the same shape (`Charge`,
  `CreateChargeInput`, ...). The type is `z.infer<typeof Schema>` on
  top of the schema — there's no separate hand-written type anywhere
  that could drift from it.

Reach for `@klappay/types` directly, rather than only through the SDK,
any time you're calling the API yourself but still want the contracts:
a `fetch` call in a framework the SDK doesn't fit, a codegen step, a
different language's types generated from the same schemas, or
validating a webhook payload in a service that doesn't otherwise use
`@klappay/node`.

**Typing a response:**

```ts
import type { Charge } from '@klappay/types'

async function getCharge(id: string): Promise<Charge> {
  const res = await fetch(`https://api.klappay.com/v1/charges/${id}`, {
    headers: { Authorization: `Bearer ${process.env.KLAP_API_KEY}` },
  })
  return res.json()
}
```

**Validating a response or webhook payload at runtime** — a type only
helps at compile time; it says nothing about what actually came back
over the wire. Parse anything you don't fully control through its
schema:

```ts
import { WebhookPayloadSchema } from '@klappay/types'

app.post('/webhooks/klap', (req, res) => {
  const payload = WebhookPayloadSchema.parse(req.body) // throws on anything invalid
  res.sendStatus(200)
})
```

This only validates *shape* — it never checks the
`X-Klappay-Signature` header, so don't trust a webhook body just
because it parsed. See [Webhooks](/webhooks) for verifying that
signature yourself (the SDK's `constructEvent()` does both the
signature check and the parse in a single call).

## Where to go next

- [Charges](/charges) — the core resource: create, list, paginate, and
  observe a charge's status until it resolves.
- [Webhooks](/webhooks) — registering webhooks and verifying signatures
  on what you receive.
- [Authentication](/authentication) — API key format, scopes, and what
  each scope actually gates.
- [Sandbox](/sandbox) — testing your integration end-to-end, including
  triggering any charge state transition, without any real on-chain
  activity.
- [Errors](/errors) — every error shape the API returns (and, if
  you're on the SDK, every error class it throws), and when.

## For LLMs and agents

This site publishes [`llms.txt`](https://docs.klappay.com/llms.txt) — a
link index of every page here — and
[`llms-full.txt`](https://docs.klappay.com/llms-full.txt) — the full
content of every page concatenated into one plain-text file. Point an
agent, RAG pipeline, or MCP server at either as a lightweight way to
hand it the whole integration documentation without scraping HTML. Both
regenerate on every deploy, so they never drift from what's on these
pages.

Each SDK publishes its own pair at the same paths on its own site:
[`@klappay/node`](https://node-sdk.klappay.com/llms.txt),
[`@klappay/types`](https://api.klappay.com/types/llms.txt),
[`@klappay/cli`](https://cli.klappay.com/llms.txt),
[`@klappay/checkout-kit`](https://node-checkout-sdk.klappay.com/llms.txt),
and [`@klappay/one`](https://js-one.klappay.com/llms.txt).
