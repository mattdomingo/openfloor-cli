import { execFile } from "node:child_process";
import { basename } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stderr, stdout } from "node:process";
import { promisify } from "node:util";
import { Command, Option } from "commander";
import open from "open";
import { OpenFloorActions } from "./actions.js";
import { accessToken, logoutAccess } from "./auth.js";
import { updateConfig, writeConfig } from "./config.js";
import { OpenFloorError } from "./errors.js";
import { resolveId } from "./id.js";
import { writeResult } from "./output.js";
import { createRuntime, requireSession, type GlobalOptions } from "./runtime.js";
import type { RepositoryOption } from "./contracts.js";

type AnyOptions = Record<string, any>;
const exec = promisify(execFile);

export function buildProgram(): Command {
  const program = new Command()
    .name("openfloor")
    .description("Command-line and terminal client for openfloor")
    .version("0.1.0")
    .option("--session <id>", "session UUID or unique prefix")
    .option("--base-url <url>", "openfloor origin")
    .option("--json", "stable JSON envelope")
    .option("--quiet", "suppress successful output")
    .option("--no-color", "disable color")
    .option("--debug", "redacted transport diagnostics")
    .option("--yes", "confirm destructive action noninteractively")
    .action(() => {});

  registerAuth(program);
  registerConfig(program);
  registerSessions(program);
  registerInvitesMembers(program);
  registerAgents(program);
  registerQueueTeam(program);
  registerRunsConflicts(program);
  registerRepository(program);
  registerSkillsMcp(program);
  registerReview(program);
  registerWeb(program);
  registerDoctor(program);
  return program;
}

function globals(command: Command): GlobalOptions { return command.optsWithGlobals<GlobalOptions>(); }

async function context(command: Command, needsSession = false) {
  const options = globals(command);
  const runtime = await createRuntime(options);
  const actions = new OpenFloorActions(runtime.client);
  let sessionId: string | undefined;
  if (needsSession) sessionId = await actions.resolveSession(requireSession(options, runtime.config.currentSessionId));
  return { ...runtime, actions, sessionId };
}

async function run(command: Command, action: (ctx: Awaited<ReturnType<typeof context>>) => Promise<unknown>, needsSession = false): Promise<void> {
  const ctx = await context(command, needsSession);
  writeResult(await action(ctx), ctx.options);
}

async function confirm(command: Command, message: string): Promise<void> {
  if (globals(command).yes) return;
  if (!stdin.isTTY || !stderr.isTTY) throw new OpenFloorError(`${message}; pass --yes in noninteractive use`, "usage");
  const prompt = createInterface({ input: stdin, output: stderr });
  try {
    const answer = await prompt.question(`${message} Type "yes" to continue: `);
    if (answer.trim() !== "yes") throw new OpenFloorError("Cancelled", "usage");
  } finally { prompt.close(); }
}

function registerAuth(program: Command): void {
  const auth = program.command("auth").description("Cloudflare Access authentication");
  auth.command("login").action(async function (this: Command) {
    const ctx = await context(this);
    await accessToken({ baseUrl: ctx.baseUrl, ...(ctx.options.debug === undefined ? {} : { debug: ctx.options.debug }) }, true);
    writeResult(await ctx.actions.me(), ctx.options);
  });
  auth.command("status").action(async function (this: Command) { await run(this, ({ actions }) => actions.me()); });
  auth.command("logout").description("Remove openfloor's local Access session").action(async function (this: Command) {
    const options = globals(this);
    await logoutAccess();
    writeResult({ loggedOut: true }, options);
  });
}

function registerConfig(program: Command): void {
  const config = program.command("config").description("Non-secret local configuration");
  config.command("show").action(async function (this: Command) { const ctx = await context(this); writeResult(ctx.config, ctx.options); });
  config.command("set")
    .option("--base-url <url>")
    .option("--session <id>")
    .option("--color <mode>", "auto, always, or never")
    .action(async function (this: Command, options: AnyOptions) {
      const ctx = await context(this);
      const patch: AnyOptions = {};
      if (options.baseUrl) patch.baseUrl = new URL(options.baseUrl).origin;
      if (options.session) patch.currentSessionId = await ctx.actions.resolveSession(options.session);
      if (options.color) {
        if (!["auto", "always", "never"].includes(options.color)) throw new OpenFloorError("Color must be auto, always, or never", "usage");
        patch.color = options.color === "auto" ? undefined : options.color === "always";
      }
      writeResult(await updateConfig(patch), ctx.options);
    });
  config.command("clear").action(async function (this: Command) { const ctx = await context(this); await writeConfig({}); writeResult({}, ctx.options); });
}

