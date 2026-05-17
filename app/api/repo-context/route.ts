import { NextRequest, NextResponse } from "next/server";
import type { GitHubRepoMention } from "@/lib/trace-chat";
import {
  buildGitHubRepoSnapshot,
  listGitHubRepoDirectory,
  readGitHubRepoFile,
  searchGitHubRepoPaths,
} from "@/lib/github-repo";
import {
  listLocalRepoDirectory,
  readLocalRepoFile,
  searchLocalRepoPaths,
} from "@/lib/local-repo";

export const runtime = "nodejs";

interface RepoContextRequest {
  action: "snapshot" | "search_paths" | "list_directory" | "read_file";
  repo: GitHubRepoMention;
  clonePath?: string;
  query?: string;
  path?: string;
  limit?: number;
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as RepoContextRequest;

  try {
    if (body.clonePath) {
      switch (body.action) {
        case "snapshot":
          return NextResponse.json(await buildGitHubRepoSnapshot(body.repo));
        case "search_paths":
          return NextResponse.json(
            await searchLocalRepoPaths(body.clonePath, body.query ?? "", body.limit ?? 12),
          );
        case "list_directory":
          return NextResponse.json(
            await listLocalRepoDirectory(body.clonePath, body.path ?? ""),
          );
        case "read_file":
          return NextResponse.json(
            await readLocalRepoFile(body.clonePath, body.path ?? ""),
          );
        default:
          return NextResponse.json({ error: "Unsupported repo action." }, { status: 400 });
      }
    }

    switch (body.action) {
      case "snapshot":
        return NextResponse.json(await buildGitHubRepoSnapshot(body.repo));
      case "search_paths":
        return NextResponse.json(
          await searchGitHubRepoPaths(body.repo, body.query ?? "", body.limit ?? 12)
        );
      case "list_directory":
        return NextResponse.json(
          await listGitHubRepoDirectory(body.repo, body.path ?? "")
        );
      case "read_file":
        return NextResponse.json(await readGitHubRepoFile(body.repo, body.path ?? ""));
      default:
        return NextResponse.json({ error: "Unsupported repo action." }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "GitHub repo request failed.",
      },
      { status: 500 }
    );
  }
}
