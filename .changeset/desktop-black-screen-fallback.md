---
"executor": patch
---

Fix desktop startup so a failed supervised-daemon replacement no longer leaves
the app on a black window. The desktop now re-checks the daemon after install
failures, falls back to a managed sidecar when the stale daemon disappears, and
surfaces startup recovery instead of leaving a failed renderer visible.
