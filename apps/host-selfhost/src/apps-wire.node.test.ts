import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, expect, test } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { createEmulator, type Emulator } from "@executor-js/emulate";
import { createClient } from "@libsql/client";

const dataDir = mkdtempSync(join(tmpdir(), "eh-apps-wire-"));
const dbPath = join(dataDir, "data.db");
process.env.EXECUTOR_DATA_DIR = dataDir;
process.env.EXECUTOR_SECRET_KEY = "apps-wire-secret-key";
process.env.EXECUTOR_ALLOW_LOCAL_NETWORK = "true";

const TEST_USER = "apps-user";
const TEST_ORG = "apps-org";
const OWNER = "syncer";
const REPO = "custom-tools";
const REPO_FULL_NAME = `${OWNER}/${REPO}`;
const GITHUB_CONNECTION = "tools.github.user.main";
const APP_SLUG = "custom-tools-app";
const SCHEMA_APP_SLUG = "schema-tools-app";
const APPROVAL_APP_SLUG = "approval-tools-app";

interface TestHttpServer {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

interface SyncResult {
  readonly status: "published" | "up-to-date" | "failed";
  readonly snapshotId?: string;
  readonly upstreamSha?: string;
  readonly tools: readonly string[];
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
  readonly errors?: readonly { readonly message?: string }[];
}

interface ToolRow {
  readonly address: string;
  readonly name: string;
  readonly integration: string;
}

interface ConnectionRow {
  readonly address: string;
}

interface IntegrationRow {
  readonly slug: string;
  readonly name: string;
  readonly kind: string;
  readonly canRemove: boolean;
  readonly displayUrl?: string;
}

interface ExecuteResponse {
  readonly status: "completed" | "paused";
  readonly text: string;
  readonly structured: {
    readonly status?: string;
    readonly result?: unknown;
    readonly error?: unknown;
  };
  readonly isError?: boolean;
}

const bearerTemplate = {
  slug: "bearer",
  type: "apiKey",
  label: "Bearer token",
  headers: { Authorization: ["Bearer ", { type: "variable", name: "token" }] },
};

const jsonHeaders = {
  "content-type": "application/json",
  "x-test-user": TEST_USER,
  "x-test-org": TEST_ORG,
};

const decodeJsonText = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

const parseJsonText = async <T>(text: string): Promise<T> => {
  if (text.length === 0) return null as T;
  const value = await Effect.runPromise(decodeJsonText(text));
  return value as T;
};

const findFreePort = (): Promise<number> =>
  Effect.runPromise(
    Effect.callback<number, string>((resume) => {
      const probe = createNetServer();
      probe.once("error", () => resume(Effect.fail("failed to find a free port")));
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        const port = typeof address === "object" && address ? address.port : 0;
        probe.close((error) =>
          error
            ? resume(Effect.fail("failed to close free-port probe"))
            : resume(Effect.succeed(port)),
        );
      });
    }),
  );

const readRequestBody = async (request: IncomingMessage): Promise<Buffer | undefined> => {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks);
  return body.length > 0 ? body : undefined;
};

const webRequestFromNode = async (request: IncomingMessage, port: number): Promise<Request> => {
  const headers = new Headers();
  for (const [name, raw] of Object.entries(request.headers)) {
    if (Array.isArray(raw)) {
      for (const value of raw) headers.append(name, value);
    } else if (raw !== undefined) {
      headers.set(name, raw);
    }
  }
  const body = await readRequestBody(request);
  return new Request(`http://127.0.0.1:${port}${request.url ?? "/"}`, {
    method: request.method,
    headers,
    body: body ? new Uint8Array(body) : undefined,
  });
};

const sendWebResponse = async (webResponse: Response, response: ServerResponse): Promise<void> => {
  response.statusCode = webResponse.status;
  webResponse.headers.forEach((value, name) => response.setHeader(name, value));
  response.end(Buffer.from(await webResponse.arrayBuffer()));
};

