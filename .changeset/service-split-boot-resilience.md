---
"@executor-js/plugin-provider-service-split": patch
"executor": patch
---

The provider service split boot migration now skips an org whose Google or Microsoft integration cannot be migrated (for example a config without a stored specHash) instead of failing the whole migration and blocking server startup. A daemon that does fail during boot now exits with the underlying error message instead of hanging with a generic "Unknown error".
