# Deployment

Dayriff runs on Cloud Run with regional Firestore and Secret Manager in `us-east1`. The v0.1.0 container passed hosted acceptance checks. Direct Cloud Run mappings for `dayriff.com` and `www.dayriff.com` are configured using the preview domain-mapping service. Both domains have valid managed HTTPS certificates; `www` redirects to the canonical apex.

## Runtime configuration

| Setting | Launch configuration |
| --- | --- |
| Service | `dayriff` |
| CPU / memory | 1 CPU / 512 MiB |
| Concurrency | 8 requests per instance |
| Minimum instances | 0 |
| Maximum instances | 1 at service and revision level |
| Billing / timeout | Request-based / 150 seconds |
| Application mode | `NODE_ENV=production`, `APP_MODE=live` |
| Listening interface | `HOST=0.0.0.0`; Cloud Run supplies `PORT` |
| Public origin | Exact canonical HTTPS origin in `APP_ORIGIN`, without a trailing slash |

The app’s planning deadline is 120 seconds. Set API/model settings from [`.env.example`](../.env.example) and app/provider caps from [operations](operations.md). Caps do not replace provider-side quotas or spending controls; billing alerts are not hard spending limits.

## Reproduce the deployment

1. Use a dedicated Google Cloud project and a dedicated runtime service account. Build the repository’s multi-stage Dockerfile after `npm ci`, `npm run check` and `npm run build`. Keep `.gcloudignore` and `.dockerignore` intact: environment files, private records, caches and test reports must not enter source uploads or the container. The runtime image runs as a non-root user.
2. Use a **regional Firestore Native Standard** database in `us-east1`, database `(default)`. Set `STORAGE_BACKEND=firestore`, `FIRESTORE_PROJECT_ID` to your project and `FIRESTORE_DATABASE_ID=(default)`. Grant the runtime identity only its required database access; the browser has no database SDK or direct database permissions.
3. Enable TTL on collection group `dayriff_state`, field `expiresAt`, and disable indexes on `payload` and `expiresAt`. These settings are active for the launch database. App access enforces 30-day inactivity expiry even before asynchronous TTL cleanup. Clear trip deletes its active record immediately.
4. Store Qloo, OpenAI and a stable 32+ character cookie secret in Secret Manager. Grant the runtime identity access only to the selected secrets and pin deployed versions; the initial launch uses version `1`. Keep `COOKIE_SECRET` stable through redeployments. Google Routes is optional. No secret belongs in source, build arguments, container layers or ordinary checked-in environment settings.
5. Deploy the container with the runtime settings above. Use its exact public HTTPS origin for `APP_ORIGIN`, then update it to the final canonical custom domain after DNS/TLS verification. The production app rejects ephemeral storage rather than falling back to memory.
6. Keep source and build-log buckets private, with a seven-day object lifecycle. Maintain access restrictions on provider caches and stored trip data. Logs should omit bodies, cookies and credentials.
7. Verify HTTPS, live creation/revisions, reload and restart recovery, earlier versions, sharing, smaller-city coverage and clear-trip behavior. Confirm database TTL, restricted runtime identity and quota failures. Record actual hosted results in [validation](validation.md) before tagging/publishing the release.

The current flow needs Cloud Run, Firestore, Secret Manager and the build pipeline; no database server, queue, scheduled cleanup job or always-on worker is required. Zero minimum instances keeps idle runtime costs down. Direct domain mapping avoids a load balancer, but remains a preview service with its own limitations.

Event keys must remain usable through judging. A public `sample` preview must retain sample labeling and must not be presented as a live Qloo integration.
