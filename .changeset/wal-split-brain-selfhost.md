---
"@executor-js/host-selfhost": patch
---

Fix self-hosted data loss on restart. The auth bootstrap built a throwaway
Better Auth instance to run migrations and seed the org before the
organization id was known, then discarded it. Its libSQL connection — a
different native build than the executor's — was garbage-collected mid-boot,
and that close unlinked the shared SQLite WAL out from under the executor's
still-open connection. Every executor write (integrations, connections, the
generated tools) then landed in a deleted WAL file and vanished on the next
restart, surfacing as a reconnected account whose tools had silently
disappeared.

The bootstrap now uses a single long-lived auth instance with the
organization id late-bound, so there is no second connection to be closed
mid-boot and no split WAL.
