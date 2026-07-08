import { Effect, Result, Schema } from "effect";

import { PublishError, enforcePublishLimits, type PublishFile } from "../pipeline/publish";
import { AppSourceError, type AppSourceSnapshot } from "./app-source";
import { classifyAppSourcePath, type SourceSkippedFile } from "./relevant-files";
import { parseGitHubSourceUrl, type ParsedGitHubSourceUrl } from "./github-url";

export interface GitHubAppSourceInput {
  readonly url: string;
  readonly ref?: string;
  readonly token?: string | null;
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export interface GitHubAppSourceSnapshot extends AppSourceSnapshot {
  readonly repo: string;
  readonly ref: string;
  readonly url: string;
  readonly skipped: readonly SourceSkippedFile[];
}

const REGULAR_FILE_MODES = new Set(["100644", "100755"]);
const textEncoder = new TextEncoder();

const trimBaseUrl = (baseUrl: string): string => baseUrl.replace(/\/+$/, "");

const encodedRepoPath = (source: ParsedGitHubSourceUrl): string =>
  `${encodeURIComponent(source.owner)}/${encodeURIComponent(source.name)}`;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const parseSourceInput = (
  input: GitHubAppSourceInput,
): Effect.Effect<ParsedGitHubSourceUrl, AppSourceError> => {
  const parsed = parseGitHubSourceUrl(input.url, { ref: input.ref });
  return parsed.ok
    ? Effect.succeed(parsed.value)
    : Effect.fail(new AppSourceError({ message: parsed.message, path: input.url }));
};

const requestJson = <A>(
  input: GitHubAppSourceInput,
  path: string,
): Effect.Effect<A, AppSourceError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: async () => {
        const fetchImpl = input.fetch ?? globalThis.fetch;
        const headers: Record<string, string> = {
          accept: "application/vnd.github+json",
          "user-agent": "executor-apps-github-source",
        };
        if (input.token) headers.authorization = `Bearer ${input.token}`;
        return fetchImpl(`${trimBaseUrl(input.baseUrl ?? "https://api.github.com")}${path}`, {
          headers,
        });
      },
      catch: (cause) =>
        new AppSourceError({
          message: `GitHub request failed: GET ${path}`,
          path,
          cause,
        }),
    });
    if (!response.ok) {
      return yield* new AppSourceError({
        message: `GitHub request failed: GET ${path} -> ${response.status}`,
        status: response.status,
        path,
      });
    }
    return yield* Effect.tryPromise({
      try: () => response.json() as Promise<A>,
      catch: (cause) =>
        new AppSourceError({
          message: `GitHub response was not valid JSON: GET ${path}`,
          path,
          cause,
        }),
    });
  });

interface RepoResponse {
  readonly default_branch?: unknown;
}

interface CommitResponse {
  readonly sha?: unknown;
  readonly commit?: { readonly tree?: { readonly sha?: unknown } };
}

interface GitCommitResponse {
  readonly sha?: unknown;
  readonly tree?: { readonly sha?: unknown };
}

interface RefResponse {
  readonly object?: { readonly sha?: unknown };
}

interface TreeEntry {
  readonly path?: unknown;
  readonly type?: unknown;
  readonly mode?: unknown;
  readonly sha?: unknown;
  readonly size?: unknown;
}

interface TreeResponse {
  readonly tree?: readonly TreeEntry[];
  readonly truncated?: unknown;
}

interface BlobResponse {
  readonly content?: unknown;
  readonly encoding?: unknown;
}

const commitTreeSha = (commit: CommitResponse | GitCommitResponse): string | undefined => {
  if ("commit" in commit) return asString(commit.commit?.tree?.sha);
  if ("tree" in commit) return asString(commit.tree?.sha);
  return undefined;
};

const treeLimitError = (entries: readonly TreeEntry[]): PublishError | null => {
  const files: PublishFile[] = [];
  for (const entry of entries) {
    const path = String(entry.path ?? "");
    const size = typeof entry.size === "number" ? entry.size : 0;
    files.push({ path, bytes: new Uint8Array(size) });
  }
  return enforcePublishLimits(files);
};

const classifyTreeEntry = (
  entry: TreeEntry,
):
  | {
      readonly kind: "fetch";
      readonly entry: TreeEntry & { readonly path: string; readonly sha: string };
    }
  | { readonly kind: "skip"; readonly skipped: SourceSkippedFile }
  | null => {
  const path = asString(entry.path);
  if (!path) return null;
  const type = asString(entry.type);
  const mode = asString(entry.mode);
  if (type === "tree") return null;
  if (type !== "blob" || !mode || !REGULAR_FILE_MODES.has(mode)) {
    return { kind: "skip", skipped: { path, reason: "unsupported file type" } };
  }
  const sha = asString(entry.sha);
  if (!sha) return { kind: "skip", skipped: { path, reason: "unsupported file type" } };
  const classified = classifyAppSourcePath(path);
  return classified === "fetch"
    ? { kind: "fetch", entry: { ...entry, path, sha } }
    : { kind: "skip", skipped: classified };
};

