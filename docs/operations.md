# Operations and live validation

Detailed operating limits and opt-in API acceptance checks for Dayriff. For local setup, see the [README](../README.md); for hosting configuration, see [deployment](deployment.md).

## Saved trips and limits

Local development stores private records in ignored `.private/state` with a persistent `.private/cookie-secret`; directories are private and files use owner-only permissions. Keep both through local restarts. Losing the cookie or signing secret makes an anonymous trip inaccessible; there is no account recovery or cross-device synchronization. Do not copy `.private` to Git, a build upload, or a public backup.

Production requires `STORAGE_BACKEND=firestore`, optionally `FIRESTORE_PROJECT_ID` and `FIRESTORE_DATABASE_ID` (default `(default)`), and a stable `COOKIE_SECRET`. The official server SDK uses the runtime service account; no browser database SDK or service-account key file is needed. Cloud Run’s filesystem is never used for production trips. The app refuses a production memory/file store and returns a recoverable error if shared storage is unavailable.

The same transactional store holds these UTC-day limits across restarts and instances:

| Setting | Default | Counts |
| --- | ---: | --- |
| `MAX_DAILY_PLANS` | 100 | Initial plans and chat/swap attempts, globally |
| `MAX_SESSION_DAILY_PLANS` | 30 | Planning attempts per signed browser session; HMAC IP fallback for requests without a trusted cookie |
| `MAX_DAILY_LOOKUPS` | 2,000 | Artist and venue lookup requests |
| `MAX_DAILY_OPENAI_REQUESTS` | 400 | Actual outbound OpenAI attempts |
| `MAX_DAILY_QLOO_REQUESTS` | 2,000 | Actual outbound Qloo attempts, including read retries |
| `MAX_DAILY_ROUTES_REQUESTS` | 300 | Actual optional Google Routes attempts |

Provider reservations happen before network calls. A denied reservation or unavailable quota store cannot send an uncounted call. Reads, history restore/removal and Clear trip do not consume daily planning/provider allowances. Short per-IP rate limits still apply. Usage records expire separately after three UTC days; they contain counters and keyed hashes, not trip contents or raw IP addresses. Clearing a trip does not reset global usage. API call caps are not dollar budgets and do not cover use of the same credentials outside Dayriff; retain provider-side quotas and spending controls.

Trips expire on access after 30 days of inactivity even if database cleanup is delayed. Enable Firestore TTL on `dayriff_state.expiresAt` before launch; physical TTL deletion is asynchronous. Clear trip explicitly deletes the active stored document and cookie, including plan, chat, history, candidates, preferences and starting point. In-flight writers cannot recreate it. OpenAI/Qloo requests already sent remain subject to those providers’ policies.

## Sharing and public metadata

Use the native Share plan control on results to prepare a read-only seven-day snapshot. The native share sheet is available where the browser supports Web Share; Copy link and a selectable URL cover unsupported sharing/clipboard permissions. Canceling native sharing sends nothing. Links preserve the shared revision; newer edits need a new link. Up to eight unexpired snapshots can exist per anonymous trip. Clear trip turns off all of its shared links.

Snapshots include public stops, show details and directions from the first public stop. They exclude the original starting text/address, private first walking leg, chat, history, budget and personalized narratives. Public views create no session and do not renew the owner’s retention. Shared copies expire for access after seven days; their content lives within the owner’s retained trip record until pruned or cleared. Anyone holding a link can read that copy while active; already received copies or third-party preview caches cannot be recalled.

Homepage metadata, canonical URLs, Open Graph/Twitter cards and WebSite/WebApplication structured data are rendered on the server from the configured production origin. Shared pages render their own artist/city title, real stop/venue/date summary and the branded Dayriff homepage screenshot without executing JavaScript. Shared links are noindex and omitted from the sitemap; their metadata contains only the sanitized snapshot. Local/sample builds remain noindex and omit unpublished canonical URLs. No search ranking or answer-engine inclusion is promised.

The social card uses a close crop of an actual homepage screenshot so the main form fills more of the frame. It has no added corner wordmark or fade. Its editable crop is in `assets/social-card.svg`; only the optimized 1200×630 `public/share-dayriff.jpg` is served. The Apple home-screen icon derives from the existing Dayriff favicon. These are static assets, with no image-generation or paid-provider work at request time. See [submission preparation](submission.md) for the outstanding publication checks.

Place details show up to five distinct photos when Qloo provides them. The first photo loads immediately; additional photos download only when selected or swiped into view. Existing provider responses supply the gallery, with no extra discovery calls or photo-service dependency. Many Qloo records currently provide a single photo, which retains the single-photo layout.

## Live conversation acceptance checks

`npm run qa:live -- --live` runs isolated synthetic user journeys through the real app routes and configured Qloo/OpenAI APIs. It deliberately requires `--live`, uses the server-only local configuration, and does not run as part of `npm test`. Run it from the repository root with `APP_MODE=live` configured. It creates no cloud resources.

The journeys cover New York from SoHo, New York near a venue, and London from Camden Town: setting two stops, adding a third, repeated cultural refinements, button and typed swaps, changing budget/place preferences, changing arrival time, answering a question without mutation, and restoring the conversation on reload. Checks validate actual stop IDs, unchanged positions for atomic swaps, schedule arithmetic, optional inputs and map waypoints. Missing cultural price data must produce an explicit budget-coverage explanation; removing that preference requires an explicit user turn.

Reports are written to ignored `.private/live-qa/` and contain no credentials or session cookies. `--case=nyc-soho`, `--case=nyc-near-venue`, or `--case=london` can select one journey. Add `--edges` for withdrawal and persistent avoidance, contradictory requests, mixed replacement/whole-plan requirements, invalid arrival, and unsupported city changes. Add `--comfort` for walking reductions and clearing that preference, a mixed route with high-end dining, an unverifiable Michelin-only request, and a subsequent cheaper café request. The runner honors the app’s actual rate-limit retry delay. These are acceptance checks over changing external data, not a guarantee that every place or preference combination has sufficient coverage.

See [validation and launch readiness](validation.md) for tested boundaries, provider limitations, and the work remaining before public deployment.

Regional live journeys can be run deliberately with `node_modules/.bin/tsx scripts/check-regional-live.ts --live`. The default matrix covers Asheville, Tulsa and Dunedin; `--case=asheville`, `--case=tulsa`, or `--case=dunedin` selects one. `--case=ghent` probes the documented sparse venue coverage rather than assuming success. Both runners use isolated in-memory synthetic storage, keeping preview trips intact. Regional evidence is in ignored `.private/regional-live-qa/`.