function registerSessions(program: Command): void {
  const sessions = program.command("sessions").description("Session lifecycle");
  sessions.command("list").option("--state <state>", "active, archived, ended, or all", "all")
    .action(async function (this: Command, options: AnyOptions) {
      await run(this, async ({ actions }) => {
        const rows = (await actions.home()).props.sessions;
        return rows.filter((session) => options.state === "all" ||
          (options.state === "ended" ? session.endedAt != null : options.state === "archived" ? session.archivedAt != null : session.endedAt == null && session.archivedAt == null));
      });
    });
  sessions.command("show").argument("[id]").action(async function (this: Command, id?: string) {
    await run(this, async ({ actions, config, options }) => actions.session(await actions.resolveSession(id || requireSession(options, config.currentSessionId))));
  });
  sessions.command("objective").argument("[text]").option("--file <path>").action(async function (this: Command, value: string | undefined, options: AnyOptions) {
    await run(this, async ({ actions, sessionId }) => actions.patch(`/api/sessions/${sessionId!}`, { objective: (await actions.readTextInput(value, options.file)) || null }), true);
  });
  sessions.command("use").argument("<id>").action(async function (this: Command, id: string) {
    const ctx = await context(this); const resolved = await ctx.actions.resolveSession(id);
    writeResult(await updateConfig({ currentSessionId: resolved }), ctx.options);
  });
  sessions.command("create").requiredOption("--title <title>").option("--objective <text>").option("--candidate-name <name>")
    .option("--repository <id>").option("--installation <id>")
    .action(async function (this: Command, options: AnyOptions) {
      await run(this, async ({ actions }) => {
        const repositories = (await actions.repositories()).repositories;
        const repository = await chooseRepository(repositories, options.repository, options.installation);
        return actions.createSession({
          title: options.title, objective: options.objective ?? null, candidateName: options.candidateName ?? null,
          repositoryId: repository.id, accountInstallationId: repository.accountInstallationId,
        });
      });
    });
  sessions.command("archive").action(async function (this: Command) {
    await run(this, async ({ actions, sessionId }) => { await actions.post(`/api/sessions/${sessionId!}/archive`); return { sessionId: sessionId!, archived: true }; }, true);
  });
  sessions.command("unarchive").action(async function (this: Command) {
    await run(this, async ({ actions, sessionId }) => { await actions.post(`/api/sessions/${sessionId!}/unarchive`); return { sessionId: sessionId!, archived: false }; }, true);
  });
  sessionNoBody(sessions, "lock", "POST", "lock");
  sessionNoBody(sessions, "unlock", "DELETE", "lock");
  sessions.command("end").action(async function (this: Command) { await confirm(this, "End this session permanently?"); await run(this, ({ actions, sessionId }) => actions.post(`/api/sessions/${sessionId!}/end`), true); });
  sessions.command("leave").action(async function (this: Command) { await confirm(this, "Leave this session?"); await run(this, ({ actions, sessionId }) => actions.delete(`/api/sessions/${sessionId!}/membership`), true); });
  sessions.command("delete").addOption(new Option("--candidate <choice>").choices(["delete-branch", "orphan"]))
    .action(async function (this: Command, options: AnyOptions) {
      await confirm(this, `Delete this session${options.candidate ? ` and ${options.candidate === "orphan" ? "orphan" : "delete"} its candidate branch` : ""}?`);
      await run(this, async ({ actions, sessionId }) => {
        try {
          return await actions.delete(`/api/sessions/${sessionId!}`, options.candidate ? { candidate: options.candidate } : undefined);
        } catch (error) {
          throw candidateLiveHint(error);
        }
      }, true);
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Rethrows a 409 candidate_live delete failure with the --candidate flags the caller needs; passes other errors through unchanged. */
export function candidateLiveHint(error: unknown): unknown {
  if (!(error instanceof OpenFloorError) || error.code !== "conflict" || !isRecord(error.details)) return error;
  const { details } = error;
  if (details.code !== "candidate_live" || typeof details.branch !== "string") return error;
  return new OpenFloorError(`${error.message}. Candidate branch ${details.branch} hasn't merged yet; pass --candidate delete-branch or --candidate orphan.`, error.code, error.status, error.details);
}

function sessionNoBody(group: Command, name: string, method: "POST" | "DELETE", endpoint: string): void {
  group.command(name).action(async function (this: Command) {
    await run(this, ({ actions, sessionId }) => method === "POST" ? actions.post(`/api/sessions/${sessionId!}/${endpoint}`) : actions.delete(`/api/sessions/${sessionId!}/${endpoint}`), true);
  });
}

function registerInvitesMembers(program: Command): void {
  const invite = program.command("invite");
  invite.command("show").action(async function (this: Command) { await run(this, ({ actions, sessionId }) => actions.get(`/api/sessions/${sessionId!}/invite`), true); });
  invite.command("rotate").action(async function (this: Command) { await confirm(this, "Rotate invite and invalidate the old link?"); await run(this, ({ actions, sessionId }) => actions.post(`/api/sessions/${sessionId!}/invite`), true); });
  invite.command("revoke").action(async function (this: Command) { await confirm(this, "Revoke the active invite?"); await run(this, ({ actions, sessionId }) => actions.delete(`/api/sessions/${sessionId!}/invite`), true); });
  invite.command("join").argument("<token>").action(async function (this: Command, token: string) { await run(this, ({ actions }) => actions.post(`/api/invites/${encodeURIComponent(token)}/accept`)); });

  const members = program.command("members");
  members.command("list").option("--removed").action(async function (this: Command, options: AnyOptions) {
    await run(this, async ({ actions, sessionId }) => {
      const props = (await actions.session(sessionId!)).props as AnyOptions;
      return options.removed ? props.initialRemovedMembers ?? [] : props.initialMembers;
    }, true);
  });
  for (const [name, method] of [["remove", "DELETE"], ["restore", "POST"]] as const) {
    members.command(name).argument("<member>").action(async function (this: Command, member: string) {
      if (name === "remove") await confirm(this, "Remove this member?");
      await run(this, async ({ actions, sessionId }) => {
        const props = (await actions.session(sessionId!)).props as AnyOptions;
        const pool = name === "remove" ? props.initialMembers : props.initialRemovedMembers ?? [];
        const id = resolveId(member, pool, "Member");
        return method === "POST" ? actions.post(`/api/sessions/${sessionId!}/members/${id}`) : actions.delete(`/api/sessions/${sessionId!}/members/${id}`);
      }, true);
    });
  }
}

function registerAgents(program: Command): void {
  const agents = program.command("agents");
  agents.command("list").action(async function (this: Command) { await run(this, async ({ actions, sessionId }) => (await actions.floor(sessionId!)).props.initialFloor.agents, true); });
  agents.command("show").argument("<agent>").action(async function (this: Command, agent: string) {
    await run(this, async ({ actions, sessionId }) => { const floor = (await actions.floor(sessionId!)).props.initialFloor; const id = await actions.resolveFloorEntity(sessionId!, agent, "agent"); return floor.agents.find((item) => item.id === id); }, true);
  });
  agents.command("create").requiredOption("--name <name>").requiredOption("--role <role>").requiredOption("--task <task>")
    .option("--owner <id>").option("--provider <provider>", "openai, anthropic, kimi, gemini, or glm", "openai").option("--model <model>").option("--credential-kind <kind>")
    .action(async function (this: Command, options: AnyOptions) {
      await run(this, async ({ actions, sessionId }) => {
        const props = (await actions.session(sessionId!)).props;
        const owner = options.owner ? resolveId(options.owner, props.initialMembers, "Member") : props.user.id;
        return actions.post(`/api/sessions/${sessionId!}/agents`, { name: options.name, role: options.role, task: options.task, ownerUserId: owner, provider: options.provider, model: options.model ?? null, credentialKind: options.credentialKind ?? null });
      }, true);
    });
  agents.command("edit").argument("<agent>").option("--task <task>").option("--model <model>").option("--default-model").option("--credential-kind <kind>").option("--default-credential")
    .action(async function (this: Command, agent: string, options: AnyOptions) {
      await run(this, async ({ actions, sessionId }) => {
        const id = await actions.resolveFloorEntity(sessionId!, agent, "agent"); const body: AnyOptions = {};
        if (options.task != null) body.task = options.task;
        if (options.model != null || options.defaultModel) body.model = options.defaultModel ? null : options.model;
        if (options.credentialKind != null || options.defaultCredential) body.credentialKind = options.defaultCredential ? null : options.credentialKind;
        return actions.patch(`/api/sessions/${sessionId!}/agents/${id}`, body);
      }, true);
    });
  agentToggle(agents, "pause", true); agentToggle(agents, "resume", false);
  for (const name of ["stop", "delete"] as const) {
    agents.command(name).argument("<agent>").action(async function (this: Command, agent: string) {
      if (name === "delete") await confirm(this, "Delete this persistent agent?");
      await run(this, async ({ actions, sessionId }) => {
        const id = await actions.resolveFloorEntity(sessionId!, agent, "agent");
        return name === "stop" ? actions.post(`/api/sessions/${sessionId!}/agents/${id}/stop`) : actions.delete(`/api/sessions/${sessionId!}/agents/${id}`);
      }, true);
    });
  }
  for (const name of ["pause-all", "resume-all", "stop-all"]) agents.command(name).action(async function (this: Command) { await run(this, ({ actions, sessionId }) => actions.post(`/api/sessions/${sessionId!}/agents/${name}`), true); });

  const assignments = program.command("assignments");
  assignments.command("set").argument("<member>").argument("<task>").action(async function (this: Command, member: string, task: string) {
    await run(this, async ({ actions, sessionId }) => { const props = (await actions.session(sessionId!)).props; return actions.patch(`/api/sessions/${sessionId!}/assignments/${resolveId(member, props.initialMembers, "Member")}`, { task }); }, true);
  });
  assignments.command("clear").argument("<member>").action(async function (this: Command, member: string) {
    await run(this, async ({ actions, sessionId }) => { const props = (await actions.session(sessionId!)).props; return actions.patch(`/api/sessions/${sessionId!}/assignments/${resolveId(member, props.initialMembers, "Member")}`, { task: null }); }, true);
  });

  const routing = program.command("routing");
  routing.command("show").action(async function (this: Command) { await run(this, async ({ actions, sessionId }) => { const floor = (await actions.floor(sessionId!)).props.initialFloor; return { autoDispatch: floor.autoDispatch, autoProvisionAgents: floor.autoProvisionAgents, autoResolveConflicts: floor.autoResolveConflicts, autoAgentProvider: (floor as AnyOptions).autoAgentProvider }; }, true); });
  routing.command("set").option("--auto-dispatch <boolean>").option("--auto-agents <boolean>").option("--auto-conflicts <boolean>").option("--provider <provider>")
    .action(async function (this: Command, options: AnyOptions) {
      await run(this, ({ actions, sessionId }) => actions.patch(`/api/sessions/${sessionId!}/routing`, compact({ autoDispatch: bool(options.autoDispatch), autoProvisionAgents: bool(options.autoAgents), autoResolveConflicts: bool(options.autoConflicts), autoAgentProvider: options.provider })), true);
    });
}

function agentToggle(group: Command, name: string, paused: boolean): void {
  group.command(name).argument("<agent>").action(async function (this: Command, agent: string) {
    await run(this, async ({ actions, sessionId }) => actions.patch(`/api/sessions/${sessionId!}/agents/${await actions.resolveFloorEntity(sessionId!, agent, "agent")}/pause`, { paused }), true);
  });
}

function registerQueueTeam(program: Command): void {
  const queue = program.command("queue");
  queue.command("list").action(async function (this: Command) { await run(this, async ({ actions, sessionId }) => (await actions.floor(sessionId!)).props.initialFloor.queue, true); });
  queue.command("show").argument("<item>").action(async function (this: Command, item: string) { await run(this, async ({ actions, sessionId }) => { const floor = (await actions.floor(sessionId!)).props.initialFloor; const id = await actions.resolveFloorEntity(sessionId!, item, "queue"); return floor.queue.find((value) => value.id === id); }, true); });
  queue.command("add").argument("[prompt]").option("--file <path>").option("--agent <id>")
    .action(async function (this: Command, prompt: string | undefined, options: AnyOptions) {
      await run(this, async ({ actions, sessionId }) => actions.post(`/api/sessions/${sessionId!}/queue`, { prompt: await actions.readTextInput(prompt, options.file), agentId: options.agent ? await actions.resolveFloorEntity(sessionId!, options.agent, "agent") : null }), true);
    });
  queue.command("target").argument("<item>").argument("<agent>").action(async function (this: Command, item: string, agent: string) { await run(this, async ({ actions, sessionId }) => actions.patch(`/api/sessions/${sessionId!}/queue/${await actions.resolveFloorEntity(sessionId!, item, "queue")}`, { agentId: await actions.resolveFloorEntity(sessionId!, agent, "agent") }), true); });
  queue.command("edit").argument("<item>").argument("<prompt-id>").argument("[text]").option("--file <path>").action(async function (this: Command, item: string, promptId: string, text: string | undefined, options: AnyOptions) { await run(this, async ({ actions, sessionId }) => actions.patch(`/api/sessions/${sessionId!}/queue/${await actions.resolveFloorEntity(sessionId!, item, "queue")}/prompts/${encodeURIComponent(promptId)}`, { text: await actions.readTextInput(text, options.file) }), true); });
  for (const [name, paused] of [["pause", true], ["resume", false]] as const) queue.command(name).argument("<item>").action(async function (this: Command, item: string) { await run(this, async ({ actions, sessionId }) => actions.patch(`/api/sessions/${sessionId!}/queue/${await actions.resolveFloorEntity(sessionId!, item, "queue")}/pause`, { paused }), true); });
  queue.command("delete").argument("<item>").action(async function (this: Command, item: string) { await confirm(this, "Delete this queued item?"); await run(this, async ({ actions, sessionId }) => actions.delete(`/api/sessions/${sessionId!}/queue/${await actions.resolveFloorEntity(sessionId!, item, "queue")}`), true); });
  queue.command("move").argument("<item>").requiredOption("--to <position>").action(async function (this: Command, item: string, options: AnyOptions) { await run(this, async ({ actions, sessionId }) => { const floor = (await actions.floor(sessionId!)).props.initialFloor; const id = await actions.resolveFloorEntity(sessionId!, item, "queue"); const ids = floor.queue.map((value) => value.id).filter((value) => value !== id); const position = Math.max(0, Math.min(ids.length, Number(options.to) - 1)); ids.splice(position, 0, id); return actions.patch(`/api/sessions/${sessionId!}/queue/order`, { itemIds: ids }); }, true); });
  queue.command("run").argument("<item>").action(async function (this: Command, item: string) { await run(this, async ({ actions, sessionId }) => actions.post(`/api/sessions/${sessionId!}/queue/${await actions.resolveFloorEntity(sessionId!, item, "queue")}/run`), true); });

  const chat = program.command("chat");
  chat.command("list").option("--to <member>").action(async function (this: Command, options: AnyOptions) { await run(this, async ({ actions, sessionId }) => { const props = (await actions.floor(sessionId!)).props; const target = options.to ? resolveId(options.to, props.initialMembers, "Member") : null; return props.initialFloor.messages.filter((message: any) => target ? message.recipientUserId === target || (message.authorUserId === target && message.recipientUserId === props.user.id) : message.recipientUserId == null); }, true); });
  chat.command("send").argument("[text]").option("--file <path>").option("--to <member>").option("--attach <path...>")
    .action(async function (this: Command, text: string | undefined, options: AnyOptions) { await run(this, async ({ actions, sessionId }) => { let attachmentIds: string[] = []; if (options.attach?.length) { const upload = await actions.uploadFiles(sessionId!, options.attach); attachmentIds = upload.fileIds as string[] ?? []; } const props = (await actions.session(sessionId!)).props; const recipientUserId = options.to ? resolveId(options.to, props.initialMembers, "Member") : null; return actions.post(`/api/sessions/${sessionId!}/messages`, { text: await actions.readTextInput(text, options.file), recipientUserId, attachmentIds }); }, true); });

  const files = program.command("files");
  files.command("list").action(async function (this: Command) { await run(this, async ({ actions, sessionId }) => (await actions.floor(sessionId!)).props.initialFloor.files, true); });
  files.command("upload").argument("<paths...>").action(async function (this: Command, paths: string[]) { await run(this, ({ actions, sessionId }) => actions.uploadFiles(sessionId!, paths), true); });
  files.command("download").argument("<file>").option("--output <path>").action(async function (this: Command, file: string, options: AnyOptions) { await run(this, async ({ actions, sessionId }) => { const floor = (await actions.floor(sessionId!)).props.initialFloor; const id = resolveId(file, floor.files as any, "File"); const record = (floor.files as any[]).find((value) => value.id === id); return actions.download(sessionId!, id, options.output || basename(record?.name || id)); }, true); });
}

function registerRunsConflicts(program: Command): void {
  const runs = program.command("runs");
  runs.command("list").action(async function (this: Command) { await run(this, async ({ actions, sessionId }) => (await actions.floor(sessionId!)).props.initialFloor.runs, true); });
  runs.command("show").argument("<run>").action(async function (this: Command, value: string) { await run(this, async ({ actions, sessionId }) => { const floor = (await actions.floor(sessionId!)).props.initialFloor; const id = await actions.resolveFloorEntity(sessionId!, value, "run"); return floor.runs.find((item) => item.id === id); }, true); });
  runs.command("watch").argument("<run>").option("--interval <ms>", "poll interval", "1000").action(async function (this: Command, value: string, options: AnyOptions) {
    const ctx = await context(this, true); const runId = await ctx.actions.resolveFloorEntity(ctx.sessionId!, value, "run"); let after = 0; const abort = new AbortController();
    const interrupt = () => abort.abort(); process.once("SIGINT", interrupt);
    try {
      while (!abort.signal.aborted) {
        const result = await ctx.actions.events(ctx.sessionId!, runId, after);
        for (const event of result.events) { after = Math.max(after, event.sequence); if (ctx.options.json) writeResult(event, ctx.options); else stdout.write(`[${event.kind}] ${event.detail}\n`); }
        const floor = (await ctx.actions.floor(ctx.sessionId!)).props.initialFloor; const current = floor.runs.find((item) => item.id === runId);
        if (!current || ["integrated", "ready", "conflicted", "failed", "cancelled"].includes(current.status)) { writeResult(current ?? { runId, status: "missing" }, ctx.options); break; }
        await new Promise((resolve) => setTimeout(resolve, Math.max(250, Number(options.interval))));
      }
      if (abort.signal.aborted) process.exitCode = 130;
    } finally { process.off("SIGINT", interrupt); }
  });
  for (const name of ["cancel", "retry", "discard"] as const) runs.command(name).argument("<run>").action(async function (this: Command, value: string) { if (name === "discard") await confirm(this, "Discard this run branch using its expected-SHA lease?"); await run(this, async ({ actions, sessionId }) => actions.post(`/api/sessions/${sessionId!}/runs/${await actions.resolveFloorEntity(sessionId!, value, "run")}/${name}`), true); });
  runs.command("rollback").argument("<run>").action(async function (this: Command, value: string) { await confirm(this, "Roll back this integrated run from the current candidate?"); await run(this, async ({ actions, sessionId }) => actions.post(`/api/sessions/${sessionId!}/runs/${await actions.resolveFloorEntity(sessionId!, value, "run")}/rollback`), true); });
  runs.command("artifacts").argument("<run>").option("--kind <kind>").action(async function (this: Command, value: string, options: AnyOptions) { await run(this, async ({ actions, sessionId }) => actions.text(`/api/sessions/${sessionId!}/runs/${await actions.resolveFloorEntity(sessionId!, value, "run")}/artifacts${options.kind ? `?kind=${encodeURIComponent(options.kind)}` : ""}`), true); });

  const conflicts = program.command("conflicts");
  conflicts.command("list").action(async function (this: Command) { await run(this, async ({ actions, sessionId }) => ((await actions.floor(sessionId!)).props.initialFloor.review as AnyOptions)?.conflicts ?? [], true); });
  conflicts.command("show").argument("<case>").action(async function (this: Command, value: string) { await run(this, async ({ actions, sessionId }) => { const cases = (((await actions.floor(sessionId!)).props.initialFloor.review as AnyOptions)?.conflicts ?? []) as any[]; return cases.find((item) => item.id === resolveId(value, cases, "Conflict")); }, true); });
  conflicts.command("answer").argument("<case>").requiredOption("--answer <questionId=answer...>").action(async function (this: Command, value: string, options: AnyOptions) { await run(this, async ({ actions, sessionId }) => { const cases = (((await actions.floor(sessionId!)).props.initialFloor.review as AnyOptions)?.conflicts ?? []) as any[]; const id = resolveId(value, cases, "Conflict"); const answers = ([] as string[]).concat(options.answer).map((entry) => { const index = entry.indexOf("="); if (index < 1) throw new OpenFloorError("Answers use questionId=answer", "usage"); return { questionId: entry.slice(0, index), answer: entry.slice(index + 1) }; }); return actions.post(`/api/sessions/${sessionId!}/conflicts/${id}/answers`, { answers }); }, true); });
  conflicts.command("resolve").argument("<case>").action(async function (this: Command, value: string) { await run(this, async ({ actions, sessionId }) => { const cases = (((await actions.floor(sessionId!)).props.initialFloor.review as AnyOptions)?.conflicts ?? []) as any[]; return actions.post(`/api/sessions/${sessionId!}/conflicts/${resolveId(value, cases, "Conflict")}/resolve`); }, true); });
}

function registerRepository(program: Command): void {
  const repo = program.command("repository");
  repo.command("show").action(async function (this: Command) { await run(this, ({ actions, sessionId }) => actions.get(`/api/sessions/${sessionId!}/repository`), true); });
  repo.command("options").action(async function (this: Command) { await run(this, ({ actions, sessionId }) => actions.get(`/api/sessions/${sessionId!}/repository/options`), true); });
  repo.command("connect").option("--repository <id>").option("--installation <id>").option("--base <branch>").action(async function (this: Command, options: AnyOptions) {
    await run(this, ({ actions, sessionId }) => {
      if (!options.repository && !options.installation && !options.base) return actions.post(`/api/sessions/${sessionId!}/repository/connect`);
      if (!options.repository || !options.installation || !options.base) throw new OpenFloorError("Initial connection requires --repository, --installation, and --base", "usage");
      return actions.post(`/api/sessions/${sessionId!}/repository`, { repositoryId: options.repository, accountInstallationId: options.installation, baseBranch: options.base });
    }, true);
  });
  repo.command("configure").requiredOption("--repository <id>").requiredOption("--base <branch>").action(async function (this: Command, options: AnyOptions) { await run(this, ({ actions, sessionId }) => actions.patch(`/api/sessions/${sessionId!}/repository`, { repositoryId: options.repository, baseBranch: options.base }), true); });
  repo.command("disconnect").action(async function (this: Command) { await confirm(this, "Disconnect this session repository?"); await run(this, ({ actions, sessionId }) => actions.delete(`/api/sessions/${sessionId!}/repository`), true); });
  repo.command("sync").action(async function (this: Command) { await run(this, ({ actions, sessionId }) => actions.post(`/api/sessions/${sessionId!}/repository/sync`), true); });
  repo.command("tree").option("--cursor <cursor>").action(async function (this: Command, options: AnyOptions) { await run(this, ({ actions, sessionId }) => actions.get(`/api/sessions/${sessionId!}/repository/tree${options.cursor ? `?cursor=${encodeURIComponent(options.cursor)}` : ""}`), true); });
  repo.command("cat").argument("<path>").action(async function (this: Command, path: string) { await run(this, ({ actions, sessionId }) => actions.get(`/api/sessions/${sessionId!}/repository/file?path=${encodeURIComponent(path)}`), true); });
  const candidate = repo.command("candidate");
  candidate.command("show").action(async function (this: Command) { await run(this, async ({ actions, sessionId }) => (await actions.floor(sessionId!)).props.initialFloor.activeCandidate, true); });
  candidate.command("create").requiredOption("--name <name>").option("--description <description>").action(async function (this: Command, options: AnyOptions) { await run(this, ({ actions, sessionId }) => actions.post(`/api/sessions/${sessionId!}/repository/candidate`, { name: options.name, description: options.description ?? "" }), true); });
  candidate.command("abandon").option("--delete-branch").action(async function (this: Command, options: AnyOptions) { await confirm(this, `Abandon candidate${options.deleteBranch ? " and delete its verified branch" : ""}?`); await run(this, ({ actions, sessionId }) => actions.delete(`/api/sessions/${sessionId!}/repository/candidate`, { deleteBranch: Boolean(options.deleteBranch) }), true); });
  const preflight = repo.command("preflight");
  preflight.command("show").action(async function (this: Command) { await run(this, ({ actions, sessionId }) => actions.get(`/api/sessions/${sessionId!}/repository/preflight`), true); });
  preflight.command("start").action(async function (this: Command) { await run(this, ({ actions, sessionId }) => actions.post(`/api/sessions/${sessionId!}/repository/preflight`), true); });
  const showPreflightLogs = async (command: Command, id: string) => run(command, ({ actions, sessionId }) => actions.text(`/api/sessions/${sessionId!}/repository/preflight/${encodeURIComponent(id)}/logs`), true);
  preflight.command("logs").argument("<preflight>").action(async function (this: Command, id: string) { await showPreflightLogs(this, id); });
  repo.command("logs").argument("<preflight>").action(async function (this: Command, id: string) { await showPreflightLogs(this, id); });
}

function registerSkillsMcp(program: Command): void {
  const skills = program.command("skills");
  skills.command("list").action(async function (this: Command) { await run(this, ({ actions, sessionId }) => actions.get(`/api/sessions/${sessionId!}/skills`), true); });
  skills.command("add").argument("<file>").action(async function (this: Command, file: string) { await run(this, async ({ actions, sessionId }) => actions.post(`/api/sessions/${sessionId!}/skills`, { content: await actions.readTextInput(undefined, file) }), true); });
  skills.command("remove").argument("<id>").action(async function (this: Command, id: string) { await confirm(this, "Remove this session skill?"); await run(this, ({ actions, sessionId }) => actions.delete(`/api/sessions/${sessionId!}/skills/${encodeURIComponent(id)}`), true); });

  const mcp = program.command("mcp");
  mcp.command("list").action(async function (this: Command) { await run(this, ({ actions, sessionId }) => actions.get(`/api/sessions/${sessionId!}/mcp-servers`), true); });
  mcp.command("add").requiredOption("--name <name>").requiredOption("--transport <type>").requiredOption("--url <url>").option("--headers-file <path>", "JSON object; use - for stdin").option("--disabled")
    .action(async function (this: Command, options: AnyOptions) { await run(this, async ({ actions, sessionId }) => actions.post(`/api/sessions/${sessionId!}/mcp-servers`, { name: options.name, transport: options.transport, url: options.url, headers: await readSecretHeaders(actions, options.headersFile), enabled: !options.disabled }), true); });
  mcp.command("edit").argument("<id>").option("--url <url>").option("--transport <type>").option("--headers-file <path>", "JSON object; use - for stdin").option("--enabled <boolean>")
    .action(async function (this: Command, id: string, options: AnyOptions) { await run(this, async ({ actions, sessionId }) => actions.patch(`/api/sessions/${sessionId!}/mcp-servers/${encodeURIComponent(id)}`, compact({ transport: options.transport, url: options.url, headers: options.headersFile ? await readSecretHeaders(actions, options.headersFile) : undefined, enabled: bool(options.enabled) })), true); });
  mcp.command("remove").argument("<id>").action(async function (this: Command, id: string) { await confirm(this, "Remove this MCP server?"); await run(this, ({ actions, sessionId }) => actions.delete(`/api/sessions/${sessionId!}/mcp-servers/${encodeURIComponent(id)}`), true); });
}

function registerReview(program: Command): void {
  const review = program.command("review");
  review.command("status").action(async function (this: Command) { await run(this, async ({ actions, sessionId }) => (await actions.floor(sessionId!)).props.initialFloor.review, true); });
  review.command("prompts").option("--cursor <cursor>").option("--history").action(async function (this: Command, options: AnyOptions) { await run(this, ({ actions, sessionId }) => actions.get(`/api/sessions/${sessionId!}/review/contributions?status=${options.history ? "rolled_back" : "active"}${options.cursor ? `&cursor=${encodeURIComponent(options.cursor)}` : ""}`), true); });
  review.command("files").option("--cursor <cursor>").option("--history").action(async function (this: Command, options: AnyOptions) { await run(this, async ({ actions, sessionId }) => {
    const page = await actions.get(`/api/sessions/${sessionId!}/review/contributions?status=${options.history ? "rolled_back" : "active"}${options.cursor ? `&cursor=${encodeURIComponent(options.cursor)}` : ""}`);
    const items = Array.isArray(page.items) ? page.items as AnyOptions[] : [];
    return { ...page, files: items.flatMap((item) => Array.isArray(item.files) ? item.files.map((file) => ({ ...(file as AnyOptions), runId: item.runId, agentName: item.agentName })) : []) };
  }, true); });
  review.command("diff").argument("<run>").action(async function (this: Command, runValue: string) { await run(this, async ({ actions, sessionId }) => actions.get(`/api/sessions/${sessionId!}/review/contributions/${await actions.resolveFloorEntity(sessionId!, runValue, "run")}`), true); });
  review.command("rollback-impact").requiredOption("--scope <scope>").requiredOption("--subject <id>").action(async function (this: Command, options: AnyOptions) { await run(this, async ({ actions, sessionId }) => { const subjectId = await resolveRollbackSubject(actions, sessionId!, options.scope, options.subject); return actions.get(`/api/sessions/${sessionId!}/review/rollback-impact?scope=${encodeURIComponent(options.scope)}&subjectId=${encodeURIComponent(subjectId)}`); }, true); });
  review.command("rollback").requiredOption("--scope <scope>").requiredOption("--subject <id>").action(async function (this: Command, options: AnyOptions) {
    const ctx = await context(this, true); const subjectId = await resolveRollbackSubject(ctx.actions, ctx.sessionId!, options.scope, options.subject); const impactResult = await ctx.actions.get(`/api/sessions/${ctx.sessionId!}/review/rollback-impact?scope=${encodeURIComponent(options.scope)}&subjectId=${encodeURIComponent(subjectId)}`); const impact = impactResult.impact as AnyOptions;
    writeResult(impact, ctx.options); await confirm(this, `Remove ${impact?.runs?.length ?? "selected"} integrated contribution group(s) from candidate ${impact?.expectedCandidateSha ?? ""}?`);
    const expectedRunIds = Array.isArray(impact.targets) ? impact.targets.map((target: AnyOptions) => target.runId).filter((id: unknown): id is string => typeof id === "string") : [];
    writeResult(await ctx.actions.post(`/api/sessions/${ctx.sessionId!}/review/rollbacks`, { scope: options.scope, subjectId, expectedCandidateSha: impact.expectedCandidateSha, expectedRunIds }), ctx.options);
  });
  review.command("ready").action(async function (this: Command) { await confirm(this, "Mark the draft pull request ready for review?"); await run(this, ({ actions, sessionId }) => actions.post(`/api/sessions/${sessionId!}/review/ready`), true); });
  review.command("merge").option("--delete-candidate-branch").action(async function (this: Command, options: AnyOptions) { const ctx = await context(this, true); const state = (await ctx.actions.floor(ctx.sessionId!)).props.initialFloor.review; writeResult(state, ctx.options); await confirm(this, "Squash merge the current expected GitHub head and end this session?"); writeResult(await ctx.actions.post(`/api/sessions/${ctx.sessionId!}/review/merge`, { deleteCandidateBranch: Boolean(options.deleteCandidateBranch) }), ctx.options); });
  review.command("delete-branch").action(async function (this: Command) { await confirm(this, "Delete the verified review branch?"); await run(this, ({ actions, sessionId }) => actions.delete(`/api/sessions/${sessionId!}/review/branch`), true); });
}

function registerWeb(program: Command): void {
  const web = program.command("web");
  const paths: Record<string, string> = { onboarding: "/onboarding", settings: "/home/settings", billing: "/home/settings?section=plan", connections: "/home/settings?section=connections", github: "/home/settings?section=connections" };
  for (const [name, path] of Object.entries(paths)) web.command(name).action(async function (this: Command) { const ctx = await context(this); await open(`${ctx.baseUrl}${path}`); writeResult({ opened: `${ctx.baseUrl}${path}` }, ctx.options); });
}

function registerDoctor(program: Command): void {
  program.command("doctor").action(async function (this: Command) {
    const ctx = await context(this); const checks: AnyOptions[] = [{ check: "node", ok: Number(process.versions.node.split(".")[0]) >= 22, value: process.version }];
    if (new URL(ctx.baseUrl).hostname === "localhost" || new URL(ctx.baseUrl).hostname === "127.0.0.1") checks.push({ check: "cloudflared", ok: true, value: "skipped for loopback" });
    else {
      const binary = process.env.OPENFLOOR_CLOUDFLARED || "cloudflared";
      try { const result = await exec(binary, ["--version"], { timeout: 10_000 }); checks.push({ check: "cloudflared", ok: true, value: result.stdout.trim() || binary }); }
      catch (error) { checks.push({ check: "cloudflared", ok: false, value: error instanceof Error ? error.message : String(error) }); }
    }
    try { const me = await ctx.actions.me(); checks.push({ check: "api", ok: true, value: me.user.email }); }
    catch (error) { checks.push({ check: "api", ok: false, value: error instanceof Error ? error.message : String(error) }); }
    writeResult(checks, ctx.options); if (checks.some((check) => !check.ok)) process.exitCode = 6;
  });
}

function bool(value: unknown): boolean | undefined {
  if (value == null) return undefined;
  if (value === true || value === "true" || value === "on" || value === "1") return true;
  if (value === false || value === "false" || value === "off" || value === "0") return false;
  const shown = typeof value === "string" || typeof value === "number" || typeof value === "bigint" || typeof value === "boolean" || typeof value === "symbol"
    ? String(value) : JSON.stringify(value);
  throw new OpenFloorError(`Expected boolean, got ${shown ?? "unknown"}`, "usage");
}

function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

async function readSecretHeaders(actions: OpenFloorActions, path: unknown): Promise<Record<string, string>> {
  if (path === undefined) return {};
  if (typeof path !== "string") throw new OpenFloorError("--headers-file requires a path or -", "usage");
  const text = await actions.readTextInput(undefined, path === "-" ? undefined : path);
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new OpenFloorError("MCP headers file must contain a JSON object", "usage"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.entries(value).some(([name, entry]) => !name.trim() || typeof entry !== "string")) {
    throw new OpenFloorError("MCP headers file must map header names to string values", "usage");
  }
  return value as Record<string, string>;
}

async function resolveRollbackSubject(actions: OpenFloorActions, sessionId: string, scope: unknown, value: unknown): Promise<string> {
  if (typeof scope !== "string" || !["prompt", "engineer", "agent"].includes(scope) || typeof value !== "string") throw new OpenFloorError("Rollback scope must be prompt, engineer, or agent", "usage");
  if (scope === "prompt") return actions.resolveFloorEntity(sessionId, value, "run");
  if (scope === "agent") return actions.resolveFloorEntity(sessionId, value, "agent");
  const members = (await actions.session(sessionId)).props.initialMembers;
  return resolveId(value, members, "Member");
}

export async function chooseRepository(repositories: RepositoryOption[], selector: unknown, installation: unknown): Promise<RepositoryOption> {
  const installationId = typeof installation === "string" ? installation.trim() : null;
  const available = installationId ? repositories.filter((item) => item.accountInstallationId === installationId) : repositories;
  if (!available.length) throw new OpenFloorError("No account-authorized repositories are available. Run `openfloor web github`.", "conflict");
  if (typeof selector === "string" && selector.trim()) {
    const value = selector.trim().toLowerCase();
    const exact = available.filter((item) => item.id.toLowerCase() === value || item.fullName.toLowerCase() === value);
    if (exact.length === 1) return exact[0]!;
    const prefix = available.filter((item) => item.id.toLowerCase().startsWith(value));
    if (prefix.length === 1) return prefix[0]!;
    throw new OpenFloorError(exact.length > 1 || prefix.length > 1 ? "Repository selection is ambiguous" : "Repository is not available", "usage");
  }
  if (available.length === 1) return available[0]!;
  if (!stdin.isTTY || !stderr.isTTY) throw new OpenFloorError("Multiple repositories are available; pass --repository <owner/name>", "usage");
  stderr.write("Choose a repository:\n");
  for (const [index, repository] of available.entries()) {
    stderr.write(`  ${index + 1}. ${repository.fullName} (${repository.private ? "private" : "public"}, ${repository.defaultBranch})\n`);
  }
  const prompt = createInterface({ input: stdin, output: stderr });
  try {
    const answer = await prompt.question(`Repository [1-${available.length}]: `);
    const index = Number(answer) - 1;
    if (!Number.isInteger(index) || !available[index]) throw new OpenFloorError("Choose a listed repository number", "usage");
    return available[index];
  } finally { prompt.close(); }
}
