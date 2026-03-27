import { Buffer } from "buffer";
import type { GitHubRepoMention } from "@/lib/trace-chat";

const GITHUB_API_BASE = "https://api.github.com";
const MAX_REPO_FILE_SEARCH_RESULTS = 40;
const MAX_REPO_DIRECTORY_RESULTS = 80;
const MAX_REPO_FILE_CONTENT_CHARS = 40_000;
const MAX_REPO_SUMMARY_PATHS = 160;

export interface GitHubRepoReference {
  owner: string;
  repo: string;
  canonicalUrl: string;
}

export interface GitHubRepoTreeEntry {
  path: string;
  type: "blob" | "tree";
  size?: number;
}

export interface GitHubRepoSnapshot {
  id: string;
  url: string;
  owner: string;
  repo: string;
  canonicalUrl: string;
  defaultBranch: string;
  description: string | null;
  homepage: string | null;
  stars: number;
  primaryLanguage: string | null;
  topLevelEntries: GitHubRepoTreeEntry[];
  samplePaths: string[];
  readmeExcerpt: string | null;
}

function decodeBase64Utf8(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}

function normalizeGitHubPathname(pathname: string): string[] {
  return pathname
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean);
}

export function parseGitHubRepoUrl(url: string): GitHubRepoReference | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "github.com" && parsed.hostname !== "www.github.com") {
      return null;
    }

    const segments = normalizeGitHubPathname(parsed.pathname);
    if (segments.length < 2) return null;

    const owner = segments[0];
    const repo = segments[1].replace(/\.git$/i, "");
    if (!owner || !repo) return null;

    return {
      owner,
      repo,
      canonicalUrl: `https://github.com/${owner}/${repo}`,
    };
  } catch {
    return null;
  }
}

export function buildGitHubRepoMentionToken(url: string): string | null {
  const parsed = parseGitHubRepoUrl(url);
  if (!parsed) return null;
  return `@[${parsed.owner}/${parsed.repo}|${parsed.canonicalUrl}]`;
}