const startHttpServer = async (
  handler: (request: Request) => Promise<Response>,
): Promise<TestHttpServer> => {
  let port = 0;
  const server = createServer((request, response) => {
    void Effect.runPromise(
      Effect.tryPromise({
        try: async () => {
          await sendWebResponse(await handler(await webRequestFromNode(request, port)), response);
        },
        catch: () => "request failed",
      }).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            response.statusCode = 500;
            response.end("request failed");
          }),
        ),
      ),
    );
  });
  await Effect.runPromise(
    Effect.callback<void, string>((resume) => {
      server.once("error", () => resume(Effect.fail("failed to start test server")));
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        port = typeof address === "object" && address ? address.port : 0;
        resume(Effect.void);
      });
    }),
  );
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      Effect.runPromise(
        Effect.callback<void, string>((resume) => {
          server.close((error) =>
            error ? resume(Effect.fail("failed to close test server")) : resume(Effect.void),
          );
        }),
      ),
  };
};

const requestJson = async <T>(
  path: string,
  init: RequestInit = {},
  expectedStatus = 200,
): Promise<T> => {
  const response = await fetch(`${server.baseUrl}${path}`, init);
  const text = await response.text();
  expect(response.status).toBe(expectedStatus);
  return parseJsonText<T>(text);
};

const postJson = <T>(path: string, body: unknown, expectedStatus = 200): Promise<T> =>
  requestJson<T>(
    path,
    {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify(body),
    },
    expectedStatus,
  );

const deleteJson = <T>(path: string, expectedStatus = 200): Promise<T> =>
  requestJson<T>(
    path,
    {
      method: "DELETE",
      headers: jsonHeaders,
    },
    expectedStatus,
  );

const querySqliteRows = async (
  path: string,
  sql: string,
  args: readonly unknown[] = [],
): Promise<readonly Record<string, unknown>[]> => {
  const client = createClient({ url: `file:${path}` });
  const result = await client.execute({ sql, args: [...args] as never });
  client.close();
  return result.rows.map((row) => ({ ...row }));
};

const sourceStorageKey = (scope: string): string =>
  `v2-${Buffer.from(JSON.stringify([TEST_ORG, scope]), "utf8").toString("hex")}`;

const sourceTokenItemId = (scope: string): string =>
  `apps:github-source:${TEST_ORG}:${scope}:token`;

const DbJsonObject = Schema.Record(Schema.String, Schema.Unknown);
const DbJsonObjectFromString = Schema.fromJsonString(DbJsonObject);
const decodeDbJsonObject = Schema.decodeUnknownOption(DbJsonObject);
const decodeDbJsonObjectFromString = Schema.decodeUnknownOption(DbJsonObjectFromString);

const decodeDbJson = (value: unknown): Record<string, unknown> => {
  if (value instanceof ArrayBuffer) {
    return decodeDbJson(Buffer.from(value).toString("utf8"));
  }
  if (typeof value === "string") {
    return Option.getOrElse(decodeDbJsonObjectFromString(value), () => ({}));
  }
  return Option.getOrElse(decodeDbJsonObject(value), () => ({}));
};

const githubFetch = async <T>(
  emulator: Emulator,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> => {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("accept", "application/vnd.github+json");
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(`${emulator.url}${path}`, { ...init, headers });
  const text = await response.text();
  expect(response.ok).toBe(true);
  return parseJsonText<T>(text);
};

const createIssue = (
  emulator: Emulator,
  token: string,
  title: string,
  repo = REPO,
): Promise<unknown> =>
  githubFetch(emulator, token, `/repos/${OWNER}/${repo}/issues`, {
    method: "POST",
    body: JSON.stringify({ title }),
  });

const putRepoFiles = async (
  emulator: Emulator,
  token: string,
  files: Readonly<Record<string, string>>,
  repo = REPO,
): Promise<string> => {
  const ref = await githubFetch<{ object: { sha: string } }>(
    emulator,
    token,
    `/repos/${OWNER}/${repo}/git/ref/heads/main`,
  );
  const parentSha = ref.object.sha;
  const tree = await githubFetch<{ sha: string }>(
    emulator,
    token,
    `/repos/${OWNER}/${repo}/git/trees`,
    {
      method: "POST",
      body: JSON.stringify({
        tree: Object.entries(files).map(([path, content]) => ({
          path,
          mode: "100644",
          type: "blob",
          content,
        })),
      }),
    },
  );
  const commit = await githubFetch<{ sha: string }>(
    emulator,
    token,
    `/repos/${OWNER}/${repo}/git/commits`,
    {
      method: "POST",
      body: JSON.stringify({
        message: `Update custom tools ${randomBytes(3).toString("hex")}`,
        tree: tree.sha,
        parents: [parentSha],
      }),
    },
  );
  await githubFetch(emulator, token, `/repos/${OWNER}/${repo}/git/refs/heads/main`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha }),
  });
  return commit.sha;
};