const decodeBlob = (path: string, blob: BlobResponse): Effect.Effect<Uint8Array, AppSourceError> =>
  Effect.gen(function* () {
    const encoding = asString(blob.encoding);
    const content = asString(blob.content);
    if (!content || encoding !== "base64") {
      return yield* new AppSourceError({
        message: `GitHub blob ${path} did not return base64 content`,
        path,
      });
    }
    return Buffer.from(content.replace(/\s/g, ""), "base64");
  });

const decodeExecutorJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

const executorDescription = (
  files: readonly PublishFile[],
): Effect.Effect<string | undefined, AppSourceError> =>
  Effect.gen(function* () {
    const raw = files.find((file) => file.path === "executor.json");
    if (!raw) return undefined;
    const parsed = yield* decodeExecutorJson(new TextDecoder().decode(raw.bytes)).pipe(
      Effect.mapError(
        (cause) =>
          new AppSourceError({
            message: "executor.json is not valid JSON",
            path: "executor.json",
            cause,
          }),
      ),
    );
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const description = (parsed as { readonly description?: unknown }).description;
    return typeof description === "string" ? description : undefined;
  });

export const fetchGitHubAppSource = (
  input: GitHubAppSourceInput,
): Effect.Effect<GitHubAppSourceSnapshot, AppSourceError | PublishError> =>
  Effect.gen(function* () {
    const source = yield* parseSourceInput(input);
    const repoPath = encodedRepoPath(source);
    const repo = yield* requestJson<RepoResponse>(input, `/repos/${repoPath}`);
    const ref = source.ref ?? asString(repo.default_branch) ?? "main";
    const branchRef = yield* requestJson<RefResponse>(
      input,
      `/repos/${repoPath}/git/ref/${encodeURIComponent(`heads/${ref}`)}`,
    ).pipe(Effect.result);
    const commitPath =
      Result.isSuccess(branchRef) && asString(branchRef.success.object?.sha)
        ? `/repos/${repoPath}/git/commits/${encodeURIComponent(String(branchRef.success.object?.sha))}`
        : `/repos/${repoPath}/commits/${encodeURIComponent(ref)}`;
    const commit = yield* requestJson<CommitResponse | GitCommitResponse>(input, commitPath);
    const upstreamSha = asString(commit.sha);
    const treeSha = commitTreeSha(commit);
    if (!upstreamSha || !treeSha) {
      return yield* new AppSourceError({
        message: `GitHub commit ${ref} did not include a commit SHA and tree SHA`,
        path: commitPath,
      });
    }
    const tree = yield* requestJson<TreeResponse>(
      input,
      `/repos/${repoPath}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`,
    );
    if (tree.truncated === true) {
      return yield* new AppSourceError({
        message: "GitHub returned a truncated repository tree; app source is too large",
        path: `/repos/${repoPath}/git/trees/${treeSha}`,
      });
    }
    const entries: (TreeEntry & { readonly path: string; readonly sha: string })[] = [];
    const skipped: SourceSkippedFile[] = [];
    for (const entry of tree.tree ?? []) {
      const classified = classifyTreeEntry(entry);
      if (!classified) continue;
      if (classified.kind === "fetch") entries.push(classified.entry);
      else skipped.push(classified.skipped);
    }
    const limitError = treeLimitError(entries);
    if (limitError) return yield* limitError;
    const files: PublishFile[] = [];
    for (const entry of entries) {
      const blob = yield* requestJson<BlobResponse>(
        input,
        `/repos/${repoPath}/git/blobs/${encodeURIComponent(entry.sha)}`,
      );
      files.push({ path: entry.path, bytes: yield* decodeBlob(entry.path, blob) });
    }
    const payloadLimitError = enforcePublishLimits(files);
    if (payloadLimitError) return yield* payloadLimitError;
    return {
      files,
      sourceRef: upstreamSha,
      description: yield* executorDescription(files),
      repo: source.repo,
      ref,
      url: source.ref ? source.url : `https://github.com/${source.repo}`,
      skipped,
    };
  });

export const makeGitHubAppSource = (input: GitHubAppSourceInput) => ({
  fetch: () => fetchGitHubAppSource(input),
});

export const textFile = (path: string, contents: string): PublishFile => ({
  path,
  bytes: textEncoder.encode(contents),
});

export { parseGitHubSourceUrl };
export type { ParsedGitHubSourceUrl };
