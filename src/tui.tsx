import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { TextInput } from "@inkjs/ui";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import open from "open";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { OpenFloorActions } from "./actions.js";
import { logoutAccess } from "./auth.js";
import type { ApiClient } from "./client.js";
import { bindWorkspaceSession, unbindWorkspaceSession, updateConfig } from "./config.js";
import type { FloorSnapshot, RepositoryOption, SessionSummary, Usage } from "./contracts.js";
import { OpenFloorError } from "./errors.js";
import { shortId } from "./id.js";
import { PresenceClient, type ConnectionStatus, type PresenceEvent, type TypingDraft } from "./realtime.js";
import { sanitizeTerminal } from "./sanitize.js";
import { requireCleanWorkspace, synchronizeWorkspace, type LocalWorkspace } from "./workspace.js";

const exec = promisify(execFile);
type SessionPage = "floor" | "overview" | "review" | "repository" | "settings" | "help";
type Page = "sessions" | "create-session" | "bind-workspace" | "cli-settings" | "cli-help" | SessionPage;
type FloorPane = "chat" | "agents" | "queue";
type FloorDetail = { pane: FloorPane; index: number };
type LocalSync = "none" | "syncing" | "live" | "paused" | "mismatch";

export type TuiProps = { actions: OpenFloorActions; client: ApiClient; baseUrl: string; initialSessionId?: string; workspace?: LocalWorkspace; logout?: () => Promise<void> };

export function startTui(props: TuiProps): React.ReactElement {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, retry: false } } });
  return <QueryClientProvider client={queryClient}><App {...props} /></QueryClientProvider>;
}

