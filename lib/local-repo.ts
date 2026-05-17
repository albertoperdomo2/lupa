import * as fs from "fs/promises";
import * as path from "path";

const MAX_FILE_SEARCH_RESULTS = 40;
const MAX_DIRECTORY_RESULTS = 80;
const MAX_FILE_CONTENT_CHARS = 40_000;

async function walkDirectory(
  dir: string,
  base: string,
  results: Array<{ path: string; type: "blob" | "tree"; size?: number }>,
  limit: number,
): Promise<void> {
  if (results.length >= limit) return;

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= limit) return;
    if (entry.name === ".git") continue;

    const relativePath = base ? `${base}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      results.push({ path: relativePath, type: "tree" });
      await walkDirectory(path.join(dir, entry.name), relativePath, results, limit);
    } else if (entry.isFile()) {
      let size: number | undefined;
      try {
        const stat = await fs.stat(path.join(dir, entry.name));
        size = stat.size;
      } catch {
        size = undefined;
      }
      results.push({ path: relativePath, type: "blob", size });
    }
  }
}

export async function searchLocalRepoPaths(
  clonePath: string,
  query: string,
  limit: number,
) {
  const normalizedQuery = query.trim().toLowerCase();
  const allEntries: Array<{ path: string; type: "blob" | "tree"; size?: number }> = [];
  await walkDirectory(clonePath, "", allEntries, 10_000);

  const matches = allEntries
    .filter((entry) => entry.type === "blob")
    .map((entry) => {
      const lowerPath = entry.path.toLowerCase();
      if (normalizedQuery && !lowerPath.includes(normalizedQuery)) return null;

      let score = 0;
      if (lowerPath.endsWith(normalizedQuery)) score += 6;
      if (lowerPath.includes(`/${normalizedQuery}`)) score += 3;
      if (lowerPath.includes(normalizedQuery)) score += 1;

      return { path: entry.path, size: entry.size ?? null, score };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (b!.score !== a!.score) return b!.score - a!.score;
      return a!.path.localeCompare(b!.path);
    })
    .slice(0, Math.min(limit, MAX_FILE_SEARCH_RESULTS));

  return { matches, source: "local_clone" as const };
}

export async function listLocalRepoDirectory(
  clonePath: string,
  directoryPath: string,
) {
  const normalizedPath = directoryPath.trim().replace(/^\/+|\/+$/g, "");
  const targetDir = normalizedPath
    ? path.join(clonePath, normalizedPath)
    : clonePath;

  let dirEntries;
  try {
    dirEntries = await fs.readdir(targetDir, { withFileTypes: true });
  } catch {
    return { path: normalizedPath, entries: [], error: "Directory not found." };
  }

  const entries = dirEntries
    .filter((entry) => entry.name !== ".git")
    .map((entry) => ({
      path: normalizedPath ? `${normalizedPath}/${entry.name}` : entry.name,
      type: (entry.isDirectory() ? "tree" : "blob") as "tree" | "blob",
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, MAX_DIRECTORY_RESULTS);

  return { path: normalizedPath, entries, source: "local_clone" as const };
}

export async function readLocalRepoFile(
  clonePath: string,
  filePath: string,
) {
  const normalizedPath = filePath.trim().replace(/^\/+/, "");
  const fullPath = path.join(clonePath, normalizedPath);

  let content: string;
  try {
    content = await fs.readFile(fullPath, "utf-8");
  } catch {
    return {
      path: normalizedPath,
      content: "",
      size: 0,
      truncated: false,
      error: "File not found.",
      source: "local_clone" as const,
    };
  }

  return {
    path: normalizedPath,
    size: content.length,
    truncated: content.length > MAX_FILE_CONTENT_CHARS,
    content: content.slice(0, MAX_FILE_CONTENT_CHARS),
    source: "local_clone" as const,
  };
}
