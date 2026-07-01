---
"executor": patch
---

Batch the SDK invoke path with DataLoader semantics. Concurrent `execute` calls
in the same microtask window now share one storage query per table (tool,
connection, integration) and one policy-rule-set snapshot instead of four point
queries per call, so naive fan-out code (`Promise.all` over tool calls, code
mode loops, parallel MCP tool calls) no longer produces N+1 query storms.
Sequential calls are unchanged, and transactional reads bypass the batch window
so transaction isolation is preserved.
