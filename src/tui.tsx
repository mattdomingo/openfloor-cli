import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { TextInput } from "@inkjs/ui";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import React, { useEffect, useMemo, useState } from "react";
import type { OpenFloorActions } from "./actions.js";
import type { ApiClient } from "./client.js";
import type { FloorSnapshot, SessionSummary } from "./contracts.js";
import { shortId } from "./id.js";
import { PresenceClient, type ConnectionStatus, type PresenceEvent, type TypingDraft } from "./realtime.js";
import { sanitizeTerminal } from "./sanitize.js";
import { updateConfig } from "./config.js";

const exec = promisify(execFile);
const tabs = ["Overview", "Agents", "Queue", "Team", "Review", "Repository", "Settings"] as const;
type Tab = typeof tabs[number];
type Overlay = { kind: "help" } | { kind: "palette"; initial?: string } | { kind: "filter" } | { kind: "compose"; target: "queue" | "chat" } | { kind: "output"; text: string } | null;

export type TuiProps = { actions: OpenFloorActions; client: ApiClient; baseUrl: string; initialSessionId?: string };

export function startTui(props: TuiProps): React.ReactElement {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, retry: false } } });
  return <QueryClientProvider client={queryClient}><App {...props} /></QueryClientProvider>;
}

function App({ actions, client, baseUrl, initialSessionId }: TuiProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [width, setWidth] = useState(stdout.columns || 80);
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId ?? null);
  const [selected, setSelected] = useState(0);
  const [tab, setTab] = useState<Tab>("Overview");
  const [filter, setFilter] = useState("");
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionStatus>("closed");
  const [online, setOnline] = useState(new Set<string>());
  const [drafts, setDrafts] = useState<TypingDraft[]>([]);
  const [activities, setActivities] = useState<Record<string, Array<{ sequence: number; kind: string; detail: string }>>>({});
  const query = useQuery({ queryKey: ["home"], queryFn: () => actions.home() });
  const sessionQuery = useQuery({ queryKey: ["session", sessionId], queryFn: () => actions.session(sessionId!), enabled: Boolean(sessionId) });
  const floorQuery = useQuery({ queryKey: ["floor", sessionId], queryFn: () => actions.floor(sessionId!), enabled: Boolean(sessionId), refetchInterval: connection === "live" ? false : 10_000 });
  const repoTreeQuery = useQuery({ queryKey: ["tree", sessionId], queryFn: () => actions.get(`/api/sessions/${sessionId}/repository/tree`), enabled: Boolean(sessionId && tab === "Repository") });
  const skillsQuery = useQuery({ queryKey: ["skills", sessionId], queryFn: () => actions.get(`/api/sessions/${sessionId}/skills`), enabled: Boolean(sessionId && tab === "Settings") });
  const mcpQuery = useQuery({ queryKey: ["mcp", sessionId], queryFn: () => actions.get(`/api/sessions/${sessionId}/mcp-servers`), enabled: Boolean(sessionId && tab === "Settings") });
  const queryClient = useQueryClient();

  useEffect(() => {
    const resize = () => setWidth(stdout.columns || 80);
    stdout.on("resize", resize); return () => { stdout.off("resize", resize); };
  }, [stdout]);

  useEffect(() => {
    if (!sessionId) return;
    const presence = new PresenceClient(client, sessionId);
    presence.on("status", setConnection);
    presence.on("event", (event: PresenceEvent) => {
      if (event.type === "presence.snapshot") { setOnline(new Set(event.onlineUserIds)); setDrafts(event.typingDrafts); }
      else if (event.type === "presence.changed") setOnline((current) => { const next = new Set(current); if (event.online) next.add(event.userId); else next.delete(event.userId); return next; });
      else if (event.type === "typing.changed") setDrafts((current) => [...current.filter((item) => item.userId !== event.draft.userId), event.draft].filter((item) => item.text));
      else if (event.type === "floor.changed") void queryClient.invalidateQueries({ queryKey: ["floor", sessionId] });
      else if (event.type === "members.changed" || event.type === "session.changed" || event.type === "session.locked") void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
      else if (event.type === "session.ended") { setNotice(`Session ended: ${event.reason}`); void queryClient.invalidateQueries({ queryKey: ["home"] }); }
      else if (event.type === "run.activity") setActivities((current) => { const existing = current[event.runId] ?? []; const all = [...existing, ...event.events].sort((a, b) => a.sequence - b.sequence); return { ...current, [event.runId]: all.filter((item, index) => index === 0 || item.sequence !== all[index - 1]!.sequence).slice(-100) }; });
    });
    presence.on("close", ({ code, reason }) => { if (code === 4001 || code === 4005) { setNotice(reason || "Membership ended"); setSessionId(null); void queryClient.invalidateQueries({ queryKey: ["home"] }); } });
    void presence.connect().catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
    (globalThis as any).__openfloorPresence = presence;
    return () => { presence.sendDraft("", false); presence.close(); delete (globalThis as any).__openfloorPresence; };
  }, [actions, client, queryClient, sessionId]);

  const sessions = useMemo(() => {
    const values = query.data?.props.sessions ?? [];
    return values.filter((item) => `${item.title} ${item.objective ?? ""} ${item.id}`.toLowerCase().includes(filter.toLowerCase()));
  }, [filter, query.data]);

  useInput((input, key) => {
    const presence = (globalThis as any).__openfloorPresence as PresenceClient | undefined; presence?.noteInput();
    if (overlay) { if (key.escape) setOverlay(null); return; }
    if (input === "q") { exit(); return; }
    if (input === "?") { setOverlay({ kind: "help" }); return; }
    if (key.ctrl && input === "k") { setOverlay({ kind: "palette" }); return; }
    if (input === "r") { void query.refetch(); if (sessionId) { void sessionQuery.refetch(); void floorQuery.refetch(); } return; }
    if (!sessionId) {
      if (key.upArrow) setSelected((value) => Math.max(0, value - 1));
      if (key.downArrow) setSelected((value) => Math.min(Math.max(0, sessions.length - 1), value + 1));
      if (key.return && sessions[selected]) { const id = sessions[selected].id; setSessionId(id); setTab("Overview"); void updateConfig({ currentSessionId: id }); }
      if (input === "/") setOverlay({ kind: "filter" });
      if (input === "n") setOverlay({ kind: "palette", initial: "sessions create --title " });
    } else {
      if (key.escape) { setSessionId(null); void query.refetch(); return; }
      if (key.tab) { const index = tabs.indexOf(tab); setTab(tabs[(index + (key.shift ? tabs.length - 1 : 1)) % tabs.length]!); }
      if (input === "n" && tab === "Queue") setOverlay({ kind: "compose", target: "queue" });
      if (input === "c" && tab === "Team") setOverlay({ kind: "compose", target: "chat" });
      if (input === "e") setOverlay({ kind: "palette", initial: tab === "Overview" ? "sessions show" : `${tab.toLowerCase()} ` });
    }
  });

  if (width < 60) return <Box flexDirection="column"><Text bold color="red">Terminal too narrow ({width} columns)</Text><Text>Resize to at least 60 columns or use subcommands.</Text></Box>;
  if (query.isLoading) return <Text color="cyan">Loading openfloor…</Text>;
  if (query.error) return <ErrorView error={query.error} />;

  return <Box flexDirection="column" width="100%">
    <Header {...(sessionQuery.data?.props.session ? { session: sessionQuery.data.props.session } : {})} connection={connection} />
    {notice && <Text color="yellow">{notice}</Text>}
    {!sessionId ? <Home sessions={sessions} selected={selected} usage={query.data?.props.usage} /> :
      <SessionView width={width} tab={tab} members={sessionQuery.data?.props.initialMembers ?? []} {...(floorQuery.data?.props.initialFloor ? { floor: floorQuery.data.props.initialFloor } : {})} online={online} drafts={drafts} activities={activities} tree={repoTreeQuery.data} skills={skillsQuery.data} mcp={mcpQuery.data} />}
    <Footer session={Boolean(sessionId)} />
    {overlay && <OverlayView overlay={overlay} sessionId={sessionId} baseUrl={baseUrl} actions={actions} presence={(globalThis as any).__openfloorPresence} close={() => { setOverlay(null); void query.refetch(); void floorQuery.refetch(); }} showOutput={(text) => setOverlay({ kind: "output", text })} setFilter={setFilter} />}
  </Box>;
}

