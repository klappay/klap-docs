<img src="./public/logo.png" alt="Klap" width="80" />

# klap-docs

The source for [docs.klappay.com](https://docs.klappay.com) — Klap's
integration documentation, organized by resource rather than by source.
Each page covers a resource end to end: the concept, the REST
endpoint(s), the Node.js SDK usage, and the `@klappay/types` schema, so
integrating never means reading three sites in parallel.

Klap is a non-custodial crypto payments API: a merchant creates a
charge, the payer sends funds directly to a predicted on-chain address,
and Klap detects and distributes the payment without ever holding it.

## Running locally

```bash
pnpm install
pnpm dev      # http://localhost:5173
pnpm build    # static site into .vitepress/dist
pnpm preview  # serve the built site
```

`pnpm build` also fails on dead internal links, so it's worth running
after touching any cross-page link.

## What gets published

Every build emits [`llms.txt`](https://docs.klappay.com/llms.txt) and
[`llms-full.txt`](https://docs.klappay.com/llms-full.txt) alongside the
site, via `vitepress-plugin-llms`, so an LLM can read the whole
documentation set without crawling it. Deployment to GitHub Pages runs
from `.github/workflows/docs.yml` on every push to `main`.

## Related

| Package | Docs |
|---|---|
| `@klappay/node` — Node.js server SDK | [node-sdk.klappay.com](https://node-sdk.klappay.com) |
| `@klappay/types` — shared Zod schemas and types | [api.klappay.com/types](https://api.klappay.com/types) |
| `@klappay/cli` — command-line tool | [cli.klappay.com](https://cli.klappay.com) |
| `@klappay/checkout-kit` — build a custom checkout | [node-checkout-sdk.klappay.com](https://node-checkout-sdk.klappay.com) |
| `@klappay/one` — drop-in pay button | [js-one.klappay.com](https://js-one.klappay.com) |
| `@klappay/mcp` — MCP server for AI assistants | [mcp.klappay.com](https://mcp.klappay.com) |
| REST API reference | [api.klappay.com](https://api.klappay.com) |

Contributors: `CLAUDE.md` documents how the site stays in sync with upstream sources.

## License

MIT — see [LICENSE](./LICENSE).