function App({ actions, client, baseUrl, initialSessionId, workspace, logout = logoutAccess }: TuiProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [width, setWidth] = useState(stdout.columns || 100);
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId ?? null);
  const [selectedSession, setSelectedSession] = useState(0);
  const [page, setPage] = useState<Page>(initialSessionId ? "floor" : workspace ? "create-session" : "sessions");
  const [homeCommandActive, setHomeCommandActive] = useState(false);
  const [workspaceStartupResolved, setWorkspaceStartupResolved] = useState(!workspace || !initialSessionId);
  const [notice, setNotice] = useState<string | null>(workspace ? `Local workspace: ${workspace.repositoryFullName}` : null);
  const [connection, setConnection] = useState<ConnectionStatus>("closed");
  const [localSync, setLocalSync] = useState<LocalSync>("none");
  const [workspaceSyncEnabled, setWorkspaceSyncEnabled] = useState(Boolean(workspace && initialSessionId));
  const [boundSessionId, setBoundSessionId] = useState<string | null>(workspace ? initialSessionId ?? null : null);
  const [online, setOnline] = useState(new Set<string>());
  const [drafts, setDrafts] = useState<TypingDraft[]>([]);
  const [activities, setActivities] = useState<Record<string, Array<{ sequence: number; kind: string; detail: string }>>>({});
  const [floorFocus, setFloorFocus] = useState<"prompt" | FloorPane>("prompt");
  const [paneRows, setPaneRows] = useState<Record<FloorPane, number>>({ chat: 0, agents: 0, queue: 0 });
  const [floorDetail, setFloorDetail] = useState<FloorDetail | null>(null);
  const [syncAttempt, setSyncAttempt] = useState(0);
  const startupHandled = useRef(false);
  const workspaceOfferHandled = useRef(new Set<string>());
  const syncedCandidate = useRef<string | null>(null);
  const syncQueue = useRef<Promise<unknown>>(Promise.resolve());
  const queryClient = useQueryClient();

  const homeQuery = useQuery({ queryKey: ["home"], queryFn: () => actions.home() });
  const sessionQuery = useQuery({ queryKey: ["session", sessionId], queryFn: () => actions.session(sessionId!), enabled: Boolean(sessionId && workspaceStartupResolved) });
  const floorQuery = useQuery({ queryKey: ["floor", sessionId], queryFn: () => actions.floor(sessionId!), enabled: Boolean(sessionId && workspaceStartupResolved), refetchInterval: connection === "live" ? false : 10_000 });
  const treeQuery = useQuery({ queryKey: ["tree", sessionId], queryFn: () => actions.get(`/api/sessions/${sessionId}/repository/tree`), enabled: Boolean(sessionId && page === "repository") });
  const skillsQuery = useQuery({ queryKey: ["skills", sessionId], queryFn: () => actions.get(`/api/sessions/${sessionId}/skills`), enabled: Boolean(sessionId && page === "settings") });
  const mcpQuery = useQuery({ queryKey: ["mcp", sessionId], queryFn: () => actions.get(`/api/sessions/${sessionId}/mcp-servers`), enabled: Boolean(sessionId && page === "settings") });

  useEffect(() => {
    const resize = () => setWidth(stdout.columns || 100);
    stdout.on("resize", resize);
    return () => { stdout.off("resize", resize); };
  }, [stdout]);

  useEffect(() => {
    if (!workspace || !homeQuery.data || startupHandled.current) return;
    const bound = initialSessionId ? homeQuery.data.props.sessions.find((session) => session.id === initialSessionId) : undefined;
    startupHandled.current = true;
    if (bound && bound.endedAt == null) { void Promise.resolve().then(() => setWorkspaceStartupResolved(true)); return; }
    void Promise.resolve().then(async () => {
      if (initialSessionId) await unbindWorkspaceSession(workspace.root);
      setWorkspaceSyncEnabled(false);
      setBoundSessionId(null);
      setSessionId(null);
      setPage("create-session");
      setWorkspaceStartupResolved(true);
    });
  }, [homeQuery.data, initialSessionId, workspace]);

  useEffect(() => {
    if (!sessionId || !workspaceStartupResolved) return;
    const presence = new PresenceClient(client, sessionId);
    presence.on("status", setConnection);
    presence.on("event", (event: PresenceEvent) => {
      if (event.type === "presence.snapshot") { setOnline(new Set(event.onlineUserIds)); setDrafts(event.typingDrafts); }
      else if (event.type === "presence.changed") setOnline((current) => { const next = new Set(current); if (event.online) next.add(event.userId); else next.delete(event.userId); return next; });
      else if (event.type === "typing.changed") setDrafts((current) => [...current.filter((item) => item.userId !== event.draft.userId), event.draft].filter((item) => item.text));
      else if (event.type === "floor.changed") void queryClient.invalidateQueries({ queryKey: ["floor", sessionId] });
      else if (event.type === "members.changed" || event.type === "session.changed" || event.type === "session.locked") void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
      else if (event.type === "session.ended") {
        setNotice(`Session ended: ${event.reason}`);
        void queryClient.invalidateQueries({ queryKey: ["home"] });
        if (workspace && boundSessionId === sessionId) {
          void unbindWorkspaceSession(workspace.root);
          setWorkspaceSyncEnabled(false); setBoundSessionId(null); setSessionId(null); setPage("create-session");
        }
      }
      else if (event.type === "run.activity") setActivities((current) => appendActivity(current, event.runId, event.events));
    });
    presence.on("close", ({ code, reason }) => { if (code === 4001 || code === 4005) { setNotice(reason || "Membership ended"); setSessionId(null); setWorkspaceSyncEnabled(false); setBoundSessionId(null); setPage(workspace ? "create-session" : "sessions"); if (workspace) void unbindWorkspaceSession(workspace.root); void queryClient.invalidateQueries({ queryKey: ["home"] }); } });
    void presence.connect().catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
    (globalThis as Record<string, unknown>).__openfloorPresence = presence;
    return () => { presence.sendDraft("", false); presence.close(); delete (globalThis as Record<string, unknown>).__openfloorPresence; };
  }, [boundSessionId, client, queryClient, sessionId, workspace, workspaceStartupResolved]);

  const sessions = useMemo(() => {
    const values = homeQuery.data?.props.sessions ?? [];
    return [...values].sort((left, right) => sessionGroup(left) - sessionGroup(right));
  }, [homeQuery.data]);
  const homeSelection = Math.max(0, Math.min(selectedSession, Math.max(0, sessions.length - 1)));
  const floor = floorQuery.data?.props.initialFloor;
  const members = sessionQuery.data?.props.initialMembers ?? [];
  const repositoryName = floor?.repository?.repositoryFullName ?? "";
  const repositoryStatus = floor?.repository?.status ?? "disconnected";
  const candidateBranch = floor?.activeCandidate?.branchName ?? "";
  const candidateSha = floor?.activeCandidate?.remoteCandidateSha ?? "";
  const effectiveLocalSync: LocalSync = workspace && floor && repositoryName.toLowerCase() !== workspace.repositoryFullName.toLowerCase() ? "mismatch" : localSync;

  useEffect(() => {
    if (!workspace || !workspaceSyncEnabled || !sessionId || !floor || !candidateBranch || !candidateSha) return;
    if (repositoryName.toLowerCase() !== workspace.repositoryFullName.toLowerCase()) return;
    if (repositoryStatus !== "ready") { void Promise.resolve().then(() => { setLocalSync("paused"); setNotice(`Repository is ${repositoryStatus}; local sync paused.`); }); return; }
    const key = `${sessionId}:${candidateBranch}:${candidateSha}`;
    if (syncedCandidate.current === key) return;
    syncedCandidate.current = key;
    syncQueue.current = syncQueue.current.then(() => { setLocalSync("syncing"); return synchronizeWorkspace(workspace, candidateBranch, candidateSha); }).then((result) => {
      setLocalSync("live");
      setNotice(`Local workspace updated on ${result.branch} at ${result.sha.slice(0, 12)}.`);
    }, (reason) => {
      setLocalSync("paused");
      setNotice(reason instanceof Error ? reason.message : String(reason));
    });
  }, [candidateBranch, candidateSha, floor, repositoryName, repositoryStatus, sessionId, syncAttempt, workspace, workspaceSyncEnabled]);

  useEffect(() => {
    if (!workspace || !sessionId || !floor || workspaceSyncEnabled || page !== "floor" || workspaceOfferHandled.current.has(sessionId)) return;
    if (repositoryName.toLowerCase() !== workspace.repositoryFullName.toLowerCase() || !candidateBranch || !candidateSha || repositoryStatus !== "ready") return;
    workspaceOfferHandled.current.add(sessionId);
    void Promise.resolve().then(() => setPage("bind-workspace"));
  }, [candidateBranch, candidateSha, floor, page, repositoryName, repositoryStatus, sessionId, workspace, workspaceSyncEnabled]);

  useEffect(() => {
    if (!workspace || !workspaceSyncEnabled || !sessionId || !floor) return;
    if (repositoryName.toLowerCase() === workspace.repositoryFullName.toLowerCase()) return;
    void unbindWorkspaceSession(workspace.root);
    void Promise.resolve().then(() => {
      setWorkspaceSyncEnabled(false); setBoundSessionId(null); setSessionId(null); setPage("create-session");
      setNotice("Local session binding removed because its repository no longer matches this checkout.");
    });
  }, [floor, repositoryName, sessionId, workspace, workspaceSyncEnabled]);

  useEffect(() => {
    const error = sessionQuery.error ?? floorQuery.error;
    if (!(error instanceof OpenFloorError) || error.code !== "not_found" || !workspace || !workspaceSyncEnabled) return;
    void unbindWorkspaceSession(workspace.root);
    void Promise.resolve().then(() => {
      setWorkspaceSyncEnabled(false);
      setBoundSessionId(null);
      setSessionId(null);
      setPage("create-session");
      setNotice("Local session binding removed because session is no longer accessible.");
    });
  }, [floorQuery.error, sessionQuery.error, workspace, workspaceSyncEnabled]);

  const enterSession = async (id: string, bindWorkspace = false) => {
    setWorkspaceStartupResolved(true); setSessionId(id); setPage("floor"); setFloorFocus("prompt"); setFloorDetail(null); setHomeCommandActive(false);
    await updateConfig({ currentSessionId: id });
    setWorkspaceSyncEnabled(Boolean(workspace && bindWorkspace));
    if (workspace && bindWorkspace) { await bindWorkspaceSession(workspace.root, id); setBoundSessionId(id); }
  };
  const enableWorkspaceSync = async () => {
    if (!workspace || !sessionId) return;
    await requireCleanWorkspace(workspace);
    await bindWorkspaceSession(workspace.root, sessionId);
    syncedCandidate.current = null;
    setWorkspaceSyncEnabled(true);
    setBoundSessionId(sessionId);
    setSyncAttempt((value) => value + 1);
    setNotice(`Local sync enabled for ${workspace.repositoryFullName}.`);
    setPage("floor");
  };
  const retryWorkspaceSync = () => {
    if (!workspace) { setNotice("No local GitHub workspace detected."); return; }
    if (!workspaceSyncEnabled) {
      if (repositoryName.toLowerCase() === workspace.repositoryFullName.toLowerCase() && candidateBranch && candidateSha && repositoryStatus === "ready") setPage("bind-workspace");
      else setNotice("Local workspace does not match a ready candidate in this session.");
      return;
    }
    syncedCandidate.current = null;
    setSyncAttempt((value) => value + 1);
  };
  const goSessions = () => { setSessionId(null); setPage("sessions"); setConnection("closed"); setOnline(new Set()); setDrafts([]); setLocalSync("none"); setFloorFocus("prompt"); setFloorDetail(null); setHomeCommandActive(false); void homeQuery.refetch(); };
  const refreshSession = () => { void sessionQuery.refetch(); void floorQuery.refetch(); void homeQuery.refetch(); };
  const runBackground = async (line: string) => {
    try { await runPalette(line, sessionId, baseUrl); setNotice("Command completed in background."); refreshSession(); }
    catch (reason) { setNotice(sanitizeTerminal(reason instanceof Error ? reason.message : String(reason)).slice(-240)); }
  };
  const executeHomeCommand = async (raw: string) => {
    const [command = "", ...rest] = raw.trim().slice(1).split(/\s+/); const argument = rest.join(" ").trim();
    if (command === "new") { setSessionId(null); setPage("create-session"); }
    else if (command === "settings") setPage("cli-settings");
    else if (command === "help") setPage("cli-help");
    else if (command === "sessions") setPage("sessions");
    else if (command === "refresh") { await homeQuery.refetch(); setNotice("Sessions refreshed."); }
    else if (command === "run") { if (!argument) throw new Error("Usage: /run <CLI subcommand>"); await runBackground(argument); }
    else if (command === "logout") { await logout(); exit(); }
    else if (command === "quit") exit();
    else throw new Error(`Unknown command: /${command}. Use /help.`);
  };

  useInput((input, key) => {
    const presence = (globalThis as Record<string, unknown>).__openfloorPresence as PresenceClient | undefined;
    presence?.noteInput();
    if (page === "create-session" || page === "bind-workspace") return;
    if (sessionId) {
      if (page !== "floor") { if (key.escape) setPage("floor"); return; }
      if (floorDetail) { if (key.escape) setFloorDetail(null); return; }
      if (key.tab) { setFloorFocus((current) => current === "prompt" ? "chat" : current === "chat" ? "agents" : current === "agents" ? "queue" : "prompt"); return; }
      if (floorFocus === "prompt") return;
      const panes: FloorPane[] = ["chat", "agents", "queue"];
      if (key.escape) { setFloorFocus("prompt"); return; }
      if (key.leftArrow || key.rightArrow) { const index = panes.indexOf(floorFocus); const offset = key.leftArrow ? -1 : 1; setFloorFocus(panes[(index + offset + panes.length) % panes.length]!); return; }
      const count = floorPaneCount(floorFocus, floor);
      if (key.upArrow) setPaneRows((current) => ({ ...current, [floorFocus]: Math.max(0, current[floorFocus] - 1) }));
      else if (key.downArrow) setPaneRows((current) => ({ ...current, [floorFocus]: Math.min(Math.max(0, count - 1), current[floorFocus] + 1) }));
      else if (key.return && count > 0) setFloorDetail({ pane: floorFocus, index: Math.min(paneRows[floorFocus], count - 1) });
      else if (input === "r") refreshSession();
      else if (input === "?") setPage("help");
      else if (input === "q") exit();
      return;
    }
    if (homeCommandActive) return;
    if (page !== "sessions") { if (key.escape) setPage("sessions"); return; }
    if (input === "q") { exit(); return; }
    if (input === "?") { setPage("cli-help"); return; }
    if (input === "r") { void homeQuery.refetch(); return; }
    if (key.upArrow) setSelectedSession((value) => Math.max(0, value - 1));
    if (key.downArrow) setSelectedSession((value) => Math.min(Math.max(0, sessions.length - 1), value + 1));
    if (key.return && sessions[homeSelection]) void enterSession(sessions[homeSelection].id, sessions[homeSelection].id === boundSessionId);
    if (input === "n") { setPage("create-session"); return; }
    if (input && input !== "/" && !key.ctrl && !key.meta) setNotice("Commands start with /. Press / to open commands.");
  });

  if (width < 60) return <Box flexDirection="column"><Text bold color="red">Terminal too narrow ({width} columns)</Text><Text>Resize to at least 60 columns.</Text></Box>;
  if (homeQuery.isLoading && page === "sessions") return <Text color="cyan">Loading openfloor…</Text>;
  if (homeQuery.error && page === "sessions") return <ErrorView error={homeQuery.error} />;

  return <Box flexDirection="column" width="100%">
    <Header {...(sessionQuery.data?.props.session ? { session: sessionQuery.data.props.session } : {})} connection={connection} {...(workspace ? { workspace } : {})} localSync={effectiveLocalSync} />
    {notice && <Text color={effectiveLocalSync === "paused" || effectiveLocalSync === "mismatch" ? "yellow" : "cyan"}>{notice}</Text>}
    {page === "sessions" && <Home sessions={sessions} selected={homeSelection} {...(homeQuery.data?.props.usage ? { usage: homeQuery.data.props.usage } : {})} {...(workspace ? { workspace } : {})} />}
    {page === "cli-settings" && <CliSettings baseUrl={baseUrl} />}
    {page === "cli-help" && <HelpPage session={false} />}
    {page === "create-session" && <CreateSessionWizard actions={actions} baseUrl={baseUrl} close={goSessions} {...(workspace ? { workspace } : {})} onCreated={(id, ready, message) => { setNotice(message); void homeQuery.refetch(); if (ready) void enterSession(id, Boolean(workspace)); }} />}
    {page === "bind-workspace" && workspace && floor && <BindWorkspaceConfirm workspace={workspace} repositoryName={repositoryName} branch={candidateBranch} sha={candidateSha} close={() => setPage("floor")} confirm={enableWorkspaceSync} />}
    {page === "bind-workspace" && (!workspace || !floor) && <PageFrame title="Local sync unavailable"><Text>No matching local GitHub workspace is available.</Text><Text dimColor>Esc returns to the floor.</Text></PageFrame>}
    {sessionId && isSessionPage(page) && (floor ? <>
      {page === "floor" ? floorDetail ? <FloorItemDetail detail={floorDetail} floor={floor} activities={activities} /> : <FloorDashboard width={width} floor={floor} online={online} drafts={drafts} activities={activities} focus={floorFocus} rows={paneRows} /> : <PageView page={page} floor={floor} members={members} online={online} tree={treeQuery.data} skills={skillsQuery.data} mcp={mcpQuery.data} {...(workspace ? { workspace } : {})} localSync={effectiveLocalSync} />}
      <CommandBar page={page} sessionId={sessionId} actions={actions} {...((globalThis as Record<string, unknown>).__openfloorPresence ? { presence: (globalThis as Record<string, unknown>).__openfloorPresence as PresenceClient } : {})} focused={floorFocus === "prompt" && !floorDetail} navigate={(next) => { setPage(next); setFloorDetail(null); setFloorFocus("prompt"); }} goSessions={goSessions} refresh={refreshSession} retryWorkspaceSync={retryWorkspaceSync} runBackground={runBackground} setNotice={setNotice} />
    </> : <Text color="cyan">Loading session floor…</Text>)}
    {isHomePage(page) && <HomeCommandBar active={homeCommandActive} setActive={setHomeCommandActive} page={page} submit={executeHomeCommand} setNotice={setNotice} />}
  </Box>;
}

