export const DAILY_BRIEF_MANIFEST = `{
  "$schema": "https://executor.sh/schemas/scope-manifest.json",
  "scope": "rhys",
  "description": "Personal scope artifacts, GitHub issues brief.",
  "artifacts": { "tools": "tools/" }
}
`;

export const ISSUES_SYNC_TS = `import { z } from "zod";
import { defineTool, integration } from "executor:app";

export default defineTool({
  description:
    "Summarize open GitHub issues across the given repos (default: every repo the connection can see).",
  integrations: {
    github: integration("github"),
  },
  input: z.object({
    repos: z.array(z.string()).optional().describe("owner/repo entries; omit to sync all accessible repos"),
    since: z.string().optional().describe("ISO timestamp, only issues updated after this"),
  }),
  output: z.object({ synced: z.number(), repos: z.number(), issues: z.array(z.object({ repo: z.string(), number: z.number(), title: z.string() })) }),
  annotations: { readOnly: false, destructive: false },
  async handler({ repos, since }, { github }) {
    const targets =
      repos ??
      (await github.repos.listForAuthenticatedUser({ per_page: 100 })).map((r) => r.full_name);

    let synced = 0;
    const collected = [];
    for (const target of targets) {
      const [owner, repo] = target.split("/");
      const issues = await github.issues.listForRepo({ owner, repo, state: "open", since, per_page: 100 });
      for (const issue of issues) {
        if (issue.pull_request) continue;
        collected.push({ repo: target, number: issue.number, title: issue.title });
        synced++;
      }
    }
    return { synced, repos: targets.length, issues: collected };
  },
});
`;

export const SEARCH_ALL_MAIL_TS = `import { z } from "zod";
import { defineTool, integration } from "executor:app";

export default defineTool({
  description:
    "Search a connected Gmail account. Returns matches newest-first.",
  integrations: {
    inbox: integration("gmail"),
  },
  input: z.object({
    query: z.string().describe("Gmail search syntax, e.g. from:acme subject:invoice"),
    limit: z.number().int().min(1).max(100).default(25),
  }),
  output: z.object({
    results: z.array(z.object({
      inbox: z.string(), id: z.string(), from: z.string(),
      subject: z.string(), snippet: z.string(), date: z.string(),
    })),
  }),
  annotations: { readOnly: true },
  async handler({ query, limit }, { inbox }) {
    const { messages } = await inbox.messages.search({ q: query, maxResults: limit });
    const results = messages.map((m) => ({
      inbox: inbox.account.email, id: m.id, from: m.from,
      subject: m.subject, snippet: m.snippet, date: m.date,
    })).sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
    return { results };
  },
});
`;

export const dailyBriefFileSet = (): Map<string, string> =>
  new Map<string, string>([
    ["executor.json", DAILY_BRIEF_MANIFEST],
    ["tools/issues-sync.ts", ISSUES_SYNC_TS],
    ["tools/search-all-mail.ts", SEARCH_ALL_MAIL_TS],
  ]);
