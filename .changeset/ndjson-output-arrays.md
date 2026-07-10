---
"@executor-js/plugin-openapi": patch
---

Advertise NDJSON operation outputs as arrays. Endpoints declaring `application/stream+json`, `application/x-ndjson`, or `application/jsonl` responses (for example Vercel's runtime-logs) spec the schema of one line, but invocations return an array of parsed lines; describe previews now wrap the line schema in an array so generated code matches what actually comes back. Existing integrations with NDJSON operations are stale-marked once so their tool catalogs rebuild with the corrected schemas.