function Header({ session, connection, workspace, localSync }: { session?: SessionSummary; connection: ConnectionStatus; workspace?: LocalWorkspace; localSync: LocalSync }) {
  const syncText = !workspace ? "" : localSync === "live" ? " · local live" : localSync === "syncing" ? " · syncing local" : localSync === "paused" ? " · local paused" : localSync === "mismatch" ? " · different repository" : "";
  return <Box borderStyle="round" borderColor="cyan" paddingX={1} justifyContent="space-between"><Text bold color="cyan">openfloor</Text><Text>{session ? `${session.title} · ` : ""}<Text color={connection === "live" ? "green" : connection === "quota-exhausted" ? "red" : "yellow"}>{connection}</Text><Text color={localSync === "live" ? "green" : "yellow"}>{syncText}</Text></Text></Box>;
}

function Home({ sessions, selected, usage, workspace }: { sessions: SessionSummary[]; selected: number; usage?: Usage; workspace?: LocalWorkspace }) {
  const groups = [["Active", sessions.filter((session) => session.endedAt == null && session.archivedAt == null)], ["Archived", sessions.filter((session) => session.endedAt == null && session.archivedAt != null)], ["Ended", sessions.filter((session) => session.endedAt != null)]] as const;
  return <PageFrame title="Sessions">{workspace && <Text color="cyan">Git workspace detected: {workspace.repositoryFullName}</Text>}{sessions.length === 0 ? <Text dimColor>No sessions. Use /new to create one.</Text> : groups.map(([label, values]) => values.length ? <Box key={label} flexDirection="column"><Text bold>{label}</Text>{values.map((session) => { const index = sessions.indexOf(session); return <Text key={session.id} inverse={index === selected} {...(index === selected ? { color: "cyan" as const } : {})}>{index === selected ? "›" : " "} {session.title.padEnd(30).slice(0, 30)} {shortId(session.id)} {session.role}</Text>; })}</Box> : null)}{usage && <UsageSummary usage={usage} />}</PageFrame>;
}

