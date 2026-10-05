# Metrics

Ad-hoc analytics over your own organization's payment data — pick a resource
(`charges`/`transactions`/`distributions`), an aggregation, optional
`groupBy` (including a single time-bucketed entry), and filters. The
response rows are shaped by that query, not a fixed report — the same
spirit as a log/observability platform's query API (Datadog, Honeycomb,
Axiom), not a free-form query language. Every filterable/groupable/
aggregatable field is an explicit, typed literal enum — `MetricsQuerySchema`
in `@klappay/types` — checked both by TypeScript at compile time and by
the server at request time, so a query can only ever touch a field the
contract explicitly declares queryable.

## Why this is a live query, not a snapshot report

Metrics are computed live at request time from your charges,
transactions, and distributions — there's no pre-aggregated snapshot
behind this endpoint, and no second copy of the data that can drift from
the source. The tradeoff is query cost instead of staleness — every
request re-scans the underlying rows for your `dateRange`, which is exactly why `dateRange` is
required and capped (see below) instead of optional-defaulting-to-
unbounded: nothing here can silently become an unscoped table scan.

`amount` vs `amountReceived` matters here specifically: when aggregating
revenue, read `amountReceived` (the real cumulative amount actually
received on-chain) rather than `amount` (the requested target) — an
overpay, or a charge paid in installments across more than one transfer,
only reports true revenue through `amountReceived`. `feePercent` follows
the same "frozen at the source" discipline — it's set once on the charge
at creation and never rewritten, so aggregating it always reflects what a
charge's fee actually was at the time, immune to a fee change made
next month silently rewriting last month's numbers. See [Charges](/charges)
for the full state machine behind `amount`/`amountReceived`.

## Querying — `POST /metrics/query`

::: code-group

```bash [cURL]
curl -X POST https://api.klappay.com/v1/metrics/query \
  -H "Authorization: Bearer klap_live_..." \
  -H "Content-Type: application/json" \
  -d '{
    "resource": "charges",
    "environment": "live",
    "dateRange": {
      "field": "createdAt",
      "from": "2026-07-01T00:00:00.000Z",
      "to": "2026-08-01T00:00:00.000Z"
    },
    "groupBy": [{ "type": "date_bucket", "field": "createdAt", "granularity": "day" }],
    "metrics": [
      { "aggregation": "sum", "field": "amount", "alias": "volume" },
      { "aggregation": "count" }
    ],
    "filters": [{ "field": "status", "operator": "eq", "value": "confirmed" }]
  }'
```

```ts [Node.js]
const result = await klap.metrics.query({
  resource: 'charges',
  environment: 'live',
  dateRange: {
    field: 'createdAt',
    from: '2026-07-01T00:00:00.000Z',
    to: '2026-08-01T00:00:00.000Z',
  },
  groupBy: [{ type: 'date_bucket', field: 'createdAt', granularity: 'day' }],
  metrics: [
    { aggregation: 'sum', field: 'amount', alias: 'volume' },
    { aggregation: 'count' },
  ],
  filters: [{ field: 'status', operator: 'eq', value: 'confirmed' }],
})

// result.data: [{ createdAt: '2026-07-01', volume: 4820.5, count: 12 }, ...]
// result.meta: { resource: 'charges', environment: 'live', rowCount: 2, truncated: false }
```

:::