const executorJson = JSON.stringify(
  {
    $schema: "https://executor.sh/schemas/executor.json",
    description: "Curated tools wrapping our raw integration surface.",
  },
  null,
  2,
);

const dealPipelineSyncSource = `import { z } from "zod";
import { defineTool, integration } from "executor:app";

/**
 * The deterministic-program case: pull GitHub issues into the scope database
 * so agents query a table instead of paging the raw API.
 */
export default defineTool({
  description:
    "Refresh the deals table from GitHub issues. Syncs issue numbers and titles " +
    "for pipeline questions.",

  integrations: {
    github: integration("github"),
  },

  input: z.object({
    owner: z.string(),
    repo: z.string(),
  }),

  output: z.object({ synced: z.number() }),

  annotations: { readOnly: false, destructive: false },

  async handler({ owner, repo }, { github, db }) {
    await db.sql\`
      CREATE TABLE IF NOT EXISTS deals (
        id    TEXT PRIMARY KEY,
        name  TEXT NOT NULL,
        stage TEXT NOT NULL
      )\`;

    const issues = await github.repos.listIssues({ owner, repo });

    let synced = 0;
    for (const issue of issues) {
      await db.sql\`
        INSERT INTO deals (id, name, stage)
        VALUES (\${String(issue.number)}, \${issue.title}, 'open')
        ON CONFLICT (id) DO UPDATE SET
          name = excluded.name,
          stage = excluded.stage\`;
      synced++;
    }

    return { synced };
  },
});
`;

const findDealDocsSource = `import { z } from "zod";
import { defineTool, integration } from "executor:app";

/**
 * The curation case: a read-only query over the scope database populated by
 * the sync tool.
 */
export default defineTool({
  description:
    "Find documents for a deal across synced pipeline records. Searches " +
    "stored issue titles.",

  integrations: {
    github: integration("github"),
  },

  input: z.object({
    limit: z.number().int().max(50).default(20),
  }),

  output: z.object({
    documents: z.array(
      z.object({
        name: z.string(),
        stage: z.string(),
      }),
    ),
  }),

  annotations: { readOnly: true, destructive: false },

  async handler({ limit }, { db }) {
    await db.sql\`
      CREATE TABLE IF NOT EXISTS deals (
        id    TEXT PRIMARY KEY,
        name  TEXT NOT NULL,
        stage TEXT NOT NULL
      )\`;
    const rows = await db.sql\`
      SELECT name, stage FROM deals ORDER BY id LIMIT \${limit}\`;

    return {
      documents: rows.map((row) => ({
        name: String(row.name),
        stage: String(row.stage),
      })),
    };
  },
});
`;

const extraToolSource = `import { z } from "zod";
import { defineTool } from "executor:app";

export default defineTool({
  description: "Return a static custom-tools health marker.",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  annotations: { readOnly: true, destructive: false },
  async handler() {
    return { ok: true };
  },
});
`;

const approvalBridgeSource = `import { z } from "zod";
import { defineTool, integration } from "executor:app";

export default defineTool({
  description: "List issues through a bridged GitHub client.",
  integrations: {
    github: integration("github"),
  },
  input: z.object({
    owner: z.string(),
    repo: z.string(),
  }),
  output: z.object({ count: z.number() }),
  annotations: { readOnly: true, destructive: false },
  async handler({ owner, repo }, { github }) {
    const issues = await github.repos.listIssues({ owner, repo });
    return { count: issues.length };
  },
});
`;

const initialFiles = (): Record<string, string> => ({
  "executor.json": executorJson,
  "tools/deal-pipeline-sync.ts": dealPipelineSyncSource,
  "tools/find-deal-docs.ts": findDealDocsSource,
});

