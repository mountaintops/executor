---
"executor": patch
---

Self-hosted MCP connections now require explicit approval. When an MCP client
connects, the browser stops on an approval screen showing the connecting
client's name, what it can access, and that the grant is limited to the MCP
server (not a web-app login, and it can't make other API calls on your behalf);
a token is granted only after you Approve. Previously a signed-in user's client
was authorized automatically with no prompt.
