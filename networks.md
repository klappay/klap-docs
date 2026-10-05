# Networks & tokens

Which `(token, network)` pairs a given API key's environment can accept
right now — and why you should always read that live instead of
hardcoding it.

## Overview

`acceptedPayments` on a charge is a list of `(token, network)` pairs,
but not every pair that *typechecks* actually exists on-chain for your
key. Coverage is asymmetric on purpose: some tokens have no testnet
deployment at all, some networks have no `test` environment
whatsoever, and `live`/`test` don't move in lockstep — a network can be
wired up on testnet well before it goes live, or the reverse. Treating
`Token` and `Network` as a clean cross product and hardcoding all 18
combinations (2 tokens × 9 networks) client-side will eventually hand a payer a pair that
`POST /charges` then rejects with `422 token_not_supported`.

`GET /networks` exists to close that gap. It's not a separate,
maybe-stale list somebody remembers to update — it's read straight
from the exact same `TOKEN_ADDRESSES` lookup that `POST /charges`
validates `acceptedPayments` against at creation time. That makes the
guarantee exact in both directions: a pair this endpoint lists is
always safe to submit, and a pair it doesn't list is always rejected.
Build a payment-method picker (which chains/tokens to show a payer) by
calling this at render time instead of shipping a static matrix that
drifts the moment a new network or token comes online.

One more reason to prefer this over hardcoding: it's scoped to *your
key's own* `environment`. A `live` key and a `test` key against the
same account can see genuinely different matrices (see the gotchas
below), so there's no single "the matrix" to bake into a client bundle
even if you wanted to — it's inherently per-environment. Also worth
knowing: unlike almost every other authenticated route, `GET /networks`
skips the scope check entirely — any valid, unrevoked, environment-
matched key can call it, `charges:read` or not, because the response
is identical for every key in that environment and there's nothing
tenant-specific in it to protect.

## Getting the current matrix

::: code-group

```bash [cURL]
curl https://api.klappay.com/v1/networks \
  -H "Authorization: Bearer klap_live_..."
```

```ts [Node.js]
const capabilities = await klap.networks.get()
// { acceptedPayments: [
//   { token: 'USDC', network: 'base' },
//   { token: 'USDC', network: 'optimism' },
//   { token: 'USDT', network: 'base' },
//   ...
// ] }
```

:::