const approvalFiles = (): Record<string, string> => ({
  "executor.json": executorJson,
  "tools/approval-bridge.ts": approvalBridgeSource,
});

const registerGitHubSpec = async (emulator: Emulator): Promise<void> => {
  const specResponse = await fetch(`${server.baseUrl}/api/openapi/specs`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      spec: { kind: "url", url: emulator.openapiUrl },
      slug: "github",
      baseUrl: emulator.url,
      authenticationTemplate: [bearerTemplate],
    }),
  });
  expect([200, 409]).toContain(specResponse.status);
  await specResponse.text();
};

const createGitHubConnection = async (token: string): Promise<string> => {
  const existing = await requestJson<readonly ConnectionRow[]>(
    "/api/connections?integration=github",
    {
      headers: jsonHeaders,
    },
  );
  if (existing.some((connection) => connection.address === GITHUB_CONNECTION)) {
    return GITHUB_CONNECTION;
  }
  const created = await postJson<{ address: string }>("/api/connections", {
    owner: "user",
    name: "main",
    integration: "github",
    template: "bearer",
    value: token,
  });
  expect(created.address).toBe(GITHUB_CONNECTION);
  return created.address;
};

const registerGitHubIntegration = async (emulator: Emulator, token: string): Promise<void> => {
  await registerGitHubSpec(emulator);
  await createGitHubConnection(token);
};

const sourceUrl = (repo = REPO_FULL_NAME): string => `https://github.com/${repo}`;

const addSource = (
  input: { readonly name?: string; readonly repo?: string; readonly token?: string } = {},
): Promise<SyncResult> =>
  postJson<SyncResult>("/api/apps/sources/github/sync", {
    name: input.name ?? APP_SLUG,
    url: sourceUrl(input.repo),
    ...(input.token ? { token: input.token } : {}),
  });

const syncSource = (
  input: { readonly name?: string; readonly token?: string } = {},
): Promise<SyncResult> =>
  postJson<SyncResult>("/api/apps/sources/github/sync", {
    slug: input.name ?? APP_SLUG,
    ...(input.token ? { token: input.token } : {}),
  });

const listAppTools = (app = APP_SLUG): Promise<readonly ToolRow[]> =>
  requestJson<readonly ToolRow[]>(`/api/tools?integration=${encodeURIComponent(app)}`, {
    headers: jsonHeaders,
  });

const getSource = (
  app: string,
): Promise<{ readonly source: { readonly slug: string; readonly name: string } | null }> =>
  requestJson(`/api/apps/sources/github/${encodeURIComponent(app)}`, { headers: jsonHeaders });

const removeSource = (app: string): Promise<{ readonly removed: boolean }> =>
  deleteJson(`/api/apps/sources/github/${encodeURIComponent(app)}`);

const execute = (code: string): Promise<ExecuteResponse> =>
  postJson<ExecuteResponse>("/api/executions", { code, autoApprove: true });

const executeWithApprovalPause = (code: string): Promise<ExecuteResponse> =>
  postJson<ExecuteResponse>("/api/executions", { code });

const executeResult = async (code: string): Promise<unknown> => {
  const response = await execute(code);
  expect(response.status).toBe("completed");
  expect(response.isError).toBe(false);
  return response.structured.result;
};

const callAppToolCode = (toolName: string, args: unknown, namespace = APP_SLUG): string => `
const found = await tools.search({ namespace: ${JSON.stringify(namespace)}, query: ${JSON.stringify(toolName)}, limit: 20 });
const item = found.items.find((candidate) => candidate.path.endsWith(${JSON.stringify(toolName)}));
if (!item) return { ok: false, missing: ${JSON.stringify(toolName)}, found };
let fn = tools;
for (const segment of item.path.split(".")) fn = fn[segment];
const result = await fn(${JSON.stringify(args)});
return { path: item.path, result };
`;

let github!: Emulator;
let server!: TestHttpServer;
let disposeApp: () => Promise<void> = async () => {};

beforeAll(async () => {
  const emulatorPort = await findFreePort();
  github = await createEmulator({
    service: "github",
    port: emulatorPort,
    seed: {
      github: {
        users: [{ login: OWNER, name: "Syncer" }],
        repos: [{ owner: OWNER, name: REPO, auto_init: true }],
      },
    },
  });
  const { makeSelfHostTestApp, headerIdentityLayer } = await import("./testing/test-app");
  const app = await makeSelfHostTestApp({ identity: headerIdentityLayer, dbPath });
  disposeApp = app.dispose;
  server = await startHttpServer(app.handler);
});