function Header({ session, connection }: { session?: SessionSummary; connection: ConnectionStatus }) {
  return <Box borderStyle="round" borderColor="cyan" paddingX={1} justifyContent="space-between"><Text bold color="cyan">openfloor</Text><Text>{session ? `${session.title}  ` : ""}<Text color={connection === "live" ? "green" : connection === "quota-exhausted" ? "red" : "yellow"}>{connection}</Text></Text></Box>;
}

function Home({ sessions, selected, usage }: { sessions: SessionSummary[]; selected: number; usage: unknown }) {
  const groups = [
    ["Active", sessions.filter((session) => session.endedAt == null && session.archivedAt == null)],
    ["Archived", sessions.filter((session) => session.endedAt == null && session.archivedAt != null)],
    ["Ended", sessions.filter((session) => session.endedAt != null)],
  ] as const;
  return <Box flexDirection="column" paddingX={1}>
    <Text bold>Sessions</Text>
    {sessions.length === 0 ? <Text dimColor>No sessions.</Text> : groups.map(([label, values]) => values.length ? <Box key={label} flexDirection="column"><Text bold>{label}</Text>{values.map((session) => { const index = sessions.indexOf(session); return <Text key={session.id} {...(index === selected ? { color: "cyan" as const } : {})} inverse={index === selected}>{index === selected ? "›" : " "} {session.title.padEnd(28).slice(0, 28)} {shortId(session.id)} {session.role}</Text>; })}</Box> : null)}
    <Text dimColor>Usage: {JSON.stringify(usage)}</Text>
  </Box>;
}

