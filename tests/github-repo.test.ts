import { describe, expect, it } from "vitest";
import {
  buildGitHubRepoMentionToken,
  parseGitHubRepoUrl,
} from "@/lib/github-repo";

describe("parseGitHubRepoUrl", () => {
  it("normalizes GitHub repo URLs", () => {
    expect(parseGitHubRepoUrl("https://github.com/openai/openai-node")).toEqual({
      owner: "openai",
      repo: "openai-node",
      canonicalUrl: "https://github.com/openai/openai-node",
    });

    expect(parseGitHubRepoUrl("https://github.com/vercel/next.js.git")).toEqual({
      owner: "vercel",
      repo: "next.js",
      canonicalUrl: "https://github.com/vercel/next.js",
    });
  });

  it("rejects non-repository URLs", () => {
    expect(parseGitHubRepoUrl("https://example.com/openai/openai-node")).toBeNull();
    expect(parseGitHubRepoUrl("not a url")).toBeNull();
  });
});

describe("buildGitHubRepoMentionToken", () => {
  it("formats repo mentions as @owner/repo tokens", () => {
    expect(buildGitHubRepoMentionToken("https://github.com/openai/openai-node")).toBe(
      "@[openai/openai-node|https://github.com/openai/openai-node]"
    );
  });
});