afterAll(async () => {
  await server?.close();
  await disposeApp();
  await github?.close();
});

test("custom tool connection schema updates when connections change after sync", async () => {
  const credential = await github.credentials.mint({
    type: "api-key",
    login: OWNER,
    scopes: ["repo", "user"],
  });
  const token = credential.token;
  expect(token).toBeTruthy();
  await registerGitHubSpec(github);
  const initialConnections = await requestJson<readonly ConnectionRow[]>(
    "/api/connections?integration=github",
    { headers: jsonHeaders },
  );
  expect(initialConnections).toEqual([]);
  await putRepoFiles(github, token!, initialFiles());

  const published = await addSource({ name: SCHEMA_APP_SLUG });
  expect(published.status).toBe("published");

  const listed = await listAppTools(SCHEMA_APP_SLUG);
  const dealSync = listed.find((tool) => tool.name === "deal-pipeline-sync");
  expect(dealSync).toBeTruthy();
  const beforeConnection = await requestJson<{
    inputSchema: { properties?: Record<string, unknown>; required?: readonly string[] };
  }>(`/api/tools/schema?address=${encodeURIComponent(dealSync!.address)}`, {
    headers: jsonHeaders,
  });
  expect(beforeConnection.inputSchema.properties?.github).toMatchObject({
    type: "string",
    enum: [],
  });
  expect(beforeConnection.inputSchema.required ?? []).toContain("github");

  await createGitHubConnection(token!);
  const afterConnection = await requestJson<{
    inputSchema: { properties?: Record<string, unknown>; required?: readonly string[] };
  }>(`/api/tools/schema?address=${encodeURIComponent(dealSync!.address)}`, {
    headers: jsonHeaders,
  });
  expect(afterConnection.inputSchema.properties?.github).toMatchObject({
    type: "string",
    enum: [GITHUB_CONNECTION],
    default: GITHUB_CONNECTION,
  });
  expect(afterConnection.inputSchema.required ?? []).not.toContain("github");

  const defaultInvoke = (await executeResult(
    callAppToolCode(
      "deal-pipeline-sync",
      {
        owner: OWNER,
        repo: REPO,
      },
      SCHEMA_APP_SLUG,
    ),
  )) as { result?: { ok?: boolean; data?: { synced?: number }; error?: unknown } };
  expect(defaultInvoke.result?.ok).toBe(true);
  expect(defaultInvoke.result?.data?.synced).toBe(0);
});