function SessionView({ width, tab, members, floor, online, drafts, activities, tree, skills, mcp }: { width: number; tab: Tab; members: any[]; floor?: FloorSnapshot; online: Set<string>; drafts: TypingDraft[]; activities: Record<string, Array<{ sequence: number; kind: string; detail: string }>>; tree?: any; skills?: any; mcp?: any }) {
  if (!floor) return <Text color="cyan">Loading floor…</Text>;
  const narrow = width < 120;
  return <Box flexDirection={narrow ? "column" : "row"} minHeight={16}>
    <Box flexDirection={narrow ? "row" : "column"} width={narrow ? "100%" : 16} borderStyle="single" borderColor="gray" paddingX={1}>{tabs.map((name) => <Text key={name} {...(tab === name ? { color: "cyan" as const } : {})} bold={tab === name}>{narrow ? `${name} ` : name}</Text>)}</Box>
    <Box flexDirection="column" flexGrow={1} borderStyle="single" borderColor="gray" paddingX={1}>
      {tab === "Overview" && <><Text bold>Members</Text>{members.map((member) => <Text key={member.id} {...(online.has(member.id) ? { color: "green" as const } : {})}>● {member.displayName} · {member.role}{online.has(member.id) ? " · online" : ""}</Text>)}<Text bold>Assignments</Text>{floor.assignments.map((item: any) => <Text key={item.userId}>{item.userName}: {item.task ?? "Unassigned"}</Text>)}</>}
      {tab === "Agents" && <>{floor.agents.length ? floor.agents.map((agent) => { const run = floor.runs.find((item) => item.agentId === agent.id); const live = run ? activities[run.id]?.at(-1) : undefined; return <Box key={agent.id} flexDirection="column" marginBottom={1}><Text bold color={agent.pausedAt ? "yellow" : "cyan"}>{agent.name} · {agent.provider}/{agent.model ?? "default"} · {agent.pausedAt ? "paused" : run?.status ?? "idle"}</Text><Text>{agent.role}: {agent.task}</Text>{live && <Text dimColor>[{live.kind}] {live.detail}</Text>}</Box>; }) : <Text dimColor>No agents.</Text>}</>}
      {tab === "Queue" && <>{floor.queue.length ? floor.queue.map((item) => <Box key={item.id} flexDirection="column"><Text color={item.status === "failed" ? "red" : item.status === "completed" ? "green" : "white"}>{String(item.position + 1).padStart(2)} {item.status.padEnd(10)} {item.agentName ?? "unassigned"} · {shortId(item.id)}</Text><Text dimColor>{item.prompts.map((prompt) => prompt.text).join(" / ").slice(0, 140)}</Text></Box>) : <Text dimColor>Queue empty. Press n to add.</Text>}</>}
      {tab === "Team" && <>{floor.messages.slice(-20).map((message: any) => <Text key={message.id}><Text bold>{message.authorName}</Text>{message.recipientUserId ? " → DM" : ""}: {message.text}</Text>)}{drafts.map((draft) => <Text key={draft.userId} color="yellow">{draft.displayName} typing: {draft.text}</Text>)}<Text dimColor>Press c to send team chat.</Text></>}
      {tab === "Review" && <ReviewView review={floor.review} runs={floor.runs} />}
      {tab === "Repository" && <><Text bold>{recordText(floor.repository, "repositoryFullName", "No repository")}</Text><Text>Candidate: {recordText(floor.activeCandidate, "branchName", "none")}</Text><Text>Preflight: {recordText(floor.latestPreflight, "status", "none")}</Text><Text bold>Tree</Text>{recordArray(tree, "entries", "tree").slice(0, 20).map((entry) => <Text key={recordText(entry, "path", "unknown")}>{recordText(entry, "type") === "tree" ? "▸" : "·"} {recordText(entry, "path")}</Text>)}</>}
      {tab === "Settings" && <><Text>Auto-dispatch: {String(floor.autoDispatch)} · Auto-agents: {String(floor.autoProvisionAgents)} · Auto-conflicts: {String(floor.autoResolveConflicts)}</Text><Text>Skills: {recordArray(skills, "skills").length} · MCP servers: {recordArray(mcp, "servers").length}</Text><Text dimColor>Ctrl+K exposes invite, member, repository, skill, MCP, lock, archive, end, and delete actions.</Text></>}
    </Box>
  </Box>;
}

