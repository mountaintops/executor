import { Effect } from "effect";

import { BindingError, type ClientResolver } from "../plugin/bindings";

// ---------------------------------------------------------------------------
// A ClientResolver that maps the daily-brief github client methods to real
// GitHub REST calls against a base URL (the emulate GitHub emulator in the
// e2e). This stands in for the platform invoke path: in production the resolver
// routes through the catalog (credentials injected platform-side, policy/audit
// applied); here it makes the real authenticated HTTP call with the bound
// connection's token. Everything crossing is JSON.
// ---------------------------------------------------------------------------

export interface GithubResolverOptions {
  readonly baseUrl: string;
  /** Bearer token per connection name. */
  readonly tokens: Readonly<Record<string, string>>;
}

export const makeGithubRestResolver = (options: GithubResolverOptions): ClientResolver => {
  const call = async (
    connection: string,
    path: readonly string[],
    args: readonly unknown[],
  ): Promise<unknown> => {
    const token = options.tokens[connection];
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "content-type": "application/json",
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const method = path.join(".");
    const input = (args[0] ?? {}) as Record<string, unknown>;

    if (method === "repos.listForAuthenticatedUser") {
      const perPage = input.per_page ?? 100;
      const res = await fetch(`${options.baseUrl}/user/repos?per_page=${perPage}`, { headers });
      return (await res.json()) as Array<{ full_name: string }>;
    }
    if (method === "issues.listForRepo") {
      const owner = String(input.owner);
      const repo = String(input.repo);
      const state = String(input.state ?? "open");
      const perPage = input.per_page ?? 100;
      const since = input.since ? `&since=${encodeURIComponent(String(input.since))}` : "";
      const res = await fetch(
        `${options.baseUrl}/repos/${owner}/${repo}/issues?state=${state}&per_page=${perPage}${since}`,
        { headers },
      );
      const issues = (await res.json()) as Array<Record<string, unknown>>;
      // Normalize to the shape the tool expects.
      return issues.map((i) => ({
        number: i.number,
        title: i.title,
        labels: Array.isArray(i.labels)
          ? (i.labels as Array<{ name?: string } | string>).map((l) =>
              typeof l === "string" ? { name: l } : { name: l.name ?? "" },
            )
          : [],
        assignee: i.assignee ?? null,
        updated_at: i.updated_at,
        html_url: i.html_url,
        pull_request: i.pull_request,
      }));
    }
    throw new Error(`unsupported github method: ${method}`);
  };

  return {
    call: ({ connection, path, args }) =>
      Effect.tryPromise({
        try: () => call(connection, path, args),
        catch: (cause) =>
          new BindingError({
            message: cause instanceof Error ? cause.message : String(cause),
            role: "github",
            surface: "github",
          }),
      }),
  };
};