test("GitHub source sync publishes and invokes custom tools through self-host HTTP", async () => {
  const credential = await github.credentials.mint({
    type: "api-key",
    login: OWNER,
    scopes: ["repo", "user"],
  });
  const token = credential.token;
  expect(token).toBeTruthy();
  await registerGitHubIntegration(github, token!);
  await createIssue(github, token!, "Acme renewal diligence");
  await createIssue(github, token!, "Beta pipeline memo");
  await putRepoFiles(github, token!, initialFiles());

  const unauthorized = await fetch(`${server.baseUrl}/api/apps/sources/github/sync`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: sourceUrl(), token }),
  });
  expect(unauthorized.status).toBe(401);

  const published = await addSource({ name: APP_SLUG, token: token! });
  expect(published.status).toBe("published");
  expect(JSON.stringify(published)).not.toContain(token!);
  expect(published.tools).toEqual(["deal-pipeline-sync", "find-deal-docs"]);
  expect(published.skipped).toEqual([]);
  const firstSnapshot = published.snapshotId;
  expect(firstSnapshot).toBeTruthy();

  const tokenUpToDate = await syncSource({ token: token! });
  expect(tokenUpToDate.status).toBe("up-to-date");
  expect(JSON.stringify(tokenUpToDate)).not.toContain(token!);

  const sourcesList = await requestJson<{
    sources: readonly { readonly slug: string; readonly hasToken: boolean }[];
  }>("/api/apps/sources/github", { headers: jsonHeaders });
  expect(sourcesList.sources.find((source) => source.slug === APP_SLUG)?.hasToken).toBe(true);
  expect(JSON.stringify(sourcesList)).not.toContain(token!);

  const listed = await listAppTools();
  expect(listed.map((tool) => tool.name).sort()).toEqual(["deal-pipeline-sync", "find-deal-docs"]);

  const searchResult = await executeResult(
    `const found = await tools.search({ namespace: ${JSON.stringify(APP_SLUG)}, query: "pipeline", limit: 10 }); return found.items.map((item) => item.path);`,
  );
  expect(JSON.stringify(searchResult)).toContain("deal-pipeline-sync");

  const schema = await requestJson<{
    inputSchema: { properties?: Record<string, unknown>; required?: readonly string[] };
  }>(
    `/api/tools/schema?address=${encodeURIComponent(listed.find((tool) => tool.name === "deal-pipeline-sync")!.address)}`,
    { headers: jsonHeaders },
  );
  expect(schema.inputSchema.properties?.github).toMatchObject({
    type: "string",
    enum: [GITHUB_CONNECTION],
    default: GITHUB_CONNECTION,
  });
  expect(schema.inputSchema.required ?? []).not.toContain("github");

  const defaultInvoke = (await executeResult(
    callAppToolCode("deal-pipeline-sync", {
      owner: OWNER,
      repo: REPO,
    }),
  )) as { result?: { ok?: boolean; data?: { synced?: number }; error?: unknown } };
  expect(defaultInvoke.result?.ok).toBe(true);
  expect(defaultInvoke.result?.data?.synced).toBe(2);

  const bareNameInvoke = await execute(
    callAppToolCode("deal-pipeline-sync", {
      github: "main",
      owner: OWNER,
      repo: REPO,
    }),
  );
  const bareNameStructured = bareNameInvoke.structured.result as {
    readonly result?: { readonly error?: { readonly message?: string } };
  };
  expect(bareNameInvoke.status).toBe("completed");
  expect(bareNameStructured.result?.error?.message).toContain(
    'unknown connection "main" for role "github" (github)',
  );
  expect(bareNameStructured.result?.error?.message).toContain(GITHUB_CONNECTION);

  const invoke = (await executeResult(
    callAppToolCode("deal-pipeline-sync", {
      github: GITHUB_CONNECTION,
      owner: OWNER,
      repo: REPO,
    }),
  )) as { result?: { ok?: boolean; data?: { synced?: number }; error?: unknown } };
  expect(invoke.result?.ok).toBe(true);
  expect(invoke.result?.data?.synced).toBe(2);

  const bogusConnection = await execute(
    callAppToolCode("deal-pipeline-sync", {
      github: "garbage",
      owner: OWNER,
      repo: REPO,
    }),
  );
  const bogusBody = JSON.stringify(bogusConnection);
  const bogusStructured = bogusConnection.structured.result as {
    readonly result?: { readonly error?: { readonly message?: string } };
  };
  expect(bogusConnection.status).toBe("completed");
  expect(bogusStructured.result?.error?.message).toContain(
    'unknown connection "garbage" for role "github" (github)',
  );
  expect(bogusBody).not.toContain("Internal tool error");

  const ledger = await github.ledger.list();
  const sourceFetches = ledger.filter((entry) => entry.path === `/repos/${OWNER}/${REPO}`);
  expect(sourceFetches.some((entry) => entry.identity.user?.login === OWNER)).toBe(true);
  expect(sourceFetches.some((entry) => !entry.identity.user)).toBe(true);
  const issueList = ledger.find(
    (entry) =>
      entry.operationId === "issues/listForRepo" && entry.path === `/repos/${OWNER}/${REPO}/issues`,
  );
  expect(issueList?.identity.user?.login).toBe(OWNER);

  const readDb = (await executeResult(callAppToolCode("find-deal-docs", { limit: 10 }))) as {
    result?: { ok?: boolean; data?: { documents?: readonly { name: string }[] } };
  };
  expect(readDb.result?.ok).toBe(true);
  expect(readDb.result?.data?.documents?.map((row) => row.name).sort()).toEqual([
    "Acme renewal diligence",
    "Beta pipeline memo",
  ]);

  const upToDate = await syncSource();
  expect(upToDate.status).toBe("up-to-date");
  expect("snapshotId" in upToDate).toBe(false);

  await putRepoFiles(github, token!, {
    ...initialFiles(),
    "tools/extra-tool.ts": extraToolSource,
  });
  const withExtra = await syncSource();
  expect(withExtra.status).toBe("published");
  expect(withExtra.snapshotId).not.toBe(firstSnapshot);
  expect((await listAppTools()).map((tool) => tool.name).sort()).toEqual([
    "deal-pipeline-sync",
    "extra-tool",
    "find-deal-docs",
  ]);

  await putRepoFiles(github, token!, initialFiles());
  const removed = await syncSource();
  expect(removed.status).toBe("published");
  expect((await listAppTools()).map((tool) => tool.name).sort()).toEqual([
    "deal-pipeline-sync",
    "find-deal-docs",
  ]);

  await putRepoFiles(github, token!, {
    ...initialFiles(),
    "workflows/x.ts": "export default {};",
  });
  const skipped = await syncSource();
  expect(skipped.status).toBe("published");
  expect(skipped.skipped).toEqual([{ path: "workflows/x.ts", reason: "not supported yet" }]);
  const afterSkipped = await listAppTools();
  expect(afterSkipped.map((tool) => tool.name).sort()).toEqual([
    "deal-pipeline-sync",
    "find-deal-docs",
  ]);
  expect(afterSkipped.some((tool) => tool.address.includes("workflow"))).toBe(false);
});

