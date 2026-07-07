---
"@executor-js/sdk": patch
---

`connections.create` now fails with `ConnectionAlreadyExistsError` (HTTP 409) when a connection with the same owner, integration, and name already exists, instead of silently overwriting the existing connection and its stored credential. Remove the existing connection first or pick a different name. OAuth reconnects are unaffected: they intentionally re-mint the same connection.