[→ Try `POST /metrics/query` in the API Playground](https://api.klappay.com/#tag/metrics/POST/metrics/query)

`klap.metrics.query()` — also available standalone as
`createMetricsClient` from `@klappay/node/metrics` (see
[Tree-shaking](/sdk/tree-shaking)) — is a thin wrapper: it doesn't
pre-validate before sending, so a malformed query comes back as a `400
validation_error`/`invalid_field` `KlapApiError` from the server, exactly
as it would calling the REST endpoint directly. `environment` must match
the calling key's own environment — a `test` key can never query `live`
data or vice versa, regardless of what `resource`/`filters` say; a
mismatch is `422 environment_mismatch`. Rate limited to 60 requests/min
per organization across all of `/v1/metrics/*` — tighter than the general `/v1/*`
limit, since this can be an expensive aggregate query; over that is `429
rate_limited`.

A key also needs the right **scope**: `metrics:read` covers every
resource, or one of the narrower `metrics:charges:read` /
`metrics:transactions:read` / `metrics:distributions:read` scoped to just
that one `resource` — see [Authentication](/authentication) for the full
scope list. A key missing the scope this query needs gets `403
insufficient_scope`, distinct from `401 invalid_api_key` (key itself
invalid/revoked).

The request type is `MetricsQueryRequest` (`@klappay/types`) — a
discriminated union on `resource`, so TypeScript narrows which dimension/
metric/date fields are valid the instant you set `resource`. `groupBy`,
`filters`, and `limit` are all optional there (`MetricsQuerySchema`
defaults them to `[]`/`[]`/`100`); `MetricsQuery` (`z.infer<>`) is the
post-parse shape where those are always present — the same `*Request`/
already-parsed split `CreateChargeSchema` follows (see [Charges](/charges)).

## Query shape, field by field

### `resource` and its fields

One row per underlying record: `charges` is one row per charge,
`transactions` is one row per detected on-chain transfer (a charge paid
in installments has more than one — see [Charges](/charges)'
`causedTransition` timeline events), `distributions` is one row per
payout attempt for one `(token, network)` pair a charge settled across.

| Resource | Dimension fields (filter/groupBy) | Numeric fields (`sum`/`avg`/`min`/`max`) | Date fields |
|---|---|---|---|
| `charges` | `status`, `source`, `apiKeyId`, `currency`, `isOverpaid`, `externalRef` | `amount`, `amountReceived`, `feePercent` | `createdAt`, `confirmedAt`, `lastActivityAt`, `expiresAt` |
| `transactions` | `network`, `token`, `source`, `causedTransition` | `amount` | `detectedAt` |
| `distributions` | `status`, `network`, `token`, `distributorAddress` | `attempts` | `createdAt`, `processingStartedAt`, `completedAt` |

Every field name is also exported as its own literal-union schema/type
(`ChargesQueryFieldSchema`/`ChargesQueryField`, `TransactionsMetricField`,
etc.) from `@klappay/types` — import these directly for full autocomplete
instead of typing the string by hand. A few fields are worth knowing the
shape of before you query them:

- **`confirmedAt`** (charges) is `null` until a charge reaches
  `confirmed` — a `dateRange`/`date_bucket` on it implicitly excludes
  every charge that never confirmed. `expiresAt` is always present (set
  at creation), useful for e.g. finding charges expiring soon.
- **`causedTransition`** (transactions) is `true` only for the transfer(s)
  that actually flipped the charge's `status` — a charge paid in
  installments can legitimately have more than one `true` row; filtering/
  grouping on it excludes no-op duplicate transfers detected on the same
  address.
- **`distributorAddress`** (distributions) is the on-chain address that
  actually called `distribute()` for a `completed` distribution —
  Klap's address if Klap settled it, the keeper's address if a
  third party did, `null` for every
  non-`completed` status.
- **`processingStartedAt`** (distributions) is `null` until the first
  payout attempt, then overwritten on every retry — it reflects the
  *latest* attempt's start, not the first. `completedAt` is `null` until
  `status` reaches `completed`, so a `dateRange`/`date_bucket` on it
  implicitly excludes every distribution still pending/processing/failed.

### `dateRange` — required, and capped

Every query needs a `dateRange`: `{ field, from, to }`, `field` one of
that resource's date fields above. Not optional-defaulting-to-unbounded
on purpose — it's what keeps a query from scanning your entire history.
The span can't exceed `MAX_METRICS_QUERY_DATE_RANGE_DAYS` (366 days), and
`from` must be before `to` — a `superRefine` on `MetricsQuerySchema`
rejects anything wider, enforced server-side regardless of what the SDK
does client-side.

### `groupBy`

Up to `METRICS_QUERY_MAX_GROUP_BY` (3) entries, each either:

- `{ type: 'field', field: <a dimension field> }`
- `{ type: 'date_bucket', field: <a date field>, granularity }` — at
  most one of these per query. `granularity` is `'day' | 'week' | 'month'
  | 'year'`. Buckets are calendar-aligned and computed in UTC, so a day
boundary is midnight UTC and a week starts on Monday.

### `metrics`

At least one, up to `METRICS_QUERY_MAX_METRICS` (10): `{ aggregation,
field?, alias? }`. `aggregation` is `'count' | 'sum' | 'avg' | 'min' |
'max'`. `field` is required unless `aggregation` is `'count'` (rejected
otherwise), and must be one of the resource's numeric fields. `alias`
names the output column — omit it and the column is named `${aggregation}`
for `count`, or `${aggregation}_${field}` otherwise (e.g. `sum_amount`).
Every alias in one query must be unique, must not collide with a
`groupBy` field name or the reserved word `bucket`, and must match
`^[a-zA-Z_][a-zA-Z0-9_]*$` — letters, digits, underscores, not starting
with a digit.

### `filters`

Up to `METRICS_QUERY_MAX_FILTERS` (20): `{ field, operator, value }`.
`field` is one of that resource's **dimension** fields, not its numeric
fields — filtering `amount > 100` isn't supported today, only grouping/
aggregating on it. `operator` is `'eq' | 'neq' | 'in' | 'gt' | 'gte' |
'lt' | 'lte'` — `in` expects an array value (max 50 entries), every other
operator a single scalar.

### `orderBy` and `limit`

`orderBy` (optional): `{ key, direction }`, where `key` is an output
column name from this same query (a `groupBy` field name, or a metric's
`alias`/default name) — must match `^[a-zA-Z_][a-zA-Z0-9_]*$`, same
pattern as `alias` above, though every real output column name already
satisfies it, so this only ever rejects a value that could never have
been a real column to begin with. Omit `orderBy` and you get
ascending-by-bucket order for a date-bucketed query, or implementation-
defined (not guaranteed stable) order otherwise.

`limit` (default 100, max `METRICS_QUERY_MAX_ROW_LIMIT` = 1000) caps rows
returned — if more rows matched, the response's `meta.truncated` is
`true` and `data` holds only the first `limit`. Narrow the query (a
tighter `dateRange`, an added filter, a coarser `date_bucket`
granularity) instead of just raising `limit`.

## Response shape

```ts
interface MetricsQueryResult {
  data: Array<Record<string, string | number | boolean | null>>
  meta: {
    resource: 'charges' | 'transactions' | 'distributions'
    environment: 'live' | 'test'
    rowCount: number
    truncated: boolean
  }
}
```

`data` rows are shaped entirely by your query — keys are whatever your
`groupBy` fields and metric aliases resolved to, values are `string |
number | boolean | null`. There's no fixed report shape to fall back on:
a query with `groupBy: [{ type: 'field', field: 'source' }]` and two
`metrics` entries returns one row per distinct `source` value with those
two metric columns; a `date_bucket` query returns one row per bucket that
had at least one matching underlying record (no zero-filled gaps for
buckets with no data — pad those client-side if you need a continuous
series).

## Errors

| Status | `error.code` | Meaning |
|---|---|---|
| `400` | `validation_error` / `invalid_field` | Malformed query, or a `filters`/`groupBy`/`metrics` value that doesn't match its field's declared type |
| `401` | `missing_api_key` / `invalid_api_key` | No key, or a key that's invalid/revoked |
| `403` | `insufficient_scope` | Key is missing `metrics:read` and the matching `metrics:{resource}:read` scope |
| `422` | `environment_mismatch` | Requested `environment` doesn't match the calling key's own environment |
| `429` | `rate_limited` | Over 60 requests/min per organization on `/v1/metrics/*` |

Every error response shares the same `{ error: { code, message, param? }
}` envelope — see [Errors](/errors) for the full catalog and the
`KlapApiError` shape the Node SDK throws.

## Access control

Every valid API key gets unrestricted access to your organization's data —
there's no member/role-based sub-scoping within an organization, and no
organization id to pass anywhere. A key can only ever see data attributed
to your organization, never another's, and only its own
`environment` (`live`/`test`) — this is a structural limit of the query
engine, not a filter you can opt out of, which is also why cross-organization
analysis (cohorts, platform-wide rollups) isn't something this endpoint
can ever answer.

## What it can't answer yet

Deliberately out of scope today — worth knowing before you reach for a
workaround:

- **Cross-resource joins** — e.g. "sum of `Charge.amount` for charges
  whose distribution ultimately failed" needs a join between `charges`
  and `distributions` beyond what a single-resource query can express.
- **Activation funnels / time-to-first-X** — "time between two different
  resources' first row" isn't expressible as a `groupBy`/aggregate over
  one resource; it needs its own purpose-built query.
- **Cross-organization analysis** — cohort retention, platform-wide payer
  activity. Every query is scoped to one organization by design (see
  Access control above); this is platform-side analysis, not a
  merchant-facing feature.
- **Median/percentile aggregations** — only `count`/`sum`/`avg`/`min`/
  `max` exist today; time-to-payment percentiles need a genuinely
  different computation, not a config change.

## See also

- [Charges](/charges) — the underlying `Charge` resource this endpoint
  aggregates, its full state machine, and the `amount`/`amountReceived`
  distinction that matters for revenue metrics.
- [Distributions](/distributions) — the payout/settlement resource behind
  the `distributions` metrics resource, and what `status`/`attempts`
  mean there.
- [Errors](/errors) — the full `error.code` catalog and the `KlapApiError`
  shape every SDK method throws.