test("custom tools sources are per-integration and remove tears down owned state", async () => {
  const credential = await github.credentials.mint({
    type: "api-key",
    login: OWNER,
    scopes: ["repo", "user"],
  });
  const token = credential.token;
  expect(token).toBeTruthy();
  await registerGitHubIntegration(github, token!);
  await putRepoFiles(github, token!, initialFiles());

  const firstApp = "side-tools-a";
  const secondApp = "side-tools-b";
  const first = await addSource({ name: firstApp, token: token! });
  const second = await addSource({ name: secondApp, token: token! });
  expect(first.status).toBe("published");
  expect(second.status).toBe("published");

  const collision = await addSource({ name: firstApp, token: token! });
  expect(collision.status).toBe("failed");
  expect(collision.errors?.[0]?.message).toContain(
    `Integration "${firstApp}" already exists. Choose another name.`,
  );

  const integrations = await requestJson<readonly IntegrationRow[]>("/api/integrations", {
    headers: jsonHeaders,
  });
  expect(integrations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        slug: firstApp,
        name: firstApp,
        kind: "apps",
        canRemove: true,
        displayUrl: sourceUrl(),
      }),
      expect.objectContaining({
        slug: secondApp,
        name: secondApp,
        kind: "apps",
        canRemove: true,
        displayUrl: sourceUrl(),
      }),
    ]),
  );

  const configRows = await querySqliteRows(
    dbPath,
    "SELECT slug, plugin_id, config FROM integration WHERE slug IN (?, ?) ORDER BY slug",
    [firstApp, secondApp],
  );
  expect(configRows).toHaveLength(2);
  for (const row of configRows) {
    expect(row.plugin_id).toBe("apps");
    const config = decodeDbJson(row.config);
    expect(config).toMatchObject({
      kind: "github",
      repoUrl: sourceUrl(),
      repo: REPO_FULL_NAME,
      scope: row.slug,
    });
    expect(JSON.stringify(config)).not.toContain(token!);
  }

  expect((await listAppTools(firstApp)).map((tool) => tool.address).sort()).toEqual([
    `tools.${firstApp}.user.main.deal-pipeline-sync`,
    `tools.${firstApp}.user.main.find-deal-docs`,
  ]);
  expect((await listAppTools(secondApp)).map((tool) => tool.address).sort()).toEqual([
    `tools.${secondApp}.user.main.deal-pipeline-sync`,
    `tools.${secondApp}.user.main.find-deal-docs`,
  ]);

  const secondInvoke = (await executeResult(
    callAppToolCode(
      "deal-pipeline-sync",
      {
        owner: OWNER,
        repo: REPO,
      },
      secondApp,
    ),
  )) as { result?: { ok?: boolean; data?: { synced?: number }; error?: unknown } };
  expect(secondInvoke.result?.ok).toBe(true);

  const secondKey = sourceStorageKey(secondApp);
  const secondArtifactDir = join(dataDir, "apps", "artifacts", `${secondKey}.git`);
  const secondScopeDb = join(dataDir, "apps", "scope-db", `${secondKey}.db`);
  expect(existsSync(secondArtifactDir)).toBe(true);
  expect(existsSync(secondScopeDb)).toBe(true);

  const tokenRowsBefore = await querySqliteRows(
    dbPath,
    "SELECT key FROM plugin_storage WHERE plugin_id = ? AND collection = ? AND key = ?",
    ["encryptedSecrets", "secrets", sourceTokenItemId(secondApp)],
  );
  expect(tokenRowsBefore).toHaveLength(1);

  expect(await getSource(secondApp)).toMatchObject({
    source: { slug: secondApp, name: secondApp },
  });
  expect(await removeSource(secondApp)).toEqual({ removed: true });
  expect(await getSource(secondApp)).toEqual({ source: null });

  const secondIntegration = await fetch(
    `${server.baseUrl}/api/integrations/${encodeURIComponent(secondApp)}`,
    { headers: jsonHeaders },
  );
  expect(secondIntegration.status).toBe(404);
  await secondIntegration.text();

  expect(await listAppTools(secondApp)).toEqual([]);
  expect((await listAppTools(firstApp)).map((tool) => tool.address).sort()).toEqual([
    `tools.${firstApp}.user.main.deal-pipeline-sync`,
    `tools.${firstApp}.user.main.find-deal-docs`,
  ]);

  const descriptorRows = await querySqliteRows(
    join(dataDir, "apps", "store.sqlite"),
    "SELECT scope FROM descriptors WHERE tenant = ? AND scope = ?",
    [TEST_ORG, secondApp],
  );
  expect(descriptorRows).toEqual([]);
  const tokenRowsAfter = await querySqliteRows(
    dbPath,
    "SELECT key FROM plugin_storage WHERE plugin_id = ? AND collection = ? AND key = ?",
    ["encryptedSecrets", "secrets", sourceTokenItemId(secondApp)],
  );
  expect(tokenRowsAfter).toEqual([]);
  expect(existsSync(secondArtifactDir)).toBe(false);
  expect(existsSync(secondScopeDb)).toBe(false);
});