function CliSettings({ baseUrl }: { baseUrl: string }) {
  return <PageFrame title="CLI settings"><Text>Server: {baseUrl}</Text><Text>Authentication: Cloudflare Access in an openfloor-only local cache</Text><Text dimColor>/logout removes this CLI's cached Access session and workspace bindings.</Text><Text bold>Browser-owned settings</Text><Text>/run web settings · /run web billing · /run web connections · /run web github</Text><Text dimColor>Esc or /sessions returns to Sessions.</Text></PageFrame>;
}

function HelpPage({ session }: { session: boolean }) {
  return <PageFrame title="Help">{session ? <><Text>Type ordinary text to queue work; use /chat &lt;message&gt; for team chat.</Text><Text>/floor /overview /review /repository /settings /sessions /sync /refresh /run</Text><Text>Tab enters panes · arrows navigate · Enter opens · Esc returns to prompt.</Text></> : <><Text>↑↓ select · Enter opens · n creates · / starts a command.</Text><Text>/new /settings /help /logout /sessions /refresh /run /quit</Text><Text>Ctrl+K focuses commands · Esc returns to Sessions.</Text></>}<Text>Ctrl+C exits locally and never cancels remote runs.</Text></PageFrame>;
}

function PageFrame({ title, children }: { title: string; children: React.ReactNode }) {
  return <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} minHeight={22} width="100%"><Text bold color="cyan">{title}</Text>{children}</Box>;
}

function UsageSummary({ usage }: { usage: Usage }) {
  const plan = `${capitalize(usage.effectivePlan)} plan`;
  const allowance = `${usage.limitHours === null ? "Unlimited session time" : `${usage.limitHours} session hours per month`} · ${usage.limitSeats === null ? "Unlimited seats" : `${usage.limitSeats} seats per session`}`;
  if (usage.limitHours === null) return <Box flexDirection="column" marginTop={1}><Text bold color="cyan">{plan}</Text><Text>{allowance}</Text><Text dimColor>{formatDuration(usage.seconds)} used this month (UTC)</Text></Box>;
  const limitSeconds = usage.limitHours * 3_600; const used = limitSeconds > 0 ? Math.min(1, usage.seconds / limitSeconds) : 1; const filled = Math.round(used * 20);
  return <Box flexDirection="column" marginTop={1}><Text bold color="cyan">{plan}</Text><Text>{allowance}</Text><Text color="cyan">{"█".repeat(filled)}{"░".repeat(20 - filled)} {Math.round(used * 100)}%</Text><Text>{formatDuration(usage.seconds)} used · {formatDuration(Math.max(0, limitSeconds - usage.seconds))} remaining</Text></Box>;
}

