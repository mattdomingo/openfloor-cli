import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { TextInput } from "@inkjs/ui";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import open from "open";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { OpenFloorActions } from "./actions.js";
import type { ApiClient } from "./client.js";
import type { FloorSnapshot, RepositoryOption, SessionMember, SessionSummary, Usage } from "./contracts.js";
import { shortId } from "./id.js";
import { PresenceClient, type ConnectionStatus, type PresenceEvent, type TypingDraft } from "./realtime.js";
import { sanitizeTerminal } from "./sanitize.js";
import { updateConfig } from "./config.js";

const exec = promisify(execFile);
const tabs = ["Overview", "Agents", "Queue", "Team", "Review", "Repository", "Settings"] as const;
type Tab = typeof tabs[number];
type Overlay = { kind: "help" } | { kind: "palette"; initial?: string } | { kind: "filter" } | { kind: "create-session" } | { kind: "compose"; target: "queue" | "chat" } | { kind: "output"; text: string } | null;

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
  const [selectedRow, setSelectedRow] = useState(0);
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
    return values.filter((item) => `${item.title} ${item.objective ?? ""} ${item.id}`.toLowerCase().includes(filter.toLowerCase()))
      .sort((left, right) => sessionGroup(left) - sessionGroup(right));
  }, [filter, query.data]);

  const floor = floorQuery.data?.props.initialFloor;
  const members = sessionQuery.data?.props.initialMembers ?? [];
  const rowCount = sessionRowCount(tab, members, floor, repoTreeQuery.data);
  const homeSelection = Math.max(0, Math.min(selected, Math.max(0, sessions.length - 1)));
  const rowSelection = Math.max(0, Math.min(selectedRow, Math.max(0, rowCount - 1)));

  useInput((input, key) => {
    const presence = (globalThis as any).__openfloorPresence as PresenceClient | undefined; presence?.noteInput();
    if (overlay) {
      if (key.escape && overlay.kind !== "create-session") {
        if (overlay.kind === "compose") presence?.sendDraft("", false);
        setOverlay(null);
      }
      return;
    }
    if (input === "q") { exit(); return; }
    if (input === "?") { setOverlay({ kind: "help" }); return; }
    if (key.ctrl && input === "k") { setOverlay({ kind: "palette" }); return; }
    if (input === "r") { void query.refetch(); if (sessionId) { void sessionQuery.refetch(); void floorQuery.refetch(); } return; }
    if (!sessionId) {
      if (key.upArrow) setSelected((value) => Math.max(0, value - 1));
      if (key.downArrow) setSelected((value) => Math.min(Math.max(0, sessions.length - 1), value + 1));
      if (key.return && sessions[homeSelection]) { const id = sessions[homeSelection].id; setSessionId(id); setTab("Overview"); void updateConfig({ currentSessionId: id }); }
      if (input === "/") setOverlay({ kind: "filter" });
      if (input === "n") setOverlay({ kind: "create-session" });
    } else {
      if (key.escape) { presence?.sendDraft("", false); setSessionId(null); void query.refetch(); return; }
      if (key.upArrow) { setSelectedRow((value) => Math.max(0, value - 1)); return; }
      if (key.downArrow) { setSelectedRow((value) => Math.min(Math.max(0, rowCount - 1), value + 1)); return; }
      if (key.tab || key.leftArrow || key.rightArrow) {
        presence?.sendDraft("", false);
        const index = tabs.indexOf(tab);
        const delta = key.tab ? (key.shift ? -1 : 1) : key.leftArrow ? -1 : 1;
        setTab(tabs[(index + delta + tabs.length) % tabs.length]!); setSelectedRow(0); return;
      }
      if (key.return) { void activateSessionRow(tab, rowSelection, members, floor, repoTreeQuery.data, actions, sessionId, setOverlay, setNotice); return; }
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
    {!sessionId ? <Home sessions={sessions} selected={homeSelection} {...(query.data?.props.usage ? { usage: query.data.props.usage } : {})} /> :
      <SessionView width={width} tab={tab} selected={rowSelection} members={members} {...(floor ? { floor } : {})} online={online} drafts={drafts} activities={activities} tree={repoTreeQuery.data} skills={skillsQuery.data} mcp={mcpQuery.data} />}
    <Footer session={Boolean(sessionId)} />
    {overlay && <OverlayView overlay={overlay} sessionId={sessionId} baseUrl={baseUrl} actions={actions} presence={(globalThis as any).__openfloorPresence} close={() => { setOverlay(null); void query.refetch(); void floorQuery.refetch(); }} showOutput={(text) => setOverlay({ kind: "output", text })} setFilter={setFilter} onSessionCreated={(createdId, ready, message) => { setOverlay(null); setNotice(message); void query.refetch(); if (ready) { setSessionId(createdId); setTab("Overview"); setSelectedRow(0); void updateConfig({ currentSessionId: createdId }); } }} />}
  </Box>;
}

function Header({ session, connection }: { session?: SessionSummary; connection: ConnectionStatus }) {
  return <Box borderStyle="round" borderColor="cyan" paddingX={1} justifyContent="space-between"><Text bold color="cyan">openfloor</Text><Text>{session ? `${session.title}  ` : ""}<Text color={connection === "live" ? "green" : connection === "quota-exhausted" ? "red" : "yellow"}>{connection}</Text></Text></Box>;
}

function Home({ sessions, selected, usage }: { sessions: SessionSummary[]; selected: number; usage?: Usage }) {
  const groups = [
    ["Active", sessions.filter((session) => session.endedAt == null && session.archivedAt == null)],
    ["Archived", sessions.filter((session) => session.endedAt == null && session.archivedAt != null)],
    ["Ended", sessions.filter((session) => session.endedAt != null)],
  ] as const;
  return <Box flexDirection="column" paddingX={1}>
    <Text bold>Sessions</Text>
    {sessions.length === 0 ? <Text dimColor>No sessions.</Text> : groups.map(([label, values]) => values.length ? <Box key={label} flexDirection="column"><Text bold>{label}</Text>{values.map((session) => { const index = sessions.indexOf(session); return <Text key={session.id} {...(index === selected ? { color: "cyan" as const } : {})} inverse={index === selected}>{index === selected ? "›" : " "} {session.title.padEnd(28).slice(0, 28)} {shortId(session.id)} {session.role}</Text>; })}</Box> : null)}
    {usage && <UsageSummary usage={usage} />}
  </Box>;
}

function UsageSummary({ usage }: { usage: Usage }) {
  const plan = `${usage.effectivePlan[0]!.toUpperCase()}${usage.effectivePlan.slice(1)} plan`;
  const allowance = `${usage.limitHours === null ? "Unlimited session time" : `${usage.limitHours} session hours per month`} · ${usage.limitSeats === null ? "Unlimited seats" : `${usage.limitSeats} seats per session`}`;
  if (usage.limitHours === null) {
    return <Box flexDirection="column" marginTop={1}><Text bold color="cyan">{plan}</Text><Text>{allowance}</Text><Text dimColor>{formatDuration(usage.seconds)} used this month (UTC)</Text></Box>;
  }
  const limitSeconds = usage.limitHours * 3600;
  const used = limitSeconds > 0 ? Math.min(1, usage.seconds / limitSeconds) : 1;
  const cells = 20;
  const filled = Math.round(used * cells);
  const remaining = Math.max(0, limitSeconds - usage.seconds);
  return <Box flexDirection="column" marginTop={1}>
    <Text bold color="cyan">{plan}</Text>
    <Text>{allowance}</Text>
    <Text><Text color="cyan">{`${"█".repeat(filled)}${"░".repeat(cells - filled)}`}</Text> {Math.round(used * 100)}%</Text>
    <Text>{formatDuration(usage.seconds)} of {usage.limitHours}h used · {formatDuration(remaining)} remaining (UTC month)</Text>
  </Box>;
}

function SessionView({ width, tab, selected, members, floor, online, drafts, activities, tree, skills, mcp }: { width: number; tab: Tab; selected: number; members: any[]; floor?: FloorSnapshot; online: Set<string>; drafts: TypingDraft[]; activities: Record<string, Array<{ sequence: number; kind: string; detail: string }>>; tree?: any; skills?: any; mcp?: any }) {
  if (!floor) return <Text color="cyan">Loading floor…</Text>;
  const narrow = width < 120;
  return <Box flexDirection={narrow ? "column" : "row"} minHeight={16}>
    <Box flexDirection={narrow ? "row" : "column"} width={narrow ? "100%" : 16} borderStyle="single" borderColor="gray" paddingX={1}>{tabs.map((name) => <Text key={name} {...(tab === name ? { color: "cyan" as const } : {})} bold={tab === name}>{narrow ? `${name} ` : name}</Text>)}</Box>
    <Box flexDirection="column" flexGrow={1} borderStyle="single" borderColor="gray" paddingX={1}>
      {tab === "Overview" && <><Text bold>Members</Text>{members.map((member, index) => <Selectable key={member.id} active={selected === index} color={online.has(member.id) ? "green" : "white"}>● {member.displayName} · {member.role}{online.has(member.id) ? " · online" : ""}</Selectable>)}<Text bold>Assignments</Text>{floor.assignments.map((item: any, index: number) => <Selectable key={item.userId} active={selected === members.length + index}>{item.userName}: {item.task ?? "Unassigned"}</Selectable>)}</>}
      {tab === "Agents" && <>{floor.agents.length ? floor.agents.map((agent, index) => { const run = floor.runs.find((item) => item.agentId === agent.id); const live = run ? activities[run.id]?.at(-1) : undefined; return <Box key={agent.id} flexDirection="column" marginBottom={1}><Selectable active={selected === index} color={agent.pausedAt ? "yellow" : "cyan"}>{agent.name} · {agent.provider}/{agent.model ?? "default"} · {agent.pausedAt ? "paused" : run?.status ?? "idle"}</Selectable><Text>{agent.role}: {agent.task}</Text>{live && <Text dimColor>[{live.kind}] {live.detail}</Text>}</Box>; }) : <Text dimColor>No agents.</Text>}</>}
      {tab === "Queue" && <>{floor.queue.length ? floor.queue.map((item, index) => <Box key={item.id} flexDirection="column"><Selectable active={selected === index} color={item.status === "failed" ? "red" : item.status === "completed" ? "green" : "white"}>{String(item.position + 1).padStart(2)} {item.status.padEnd(10)} {item.agentName ?? "unassigned"} · {shortId(item.id)}</Selectable><Text dimColor>{item.prompts.map((prompt) => prompt.text).join(" / ").slice(0, 140)}</Text></Box>) : <Text dimColor>Queue empty. Press n to add.</Text>}</>}
      {tab === "Team" && <>{floor.messages.slice(-20).map((message: any, index: number) => <Selectable key={message.id} active={selected === index}><Text bold>{message.authorName}</Text>{message.recipientUserId ? " · DM" : ""}: {message.text}</Selectable>)}{drafts.map((draft) => <Text key={draft.userId} color="yellow">{draft.displayName} typing: {draft.text}</Text>)}<Text dimColor>Press c to send team chat.</Text></>}
      {tab === "Review" && <ReviewView review={floor.review} runs={floor.runs} selected={selected} />}
      {tab === "Repository" && <><Text bold>{recordText(floor.repository, "repositoryFullName", "No repository")}</Text><Text>Candidate: {recordText(floor.activeCandidate, "branchName", "none")}</Text><Text>Preflight: {recordText(floor.latestPreflight, "status", "none")}</Text><Text bold>Tree</Text>{recordArray(tree, "entries", "tree").slice(0, 20).map((entry, index) => <Selectable active={selected === index} key={recordText(entry, "path", "unknown")}>{recordText(entry, "type") === "tree" ? "▸" : "·"} {recordText(entry, "path")}</Selectable>)}</>}
      {tab === "Settings" && <><Selectable active={selected === 0}>Routing · auto-dispatch {String(floor.autoDispatch)} · auto-agents {String(floor.autoProvisionAgents)}</Selectable><Selectable active={selected === 1}>Invite and members</Selectable><Selectable active={selected === 2}>Skills {recordArray(skills, "skills").length} · MCP servers {recordArray(mcp, "servers").length}</Selectable><Selectable active={selected === 3} color="yellow">Session lifecycle</Selectable></>}
    </Box>
  </Box>;
}

function ReviewView({ review, runs, selected }: { review: any; runs: any[]; selected: number }) {
  if (!review) return <Text dimColor>No review available.</Text>;
  return <><Text bold>Candidate review</Text><Text>PR: {review.pullRequest?.url ?? "not created"} · checks {String(review.checksPassing ?? review.githubChecksPassing ?? "pending")}</Text><Text>Files: {review.files?.length ?? runs.flatMap((run) => run.files).length} · Conflicts: {review.conflicts?.length ?? 0}</Text>{runs.slice(-8).map((run, index) => <Selectable active={selected === index} key={run.id}>{shortId(run.id)} {run.agentName} · {run.status} · {run.summary ?? ""}</Selectable>)}</>;
}

function Selectable({ active, color = "white", children }: { active: boolean; color?: string; children: React.ReactNode }) { return <Text inverse={active} bold={active} color={color}>{active ? "› " : "  "}{children}</Text>; }

function Footer({ session }: { session: boolean }) { return <Box paddingX={1}><Text dimColor>{session ? "↑↓ select · ←→/Tab views · Enter open · Esc home · " : "↑↓ select · Enter open · n create · "}Ctrl+K commands · ? help · q quit</Text></Box>; }

function OverlayView({ overlay, sessionId, baseUrl, actions, presence, close, showOutput, setFilter, onSessionCreated }: { overlay: NonNullable<Overlay>; sessionId: string | null; baseUrl: string; actions: OpenFloorActions; presence?: PresenceClient; close: () => void; showOutput: (text: string) => void; setFilter: (value: string) => void; onSessionCreated: (id: string, ready: boolean, message: string) => void }) {
  const [error, setError] = useState<string | null>(null);
  if (overlay.kind === "help") return <Modal title="Help"><Text>Arrow keys navigate. Tab changes session view. Ctrl+K runs every subcommand. n adds queue work. c sends team chat. Esc closes. q quits.</Text></Modal>;
  if (overlay.kind === "output") return <Modal title="Command output"><Text>{overlay.text.slice(-8_000)}</Text><Text dimColor>Esc closes.</Text></Modal>;
  if (overlay.kind === "filter") return <Modal title="Filter sessions"><TextInput placeholder="Title, objective, or ID" onSubmit={(value) => { setFilter(value); close(); }} /></Modal>;
  if (overlay.kind === "create-session") return <CreateSessionWizard actions={actions} baseUrl={baseUrl} close={close} onCreated={onSessionCreated} />;
  if (overlay.kind === "compose") return <Modal title={overlay.target === "queue" ? "Add queue prompt" : "Send team message"}><TextInput placeholder="Type and press Enter" onChange={(value) => { if (overlay.target === "queue") presence?.sendDraft(value); }} onSubmit={(value) => { void (async () => { try { if (!sessionId) return; if (overlay.target === "queue") { await actions.post(`/api/sessions/${sessionId}/queue`, { prompt: value, agentId: null }); presence?.sendDraft("", false); } else await actions.post(`/api/sessions/${sessionId}/messages`, { text: value, recipientUserId: null }); close(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } })(); }} />{error && <Text color="red">{error}</Text>}</Modal>;
  return <Modal title="Command palette"><TextInput {...(overlay.initial === undefined ? {} : { defaultValue: overlay.initial })} placeholder="queue add &quot;Fix tests&quot;" onSubmit={(value) => { void runPalette(value, sessionId, baseUrl).then(showOutput, (reason) => setError(reason instanceof Error ? reason.message : String(reason))); }} />{error && <Text color="red">{error}</Text>}<Text dimColor>Any subcommand; omit leading openfloor.</Text></Modal>;
}

type CreateStage = "loading" | "empty" | "title" | "objective" | "candidate" | "repository" | "repository-search" | "confirm" | "submitting" | "error";

function CreateSessionWizard({ actions, baseUrl, close, onCreated }: { actions: OpenFloorActions; baseUrl: string; close: () => void; onCreated: (id: string, ready: boolean, message: string) => void }) {
  const [stage, setStage] = useState<CreateStage>("loading");
  const [repositories, setRepositories] = useState<RepositoryOption[]>([]);
  const [selectedRepository, setSelectedRepository] = useState(0);
  const [search, setSearch] = useState("");
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [candidateName, setCandidateName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const submitted = useRef(false);

  useEffect(() => {
    let active = true;
    void actions.repositories().then(({ repositories: values }) => {
      if (!active) return;
      setRepositories(values);
      setSelectedRepository(0);
      setStage(values.length ? "title" : "empty");
    }, (reason) => {
      if (!active) return;
      setError(reason instanceof Error ? reason.message : String(reason));
      setStage("error");
    });
    return () => { active = false; };
  }, [actions, loadAttempt]);

  const filteredRepositories = repositories.filter((repository) => repository.fullName.toLowerCase().includes(search.trim().toLowerCase()));
  const selected = repositories[selectedRepository];

  const submit = async () => {
    if (!selected || submitted.current) return;
    submitted.current = true;
    setError(null);
    setStage("submitting");
    try {
      const created = await actions.createSession({
        title: title.trim(),
        objective: objective.trim() || null,
        candidateName: candidateName.trim() || title.trim(),
        repositoryId: selected.id,
        accountInstallationId: selected.accountInstallationId,
      });
      const ready = created.setupStatus === "ready";
      onCreated(created.session.id, ready, ready ? "Session created." : created.setupError ?? "Session created, but repository setup needs attention.");
    } catch (reason) {
      submitted.current = false;
      setError(reason instanceof Error ? reason.message : String(reason));
      setStage("error");
    }
  };

  useInput((input, key) => {
    if (stage === "repository") {
      if (key.upArrow) setSelectedRepository((value) => Math.max(0, value - 1));
      else if (key.downArrow) setSelectedRepository((value) => Math.min(repositories.length - 1, value + 1));
      else if (input === "/") { setSearch(""); setStage("repository-search"); }
      else if (key.return && selected) setStage("confirm");
      else if (key.escape) setStage("candidate");
      return;
    }
    if (stage === "confirm") {
      if (key.return) void submit();
      else if (key.escape) setStage("repository");
      return;
    }
    if (stage === "empty" && key.return) { void open(`${baseUrl}/home/settings?section=connections`); return; }
    if (stage === "error" && input.toLowerCase() === "r") {
      setError(null);
      if (repositories.length) setStage("confirm");
      else { setStage("loading"); setLoadAttempt((value) => value + 1); }
      return;
    }
    if (!key.escape) return;
    if (stage === "objective") setStage("title");
    else if (stage === "candidate") setStage("objective");
    else if (stage === "repository-search") setStage("repository");
    else if (!["loading", "submitting"].includes(stage)) close();
  });

  return <Modal title="New session">
    {stage === "loading" && <Text color="cyan">Loading GitHub repositories…</Text>}
    {stage === "empty" && <><Text>No repositories available.</Text><Text>Press Enter to add GitHub access in Account Settings.</Text><Text dimColor>Esc closes.</Text></>}
    {stage === "title" && <><Text>Task</Text><TextInput placeholder="What is this session for?" onSubmit={(value) => { const next = value.trim(); if (next) { setTitle(next.slice(0, 100)); setCandidateName(next.slice(0, 100)); setStage("objective"); } }} /></>}
    {stage === "objective" && <><Text>Goal <Text dimColor>(optional)</Text></Text><TextInput placeholder="Press Enter to skip" onSubmit={(value) => { setObjective(value.slice(0, 2_000)); setStage("candidate"); }} /><Text dimColor>Esc returns to task.</Text></>}
    {stage === "candidate" && <><Text>Candidate branch name</Text><TextInput defaultValue={candidateName || title} placeholder={title} onSubmit={(value) => { setCandidateName((value.trim() || title).slice(0, 100)); setStage("repository"); }} /><Text dimColor>Defaults to task. Esc returns to goal.</Text></>}
    {stage === "repository" && <><Text>Select repository</Text>{repositories.slice(Math.max(0, selectedRepository - 4), selectedRepository + 5).map((repository) => { const index = repositories.indexOf(repository); return <Selectable key={`${repository.accountInstallationId}:${repository.id}`} active={index === selectedRepository}>{repository.fullName} · {repository.defaultBranch}{repository.private ? " · private" : ""}</Selectable>; })}<Text dimColor>↑↓ select · / search · Enter continue · Esc back</Text></>}
    {stage === "repository-search" && <><Text>Search repositories</Text><TextInput placeholder="owner/repository" onChange={setSearch} onSubmit={() => { const first = filteredRepositories[0]; if (!first) return; setSelectedRepository(repositories.indexOf(first)); setStage("repository"); }} />{filteredRepositories.slice(0, 6).map((repository, index) => <Text key={`${repository.accountInstallationId}:${repository.id}`} {...(index === 0 ? { color: "cyan" as const } : {})}>{index === 0 ? "›" : " "} {repository.fullName}</Text>)}{filteredRepositories.length === 0 && <Text color="yellow">No matching repositories.</Text>}<Text dimColor>Enter selects first match · Esc cancels search</Text></>}
    {stage === "confirm" && selected && <><Text bold>{title}</Text><Text>{objective || "No goal provided"}</Text><Text>Repository: {selected.fullName}</Text><Text>Candidate: {candidateName || title}</Text><Text color="cyan">Press Enter to create once. Esc goes back.</Text></>}
    {stage === "submitting" && <Text color="cyan">Creating session and candidate branch…</Text>}
    {stage === "error" && <><Text color="red">{error ?? "Unable to create session."}</Text><Text dimColor>Press r to retry or Esc to close.</Text></>}
  </Modal>;
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

function sessionGroup(session: SessionSummary): number {
  if (session.endedAt != null) return 2;
  if (session.archivedAt != null) return 1;
  return 0;
}

function sessionRowCount(tab: Tab, members: SessionMember[], floor: FloorSnapshot | undefined, tree: unknown): number {
  if (!floor) return 0;
  if (tab === "Overview") return members.length + floor.assignments.length;
  if (tab === "Agents") return floor.agents.length;
  if (tab === "Queue") return floor.queue.length;
  if (tab === "Team") return Math.min(20, floor.messages.length);
  if (tab === "Review") return Math.min(8, floor.runs.length);
  if (tab === "Repository") return recordArray(tree, "entries", "tree").slice(0, 20).length;
  return 4;
}

async function activateSessionRow(
  tab: Tab,
  row: number,
  members: SessionMember[],
  floor: FloorSnapshot | undefined,
  tree: unknown,
  actions: OpenFloorActions,
  sessionId: string,
  setOverlay: React.Dispatch<React.SetStateAction<Overlay>>,
  setNotice: React.Dispatch<React.SetStateAction<string | null>>,
): Promise<void> {
  if (!floor) return;
  if (tab === "Agents") {
    const agent = floor.agents[row];
    if (agent) setOverlay({ kind: "palette", initial: `agents show ${agent.id}` });
    return;
  }
  if (tab === "Queue") {
    const item = floor.queue[row];
    if (item) setOverlay({ kind: "palette", initial: `queue show ${item.id}` });
    return;
  }
  if (tab === "Review") {
    const run = floor.runs.slice(-8)[row];
    if (run) setOverlay({ kind: "palette", initial: `runs show ${run.id}` });
    return;
  }
  if (tab === "Settings") {
    setOverlay({ kind: "palette", initial: ["routing show", "members list", "skills list", "sessions show"][row] ?? "sessions show" });
    return;
  }
  if (tab === "Repository") {
    const entry = recordArray(tree, "entries", "tree").slice(0, 20)[row];
    const path = recordText(entry, "path");
    if (!path) return;
    if (recordText(entry, "type") === "tree") { setNotice(`Directory: ${path}`); return; }
    try {
      const file = await actions.get(`/api/sessions/${sessionId}/repository/file?path=${encodeURIComponent(path)}`);
      setOverlay({ kind: "output", text: `${path}\n\n${recordText(file, "content", "File has no text content.")}` });
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)); }
    return;
  }
  if (tab === "Overview") {
    const member = members[row];
    if (member) setOverlay({ kind: "output", text: `${member.displayName}\nRole: ${member.role}\nStatus: ${member.online ? "online" : "offline"}\nID: ${member.id}` });
    else {
      const assignment = floor.assignments[row - members.length];
      if (assignment) setOverlay({ kind: "output", text: `${recordText(assignment, "userName", "Assignment")}\n${recordText(assignment, "task", "Unassigned")}` });
    }
    return;
  }
  const message = floor.messages.slice(-20)[row] as Record<string, unknown> | undefined;
  if (message) setOverlay({ kind: "output", text: `${recordText(message, "authorName", "Message")}${recordText(message, "recipientUserId") ? " · DM" : ""}\n\n${recordText(message, "text")}` });
}

export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3_600);
  const minutes = Math.floor((whole % 3_600) / 60);
  const remainder = whole % 60;
  return [hours ? `${hours}h` : "", minutes ? `${minutes}m` : "", (!hours && !minutes) || remainder ? `${remainder}s` : ""].filter(Boolean).join(" ");
}

async function runPalette(line: string, sessionId: string | null, baseUrl: string): Promise<string> {
  const args = tokenize(line);
  if (!args.length) return "No command.";
  args.push("--base-url", baseUrl, "--no-color");
  if (sessionId) args.push("--session", sessionId);
  const entry = process.argv[1];
  if (!entry) throw new Error("CLI entry point unavailable");
  try {
    const result = await exec(process.execPath, [entry, ...args], { encoding: "utf8", maxBuffer: 1024 * 1024 });
    return sanitizeTerminal(`${result.stdout}${result.stderr}`.trim() || "Done.");
  } catch (reason) {
    const error = reason as { stderr?: string; stdout?: string; message?: string };
    const detail = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim() || error.message || "Command failed.";
    throw new Error(sanitizeTerminal(detail).slice(-8_000));
  }
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
