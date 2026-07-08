export interface ParsedGitHubSourceUrl {
  readonly owner: string;
  readonly name: string;
  readonly repo: string;
  readonly ref?: string;
  readonly url: string;
}

export type GitHubSourceUrlParseResult =
  | { readonly ok: true; readonly value: ParsedGitHubSourceUrl }
  | { readonly ok: false; readonly message: string };

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9_.-]+$/;
const COMMIT_RE = /^[0-9a-f]{7,40}$/i;
const URL_RE = /^https?:\/\/([^/?#]+)(?:\/([^?#]*))?$/i;

const trimSlashes = (value: string): string => value.replace(/^\/+|\/+$/g, "");

const normalizeRepoName = (value: string): string =>
  value.endsWith(".git") ? value.slice(0, -4) : value;

const invalidShape =
  "Use a GitHub repo URL like https://github.com/owner/repo, optionally with /tree/<ref> or /commit/<sha>.";

const validateOwnerRepo = (
  owner: string | undefined,
  nameInput: string | undefined,
): { readonly owner: string; readonly name: string } | null => {
  const name = nameInput ? normalizeRepoName(nameInput) : "";
  if (!owner || !name) return null;
  if (!OWNER_RE.test(owner) || !REPO_RE.test(name)) return null;
  return { owner, name };
};

const canonicalUrl = (
  owner: string,
  name: string,
  kind: "base" | "tree" | "commit",
  ref?: string,
): string => {
  const base = `https://github.com/${owner}/${name}`;
  if (!ref || kind === "base") return base;
  return `${base}/${kind}/${ref}`;
};

export const parseGitHubSourceUrl = (
  input: string,
  options?: { readonly ref?: string | undefined },
): GitHubSourceUrlParseResult => {
  const trimmed = input.trim();
  const overrideRef = options?.ref?.trim();
  if (trimmed.length === 0) return { ok: false, message: "Enter a GitHub URL." };

  const urlMatch = URL_RE.exec(trimmed);
  const path = urlMatch ? trimSlashes(urlMatch[2] ?? "") : trimSlashes(trimmed);
  if (urlMatch && urlMatch[1]?.toLowerCase() !== "github.com") {
    return { ok: false, message: "GitHub source URLs must use github.com." };
  }
  if (!urlMatch && /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)) {
    return { ok: false, message: "GitHub source URLs must use github.com." };
  }

  const segments = path.split("/").filter((segment) => segment.length > 0);
  const validated = validateOwnerRepo(segments[0], segments[1]);
  if (!validated) return { ok: false, message: invalidShape };
  const { owner, name } = validated;
  const repo = `${owner}/${name}`;

  if (segments.length === 2) {
    const ref = overrideRef || undefined;
    return {
      ok: true,
      value: {
        owner,
        name,
        repo,
        ...(ref ? { ref } : {}),
        url: canonicalUrl(owner, name, ref ? "tree" : "base", ref),
      },
    };
  }

  const route = segments[2];
  if (route === "tree") {
    const ref = overrideRef || segments.slice(3).join("/");
    if (!ref)
      return { ok: false, message: "GitHub tree URLs must include a branch, tag, or commit SHA." };
    return {
      ok: true,
      value: { owner, name, repo, ref, url: canonicalUrl(owner, name, "tree", ref) },
    };
  }

  if (route === "commit") {
    const sourceRef = segments.length === 4 ? segments[3] : "";
    const ref = overrideRef || sourceRef;
    if (!ref || !COMMIT_RE.test(ref)) {
      return { ok: false, message: "GitHub commit URLs must include a commit SHA." };
    }
    return {
      ok: true,
      value: { owner, name, repo, ref, url: canonicalUrl(owner, name, "commit", ref) },
    };
  }

  return { ok: false, message: invalidShape };
};
