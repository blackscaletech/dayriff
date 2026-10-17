# Validation

Validated on 16 October 2026 using isolated synthetic trips and public destinations. Live checks use the actual application routes, Qloo and OpenAI; private reports, credentials and session cookies are excluded from the repository.

## Current results

| Coverage | Result |
| --- | --- |
| Offline constraint, security and failure tests | 304 passed |
| Type checking and production build | Passed |
| Production dependency audit | No known vulnerabilities reported |
| Hosted live acceptance | 20/20 checks passed, 9 planning/chat requests |
| Earlier New York/London conversations | 56 checks passed |
| Regional live matrix: Asheville, Tulsa, Dunedin | 24/24 checks passed |
| Schedule arithmetic sweep | 103,680 combinations checked |

## Hosted acceptance

The hosted New York conversation exercised exactly two stops, adding a third while preserving the existing stops, a cultural replacement at capacity, an atomic button swap affecting only its target, changing arrival to 6:15 PM, and a question that left the plan unchanged.

A server revision restart preserved the exact plan, conversation and history through real Firestore with a stable cookie secret. Restoring an owned earlier version also passed.

A seven-day shared snapshot was read-only and excluded private starting details, chat, preferences and the private first walking leg. Its HTML contained the correct trip-specific Open Graph/Twitter metadata and 1200×630 social image metadata. Clear trip revoked both JSON and HTML access to the snapshot and rejected stale-cookie access. The hosted Asheville flow returned three initial stops, accepted exactly two, and restored them after reload. Synthetic trips were cleared afterward.

## Security, persistence and quotas

Hosted checks confirmed unauthenticated Firestore access returned 403, private bucket access was denied, and the runtime identity had only database-user access plus access to the selected secrets. No user-managed service-account keys were present. Firestore TTL on `dayriff_state.expiresAt` is active, with `payload` and `expiresAt` excluded from indexing. App access enforces expiry before asynchronous physical TTL cleanup.

Offline tests additionally cover owner/revision boundaries, forged and expired cookies, simultaneous writers, transaction retries, bounded payloads, expired leases, rejected stale commits and clear during an in-flight operation without late resurrection. Durable daily quota tests cover concurrent reservations, restarts, UTC rollover, browser limits, counted provider retries and no outbound request after a denied reservation. Unavailable quota/storage services fail closed.

Privacy and sharing checks cover confirmed deletion, cancellation, recoverable failures, content-free cross-tab clearing, public snapshot redaction, expiry and native-share cancellation without unintended copying. The Firestore SDK and provider credentials stay server-side.

## Broader live coverage

The earlier 56-check matrix covered New York from SoHo and near the venue, plus London from Camden Town. It exercised repeated preferences, typed/button swaps, exclusions and reversals, budget changes, dining/café requests, walking changes, retained places, contradictory requests, read-only answers and reload/history restoration.

The 24-check regional matrix covered Asheville’s Orange Peel, Tulsa’s Cain’s Ballroom and Dunedin Town Hall. Each produced real recommendations and exercised count changes, cultural swaps, an unsupported greater-than-three request, a read-only answer and reload. A separate approximate downtown-Asheville start and a Beverly Hills municipality start also passed. These establish specific additional destinations, not universal coverage; Ghent’s Vooruit had no Qloo venue match.

The schedule sweep covered date/time/duration/arrival combinations, previous-day starts and calendar boundaries. It validates arithmetic rather than every natural-language expression. Metadata tests cover canonical origins, escaped markup, honest structured data and CSP hashes, preview noindex, robots/sitemaps and unavailable-share 404s.

## Limits and remaining verification

- Plans support one to three stops. Infeasible adjustments preserve the current plan and explain the constraint.
- Provider coverage, opening hours and prices can be incomplete. Unknown prices are not verified budget matches; current Michelin stars, bookings and live opening are not verified.
- Live checks used the labeled approximate walking estimates. Map destinations and stop order were checked; street-level travel times were not independently validated through Google Routes.
- Provider latency, outages and future quota exhaustion remain possible. Passing runs do not guarantee every city or preference combination.
- Custom-domain DNS and managed TLS are verified. Six public HTTPS checks passed for homepage metadata, robots, sitemap, favicon, social image and the query-preserving `www` redirect. The live-domain browser flow accepted real autocomplete selections, created a plan, replaced a stop with a café while keeping exactly three stops, and restored its conversation and route after reload. Desktop/mobile layout, custom time controls, logo navigation and About/Privacy back navigation were inspected. A failed secondary photo was reproduced and rechecked after the gallery fix: the loaded photo remains visible during the attempt, then the failed entry leaves the count and controls within eight seconds. Actual external social-preview rendering is not claimed by metadata tests alone.

## Reproduce

```sh
npm run check
npm run build
npm run qa:live -- --live --edges --comfort
node_modules/.bin/tsx scripts/check-regional-live.ts --live
```

Live commands deliberately make provider calls and require server-only live configuration. See [operations](operations.md) for case selection, report locations, retention and quotas, and [deployment](deployment.md) for the hosted configuration.