test("bridged integration calls inherit the caller approval handler", async () => {
  const credential = await github.credentials.mint({
    type: "api-key",
    login: OWNER,
    scopes: ["repo", "user"],
  });
  const token = credential.token;
  expect(token).toBeTruthy();
  await registerGitHubIntegration(github, token!);
  await createIssue(github, token!, "Approval-gated issue");
  await putRepoFiles(github, token!, approvalFiles());
  const published = await addSource({ name: APPROVAL_APP_SLUG, token: token! });
  expect(published.status).toBe("published");

  const githubTools = await requestJson<readonly ToolRow[]>("/api/tools?integration=github", {
    headers: jsonHeaders,
  });
  const listIssues = githubTools.find((tool) => tool.name === "repos.listIssues");
  expect(listIssues).toBeTruthy();
  await postJson("/api/policies", {
    owner: "org",
    pattern: listIssues!.address.replace(/^tools\./, ""),
    action: "require_approval",
  });

  const beforeLedger = await github.ledger.list();
  const beforeCalls = beforeLedger.filter(
    (entry) =>
      entry.operationId === "issues/listForRepo" && entry.path === `/repos/${OWNER}/${REPO}/issues`,
  ).length;

  const response = await executeWithApprovalPause(
    callAppToolCode(
      "approval-bridge",
      {
        github: GITHUB_CONNECTION,
        owner: OWNER,
        repo: REPO,
      },
      APPROVAL_APP_SLUG,
    ),
  );
  expect(response.status).toBe("paused");

  const afterLedger = await github.ledger.list();
  const afterCalls = afterLedger.filter(
    (entry) =>
      entry.operationId === "issues/listForRepo" && entry.path === `/repos/${OWNER}/${REPO}/issues`,
  ).length;
  expect(afterCalls).toBe(beforeCalls);
});