function FloorDashboard({ width, floor, online, drafts, activities, focus, rows }: { width: number; floor: FloorSnapshot; online: Set<string>; drafts: TypingDraft[]; activities: Record<string, Array<{ sequence: number; kind: string; detail: string }>>; focus: "prompt" | FloorPane; rows: Record<FloorPane, number> }) {
  const horizontal = width >= 100;
  return <Box flexDirection={horizontal ? "row" : "column"} minHeight={22}>
    <Panel title="Team chat" width={horizontal ? "28%" : "100%"} active={focus === "chat"}>{floor.messages.length ? floor.messages.slice(-14).map((message, index) => <Text key={recordText(message, "id", String(index))} inverse={focus === "chat" && index === rows.chat}><Text bold color="cyan">{recordText(message, "authorName", "Member")}</Text>{recordText(message, "recipientUserId") ? " · DM" : ""}: {recordText(message, "text")}</Text>) : <Text dimColor>No messages. Use /chat message.</Text>}{drafts.slice(-3).map((draft) => <Text key={draft.userId} color="yellow">{draft.displayName} typing: {draft.text.slice(0, 60)}</Text>)}{online.size > 0 && <Text dimColor>{online.size} online</Text>}</Panel>
    <Panel title="Agent floor" width={horizontal ? "44%" : "100%"} active={focus === "agents"}>{floor.agents.length ? floor.agents.map((agent, index) => { const run = floor.runs.filter((item) => item.agentId === agent.id).sort((left, right) => right.updatedAt - left.updatedAt)[0]; const live = run ? activities[run.id]?.at(-1) : undefined; const status = agent.pausedAt ? "paused" : run?.status ?? "idle"; return <Box key={agent.id} flexDirection="column" marginBottom={1}><Text inverse={focus === "agents" && index === rows.agents} bold color={statusColor(status)}>● {agent.name} <Text dimColor>{agent.provider}/{agent.model ?? "default"}</Text></Text><Text>{agent.role}: {agent.task}</Text><Text color={statusColor(status)}>{status}{live ? ` · ${live.detail}` : ""}</Text></Box>; }) : <Text dimColor>No agents running. Create one with /run agents create …</Text>}</Panel>
    <Panel title="Prompt queue" width={horizontal ? "28%" : "100%"} active={focus === "queue"}>{floor.queue.length ? floor.queue.slice(0, 14).map((item, index) => <Box key={item.id} flexDirection="column" marginBottom={1}><Text inverse={focus === "queue" && index === rows.queue} color={statusColor(item.status)}>{String(item.position + 1).padStart(2)} · {item.status} · {item.agentName ?? "unassigned"}</Text><Text>{item.prompts.map((prompt) => prompt.text).join(" / ").slice(0, 100)}</Text></Box>) : <Text dimColor>Queue empty. Type a prompt below.</Text>}</Panel>
  </Box>;
}

function Panel({ title, width, active, children }: { title: string; width: number | `${number}%`; active: boolean; children: React.ReactNode }) { return <Box flexDirection="column" width={width} borderStyle={active ? "double" : "round"} borderColor={active ? "cyan" : "gray"} paddingX={1}><Text bold color="cyan">{active ? "› " : ""}{title}</Text>{children}</Box>; }

function FloorItemDetail({ detail, floor, activities }: { detail: FloorDetail; floor: FloorSnapshot; activities: Record<string, Array<{ sequence: number; kind: string; detail: string }>> }) {
  if (detail.pane === "chat") { const message = floor.messages.slice(-14)[detail.index]; return <Detail title="Team message"><Text bold>{recordText(message, "authorName", "Member")}{recordText(message, "recipientUserId") ? " · DM" : ""}</Text><Text>{recordText(message, "text")}</Text><Text dimColor>Esc returns to floor</Text></Detail>; }
  if (detail.pane === "agents") { const agent = floor.agents[detail.index]; if (!agent) return <Detail title="Agent">Agent no longer available.</Detail>; const run = floor.runs.filter((item) => item.agentId === agent.id).sort((left, right) => right.updatedAt - left.updatedAt)[0]; const live = run ? activities[run.id]?.at(-1) : undefined; return <Detail title={agent.name}><Text>{agent.role}: {agent.task}</Text><Text>Provider: {agent.provider}/{agent.model ?? "default"}</Text><Text>Owner: {agent.ownerName}</Text><Text>Status: {agent.pausedAt ? "paused" : run?.status ?? "idle"}</Text>{live && <Text>Latest: {live.detail}</Text>}<Text dimColor>ID {agent.id} · Esc returns to floor</Text></Detail>; }
  const item = floor.queue.slice(0, 14)[detail.index]; if (!item) return <Detail title="Prompt">Prompt no longer available.</Detail>; return <Detail title={`Queue ${item.position + 1}`}><Text>Status: {item.status} · {item.agentName ?? "unassigned"}</Text>{item.prompts.map((prompt) => <Text key={prompt.id}><Text bold>{prompt.authorName}:</Text> {prompt.text}</Text>)}<Text dimColor>ID {item.id} · Esc returns to floor</Text></Detail>;
}

function Detail({ title, children }: { title: string; children: React.ReactNode }) { return <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} minHeight={22}><Text bold color="cyan">{title}</Text>{children}</Box>; }

function PageView({ page, floor, members, online, tree, skills, mcp, workspace, localSync }: { page: Exclude<SessionPage, "floor">; floor: FloorSnapshot; members: any[]; online: Set<string>; tree: unknown; skills: unknown; mcp: unknown; workspace?: LocalWorkspace; localSync: LocalSync }) {
  return <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} minHeight={22}><Text bold color="cyan">/{page}</Text>
    {page === "overview" && <><Text bold>Members</Text>{members.map((member) => <Text key={member.id} color={online.has(member.id) ? "green" : "white"}>● {member.displayName} · {member.role}{online.has(member.id) ? " · online" : ""}</Text>)}<Text bold>Assignments</Text>{floor.assignments.length ? floor.assignments.map((assignment: any) => <Text key={assignment.userId}>{assignment.userName}: {assignment.task ?? "Unassigned"}</Text>) : <Text dimColor>No assignments.</Text>}<Text bold>Repository</Text><Text>{recordText(floor.repository, "repositoryFullName", "No repository")} · {recordText(floor.activeCandidate, "branchName", "No candidate")}</Text>{workspace && <Text>Local: {workspace.root} · {localSync}</Text>}</>}
    {page === "review" && <ReviewView floor={floor} />}
    {page === "repository" && <><Text>{recordText(floor.repository, "repositoryFullName", "No repository")}</Text><Text>Candidate: {recordText(floor.activeCandidate, "branchName", "none")}</Text><Text>Preflight: {recordText(floor.latestPreflight, "status", "none")}</Text><Text bold>Files</Text>{recordArray(tree, "entries", "tree").slice(0, 18).map((entry) => <Text key={recordText(entry, "path", "unknown")}>{recordText(entry, "type") === "tree" ? "▸" : "·"} {recordText(entry, "path")}</Text>)}</>}
    {page === "settings" && <><Text>Auto-dispatch: {String(floor.autoDispatch)}</Text><Text>Auto-agents: {String(floor.autoProvisionAgents)}</Text><Text>Auto-conflicts: {String(floor.autoResolveConflicts)}</Text><Text>Skills: {recordArray(skills, "skills").length} · MCP servers: {recordArray(mcp, "servers").length}</Text><Text dimColor>Use /run routing, invite, members, skills, mcp, repository, or session lifecycle commands.</Text></>}
    {page === "help" && <HelpPage session />}
  </Box>;
}

