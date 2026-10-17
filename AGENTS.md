# Working on Dayriff

Keep the product small, complete, and fast. Use the existing shared contracts and central style tokens. Put provider access in server/providers, scheduling and planning in server/services, and reusable UI in client/components. Add a dependency only when it removes meaningful implementation risk or complexity.

Credentials, provider payload caches, and session data are server-only and must never enter Git or client bundles. Sample mode is explicitly illustrative; live failures must never silently become sample recommendations. Optional arrival time and budget remain absent until supplied. Verify plan IDs, place IDs, and feasibility on the server.

Run type checking, focused boundary tests, and a production build before delivery. Prefer tests for constraints, access boundaries, and failure handling over snapshots or implementation-mirroring UI tests. Inspect the rendered app on mobile and desktop after visual changes. Avoid repeated CSS overrides; change the owning component or shared token.