[→ Try `GET /networks` in the API Playground](https://api.klappay.com/#tag/networks/GET/networks)

`GET /networks` takes no parameters — the only input is which key you
authenticate with, since that's what determines the `environment`
being read. `klap.networks` is also available standalone as
`createNetworksClient` from `@klappay/node/networks` (see
[Tree-shaking](/sdk/tree-shaking)); it requires only an `apiKey`, no
other client setup.

Response shape (`CapabilitiesSchema`/`Capabilities` in
`@klappay/types`):

```ts
{ acceptedPayments: { token: Token; network: Network }[] }
```

Every entry is a pair actually configured for the calling key's
`environment` right now — not the full type-level set of values
`Token`/`Network` can hold (see below), which is a wider, aspirational
list that includes combinations with no real deployment yet.

## Tokens and networks reference

### `Token`

`TokenSchema`/`Token` — currently `'USDC' | 'USDT'`. This is today's
supported list, not a permanent ceiling — more tokens are expected to
be added over time as new networks and assets come online. Support
depends on both `network` and `environment`, and coverage isn't
symmetric:

- **`live`** has both `USDC` and `USDT` on `base`, `optimism`,
  `polygon`, `ethereum`, `arbitrum`, `avalanche`, and `bnb`; `arc` has
  `USDC` only (Circle's own chain has no `USDT` deployment). On `bnb`, both tokens
  are Binance-Peg, not Circle/Tether deployments (see below) — they're
  still listed under `USDC`/`USDT` because that's what those symbols
  mean on BNB Chain in practice, just with a different trust model.
- **`test`** coverage varies per network, for two unrelated reasons:
  - `base`, `optimism`, and `ethereum` each have a `test` environment
    with `USDC` only — none has an official Sepolia `USDT`, because
    Tether simply doesn't issue one there. A token-level gap. `arc`
    likewise has `USDC` on its testnet.
  - `arbitrum`, `polygon`, and `avalanche` have no `test` environment
    at all yet, for *any* token — 0xSplits (the split-factory
    infrastructure Klap's charge addresses are built on) hasn't
    deployed on Arbitrum Sepolia, and has no Polygon or Avalanche Fuji
    testnet support at all. A network-level gap, not a token-level
    one — it's not that `USDC` is missing there, it's that nothing is.
  - `bnb` has no `test` environment either, same root cause: no BNB
    testnet support in 0xSplits.

An unconfigured `(token, network, environment)` combination is
rejected with `422 token_not_supported` at charge creation — never
silently accepted and left to strand a payer's funds.

**`USDC` and `USDT` on `bnb` are Binance-Peg tokens, not Circle or
Tether deployments, and both use 18 on-chain decimals.** Payments on
BNB Chain are supported, and a charge can accept both pairs like any
other network's.

On `USDC`:
Circle issues no native USDC on BNB Chain at all — it's absent from
both Circle's own address list and its CCTP-supported chain list. The
address behind `bnb`'s `USDC` entry is a Binance-custodied,
1:1-pegged BEP-20 token instead: Binance locks real USDC (or
equivalent collateral) in its own wallet and mints this against it.
Real liquidity and adoption — it genuinely is what "USDC" means on BNB
Chain in practice — but a centralized-custody trust model, unlike
every other `USDC`/`USDT` entry in this matrix, which is verified
directly against its actual issuer. Accepted at the payer's own risk —
Klap doesn't verify or guarantee Binance's collateral backing it.
`USDT` on `bnb` is the same story: the configured contract is also a
Binance-Peg asset with 18 decimals, not Tether's own issuance, so don't
present either BNB entry as direct Circle or Tether issuance in your UI.
Token symbols alone never identify a contract, issuer, or decimal count.

**`USDC` on `arc` isn't a separately-deployed contract.** It's Arc's
native gas asset, exposed through a fixed system address with an
optional ERC-20 interface (the same address on mainnet and testnet).
That interface reports 6 decimals, which is what `getTokenDeployment`
returns, even though the native balance itself has 18.

One more naming quirk, cosmetic but worth knowing if you're
cross-checking on a block explorer: on `arbitrum`, the `USDT` contract
is real and Tether-backed, but reports its on-chain name/`symbol()` as
`"USD₮0"` (Tether's "USDT0" cross-chain standard, migrated in place in
January 2025). Verification is always done by contract address, never
by `symbol()`, so this doesn't affect anything functionally — but
don't mistake "USD₮0" on Arbiscan for a different, unsupported token.

Resolve a deployment's contract address **and** its decimals together
with `getTokenDeployment(token, network, environment)` from
`@klappay/types` (also in `@klappay/types/constants`), which returns
`{ address, decimals }` or `undefined` when that combination isn't
configured. Every deployment outside BNB Chain uses 6 decimals; both
BNB Chain contracts use 18. `TOKEN_DECIMALS` (`6`) is still exported for
source compatibility but is deprecated and unsafe for general token
conversion — it's wrong for `bnb`. Read
`deployment.decimals` for payment preparation, amount formatting, and
raw-value validation. `TOKEN_ADDRESSES` is likewise a legacy
address-only view derived from the same data — a present address alone
doesn't mean a payment method is on offer, and test and live metadata
must never fall back to each other, since they're different chains.

**`tron` isn't accepting payments right now, in either environment.**
It's still a valid `Network` value (so it typechecks, and filtering or
reading by it works), but `GET /networks` doesn't list any TRON pair and
`POST /charges` rejects one with `422 token_not_supported`. When it's
enabled it will simply appear in `GET /networks` — another reason to
build the picker from that response instead of from the `Network` type.
TRON addresses aren't `0x`-prefixed: they're Base58 (`T...`).

### `Network`

`NetworkSchema`/`Network` — `'base' | 'optimism' | 'polygon' |
'ethereum' | 'arbitrum' | 'avalanche' | 'bnb' | 'tron' | 'arc'`. Every one of these
values is valid for reading/filtering (e.g. `ListChargesInput.network`)
regardless of whether it's fully wired for writes. A network that's
dropped is removed from the type entirely rather than left behind as a
deprecated value.

`OPERATIONAL_NETWORKS` — the narrower list of networks actually wired
end-to-end today (`base`, `arbitrum`, `optimism`, `polygon`, `ethereum`,
`avalanche`, `bnb`, `arc`, `tron`), which right now happens to equal
every `Network` value. `POST /charges` enforces this at creation: a `network` outside
this list is rejected with `400 validation_error` naming the network
and what's currently supported, not silently accepted and left
unroutable. This isn't guaranteed to stay in lockstep with `Network` —
the day a genuinely new chain is added to the type before its wiring
lands, `OPERATIONAL_NETWORKS` will again be the narrower one. Being in
`OPERATIONAL_NETWORKS` only means the schema accepts the network; it
doesn't promise any pair on it is payable in a given environment (`tron`
is in the list but currently isn't, and several networks lack a `test`
environment entirely — see the gaps above). `GET /networks` is the
answer to that question.

`EVM_NETWORKS` — every `Network` value except `tron`, which isn't EVM
(Arc is, and shares the `'evm-official'` split family below). Use this to guard
any logic that assumes an EVM-style `0x` address/RPC; escrow, for
instance, needs every accepted network to be in it.

`NETWORK_FAMILIES` (`Record<Network, 'evm-official' | 'tron'>`)
— which split-address family a network belongs to. A charge predicts one
split address up front and reuses it on every network it accepts, which
is only safe when they all derive it through the same split factory.
Every EVM network, Arc included, is `'evm-official'` (0xSplits' official
contracts, same factory on every chain), so they can be mixed freely in
one charge. `tron` has its own factory, so `acceptedPayments` can't mix
it with an EVM network — that's rejected with `400 validation_error`.
`@klappay/types` 6.0.0 removed `'arc'` from this union; code that
switches on the family should drop that branch.

`NETWORK_LABELS` — display names (`'Base'`, `'Optimism'`, ...) for UI
use. `NETWORK_EXPLORERS` — each network's block explorer base URL
(e.g. `https://basescan.org`), for building a direct transaction link
yourself: `${NETWORK_EXPLORERS[network]}/tx/${charge.txHash}`.

### Known gaps at a glance

| Network | `live` | `test` |
|---|---|---|
| `base` | USDC, USDT | USDC only (no Sepolia USDT) |
| `optimism` | USDC, USDT | USDC only (no Sepolia USDT) |
| `ethereum` | USDC, USDT | USDC only (no Sepolia USDT) |
| `arbitrum` | USDC, USDT | none (no 0xSplits on Arbitrum Sepolia) |
| `polygon` | USDC, USDT | none (no 0xSplits testnet support) |
| `avalanche` | USDC, USDT | none (no 0xSplits Fuji support) |
| `bnb` | USDC, USDT (both Binance-Peg, 18 decimals) | none (no 0xSplits BNB testnet support) |
| `arc` | USDC only (no USDT on Arc) | USDC |
| `tron` | none (not accepting payments right now) | none |

This table is a snapshot for orientation only — it's exactly the kind
of hardcoded matrix this page argues against relying on. Always confirm
against `GET /networks` for your own key's environment before shipping
a payment-method picker; the day a new network/token combination lands,
this table goes stale and the live endpoint doesn't.

## See also

- [Charges](/charges) — `acceptedPayments` at charge creation is
  validated against this exact same matrix; `POST /charges` and
  `GET /networks` share one lookup, so a pair accepted here can never
  be a pair rejected there.
- [Authentication](/authentication) — `GET /networks` is one of the
  few routes that skips the scope check; still requires a valid,
  unrevoked, environment-matched key.
