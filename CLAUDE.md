# klap-docs

Engineering conventions for whoever (human or agent) is editing this
site. This repo is **only** documentation — a VitePress site (dark
theme, `appearance: 'force-dark'`, same palette as `klap-node`/
`klap-core`'s docs) that merges three previously-separate Klap docs
into one, organized **by resource** (Charges, Webhooks, Sandbox,
Metrics, Distributions, Recipients, Networks) instead of by source. Each resource
page mixes the concept, the REST endpoint(s), the Node.js SDK usage,
and the `@klappay/types` schema — Stripe/Resend style, not three linked
sub-sites.

## The three sources

| Source | What it covers | Remote (canonical, portable) | Local (higher-fidelity, if checked out) |
|---|---|---|---|
| `@klappay/node` SDK | Node.js client methods | `https://node-sdk.klappay.com/llms-full.txt` | `../klap-node/docs/*.md` |
| `@klappay/types` | Zod schemas / TS types | `https://api.klappay.com/types/llms-full.txt` | `../klap-core/docs-types/*.md` |
| REST API | Endpoints, params, responses | `https://api.klappay.com/v1/openapi.json` | same file, no local equivalent |
| REST API (concepts) | Product/behavior narrative | — no llms.txt for this one | `../klap-core/docs/*.md` (only the public-facing files, see below) |
| `@klappay/mcp` | MCP server for AI assistants (open source) | `https://mcp.klappay.com/llms-full.txt` | `../klap-mcp/docs/*.md` |

**Prefer the local sibling repos when they exist on disk** (`../klap-node`,
`../klap-core` relative to this repo) — their `.md` files are the actual
source-of-truth prose, denser and more accurate than the flattened
`llms-full.txt` export. Fall back to fetching the remote URLs above when
the sibling repos aren't present (a fresh clone of just this repo, CI,
another machine).

`api.klappay.com` is **production**. Keep every example, the API Playground link, and the changelog link on the production host; a pre-release environment exists for Klap's own testing, not for integrators reading these docs.

### What's deliberately excluded

Only use the public-facing source files listed in the map below. Anything else in `../klap-core/docs/` — and any internal auth contract described in `auth.md` — stays out of this site; `/authentication` covers only what an API consumer needs (how to send the key, scopes, rotation/revocation *from their side*).

## Resource → source file map

Keep this table current — it's what makes "update the docs" a lookup,
not a rediscovery, every time.

| Page | Node SDK | Types | REST concept | OpenAPI tag/path |
|---|---|---|---|---|
| `getting-started.md` | `getting-started.md` | `getting-started.md` | `auth.md` (top only) | — |
| `authentication.md` | — | `api-keys.md` | `auth.md` (public parts only) | — |
| `charges.md` | `charges.md` | `charges.md` | `payments.md` | tag `Charges` |
| `webhooks.md` | `webhooks.md` | `webhooks.md` | `webhooks.md` (outbound only) | tag `Webhooks` |
| `sandbox.md` | `sandbox-testing.md` | `sandbox.md` | — | tag `Sandbox` |
| `metrics.md` | `metrics.md` | `metrics-query.md` | `metrics.md` | tag `Metrics` |
| `distributions.md` | `distributions.md` | `distributions.md` | — | tag `Distributions` |
| `recipients.md` | `recipients.md` | `recipients.md` | — | tag `Recipients` |
| `networks.md` | `networks.md` | `tokens-and-networks.md` | — | path `/networks` (no dedicated tag) |
| `errors.md` | `errors.md` | `errors-and-health.md` | — | path `/health` + shared error schema |
| `realtime.md` | (`charges.md`'s wait methods, referenced not duplicated) | — | `realtime.md` | — |
| `sdk/tree-shaking.md` | `tree-shaking.md` | — | — | — |
| `mcp.md` | — (MCP source: `../klap-mcp/docs/*.md`; full refusal list linked, not duplicated) | — | — | — |

## Updating the docs

When asked to update/sync the docs:

1. Fetch the three sources (prefer local siblings, see above).
2. For each resource page, diff the new source content against what's
   already merged in — most updates are additive (a new field, a new
   endpoint, a corrected constant), not a full rewrite. Preserve the
   existing page's structure (Overview → REST → Node.js → Types → See
   also) and its cross-links; only change what actually changed
   upstream.
3. If a source doc gained a genuinely new resource/tag that doesn't
   map to an existing page yet, add a new page following the same
   template, and wire it into `.vitepress/config.mts`'s `sidebar` (and
   `index.md`'s feature grid if it's a top-level resource) — an
   unlinked page is as orphaned here as in any other VitePress site.
4. `pnpm build` — fails loudly on a dead internal link (GitHub's
   Markdown rendering silently doesn't), worth running after touching
   any cross-doc link.
5. `git status`/`git diff` to review, then commit.

## Commits

Conventional Commits (`docs:`, `chore:`, `fix:`, etc.), written in
English regardless of what language the conversation happened in.
**Never add a `Co-Authored-By: Claude` (or similar AI persona)
trailer** — a commit is authored as the person driving the session.
Split into separate commits along real seams (e.g. one resource's sync
vs. an unrelated theme tweak) rather than bundling everything into one.

**Never `git push` or touch GitHub Pages/DNS without the user's
explicit go-ahead in that specific session** — committing locally is
fine to do proactively when asked to "update the docs"; publishing is
not.

## Theme

Dark, forced (`appearance: 'force-dark'` in `.vitepress/config.mts`),
ink/beige brand palette (`#09090B` ink, `#D9D4CB` brand accent) in
`.vitepress/theme/custom.css` — copied verbatim from `klap-node`/
`klap-core`'s docs sites, which already share this exact theme. Don't
introduce a light mode or a different palette; if the brand palette
changes, change it in all three docs sites together, not just here.

Same for `public/logo.png` (512x512, the isometric "K") and
`public/favicon.png` (32x32): they're byte-identical copies of
`../klap-core/docs/public/`'s, which klap-core renders from klap-site's
`favicon.svg` and strips of PNG metadata (Chrome chokes on embedded ICC
profiles). Copy them over rather than regenerating them here.

## Content style

The product is **Klap**, not "Klappay" — write "Klap" in prose even
where an upstream source still says Klappay. Only the identifiers keep
the old name, because renaming them would break integrations: npm
packages (`@klappay/*`), domains (`*.klappay.com`), the GitHub org, and
the `X-Klappay-*` webhook headers. `LICENSE`'s copyright holder is a
legal name, not prose — don't touch it as part of a brand sweep.

Match the source docs' voice: dense, "explain the why" prose — name the
actual constant/limit/behavior and the reason it's that value, not
generic docs boilerplate. Every REST/Node.js pairing uses a VitePress
`::: code-group` block (cURL + Node.js tabs) so both integration paths
are visible without switching pages.

**Public by design.** This site and its repo are public. Never include real addresses or IDs from production, infrastructure/vendor/database/topology details, internal env vars or services, capacity numbers beyond the published per-key limits, past incidents, or "not live yet" status. Examples use obvious placeholders (e.g. `0x1111…1111`).
