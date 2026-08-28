import { execFile as execFileCallback } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { OpenFloorError } from "./errors.js";

const execFile = promisify(execFileCallback);

export type LocalWorkspace = {
  root: string;
  remoteName: string;
  remoteUrl: string;
  repositoryFullName: string;
};

export type WorkspaceStatus = {
  branch: string;
  clean: boolean;
};

export type WorkspaceSyncResult = {
  branch: string;
  sha: string;
};

type GitRunner = (args: string[], cwd: string) => Promise<string>;

async function runGit(args: string[], cwd: string): Promise<string> {
  const result = await execFile("git", args, { cwd, encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  return result.stdout.trim();
}

export function githubRepositoryFromRemote(remote: string): string | null {
  const value = remote.trim().replace(/\.git$/, "");
  const https = /^https?:\/\/github\.com\/([^/]+\/[^/]+)$/i.exec(value);
  if (https) return https[1]!;
  const scp = /^(?:[^@]+@)?github\.com:([^/]+\/[^/]+)$/i.exec(value);
  if (scp) return scp[1]!;
  const ssh = /^ssh:\/\/(?:[^@]+@)?github\.com\/(?:\d+\/)?([^/]+\/[^/]+)$/i.exec(value);
  return ssh?.[1] ?? null;
}

export async function detectLocalWorkspace(cwd = process.cwd(), git: GitRunner = runGit): Promise<LocalWorkspace | null> {
  let root: string;
  try { root = await git(["rev-parse", "--show-toplevel"], cwd); }
  catch { return null; }
  if (!root) return null;
  let remoteUrl: string;
  try { remoteUrl = await git(["remote", "get-url", "origin"], root); }
  catch { return null; }
  const repositoryFullName = githubRepositoryFromRemote(remoteUrl);
  if (!repositoryFullName) return null;
  return { root: await realpath(root), remoteName: "origin", remoteUrl, repositoryFullName };
}

export async function workspaceStatus(workspace: LocalWorkspace, git: GitRunner = runGit): Promise<WorkspaceStatus> {
  const [branch, status] = await Promise.all([
    git(["branch", "--show-current"], workspace.root),
    git(["status", "--porcelain", "--untracked-files=normal"], workspace.root),
  ]);
  return { branch, clean: status.length === 0 };
}

export async function requireCleanWorkspace(workspace: LocalWorkspace, git: GitRunner = runGit): Promise<WorkspaceStatus> {
  const status = await workspaceStatus(workspace, git);
  if (!status.clean) throw new OpenFloorError("Local workspace has uncommitted changes; commit or stash them before enabling live sync", "conflict");
  return status;
}

export async function synchronizeWorkspace(workspace: LocalWorkspace, branchName: string, expectedSha: string, git: GitRunner = runGit): Promise<WorkspaceSyncResult> {
  if (!branchName || branchName.startsWith("-") || branchName.includes("\0")) throw new OpenFloorError("Candidate branch name is unsafe", "conflict");
  if (!/^[0-9a-f]{40}$/i.test(expectedSha)) throw new OpenFloorError("Candidate SHA is missing or invalid; live sync paused", "conflict");
  try { await git(["check-ref-format", "--branch", branchName], workspace.root); }
  catch { throw new OpenFloorError("Candidate branch name is invalid", "conflict"); }
  await requireCleanWorkspace(workspace, git);

  const remoteRef = `refs/remotes/${workspace.remoteName}/${branchName}`;
  await git(["fetch", "--no-tags", workspace.remoteName, `+refs/heads/${branchName}:${remoteRef}`], workspace.root);
  const fetchedSha = await git(["rev-parse", "--verify", remoteRef], workspace.root);
  if (fetchedSha.toLowerCase() !== expectedSha.toLowerCase()) {
    throw new OpenFloorError(`Fetched candidate ${fetchedSha.slice(0, 12)} does not match openfloor ${expectedSha.slice(0, 12)}; live sync paused`, "conflict");
  }
  const current = await git(["branch", "--show-current"], workspace.root);
  if (current === branchName) {
    await git(["merge", "--ff-only", remoteRef], workspace.root);
    return { branch: branchName, sha: fetchedSha };
  }

  let localExists = true;
  try { await git(["show-ref", "--verify", `refs/heads/${branchName}`], workspace.root); }
  catch { localExists = false; }
  if (!localExists) {
    await git(["switch", "--track", "-c", branchName, remoteRef], workspace.root);
    return { branch: branchName, sha: fetchedSha };
  }

  try { await git(["merge-base", "--is-ancestor", `refs/heads/${branchName}`, remoteRef], workspace.root); }
  catch { throw new OpenFloorError("Local candidate branch diverged from openfloor; live sync paused", "conflict"); }
  await git(["switch", branchName], workspace.root);
  await git(["merge", "--ff-only", remoteRef], workspace.root);
  return { branch: branchName, sha: fetchedSha };
}