function ReviewView({ floor }: { floor: FloorSnapshot }) { if (!floor.review) return <Text dimColor>No review available.</Text>; const review = floor.review as Record<string, any>; return <><Text>PR: {review.pullRequest?.url ?? "not created"}</Text><Text>Checks: {String(review.checksPassing ?? review.githubChecksPassing ?? "pending")}</Text><Text>Files: {review.files?.length ?? floor.runs.flatMap((run) => run.files).length} · Conflicts: {review.conflicts?.length ?? 0}</Text>{floor.runs.slice(-12).map((run) => <Text key={run.id}>{shortId(run.id)} · {run.agentName} · {run.status} · {run.summary ?? ""}</Text>)}</>; }

function CommandBar({ page, sessionId, actions, presence, focused, navigate, goSessions, refresh, retryWorkspaceSync, runBackground, setNotice }: { page: SessionPage; sessionId: string; actions: OpenFloorActions; presence?: PresenceClient; focused: boolean; navigate: (page: SessionPage) => void; goSessions: () => void; refresh: () => void; retryWorkspaceSync: () => void; runBackground: (line: string) => Promise<void>; setNotice: (message: string) => void }) {
  const { exit } = useApp(); const [value, setValue] = useState(""); const [inputKey, setInputKey] = useState(0);
  const reset = () => { setValue(""); setInputKey((key) => key + 1); presence?.sendDraft("", false); };
  const submit = async (raw: string) => {
    const text = raw.trim(); if (!text) return;
    if (text.startsWith("/")) {
      const [command = "", ...rest] = text.slice(1).split(/\s+/); const argument = rest.join(" ").trim();
      if (["floor", "overview", "review", "repository", "settings"].includes(command)) navigate(command as SessionPage);
      else if (command === "sessions") goSessions();
      else if (command === "refresh") { refresh(); setNotice("Session refreshed."); }
      else if (command === "sync") retryWorkspaceSync();
      else if (command === "commands" || command === "help") navigate("help");
      else if (command === "quit") exit();
      else if (command === "chat") { if (!argument) { setNotice("Usage: /chat <message>"); return; } await actions.post(`/api/sessions/${sessionId}/messages`, { text: argument, recipientUserId: null }); setNotice("Team message sent."); refresh(); }
      else if (command === "queue") { if (!argument) { setNotice("Usage: /queue <prompt>"); return; } await actions.post(`/api/sessions/${sessionId}/queue`, { prompt: argument, agentId: null }); setNotice("Prompt added to queue."); refresh(); }
      else if (command === "run") { if (!argument) { setNotice("Usage: /run <CLI subcommand>"); return; } await runBackground(argument); }
      else setNotice(`Unknown command: /${command}. Use /commands.`);
      reset(); return;
    }
    await actions.post(`/api/sessions/${sessionId}/queue`, { prompt: text, agentId: null }); setNotice("Prompt added to queue."); refresh(); reset();
  };
  const suggestions = value.startsWith("/") ? SESSION_COMMANDS.filter((command) => command.startsWith(value.split(/\s/, 1)[0]!)).slice(0, 8) : [];
  return <Box flexDirection="column">{suggestions.length > 0 && <CommandSuggestions commands={suggestions} selected={0} />}<Box borderStyle={focused ? "double" : "round"} borderColor="cyan" paddingX={1}><Text color="cyan">{focused ? `${page} › ` : `${page} · Tab returns › `}</Text><TextInput key={inputKey} isDisabled={!focused} placeholder="Prompt agents or type /help" onChange={(next) => { setValue(next); if (next.startsWith("/")) presence?.sendDraft("", false); else presence?.sendDraft(next); }} onSubmit={(next) => { void submit(next).catch((reason) => setNotice(reason instanceof Error ? reason.message : String(reason))); }} /></Box></Box>;
}

const HOME_COMMANDS = ["/new", "/settings", "/help", "/logout", "/sessions", "/refresh", "/run", "/quit"] as const;
const SESSION_COMMANDS = ["/floor", "/overview", "/review", "/repository", "/settings", "/sessions", "/chat", "/queue", "/run", "/refresh", "/sync", "/help", "/quit"] as const;

function HomeCommandBar({ active, setActive, page, submit, setNotice }: { active: boolean; setActive: (active: boolean) => void; page: "sessions" | "cli-settings" | "cli-help"; submit: (value: string) => Promise<void>; setNotice: (message: string) => void }) {
  const [value, setValue] = useState(""); const [inputKey, setInputKey] = useState(0); const [selected, setSelected] = useState(0);
  const suggestions = HOME_COMMANDS.filter((command) => command.startsWith(value.split(/\s/, 1)[0] || "/"));
  const activeSelection = Math.min(selected, Math.max(0, suggestions.length - 1));
  const reset = () => { setActive(false); setValue(""); setSelected(0); setInputKey((key) => key + 1); };
  useInput((input, key) => {
    if (!active) {
      if (input === "/" || (key.ctrl && input === "k")) { setValue("/"); setSelected(0); setInputKey((current) => current + 1); setActive(true); }
      return;
    }
    if (key.escape) { reset(); return; }
    if (key.upArrow) setSelected((current) => Math.max(0, current - 1));
    if (key.downArrow) setSelected((current) => Math.min(Math.max(0, suggestions.length - 1), current + 1));
  });
  const execute = async (raw: string) => {
    const trimmed = raw.trim();
    const command = trimmed === "/" || (!HOME_COMMANDS.includes(trimmed as typeof HOME_COMMANDS[number]) && !trimmed.startsWith("/run ")) ? suggestions[activeSelection] ?? trimmed : trimmed;
    if (!command.startsWith("/")) { setNotice("Commands start with /. Press / to open commands."); return; }
    try { await submit(command); reset(); }
    catch (reason) { setNotice(sanitizeTerminal(reason instanceof Error ? reason.message : String(reason)).slice(-240)); }
  };
  const label = page === "sessions" ? "sessions" : page === "cli-settings" ? "settings" : "help";
  return <Box flexDirection="column">{active && suggestions.length > 0 && <CommandSuggestions commands={suggestions} selected={activeSelection} />}<Box borderStyle={active ? "double" : "round"} borderColor="cyan" paddingX={1}><Text color="cyan">{label} › </Text><TextInput key={inputKey} isDisabled={!active} {...(active ? { defaultValue: "/" } : {})} placeholder="Type / for commands" onChange={setValue} onSubmit={(raw) => { void execute(raw); }} /></Box></Box>;
}

