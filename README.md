# Dayriff

**Make a day of the show.** Discover nearby places inspired by the artist you’re seeing, then follow a walking route that ends at your concert venue.

[Open Dayriff](https://dayriff.com)

Qloo supplies real artist/place identities, cross-domain taste affinity and geographically relevant candidates. OpenAI interprets requests and proposes bounded plan changes; the server validates place IDs, timing and route feasibility before saving them. Removing Qloo would remove the taste grounding that drives discovery.

- Search for an artist and venue, then choose show time and time to explore.
- Start near the venue or enter an address, landmark or neighborhood. Arrival time and budget are optional.
- Tune the itinerary in a persistent conversation, swap a stop or revisit earlier versions.
- View available place photos and walking directions; share a read-only snapshot with friends.
- Saved anonymous trips expire after 30 days without use. Clear trip and privacy controls are available in About.

## Run locally

Requires **Node.js 22.19+**.

```sh
npm ci
cp .env.example .env.local
npm run dev
```

Open [localhost:3000](http://localhost:3000). Preserve an existing `.env.local` rather than replacing it. The default `sample` mode works without keys and uses a clearly labeled illustrative New York catalog; its pairings are editorial examples, not Qloo recommendations.

## Connect live APIs

Set these server-only values in `.env.local`:

```dotenv
APP_MODE=live
QLOO_API_KEY=your-event-key
OPENAI_API_KEY=your-project-key
```

The configured defaults are `https://hackathon.api.qloo.com`, `gpt-6-luna` and medium reasoning. `GOOGLE_MAPS_API_KEY` is optional for Google Routes walking estimates. Without it, travel estimates remain approximate. See [`.env.example`](.env.example) for all settings and [operations](docs/operations.md) for durable storage and quotas.

Keep credentials in ignored local environment files or deployment secrets. Never publish keys, provider response caches, saved trips or private validation reports. Provider requests run on the server; live failures remain explicit and never become sample recommendations.

## Scope and data

Live venue search has no city allowlist; useful results depend on Qloo coverage. Starts must resolve within 8 km of the venue. Plans contain up to three stops and work backward from arrival 30 minutes before show time, or an explicit arrival preference. Fewer stops can be appropriate when time is short.

Taste affinity does not establish an artist’s personal connection to a place. Hours, spending tiers and walking times can be incomplete or approximate; Dayriff does not promise opening, reservations or current Michelin status. Generic global chains are excluded from automatic recommendations. Photos come from available Qloo metadata, with source credit; extra gallery images load only when selected.

## Validate and build

```sh
npm run check
npm run build
npm start
```

These checks run without provider credentials. Deliberate live acceptance checks make paid API calls and are documented in [operations](docs/operations.md). Recorded coverage and remaining limitations are in [validation](docs/validation.md); passing checks do not guarantee every external-data combination will work.

## Project guide

- [Architecture](docs/architecture.md): small React/Vite client, Fastify server, provider boundaries and shared contracts.
- [Operations](docs/operations.md): retention, quotas, privacy, sharing and live test commands.
- [Deployment](docs/deployment.md): Cloud Run/Firestore launch configuration and reproduction steps.
- [Submission](docs/submission.md): current hackathon requirements and publication checks.

Current package version: **0.1.2**. Repository attribution: [blackscaletech](https://github.com/blackscaletech). Original source and brand artwork use the [MIT license](LICENSE); provider data, photography and dependencies retain their own terms as explained in [NOTICE](NOTICE).
