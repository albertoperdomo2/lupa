import { NextRequest, NextResponse } from "next/server";
import type { GitHubRepoMention } from "@/lib/trace-chat";
import {
  buildGitHubRepoSnapshot,
  listGitHubRepoDirectory,
  readGitHubRepoFile,
  searchGitHubRepoPaths,
} from "@/lib/github-repo";

export const runtime = "nodejs";

interface RepoContextRequest {
  action: "snapshot" | "search_paths" | "list_directory" | "read_file";
  repo: GitHubRepoMention;
  query?: string;
  path?: string;
  limit?: number;
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as RepoContextRequest;

  try {
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