function CommandSuggestions({ commands, selected }: { commands: readonly string[]; selected: number }) {
  return <Box flexDirection="column" paddingX={1}>{commands.map((command, index) => <Text key={command} inverse={index === selected} {...(index === selected ? { color: "cyan" as const } : {})}>{index === selected ? "›" : " "} {command}</Text>)}</Box>;
}

function BindWorkspaceConfirm({ workspace, repositoryName, branch, sha, close, confirm }: { workspace: LocalWorkspace; repositoryName: string; branch: string; sha: string; close: () => void; confirm: () => Promise<void> }) {
  const [working, setWorking] = useState(false); const [error, setError] = useState<string | null>(null);
  useInput((input, key) => { if (working) return; if (key.escape || input.toLowerCase() === "n") close(); else if (key.return || input.toLowerCase() === "y") { setWorking(true); setError(null); void confirm().then(close, (reason) => { setWorking(false); setError(reason instanceof Error ? reason.message : String(reason)); }); } });
  return <PageFrame title="Enable local live sync?"><Text>Repository: {repositoryName}</Text><Text>Directory: {workspace.root}</Text><Text>Candidate: {branch}</Text><Text>Expected SHA: {sha}</Text><Text color="yellow">Clean checkout will switch to this candidate branch and receive fast-forward updates. Local edits are never uploaded.</Text>{error && <Text color="red">{error}</Text>}<Text color="cyan">{working ? "Checking workspace…" : "Enter/y confirms · Esc/n keeps local sync off"}</Text></PageFrame>;
}

type CreateStage = "loading" | "empty" | "title" | "objective" | "candidate" | "repository" | "repository-search" | "confirm" | "submitting" | "error" | "provision-failed";
function CreateSessionWizard({ actions, baseUrl, close, workspace, onCreated }: { actions: OpenFloorActions; baseUrl: string; close: () => void; workspace?: LocalWorkspace; onCreated: (id: string, ready: boolean, message: string) => void }) {
  const [stage, setStage] = useState<CreateStage>("loading"); const [repositories, setRepositories] = useState<RepositoryOption[]>([]); const [selectedRepository, setSelectedRepository] = useState(0); const [search, setSearch] = useState(""); const [title, setTitle] = useState(""); const [objective, setObjective] = useState(""); const [candidateName, setCandidateName] = useState(""); const [error, setError] = useState<string | null>(null); const [loadAttempt, setLoadAttempt] = useState(0); const submitted = useRef(false);
  useEffect(() => { let active = true; void actions.repositories().then(({ repositories: values }) => { if (!active) return; const available = workspace ? values.filter((repository) => repository.fullName.toLowerCase() === workspace.repositoryFullName.toLowerCase()) : values; setRepositories(available); setSelectedRepository(0); setStage(available.length ? "title" : "empty"); }, (reason) => { if (active) { setError(reason instanceof Error ? reason.message : String(reason)); setStage("error"); } }); return () => { active = false; }; }, [actions, loadAttempt, workspace]);
  const filtered = repositories.filter((repository) => repository.fullName.toLowerCase().includes(search.trim().toLowerCase())); const selected = repositories[selectedRepository];
  const submit = async () => { if (!selected || submitted.current) return; submitted.current = true; setError(null); setStage("submitting"); try { if (workspace) await requireCleanWorkspace(workspace); const created = await actions.createSession({ title: title.trim(), objective: objective.trim() || null, candidateName: candidateName.trim() || title.trim(), repositoryId: selected.id, accountInstallationId: selected.accountInstallationId }); const ready = created.setupStatus === "ready"; const message = ready ? "Session created." : created.setupError ?? "Session created, but repository setup needs attention."; if (!ready) { setError(message); setStage("provision-failed"); } onCreated(created.session.id, ready, message); } catch (reason) { submitted.current = false; setError(reason instanceof Error ? reason.message : String(reason)); setStage("error"); } };
  useInput((input, key) => { if (stage === "repository") { if (key.upArrow) setSelectedRepository((value) => Math.max(0, value - 1)); else if (key.downArrow) setSelectedRepository((value) => Math.min(repositories.length - 1, value + 1)); else if (input.toLowerCase() === "s") { setSearch(""); setStage("repository-search"); } else if (key.return && selected) setStage("confirm"); else if (key.escape) setStage("candidate"); return; } if (stage === "confirm") { if (key.return) void submit(); else if (key.escape) setStage("repository"); return; } if (stage === "empty" && key.return) { void open(`${baseUrl}/home/settings?section=connections`); return; } if (stage === "error" && input.toLowerCase() === "r") { setError(null); if (repositories.length) setStage("confirm"); else { setStage("loading"); setLoadAttempt((value) => value + 1); } return; } if (!key.escape) return; if (stage === "objective") setStage("title"); else if (stage === "candidate") setStage("objective"); else if (stage === "repository-search") setStage("repository"); else if (!["loading", "submitting"].includes(stage)) close(); });
  return <PageFrame title={workspace ? `New local session · ${workspace.repositoryFullName}` : "New session"}>
    {stage === "loading" && <Text color="cyan">Loading GitHub repositories…</Text>}
    {stage === "empty" && <><Text>{workspace ? `${workspace.repositoryFullName} is not available to openfloor.` : "No repositories available."}</Text><Text>Press Enter to update GitHub access.</Text></>}
    {stage === "title" && <><Text>Task</Text><TextInput placeholder="What is this session for?" onSubmit={(value) => { const next = value.trim(); if (next) { setTitle(next.slice(0, 100)); setCandidateName(next.slice(0, 100)); setStage("objective"); } }} /></>}
    {stage === "objective" && <><Text>Goal <Text dimColor>(optional)</Text></Text><TextInput placeholder="Press Enter to skip" onSubmit={(value) => { setObjective(value.slice(0, 2_000)); setStage("candidate"); }} /></>}
    {stage === "candidate" && <><Text>Candidate branch name</Text><TextInput defaultValue={candidateName || title} placeholder={title} onSubmit={(value) => { setCandidateName((value.trim() || title).slice(0, 100)); setStage("repository"); }} /></>}
    {stage === "repository" && <><Text>Select repository</Text>{repositories.map((repository, index) => <Text key={`${repository.accountInstallationId}:${repository.id}`} inverse={index === selectedRepository} {...(index === selectedRepository ? { color: "cyan" as const } : {})}>{index === selectedRepository ? "›" : " "} {repository.fullName} · {repository.defaultBranch}</Text>)}<Text dimColor>↑↓ select · s search · Enter continue</Text></>}
    {stage === "repository-search" && <><Text>Search repositories</Text><TextInput placeholder="owner/repository" onChange={setSearch} onSubmit={() => { const first = filtered[0]; if (first) { setSelectedRepository(repositories.indexOf(first)); setStage("repository"); } }} />{filtered.slice(0, 6).map((repository, index) => <Text key={repository.id} {...(index === 0 ? { color: "cyan" as const } : {})}>{index === 0 ? "›" : " "} {repository.fullName}</Text>)}</>}
    {stage === "confirm" && selected && <><Text bold>{title}</Text><Text>{objective || "No goal provided"}</Text><Text>Repository: {selected.fullName}</Text><Text>Candidate: {candidateName || title}</Text>{workspace && <Text color="yellow">Creation requires a clean worktree. It will switch to the server candidate branch, then receive fast-forward updates. Local edits are never uploaded.</Text>}<Text color="cyan">Press Enter to create once. Esc goes back.</Text></>}
    {stage === "submitting" && <Text color="cyan">Creating session and candidate branch…</Text>}
    {stage === "error" && <><Text color="red">{error ?? "Unable to create session."}</Text><Text dimColor>Press r to retry or Esc to close.</Text></>}
    {stage === "provision-failed" && <><Text color="red">{error}</Text><Text>The session was created, but its repository needs attention.</Text><Text dimColor>Esc returns to Sessions. Select the new session to inspect Repository.</Text></>}
  </PageFrame>;
}

