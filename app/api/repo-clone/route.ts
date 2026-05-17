import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { parseGitHubRepoUrl } from "@/lib/github-repo";

export const runtime = "nodejs";

const execFileAsync = promisify(execFile);

const CLONE_BASE_DIR = path.join(os.tmpdir(), "lupa-repo-clones");

interface CloneRecord {
  cloneId: string;
  repoUrl: string;
  owner: string;
  repo: string;
  branch: string;
  clonePath: string;
  createdAt: string;
}

const activeClones = new Map<string, CloneRecord>();

type RepoCloneRequest =
  | { action: "clone"; repoUrl: string; branch?: string }
  | { action: "status"; cloneId: string }
  | { action: "cleanup"; cloneId: string }
  | { action: "cleanup_all" };

function generateCloneId(): string {
  return `clone-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function ensureBaseDir(): Promise<void> {
  await fs.mkdir(CLONE_BASE_DIR, { recursive: true });
}

async function removeClone(record: CloneRecord): Promise<void> {
  activeClones.delete(record.cloneId);
  try {
    await fs.rm(record.clonePath, { recursive: true, force: true });
  } catch {
    // Directory may already be gone
  }
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as RepoCloneRequest;

  try {
    switch (body.action) {
      case "clone": {
        const parsed = parseGitHubRepoUrl(body.repoUrl);
        if (!parsed) {
          return NextResponse.json(
            { error: "Invalid GitHub repository URL." },
            { status: 400 },
          );
        }

        const existing = [...activeClones.values()].find(
          (c) => c.repoUrl === parsed.canonicalUrl,
        );
        if (existing) {
          return NextResponse.json({
            cloneId: existing.cloneId,
            owner: existing.owner,
            repo: existing.repo,
            branch: existing.branch,
            clonePath: existing.clonePath,
            alreadyCloned: true,
          });
        }

        await ensureBaseDir();
        const cloneId = generateCloneId();
        const clonePath = path.join(CLONE_BASE_DIR, cloneId);

        const args = [
          "clone",
          "--depth=1",
          "--single-branch",
        ];
        if (body.branch) {
          args.push(`--branch=${body.branch}`);
        }
        args.push(parsed.canonicalUrl, clonePath);

        await execFileAsync("git", args, { timeout: 60_000 });

        let branch = body.branch ?? "main";
        try {
          const { stdout } = await execFileAsync(
            "git",
            ["-C", clonePath, "rev-parse", "--abbrev-ref", "HEAD"],
            { timeout: 5_000 },
          );
          branch = stdout.trim();
        } catch {
          // Keep the default
        }

        const record: CloneRecord = {
          cloneId,
          repoUrl: parsed.canonicalUrl,
          owner: parsed.owner,
          repo: parsed.repo,
          branch,
          clonePath,
          createdAt: new Date().toISOString(),
        };
        activeClones.set(cloneId, record);

        return NextResponse.json({
          cloneId: record.cloneId,
          owner: record.owner,
          repo: record.repo,
          branch: record.branch,
          clonePath: record.clonePath,
          alreadyCloned: false,
        });
      }

      case "status": {
        const record = activeClones.get(body.cloneId);
        if (!record) {
          return NextResponse.json(
            { exists: false, cloneId: body.cloneId },
          );
        }

        let dirExists = false;
        try {
          await fs.access(record.clonePath);
          dirExists = true;
        } catch {
          dirExists = false;
        }

        return NextResponse.json({
          exists: dirExists,
          cloneId: record.cloneId,
          owner: record.owner,
          repo: record.repo,
          branch: record.branch,
        });
      }

      case "cleanup": {
        const record = activeClones.get(body.cloneId);
        if (!record) {
          return NextResponse.json({ cleaned: false, reason: "Clone not found." });
        }
        await removeClone(record);
        return NextResponse.json({ cleaned: true, cloneId: body.cloneId });
      }

      case "cleanup_all": {
        const count = activeClones.size;
        const records = [...activeClones.values()];
        await Promise.all(records.map(removeClone));
        return NextResponse.json({ cleaned: true, count });
      }

      default:
        return NextResponse.json(
          { error: "Unsupported clone action." },
          { status: 400 },
        );
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Clone operation failed." },
      { status: 500 },
    );
  }
}