function ReviewView({ review, runs }: { review: any; runs: any[] }) {
  if (!review) return <Text dimColor>No review available.</Text>;
  return <><Text bold>Candidate review</Text><Text>PR: {review.pullRequest?.url ?? "not created"} · checks {String(review.checksPassing ?? review.githubChecksPassing ?? "pending")}</Text><Text>Files: {review.files?.length ?? runs.flatMap((run) => run.files).length} · Conflicts: {review.conflicts?.length ?? 0}</Text>{runs.slice(-8).map((run) => <Text key={run.id}>{shortId(run.id)} {run.agentName} · {run.status} · {run.summary ?? ""}</Text>)}</>;
}

function Footer({ session }: { session: boolean }) { return <Box paddingX={1}><Text dimColor>{session ? "Tab views · n queue · c chat · Esc home · " : "↑↓ select · Enter open · n create · "}Ctrl+K commands · ? help · q quit</Text></Box>; }

function OverlayView({ overlay, sessionId, baseUrl, actions, presence, close, showOutput, setFilter }: { overlay: NonNullable<Overlay>; sessionId: string | null; baseUrl: string; actions: OpenFloorActions; presence?: PresenceClient; close: () => void; showOutput: (text: string) => void; setFilter: (value: string) => void }) {
  const [error, setError] = useState<string | null>(null);
  if (overlay.kind === "help") return <Modal title="Help"><Text>Arrow keys navigate. Tab changes session view. Ctrl+K runs every subcommand. n adds queue work. c sends team chat. Esc closes. q quits.</Text></Modal>;
  if (overlay.kind === "output") return <Modal title="Command output"><Text>{overlay.text.slice(-8_000)}</Text><Text dimColor>Esc closes.</Text></Modal>;
  if (overlay.kind === "filter") return <Modal title="Filter sessions"><TextInput placeholder="Title, objective, or ID" onSubmit={(value) => { setFilter(value); close(); }} /></Modal>;
  if (overlay.kind === "compose") return <Modal title={overlay.target === "queue" ? "Add queue prompt" : "Send team message"}><TextInput placeholder="Type and press Enter" onChange={(value) => { if (overlay.target === "queue") presence?.sendDraft(value); }} onSubmit={(value) => { void (async () => { try { if (!sessionId) return; if (overlay.target === "queue") { await actions.post(`/api/sessions/${sessionId}/queue`, { prompt: value, agentId: null }); presence?.sendDraft("", false); } else await actions.post(`/api/sessions/${sessionId}/messages`, { text: value, recipientUserId: null }); close(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } })(); }} />{error && <Text color="red">{error}</Text>}</Modal>;
  return <Modal title="Command palette"><TextInput {...(overlay.initial === undefined ? {} : { defaultValue: overlay.initial })} placeholder="queue add &quot;Fix tests&quot;" onSubmit={(value) => { void runPalette(value, sessionId, baseUrl).then(showOutput, (reason) => setError(reason instanceof Error ? reason.message : String(reason))); }} />{error && <Text color="red">{error}</Text>}<Text dimColor>Any subcommand; omit leading openfloor.</Text></Modal>;
}

function Modal({ title, children }: { title: string; children: React.ReactNode }) { return <Box position="absolute" marginLeft={4} marginTop={2} width="90%" flexDirection="column" borderStyle="double" borderColor="cyan" paddingX={1}><Text bold color="cyan">{title}</Text>{children}</Box>; }
function ErrorView({ error }: { error: unknown }) { return <Box flexDirection="column"><Text color="red" bold>Unable to load openfloor</Text><Text>{sanitizeTerminal(error instanceof Error ? error.message : String(error))}</Text><Text dimColor>Run openfloor auth login or openfloor doctor.</Text></Box>; }

function recordText(value: unknown, key: string, fallback = ""): string {
  if (!value || typeof value !== "object" || !(key in value)) return fallback;
  const entry = (value as Record<string, unknown>)[key];
  return typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean" ? String(entry) : fallback;
}

function recordArray(value: unknown, ...keys: string[]): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object") return [];
  for (const key of keys) {
    const entry = (value as Record<string, unknown>)[key];
    if (Array.isArray(entry)) return entry.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
  }
  return [];
}

async function runPalette(line: string, sessionId: string | null, baseUrl: string): Promise<string> {
  const args = tokenize(line);
  if (!args.length) return "No command.";
  args.push("--base-url", baseUrl, "--no-color");
  if (sessionId) args.push("--session", sessionId);
  const entry = process.argv[1];
  if (!entry) throw new Error("CLI entry point unavailable");
  const result = await exec(process.execPath, [entry, ...args], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  return sanitizeTerminal(`${result.stdout}${result.stderr}`.trim() || "Done.");
}

export function tokenize(input: string): string[] {
  const values: string[] = []; let current = ""; let quote: string | null = null; let escaped = false;
  for (const char of input.trim()) {
    if (escaped) { current += char; escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = null; else current += char; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (/\s/.test(char)) { if (current) { values.push(current); current = ""; } } else current += char;
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("Unclosed quote");
  if (current) values.push(current);
  return values;
}
