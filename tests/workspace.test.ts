import { mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectLocalWorkspace, githubRepositoryFromRemote, synchronizeWorkspace, type LocalWorkspace } from "../src/workspace.js";

describe("local workspace", () => {
  it("parses common GitHub origin forms", () => {
    expect(githubRepositoryFromRemote("https://github.com/openfloor-ai/openfloor.git")).toBe("openfloor-ai/openfloor");
    expect(githubRepositoryFromRemote("git@github.com:openfloor-ai/openfloor.git")).toBe("openfloor-ai/openfloor");
    expect(githubRepositoryFromRemote("ssh://git@github.com/openfloor-ai/openfloor.git")).toBe("openfloor-ai/openfloor");
    expect(githubRepositoryFromRemote("https://gitlab.com/openfloor-ai/openfloor.git")).toBeNull();
  });

  it("detects canonical GitHub worktrees only", async () => {
    const root = join(tmpdir(), `openfloor-workspace-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    const git = (args: string[]) => Promise.resolve(args[0] === "rev-parse" ? root : "git@github.com:openfloor-ai/openfloor.git");
    await expect(detectLocalWorkspace(root, git)).resolves.toMatchObject({ root: await realpath(root), repositoryFullName: "openfloor-ai/openfloor" });
    await expect(detectLocalWorkspace(root, (args) => Promise.resolve(args[0] === "rev-parse" ? root : "git@gitlab.com:openfloor-ai/openfloor.git"))).resolves.toBeNull();
  });

  it("creates a tracking branch using fixed git arguments", async () => {
    const calls: string[][] = [];
    const workspace: LocalWorkspace = { root: "/repo", remoteName: "origin", remoteUrl: "git@github.com:openfloor-ai/openfloor.git", repositoryFullName: "openfloor-ai/openfloor" };
    const git = (args: string[]) => {
      calls.push(args);
      if (args[0] === "status" || args[0] === "branch") return Promise.resolve("");
      if (args[0] === "show-ref") return Promise.reject(new Error("missing"));
      return Promise.resolve("ok");
    };
    const sha = "a".repeat(40);
    const runner = (args: string[]) => args[0] === "rev-parse" ? Promise.resolve(sha) : git(args);
    await expect(synchronizeWorkspace(workspace, "openfloor/session/candidate/task-12345678", sha, runner)).resolves.toMatchObject({ branch: expect.stringContaining("candidate"), sha });
    expect(calls).toContainEqual(["fetch", "--no-tags", "origin", "+refs/heads/openfloor/session/candidate/task-12345678:refs/remotes/origin/openfloor/session/candidate/task-12345678"]);
    expect(calls).toContainEqual(["switch", "--track", "-c", "openfloor/session/candidate/task-12345678", "refs/remotes/origin/openfloor/session/candidate/task-12345678"]);
  });

  it("fast-forwards an existing checked-out candidate", async () => {
    const calls: string[][] = []; const sha = "b".repeat(40);
    const workspace: LocalWorkspace = { root: "/repo", remoteName: "origin", remoteUrl: "git@github.com:openfloor-ai/openfloor.git", repositoryFullName: "openfloor-ai/openfloor" };
    const git = (args: string[]) => { calls.push(args); if (args[0] === "status") return Promise.resolve(""); if (args[0] === "branch") return Promise.resolve("openfloor/candidate"); if (args[0] === "rev-parse") return Promise.resolve(sha); return Promise.resolve("ok"); };
    await expect(synchronizeWorkspace(workspace, "openfloor/candidate", sha, git)).resolves.toEqual({ branch: "openfloor/candidate", sha });
    expect(calls).toContainEqual(["merge", "--ff-only", "refs/remotes/origin/openfloor/candidate"]);
  });

  it("refuses a fetched SHA that differs from server authority", async () => {
    const calls: string[][] = []; const workspace: LocalWorkspace = { root: "/repo", remoteName: "origin", remoteUrl: "git@github.com:openfloor-ai/openfloor.git", repositoryFullName: "openfloor-ai/openfloor" };
    const git = (args: string[]) => { calls.push(args); if (args[0] === "status" || args[0] === "branch") return Promise.resolve(""); if (args[0] === "rev-parse") return Promise.resolve("b".repeat(40)); return Promise.resolve("ok"); };
    await expect(synchronizeWorkspace(workspace, "openfloor/candidate", "a".repeat(40), git)).rejects.toThrow(/does not match/);
    expect(calls.some((args) => args[0] === "switch" || args[0] === "merge")).toBe(false);
  });

  it("refuses a diverged local candidate", async () => {
    const sha = "a".repeat(40); const workspace: LocalWorkspace = { root: "/repo", remoteName: "origin", remoteUrl: "git@github.com:openfloor-ai/openfloor.git", repositoryFullName: "openfloor-ai/openfloor" };
    const git = (args: string[]) => { if (args[0] === "status" || args[0] === "branch") return Promise.resolve(""); if (args[0] === "rev-parse") return Promise.resolve(sha); if (args[0] === "merge-base") return Promise.reject(new Error("diverged")); return Promise.resolve("ok"); };
    await expect(synchronizeWorkspace(workspace, "openfloor/candidate", sha, git)).rejects.toThrow(/diverged/);
  });

  it("refuses dirty worktrees before fetching", async () => {
    const calls: string[][] = [];
    const workspace: LocalWorkspace = { root: "/repo", remoteName: "origin", remoteUrl: "https://github.com/openfloor-ai/openfloor", repositoryFullName: "openfloor-ai/openfloor" };
    const git = (args: string[]) => { calls.push(args); return Promise.resolve(args[0] === "status" ? " M src/app.ts" : "ok"); };
    await expect(synchronizeWorkspace(workspace, "openfloor/a/candidate/b-12345678", "a".repeat(40), git)).rejects.toThrow(/uncommitted changes/);
    expect(calls.some((args) => args[0] === "fetch")).toBe(false);
  });

  it("refuses invalid candidate identity before fetching", async () => {
    const calls: string[][] = []; const workspace: LocalWorkspace = { root: "/repo", remoteName: "origin", remoteUrl: "https://github.com/openfloor-ai/openfloor", repositoryFullName: "openfloor-ai/openfloor" };
    await expect(synchronizeWorkspace(workspace, "openfloor/candidate", "not-a-sha", (args) => { calls.push(args); return Promise.resolve(""); })).rejects.toThrow(/SHA/);
    expect(calls).toEqual([]);
  });
});