function ErrorView({ error }: { error: unknown }) { return <Box flexDirection="column"><Text color="red" bold>Unable to load openfloor</Text><Text>{sanitizeTerminal(error instanceof Error ? error.message : String(error))}</Text><Text dimColor>Run openfloor auth login or openfloor doctor.</Text></Box>; }
function appendActivity(current: Record<string, Array<{ sequence: number; kind: string; detail: string }>>, runId: string, events: Array<{ sequence: number; kind: string; detail: string }>) { const all = [...(current[runId] ?? []), ...events].sort((left, right) => left.sequence - right.sequence); return { ...current, [runId]: all.filter((item, index) => index === 0 || item.sequence !== all[index - 1]!.sequence).slice(-100) }; }
function floorPaneCount(pane: FloorPane, floor: FloorSnapshot | undefined): number { if (!floor) return 0; if (pane === "chat") return Math.min(14, floor.messages.length); if (pane === "agents") return floor.agents.length; return Math.min(14, floor.queue.length); }
function recordText(value: unknown, key: string, fallback = ""): string { if (!value || typeof value !== "object" || !(key in value)) return fallback; const entry = (value as Record<string, unknown>)[key]; return typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean" ? String(entry) : fallback; }
function recordArray(value: unknown, ...keys: string[]): Array<Record<string, unknown>> { if (!value || typeof value !== "object") return []; for (const key of keys) { const entry = (value as Record<string, unknown>)[key]; if (Array.isArray(entry)) return entry.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)); } return []; }
function sessionGroup(session: SessionSummary): number { return session.endedAt != null ? 2 : session.archivedAt != null ? 1 : 0; }
function isSessionPage(page: Page): page is SessionPage { return ["floor", "overview", "review", "repository", "settings", "help"].includes(page); }
function isHomePage(page: Page): page is "sessions" | "cli-settings" | "cli-help" { return ["sessions", "cli-settings", "cli-help"].includes(page); }
function statusColor(status: string): "green" | "yellow" | "red" | "cyan" | "white" { if (["completed", "integrated", "ready", "passed"].includes(status)) return "green"; if (["failed", "cancelled", "conflicted"].includes(status)) return "red"; if (["running", "publishing", "integrating"].includes(status)) return "cyan"; if (["paused", "queued", "pending", "awaiting_input"].includes(status)) return "yellow"; return "white"; }
function capitalize(value: string): string { return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`; }

async function runPalette(line: string, sessionId: string | null, baseUrl: string): Promise<void> { const args = tokenize(line); if (!args.length) return; args.push("--base-url", baseUrl, "--no-color", "--quiet"); if (sessionId) args.push("--session", sessionId); const entry = process.argv[1]; if (!entry) throw new Error("CLI entry point unavailable"); try { await exec(process.execPath, [entry, ...args], { encoding: "utf8", maxBuffer: 1024 * 1024 }); } catch (reason) { const error = reason as { stderr?: string; stdout?: string; message?: string }; throw new Error(sanitizeTerminal(`${error.stdout ?? ""}${error.stderr ?? ""}`.trim() || error.message || "Command failed.").slice(-8_000)); } }
export function tokenize(input: string): string[] { const values: string[] = []; let current = ""; let quote: string | null = null; let escaped = false; for (const char of input.trim()) { if (escaped) { current += char; escaped = false; continue; } if (char === "\\") { escaped = true; continue; } if (quote) { if (char === quote) quote = null; else current += char; continue; } if (char === '"' || char === "'") { quote = char; continue; } if (/\s/.test(char)) { if (current) { values.push(current); current = ""; } } else current += char; } if (escaped) current += "\\"; if (quote) throw new Error("Unclosed quote"); if (current) values.push(current); return values; }
export function formatDuration(seconds: number): string { const whole = Math.max(0, Math.floor(seconds)); const hours = Math.floor(whole / 3_600); const minutes = Math.floor((whole % 3_600) / 60); const remainder = whole % 60; return [hours ? `${hours}h` : "", minutes ? `${minutes}m` : "", (!hours && !minutes) || remainder ? `${remainder}s` : ""].filter(Boolean).join(" "); }