async function fetchGitHubJson<T>(path: string): Promise<T> {
  const response = await fetch(`${GITHUB_API_BASE}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "trace-agent",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`GitHub request failed: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as T;
}

async function fetchGitHubText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "trace-agent",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`GitHub request failed: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

export async function buildGitHubRepoSnapshot(
  mention: GitHubRepoMention
): Promise<GitHubRepoSnapshot> {
  const parsed = parseGitHubRepoUrl(mention.url);
  if (!parsed) {
    throw new Error("Invalid GitHub repository URL.");
  }

  const repoMetadata = await fetchGitHubJson<{
    default_branch: string;
    description: string | null;
    homepage: string | null;
    stargazers_count: number;
    language: string | null;
  }>(`/repos/${parsed.owner}/${parsed.repo}`);

  const treeResponse = await fetchGitHubJson<{
    tree: Array<{ path: string; type: "blob" | "tree"; size?: number }>;
  }>(`/repos/${parsed.owner}/${parsed.repo}/git/trees/${repoMetadata.default_branch}?recursive=1`);

  let readmeExcerpt: string | null = null;
  try {
    const readmeResponse = await fetchGitHubJson<{
      content?: string;
      encoding?: string;
    }>(`/repos/${parsed.owner}/${parsed.repo}/readme`);

    if (readmeResponse.encoding === "base64" && readmeResponse.content) {
      readmeExcerpt = decodeBase64Utf8(readmeResponse.content)
        .slice(0, 4_000)
        .trim();
    }
  } catch {
    readmeExcerpt = null;
  }

  const entries: GitHubRepoTreeEntry[] = treeResponse.tree.map((entry) => ({
    path: entry.path,
    type: entry.type,
    size: entry.size,
  }));

  const topLevelEntries = entries
    .filter((entry) => !entry.path.includes("/"))
    .sort((left, right) => left.path.localeCompare(right.path))
    .slice(0, 30);

  const samplePaths = entries
    .filter((entry) => entry.type === "blob")
    .map((entry) => entry.path)
    .sort((left, right) => left.localeCompare(right))
    .slice(0, MAX_REPO_SUMMARY_PATHS);

  return {
    id: mention.id,
    url: mention.url,
    owner: parsed.owner,
    repo: parsed.repo,
    canonicalUrl: parsed.canonicalUrl,
    defaultBranch: repoMetadata.default_branch,
    description: repoMetadata.description,
    homepage: repoMetadata.homepage,
    stars: repoMetadata.stargazers_count,
    primaryLanguage: repoMetadata.language,
    topLevelEntries,
    samplePaths,
    readmeExcerpt,
  };
}

async function buildRepoTree(mention: GitHubRepoMention): Promise<{
  snapshot: GitHubRepoSnapshot;
  entries: GitHubRepoTreeEntry[];
}> {
  const snapshot = await buildGitHubRepoSnapshot(mention);
  const treeResponse = await fetchGitHubJson<{
    tree: Array<{ path: string; type: "blob" | "tree"; size?: number }>;
  }>(`/repos/${snapshot.owner}/${snapshot.repo}/git/trees/${snapshot.defaultBranch}?recursive=1`);

  return {
    snapshot,
    entries: treeResponse.tree.map((entry) => ({
      path: entry.path,
      type: entry.type,
      size: entry.size,
    })),
  };
}

export async function searchGitHubRepoPaths(
  mention: GitHubRepoMention,
  query: string,
  limit: number
) {
  const normalizedQuery = query.trim().toLowerCase();
  const { snapshot, entries } = await buildRepoTree(mention);

  const matches = entries
    .filter((entry) => entry.type === "blob")
    .map((entry) => {
      const lowerPath = entry.path.toLowerCase();
      if (!normalizedQuery || !lowerPath.includes(normalizedQuery)) return null;

      let score = 0;
      if (lowerPath.endsWith(normalizedQuery)) score += 6;
      if (lowerPath.includes(`/${normalizedQuery}`)) score += 3;
      if (lowerPath.includes(normalizedQuery)) score += 1;

      return {
        path: entry.path,
        size: entry.size ?? null,
        score,
      };
    })
    .filter((entry): entry is { path: string; size: number | null; score: number } => Boolean(entry))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.path.localeCompare(right.path);
    })
    .slice(0, Math.min(limit, MAX_REPO_FILE_SEARCH_RESULTS));

  return {
    repo: snapshot,
    query,
    matches,
  };
}

export async function listGitHubRepoDirectory(
  mention: GitHubRepoMention,
  directoryPath: string
) {
  const { snapshot, entries } = await buildRepoTree(mention);
  const normalizedDirectory = directoryPath.trim().replace(/^\/+|\/+$/g, "");
  const prefix = normalizedDirectory ? `${normalizedDirectory}/` : "";
  const children = new Map<string, GitHubRepoTreeEntry>();

  for (const entry of entries) {
    if (!entry.path.startsWith(prefix)) continue;

    const remainder = prefix ? entry.path.slice(prefix.length) : entry.path;
    if (!remainder) continue;

    const [firstSegment] = remainder.split("/");
    const childPath = prefix ? `${prefix}${firstSegment}` : firstSegment;
    const existing = children.get(childPath);

    if (!existing) {
      children.set(childPath, {
        path: childPath,
        type: remainder.includes("/") ? "tree" : entry.type,
        size: entry.size,
      });
      continue;
    }

    if (existing.type !== "tree" && remainder.includes("/")) {
      children.set(childPath, {
        path: childPath,
        type: "tree",
      });
    }
  }

  return {
    repo: snapshot,
    path: normalizedDirectory,
    entries: [...children.values()]
      .sort((left, right) => left.path.localeCompare(right.path))
      .slice(0, MAX_REPO_DIRECTORY_RESULTS),
  };
}

export async function readGitHubRepoFile(
  mention: GitHubRepoMention,
  filePath: string
) {
  const snapshot = await buildGitHubRepoSnapshot(mention);
  const normalizedPath = filePath.trim().replace(/^\/+/, "");
  const contentResponse = await fetchGitHubJson<{
    content?: string;
    encoding?: string;
    size?: number;
    download_url?: string;
  }>(
    `/repos/${snapshot.owner}/${snapshot.repo}/contents/${encodeURIComponent(normalizedPath).replace(/%2F/g, "/")}?ref=${encodeURIComponent(snapshot.defaultBranch)}`
  );

  const content =
    contentResponse.encoding === "base64" && contentResponse.content
      ? decodeBase64Utf8(contentResponse.content)
      : contentResponse.download_url
        ? await fetchGitHubText(contentResponse.download_url)
        : "";

  return {
    repo: snapshot,
    path: normalizedPath,
    size: contentResponse.size ?? content.length,
    truncated: content.length > MAX_REPO_FILE_CONTENT_CHARS,
    content: content.slice(0, MAX_REPO_FILE_CONTENT_CHARS),
  };
}
