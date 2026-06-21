---
"executor": patch
---

Replace the code-mode output helpers with a single `emit(value)` primitive.
`emit(...)` accepts plain values, `ToolFile` attachments, and MCP content blocks,
while `return` remains reserved for ordinary structured data.
