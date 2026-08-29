import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import open from "open";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { OpenFloorActions } from "./actions.js";
import { logoutAccess } from "./auth.js";
import type { ApiClient } from "./client.js";
import { bindWorkspaceSession, unbindWorkspaceSession, updateConfig } from "./config.js";
import type { AppUser, FloorSnapshot, RepositoryOption, ReviewContribution, SessionMember, SessionSummary, Usage } from "./contracts.js";
import { OpenFloorError } from "./errors.js";
import { shortId } from "./id.js";
import { PresenceClient, type ConnectionStatus, type PresenceEvent, type TypingDraft } from "./realtime.js";
import { sanitizeTerminal } from "./sanitize.js";
import { credentialBody, credentialLabel, PROVIDER_CREDENTIAL_KINDS, PROVIDER_LABELS, PROVIDER_MODELS, PROVIDERS, type Provider } from "./providers.js";
import { EditableInput } from "./tui-input.js";
import { requireCleanWorkspace, synchronizeWorkspace, type LocalWorkspace } from "./workspace.js";

const exec = promisify(execFile);
type SessionPage = "floor" | "overview" | "review" | "settings" | "help";
type Page = "sessions" | "create-session" | "bind-workspace" | "create-agent" | "credentials" | "cli-settings" | "cli-help" | SessionPage;
type FloorPane = "chat" | "drafts" | "agents" | "queue";
type FloorDetail = { pane: FloorPane; index: number };
type LocalSync = "none" | "syncing" | "live" | "paused" | "mismatch";

export type TuiProps = { actions: OpenFloorActions; client: ApiClient; baseUrl: string; initialSessionId?: string; workspace?: LocalWorkspace; logout?: () => Promise<void>; runCommand?: (line: string, sessionId: string | null, baseUrl: string) => Promise<void> };

export function startTui(props: TuiProps): React.ReactElement {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, retry: false } } });
  return <QueryClientProvider client={queryClient}><App {...props} /></QueryClientProvider>;
}

function App({ actions, client, baseUrl, initialSessionId, workspace, logout = logoutAccess, runCommand = runPalette }: TuiProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [width, setWidth] = useState(stdout.columns || 100);
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId ?? null);
  const [selectedSession, setSelectedSession] = useState(0);
  const [page, setPage] = useState<Page>(initialSessionId ? "floor" : workspace ? "create-session" : "sessions");
  const [homeCommandActive, setHomeCommandActive] = useState(false);
  const [pagePanelFocused, setPagePanelFocused] = useState(false);
  const [credentialsReturn, setCredentialsReturn] = useState<"sessions" | "floor">("sessions");
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
  const [paneRows, setPaneRows] = useState<Record<FloorPane, number>>({ chat: 0, drafts: 0, agents: 0, queue: 0 });
  const [floorDetail, setFloorDetail] = useState<FloorDetail | null>(null);
  const [syncAttempt, setSyncAttempt] = useState(0);
  const startupHandled = useRef(false);
  const workspaceOfferHandled = useRef(new Set<string>());
  const syncedCandidate = useRef<string | null>(null);
  const syncQueue = useRef<Promise<unknown>>(Promise.resolve());
  const queryClient = useQueryClient();

  const homeQuery = useQuery({ queryKey: ["home"], queryFn: ({ signal }) => actions.home(signal) });
  const sessionQuery = useQuery({ queryKey: ["session", sessionId], queryFn: ({ signal }) => actions.session(sessionId!, signal), enabled: Boolean(sessionId && workspaceStartupResolved) });
  const floorQuery = useQuery({ queryKey: ["floor", sessionId], queryFn: ({ signal }) => actions.floor(sessionId!, signal), enabled: Boolean(sessionId && workspaceStartupResolved), refetchInterval: connection === "live" ? false : 10_000 });
  const skillsQuery = useQuery({ queryKey: ["skills", sessionId], queryFn: ({ signal }) => actions.get(`/api/sessions/${sessionId}/skills`, signal), enabled: Boolean(sessionId && page === "settings") });
  const mcpQuery = useQuery({ queryKey: ["mcp", sessionId], queryFn: ({ signal }) => actions.get(`/api/sessions/${sessionId}/mcp-servers`, signal), enabled: Boolean(sessionId && page === "settings") });

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
  const sessionLoadError = sessionQuery.error ?? floorQuery.error;
  const sessionLoading = Boolean(sessionId && (!workspaceStartupResolved || sessionQuery.isLoading || floorQuery.isLoading));
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
    setWorkspaceStartupResolved(true); setSessionId(id); setPage("floor"); setFloorFocus("prompt"); setFloorDetail(null); setHomeCommandActive(false); setPagePanelFocused(false);
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
  const goSessions = (refresh = true) => { setSessionId(null); setPage("sessions"); setConnection("closed"); setOnline(new Set()); setDrafts([]); setLocalSync("none"); setFloorFocus("prompt"); setFloorDetail(null); setHomeCommandActive(false); setPagePanelFocused(false); if (refresh) void homeQuery.refetch(); };
  const refreshSession = () => { void sessionQuery.refetch(); void floorQuery.refetch(); void homeQuery.refetch(); };
  const runBackground = async (line: string) => {
    try { await runCommand(line, sessionId, baseUrl); setNotice("Command completed in background."); refreshSession(); }
    catch (reason) { setNotice(sanitizeTerminal(reason instanceof Error ? reason.message : String(reason)).slice(-240)); }
  };
  const executeHomeCommand = async (raw: string) => {
    const [command = "", ...rest] = raw.trim().slice(1).split(/\s+/); const argument = rest.join(" ").trim();
    if (command === "new") { setSessionId(null); setPage("create-session"); }
    else if (command === "settings") setPage("cli-settings");
    else if (command === "credentials") { setCredentialsReturn("sessions"); setPage("credentials"); }
    else if (command === "account") { await open(`${baseUrl}/home/settings`); setNotice("Account settings opened in browser."); }
    else if (command === "help") setPage("cli-help");
    else if (command === "sessions") setPage("sessions");
    else if (command === "refresh") { await homeQuery.refetch(); setNotice("Sessions refreshed."); }
    else if (command === "run") { if (!argument) throw new Error("Usage: /run <CLI subcommand>"); await runBackground(argument); }
    else if (command === "logout") { await logout(); exit(); }
    else if (command === "quit" || command === "exit") exit();
    else throw new Error(`Unknown command: /${command}. Use /help.`);
  };

  useInput((input, key) => {
    const presence = (globalThis as Record<string, unknown>).__openfloorPresence as PresenceClient | undefined;
    presence?.noteInput();
    if (key.escape && page === "sessions" && homeQuery.isLoading) {
      void queryClient.cancelQueries({ queryKey: ["home"] });
      exit();
      return;
    }
    if (["create-session", "bind-workspace", "create-agent", "credentials"].includes(page)) return;
    if (sessionId) {
      if (key.escape && sessionLoading) {
        if (homeQuery.isLoading && !homeQuery.data) void queryClient.cancelQueries({ queryKey: ["home"] });
        void queryClient.cancelQueries({ queryKey: ["session", sessionId] });
        void queryClient.cancelQueries({ queryKey: ["floor", sessionId] });
        if (homeQuery.isLoading && !homeQuery.data) {
          exit();
          return;
        }
        setNotice("Session loading stopped.");
        goSessions(false);
        return;
      }
      if (sessionLoadError) {
        if (key.escape) goSessions(false);
        else if (input === "r") refreshSession();
        return;
      }
      if (key.ctrl && input === "k") { setFloorFocus("prompt"); setFloorDetail(null); return; }
      if (input === "?" && page === "floor") { setPage("help"); setFloorFocus("prompt"); setFloorDetail(null); return; }
      if (page !== "floor") {
        if (key.tab) { setPagePanelFocused((current) => !current); return; }
        if (key.escape && pagePanelFocused && page !== "review" && page !== "settings") { setPagePanelFocused(false); return; }
        return;
      }
      if (floorDetail) { if (key.escape) setFloorDetail(null); else if (input === "q") exit(); return; }
      if (key.tab) { setFloorFocus((current) => current === "prompt" ? "chat" : current === "chat" ? "drafts" : current === "drafts" ? "agents" : current === "agents" ? "queue" : "prompt"); return; }
      if (floorFocus === "prompt") return;
      const panes: FloorPane[] = ["chat", "drafts", "agents", "queue"];
      if (key.escape) { setFloorFocus("prompt"); return; }
      if (key.leftArrow || key.rightArrow) { const index = panes.indexOf(floorFocus); const offset = key.leftArrow ? -1 : 1; setFloorFocus(panes[(index + offset + panes.length) % panes.length]!); return; }
      const count = floorPaneCount(floorFocus, floor, drafts);
      if (key.upArrow) setPaneRows((current) => ({ ...current, [floorFocus]: Math.max(0, current[floorFocus] - 1) }));
      else if (key.downArrow) setPaneRows((current) => ({ ...current, [floorFocus]: Math.min(Math.max(0, count - 1), current[floorFocus] + 1) }));
      else if (key.return && count > 0) {
        const index = Math.min(paneRows[floorFocus], count - 1);
        if (floorFocus === "agents" && index === (floor?.agents.length ?? 0)) { setPage("create-agent"); setFloorFocus("prompt"); }
        else setFloorDetail({ pane: floorFocus, index });
      }
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
  if (homeQuery.isLoading && page === "sessions") return <LoadingView message="Loading openfloor…" escape="Esc stops and exits" />;
  if (homeQuery.error && page === "sessions") return <ErrorView error={homeQuery.error} />;

  return <Box flexDirection="column" width="100%">
    <Header {...(homeQuery.data?.props.user ? { user: homeQuery.data.props.user } : sessionQuery.data?.props.user ? { user: sessionQuery.data.props.user } : {})} {...(sessionQuery.data?.props.session ? { session: sessionQuery.data.props.session } : {})} connection={connection} {...(workspace ? { workspace } : {})} localSync={effectiveLocalSync} />
    {notice && <Text color={effectiveLocalSync === "paused" || effectiveLocalSync === "mismatch" ? "yellow" : "cyan"}>{notice}</Text>}
    {page === "sessions" && <Home sessions={sessions} selected={homeSelection} {...(homeQuery.data?.props.usage ? { usage: homeQuery.data.props.usage } : {})} {...(workspace ? { workspace } : {})} />}
    {page === "cli-settings" && <CliSettings baseUrl={baseUrl} />}
    {page === "cli-help" && <HelpPage session={false} />}
    {page === "credentials" && <CredentialsPage actions={actions} close={() => setPage(credentialsReturn)} setNotice={setNotice} />}
    {page === "create-session" && <CreateSessionWizard actions={actions} baseUrl={baseUrl} close={goSessions} {...(workspace ? { workspace } : {})} onCreated={(id, ready, message) => { setNotice(message); void homeQuery.refetch(); if (ready) void enterSession(id, Boolean(workspace)); }} />}
    {page === "bind-workspace" && workspace && floor && <BindWorkspaceConfirm workspace={workspace} repositoryName={repositoryName} branch={candidateBranch} sha={candidateSha} close={() => setPage("floor")} confirm={enableWorkspaceSync} />}
    {page === "bind-workspace" && (!workspace || !floor) && <PageFrame title="Local sync unavailable"><Text>No matching local GitHub workspace is available.</Text><Text dimColor>Esc returns to the floor.</Text></PageFrame>}
    {page === "create-agent" && sessionId && <CreateAgentPage actions={actions} sessionId={sessionId} members={members} close={() => setPage("floor")} completed={() => { refreshSession(); setNotice("Agent created."); setPage("floor"); }} />}
    {sessionId && isSessionPage(page) && (sessionLoadError
      ? <SessionLoadError error={sessionLoadError} />
      : floor ? <>
      {page === "floor" ? floorDetail ? <FloorItemDetail detail={floorDetail} floor={floor} drafts={drafts} activities={activities} /> : <FloorDashboard width={width} floor={floor} online={online} drafts={drafts} activities={activities} focus={floorFocus} rows={paneRows} /> : <PageView page={page} floor={floor} members={members} owner={sessionQuery.data?.props.session.role === "owner"} online={online} skills={skillsQuery.data} mcp={mcpQuery.data} active={pagePanelFocused} focusPrompt={() => setPagePanelFocused(false)} actions={actions} sessionId={sessionId} refresh={refreshSession} setNotice={setNotice} {...(workspace ? { workspace } : {})} localSync={effectiveLocalSync} />}
      <CommandBar key={page} page={page} sessionId={sessionId} actions={actions} {...((globalThis as Record<string, unknown>).__openfloorPresence ? { presence: (globalThis as Record<string, unknown>).__openfloorPresence as PresenceClient } : {})} focused={page === "floor" ? floorFocus === "prompt" && !floorDetail : !pagePanelFocused} navigate={(next) => { setPage(next); setFloorDetail(null); setFloorFocus("prompt"); setPagePanelFocused(false); }} openCredentials={() => { setCredentialsReturn("floor"); setPage("credentials"); }} goSessions={goSessions} refresh={refreshSession} retryWorkspaceSync={retryWorkspaceSync} runBackground={runBackground} logout={logout} setNotice={setNotice} />
    </> : <LoadingView message="Loading session floor…" escape={homeQuery.isLoading && !homeQuery.data ? "Esc stops and exits" : "Esc stops and returns to Sessions"} />)}
    {isHomePage(page) && <HomeCommandBar active={homeCommandActive} setActive={setHomeCommandActive} page={page} submit={executeHomeCommand} setNotice={setNotice} />}
  </Box>;
}

function Header({ user, session, connection, workspace, localSync }: { user?: AppUser; session?: SessionSummary; connection: ConnectionStatus; workspace?: LocalWorkspace; localSync: LocalSync }) {
  const syncText = !workspace ? "" : localSync === "live" ? " · local live" : localSync === "syncing" ? " · syncing local" : localSync === "paused" ? " · local paused" : localSync === "mismatch" ? " · different repository" : "";
  return <Box borderStyle="round" borderColor="cyan" paddingX={1} justifyContent="space-between"><Text bold color="cyan">openfloor</Text><Text>{user ? `Logged in as ${user.displayName || user.email} · ` : ""}{session ? `${session.title} · ` : ""}<Text color={connection === "live" ? "green" : connection === "quota-exhausted" ? "red" : "yellow"}>{connection}</Text><Text color={localSync === "live" ? "green" : "yellow"}>{syncText}</Text></Text></Box>;
}

function Home({ sessions, selected, usage, workspace }: { sessions: SessionSummary[]; selected: number; usage?: Usage; workspace?: LocalWorkspace }) {
  const groups = [["Active", sessions.filter((session) => session.endedAt == null && session.archivedAt == null)], ["Archived", sessions.filter((session) => session.endedAt == null && session.archivedAt != null)], ["Ended", sessions.filter((session) => session.endedAt != null)]] as const;
  return <PageFrame title="Sessions">{workspace && <Text color="cyan">Git workspace detected: {workspace.repositoryFullName}</Text>}{sessions.length === 0 ? <Text dimColor>No sessions. Use /new to create one.</Text> : groups.map(([label, values]) => values.length ? <Box key={label} flexDirection="column"><Text bold>{label}</Text>{values.map((session) => { const index = sessions.indexOf(session); return <Text key={session.id} inverse={index === selected} {...(index === selected ? { color: "cyan" as const } : {})}>{index === selected ? "›" : " "} {session.title.padEnd(30).slice(0, 30)} {shortId(session.id)} {session.role}</Text>; })}</Box> : null)}{usage && <UsageSummary usage={usage} />}</PageFrame>;
}

function CliSettings({ baseUrl }: { baseUrl: string }) {
  return <PageFrame title="CLI settings"><Text>Server: {baseUrl}</Text><Text>Authentication: Cloudflare Access in an openfloor-only local cache</Text><Text dimColor>/logout removes this CLI's cached Access session and workspace bindings.</Text><Text bold>Connections</Text><Text>/credentials safely connects AI credentials without shell history.</Text><Text bold>Browser-owned settings</Text><Text>/account opens profile, billing, GitHub installations, and account controls.</Text><Text dimColor>/exit returns to Sessions.</Text></PageFrame>;
}

function HelpPage({ session }: { session: boolean }) {
  return <PageFrame title="Help">{session ? <><Text>Type ordinary text to queue work; use /chat &lt;message&gt; for team chat.</Text><Text>/floor /overview /review /settings /sessions /credentials /sync /refresh /exit /quit</Text><Text>/invite /members /agents /assignments /routing /queue /files /runs /conflicts /skills /mcp</Text><Text>Tab changes panel · arrows navigate · Enter opens · Esc returns to prompt.</Text></> : <><Text>↑↓ select · Enter opens · n creates · / starts a command.</Text><Text>/new /settings /credentials /account /help /logout /refresh /exit /quit</Text><Text>Ctrl+K focuses commands · Esc closes command entry.</Text></>}<Text>Ctrl+C exits locally and never cancels remote runs.</Text></PageFrame>;
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
  const messages = teamMessages(floor);
  const queue = orderedQueue(floor);
  const chatPanel = <Panel title="Team chat" width="100%" active={focus === "chat"}>{messages.length ? messages.slice(-10).map((message, index) => <Text key={recordText(message, "id", String(index))} inverse={focus === "chat" && index === rows.chat}><Text bold color="cyan">{recordText(message, "authorName", "Member")}</Text>: {recordText(message, "text")}</Text>) : <Text dimColor>No public messages. Use /chat message.</Text>}{online.size > 0 && <Text dimColor>{online.size} online</Text>}</Panel>;
  const draftsPanel = <Panel title="Live teammate prompts" width="100%" active={focus === "drafts"}>{drafts.length ? drafts.slice(-6).map((draft, index) => <Text key={draft.userId} inverse={focus === "drafts" && index === rows.drafts} color="yellow"><Text bold>{draft.displayName}</Text>: {draft.text.slice(0, 100)}</Text>) : <Text dimColor>No teammates drafting.</Text>}</Panel>;
  return <Box flexDirection={horizontal ? "row" : "column"} minHeight={22}>
    {horizontal ? <Box flexDirection="column" width="28%">{chatPanel}{draftsPanel}</Box> : <>{chatPanel}{draftsPanel}</>}
    <Panel title="Agent floor" width={horizontal ? "44%" : "100%"} active={focus === "agents"}>{floor.agents.map((agent, index) => { const run = floor.runs.filter((item) => item.agentId === agent.id).sort((left, right) => right.updatedAt - left.updatedAt)[0]; const live = run ? activities[run.id]?.at(-1) : undefined; const status = agent.pausedAt ? "paused" : run?.status ?? "idle"; return <Box key={agent.id} flexDirection="column" marginBottom={1}><Text inverse={focus === "agents" && index === rows.agents} bold color={statusColor(status)}>● {agent.name} <Text dimColor>{agent.provider}/{agent.model ?? "default"}</Text></Text><Text>{agent.role}: {agent.task}</Text><Text color={statusColor(status)}>{status}{live ? ` · ${live.detail}` : ""}</Text></Box>; })}<Text inverse={focus === "agents" && rows.agents === floor.agents.length} color="cyan">＋ Create agent</Text></Panel>
    <Panel title="Prompt queue" width={horizontal ? "28%" : "100%"} active={focus === "queue"}>{queue.length ? queue.slice(0, 14).map((item, index) => <Box key={item.id} flexDirection="column" marginBottom={1}><Text inverse={focus === "queue" && index === rows.queue} color={statusColor(item.status)}>{String(item.position + 1).padStart(2)} · {item.status} · {item.agentName ?? "unassigned"}</Text><Text>{item.prompts.map((prompt) => prompt.text).join(" / ").slice(0, 100)}</Text></Box>) : <Text dimColor>Queue empty. Type a prompt below.</Text>}</Panel>
  </Box>;
}

function Panel({ title, width, active, children }: { title: string; width: number | `${number}%`; active: boolean; children: React.ReactNode }) { return <Box flexDirection="column" width={width} borderStyle={active ? "double" : "round"} borderColor={active ? "cyan" : "gray"} paddingX={1}><Text bold color="cyan">{active ? "› " : ""}{title}</Text>{children}</Box>; }

function FloorItemDetail({ detail, floor, drafts, activities }: { detail: FloorDetail; floor: FloorSnapshot; drafts: TypingDraft[]; activities: Record<string, Array<{ sequence: number; kind: string; detail: string }>> }) {
  if (detail.pane === "chat") { const message = teamMessages(floor).slice(-10)[detail.index]; return <Detail title="Team message"><Text bold>{recordText(message, "authorName", "Member")}</Text><Text>{recordText(message, "text")}</Text><Text dimColor>Esc returns to floor</Text></Detail>; }
  if (detail.pane === "drafts") { const draft = drafts.slice(-6)[detail.index]; return <Detail title="Live teammate prompt"><Text bold>{draft?.displayName ?? "Teammate"}</Text><Text>{draft?.text ?? "Draft ended."}</Text><Text dimColor>Ephemeral · Esc returns to floor</Text></Detail>; }
  if (detail.pane === "agents") { const agent = floor.agents[detail.index]; if (!agent) return <Detail title="Agent">Agent no longer available.</Detail>; const run = floor.runs.filter((item) => item.agentId === agent.id).sort((left, right) => right.updatedAt - left.updatedAt)[0]; const live = run ? activities[run.id]?.at(-1) : undefined; return <Detail title={agent.name}><Text>{agent.role}: {agent.task}</Text><Text>Provider: {agent.provider}/{agent.model ?? "default"}</Text><Text>Owner: {agent.ownerName}</Text><Text>Status: {agent.pausedAt ? "paused" : run?.status ?? "idle"}</Text>{live && <Text>Latest: {live.detail}</Text>}<Text dimColor>ID {agent.id} · Esc returns to floor</Text></Detail>; }
  const item = orderedQueue(floor).slice(0, 14)[detail.index]; if (!item) return <Detail title="Prompt">Prompt no longer available.</Detail>; return <Detail title={`Queue ${item.position + 1}`}><Text>Status: {item.status} · {item.agentName ?? "unassigned"}</Text>{item.prompts.map((prompt) => <Text key={prompt.id}><Text bold>{prompt.authorName}:</Text> {prompt.text}</Text>)}<Text dimColor>ID {item.id} · Esc returns to floor</Text></Detail>;
}

function Detail({ title, children }: { title: string; children: React.ReactNode }) { return <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} minHeight={22}><Text bold color="cyan">{title}</Text>{children}</Box>; }

function PageView({ page, floor, members, owner, online, skills, mcp, workspace, localSync, active, focusPrompt, actions, sessionId, refresh, setNotice }: { page: Exclude<SessionPage, "floor">; floor: FloorSnapshot; members: SessionMember[]; owner: boolean; online: Set<string>; skills: unknown; mcp: unknown; workspace?: LocalWorkspace; localSync: LocalSync; active: boolean; focusPrompt: () => void; actions: OpenFloorActions; sessionId: string; refresh: () => void; setNotice: (message: string) => void }) {
  if (page === "review") return <ReviewPage actions={actions} sessionId={sessionId} floor={floor} active={active} focusPrompt={focusPrompt} />;
  if (page === "settings") return <SessionSettingsPage actions={actions} sessionId={sessionId} floor={floor} owner={owner} skills={skills} mcp={mcp} active={active} focusPrompt={focusPrompt} refresh={refresh} setNotice={setNotice} />;
  return <Box flexDirection="column" borderStyle={active ? "double" : "round"} borderColor={active ? "cyan" : "gray"} paddingX={1} minHeight={22}><Text bold color="cyan">/{page}</Text>
    {page === "overview" && <><Text bold>Members</Text>{members.map((member) => <Text key={member.id} color={online.has(member.id) ? "green" : "white"}>● {member.displayName} · {member.role}{online.has(member.id) ? " · online" : ""}</Text>)}<Text bold>Assignments</Text>{floor.assignments.length ? floor.assignments.map((assignment) => <Text key={recordText(assignment, "userId")}>{recordText(assignment, "userName")}: {recordText(assignment, "task", "Unassigned")}</Text>) : <Text dimColor>No assignments.</Text>}<Text bold>Repository</Text><Text>{recordText(floor.repository, "repositoryFullName", "No repository")} · {recordText(floor.activeCandidate, "branchName", "No candidate")}</Text>{workspace && <Text>Local: {workspace.root} · {localSync}</Text>}</>}
    {page === "help" && <HelpPage session />}
    <Text dimColor>{active ? "Esc returns to command bar" : "Tab enters this page · /exit returns to floor"}</Text>
  </Box>;
}

function ReviewPage({ actions, sessionId, floor, active, focusPrompt }: { actions: OpenFloorActions; sessionId: string; floor: FloorSnapshot; active: boolean; focusPrompt: () => void }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<"active" | "rolled_back">("active");
  const [mode, setMode] = useState<"files" | "prompts">("files");
  const [phase, setPhase] = useState<"list" | "files" | "diff">("list");
  const [selected, setSelected] = useState(0); const [fileSelected, setFileSelected] = useState(0); const [offset, setOffset] = useState(0); const [runId, setRunId] = useState<string | null>(null); const [targetPath, setTargetPath] = useState<string | null>(null); const [wrap, setWrap] = useState(true);
  const [loadingStopped, setLoadingStopped] = useState(false);
  const list = useQuery({ queryKey: ["review-contributions", sessionId, status], queryFn: ({ signal }) => actions.reviewContributions(sessionId, status, signal) });
  const detail = useQuery({ queryKey: ["review-contribution", sessionId, runId], queryFn: ({ signal }) => actions.reviewContribution(sessionId, runId!, signal), enabled: Boolean(runId) });
  const fileRows = useMemo(() => (list.data?.items ?? []).flatMap((item) => item.files.map((file) => ({ runId: item.runId, agentName: item.agentName, prompt: item.prompts[0]?.text ?? "", file }))), [list.data]);
  const rows = mode === "files" ? fileRows : list.data?.items ?? [];
  const contribution = detail.data?.contribution;
  const files = useMemo(() => contribution?.files ?? [], [contribution]);
  const selectedFile = files[Math.min(fileSelected, Math.max(0, files.length - 1))];
  const diffFile = targetPath ? files.find((file) => file.path === targetPath) ?? selectedFile : selectedFile;
  const diff = diffFile?.diff ?? [];
  useInput((input, key) => {
    if (key.escape && (list.isLoading || detail.isLoading)) {
      void queryClient.cancelQueries({ queryKey: ["review-contributions", sessionId] });
      void queryClient.cancelQueries({ queryKey: ["review-contribution", sessionId] });
      setLoadingStopped(true);
      focusPrompt();
      return;
    }
    if (input === "r" && loadingStopped) {
      setLoadingStopped(false);
      void list.refetch();
      if (runId) void detail.refetch();
      return;
    }
    if (key.escape) { if (phase === "diff") { setPhase(mode === "files" ? "list" : "files"); setOffset(0); } else if (phase === "files") setPhase("list"); else focusPrompt(); return; }
    if (input === "v" && phase === "list") { setMode((value) => value === "files" ? "prompts" : "files"); setSelected(0); setRunId(null); return; }
    if (input === "h" && phase === "list") { setStatus((value) => value === "active" ? "rolled_back" : "active"); setSelected(0); setRunId(null); return; }
    if (input === "w" && phase === "diff") { setWrap((value) => !value); return; }
    const count = phase === "list" ? rows.length : phase === "files" ? files.length : diff.length;
    if (key.upArrow) { if (phase === "diff") setOffset((value) => Math.max(0, value - 1)); else if (phase === "files") setFileSelected((value) => Math.max(0, value - 1)); else setSelected((value) => Math.max(0, value - 1)); }
    else if (key.downArrow) { if (phase === "diff") setOffset((value) => Math.min(Math.max(0, count - 1), value + 1)); else if (phase === "files") setFileSelected((value) => Math.min(Math.max(0, count - 1), value + 1)); else setSelected((value) => Math.min(Math.max(0, count - 1), value + 1)); }
    else if (key.return && phase === "list" && rows[selected]) {
      if (mode === "files") { const row = fileRows[selected]!; setRunId(row.runId); setTargetPath(row.file.path); setPhase("diff"); }
      else { const item = rows[selected] as ReviewContribution; setRunId(item.runId); setTargetPath(null); setFileSelected(0); setPhase("files"); }
    } else if (key.return && phase === "files" && selectedFile) { setTargetPath(selectedFile.path); setOffset(0); setPhase("diff"); }
  }, { isActive: active || list.isLoading || detail.isLoading });
  const review = floor.review;
  return <Box flexDirection="column" borderStyle={active ? "double" : "round"} borderColor={active ? "cyan" : "gray"} paddingX={1} minHeight={22}><Text bold color="cyan">/review · {status === "active" ? "Active" : "History"} · {capitalize(mode)}</Text>
    {!review && !list.isLoading && (list.data?.items.length ?? 0) === 0 && <Text dimColor>No review available.</Text>}
    {list.isLoading && !loadingStopped && <Text color="cyan">Loading review contributions… · Esc stops</Text>}{loadingStopped && !list.data && <Text color="yellow">Review loading stopped. Tab into Review and press r to retry.</Text>}{list.error && <Text color="red">{errorMessage(list.error)}</Text>}
    {phase === "list" && mode === "files" && fileRows.slice(0, 18).map((row, index) => <Text key={`${row.runId}:${row.file.path}`} inverse={active && index === selected}>{row.file.changeKind.padEnd(9)} {row.file.path} <Text dimColor>+{row.file.additions} -{row.file.deletions} · {row.agentName}</Text></Text>)}
    {phase === "list" && mode === "prompts" && (list.data?.items ?? []).slice(0, 18).map((item, index) => <Text key={item.runId} inverse={active && index === selected}>{shortId(item.runId)} · {item.agentName} · {item.prompts.map((prompt) => prompt.text).join(" / ").slice(0, 100)}</Text>)}
    {phase === "files" && <><Text bold>{contribution?.prompts.map((prompt) => prompt.text).join(" / ") ?? "Loading prompt…"}</Text>{files.map((file, index) => <Text key={file.path} inverse={active && index === fileSelected}>{file.changeKind.padEnd(9)} {file.path} <Text dimColor>+{file.additions} -{file.deletions}</Text></Text>)}</>}
    {phase === "diff" && <><Text bold>{diffFile?.path ?? "Loading diff…"} · wrap {wrap ? "on" : "off"}</Text>{diff.slice(offset, offset + 16).map((line, index) => <Text key={`${offset}:${index}`} color={line.type === "add" ? "green" : line.type === "remove" ? "red" : "white"}>{String(offset + index + 1).padStart(4)} {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "} {wrap ? line.text : line.text.slice(0, 120)}</Text>)}</>}
    <Text dimColor>{active ? "↑↓ select/scroll · Enter open · v Files/Prompts · h Active/History · w wrap · Esc back/prompt" : "Tab enters review · /exit returns to floor"}</Text>
  </Box>;
}

function SessionSettingsPage({ actions, sessionId, floor, owner, skills, mcp, active, focusPrompt, refresh, setNotice }: { actions: OpenFloorActions; sessionId: string; floor: FloorSnapshot; owner: boolean; skills: unknown; mcp: unknown; active: boolean; focusPrompt: () => void; refresh: () => void; setNotice: (message: string) => void }) {
  const [selected, setSelected] = useState(0); const [working, setWorking] = useState(false);
  const provider: Provider = floor.autoAgentProvider ?? "openai";
  const rows = [
    { label: "Auto-dispatch", value: floor.autoDispatch, field: "autoDispatch" },
    { label: "Generated agents", value: floor.autoProvisionAgents, field: "autoProvisionAgents" },
    { label: "Conflict resolution", value: floor.autoResolveConflicts, field: "autoResolveConflicts" },
    { label: "Default provider", value: provider, field: "autoAgentProvider" },
  ] as const;
  const mutate = async () => {
    if (!owner || working) return;
    const row = rows[selected]!; const next = row.field === "autoAgentProvider" ? PROVIDERS[(PROVIDERS.indexOf(provider) + 1) % PROVIDERS.length] : !row.value;
    setWorking(true);
    try { await actions.patch(`/api/sessions/${sessionId}/routing`, { [row.field]: next }); setNotice(`${row.label} updated.`); refresh(); }
    catch (error) { setNotice(errorMessage(error)); }
    finally { setWorking(false); }
  };
  useInput((_input, key) => { if (key.escape) focusPrompt(); else if (key.upArrow) setSelected((value) => Math.max(0, value - 1)); else if (key.downArrow) setSelected((value) => Math.min(rows.length - 1, value + 1)); else if (key.return) void mutate(); }, { isActive: active });
  return <Box flexDirection="column" borderStyle={active ? "double" : "round"} borderColor={active ? "cyan" : "gray"} paddingX={1} minHeight={22}><Text bold color="cyan">/settings</Text>
    {rows.map((row, index) => <Text key={row.field} inverse={active && selected === index}>{row.label.padEnd(22)} {typeof row.value === "boolean" ? row.value ? "on" : "off" : PROVIDER_LABELS[provider]}</Text>)}
    <Text>Skills: {recordArray(skills, "skills").length} · MCP servers: {recordArray(mcp, "servers").length}</Text>
    <Text dimColor>{owner ? working ? "Saving…" : active ? "↑↓ select · Enter toggle/cycle · Esc returns to command bar" : "Tab enters settings · /exit returns to floor" : "Session settings are owner-only."}</Text>
  </Box>;
}

function CommandBar({ page, sessionId, actions, presence, focused, navigate, openCredentials, goSessions, refresh, retryWorkspaceSync, runBackground, logout, setNotice }: { page: SessionPage; sessionId: string; actions: OpenFloorActions; presence?: PresenceClient; focused: boolean; navigate: (page: SessionPage) => void; openCredentials: () => void; goSessions: () => void; refresh: () => void; retryWorkspaceSync: () => void; runBackground: (line: string) => Promise<void>; logout: () => Promise<void>; setNotice: (message: string) => void }) {
  const { exit } = useApp(); const [value, setValue] = useState(""); const [selected, setSelected] = useState(0); const [inputKey, setInputKey] = useState(0);
  const suggestions = value.startsWith("/") ? commandSuggestions(SESSION_COMMANDS, value) : [];
  const activeSelection = Math.min(selected, Math.max(0, suggestions.length - 1));
  const reset = () => { setValue(""); setSelected(0); setInputKey((current) => current + 1); presence?.sendDraft("", false); };
  const submit = async (raw: string) => {
    const text = raw.trim(); if (!text) return;
    if (text.startsWith("/")) {
      const [command = "", ...rest] = text.slice(1).split(/\s+/); const argument = rest.join(" ").trim();
      const exact = SESSION_COMMANDS.some((entry) => entry.name === `/${command}`) || command === "run";
      if (!exact && suggestions[activeSelection]) { setValue(`${suggestions[activeSelection].name}${argument ? ` ${argument}` : ""}`); setInputKey((current) => current + 1); return; }
      if (["floor", "overview", "settings"].includes(command)) navigate(command as SessionPage);
      else if (command === "review" && !argument) navigate("review");
      else if (command === "sessions") goSessions();
      else if (command === "refresh") { refresh(); setNotice("Session refreshed."); }
      else if (command === "sync") retryWorkspaceSync();
      else if (command === "commands" || command === "help") navigate("help");
      else if (command === "credentials") openCredentials();
      else if (command === "account") { await open(`${actions.client.baseUrl}/home/settings`); setNotice("Account settings opened in browser."); }
      else if (command === "logout") { await logout(); exit(); }
      else if (command === "quit") exit();
      else if (command === "exit") { if (page === "floor") goSessions(); else navigate("floor"); }
      else if (command === "chat" && argument && !/^(list|send)\b/.test(argument)) { await actions.post(`/api/sessions/${sessionId}/messages`, { text: argument, recipientUserId: null }); setNotice("Team message sent."); refresh(); }
      else if (command === "queue" && argument && !/^(list|show|add|target|edit|pause|resume|delete|move|run)\b/.test(argument)) { await actions.post(`/api/sessions/${sessionId}/queue`, { prompt: argument, agentId: null }); setNotice("Prompt added to queue."); refresh(); }
      else if (command === "run") { if (!argument) { setNotice("Usage: /run <CLI subcommand>"); return; } await runBackground(argument); }
      else if (BACKGROUND_GROUPS.includes(command)) {
        const defaultAction = BACKGROUND_DEFAULTS[command];
        if (!argument && !defaultAction) { setNotice(`Usage: /${command} <subcommand>`); return; }
        await runBackground(`${command} ${argument || defaultAction}`.trim());
      }
      else setNotice(`Unknown command: /${command}. Use /commands.`);
      reset(); return;
    }
    await actions.post(`/api/sessions/${sessionId}/queue`, { prompt: text, agentId: null }); setNotice("Prompt added to queue."); refresh(); reset();
  };
  return <Box flexDirection="column">{focused && suggestions.length > 0 && <CommandSuggestions commands={suggestions} selected={activeSelection} />}<Box borderStyle={focused ? "double" : "round"} borderColor="cyan" paddingX={1}><Text color="cyan">{focused ? `${page} › ` : `${page} › `}</Text><EditableInput key={inputKey} value={value} active={focused} placeholder="Prompt agents or type /help" onUp={() => setSelected((current) => Math.max(0, current - 1))} onDown={() => setSelected((current) => Math.min(Math.max(0, suggestions.length - 1), current + 1))} onEscape={reset} onChange={(next) => { setValue(next); setSelected(0); if (next.startsWith("/")) presence?.sendDraft("", false); else presence?.sendDraft(next); }} onSubmit={(next) => { void submit(next).catch((reason) => setNotice(errorMessage(reason))); }} /></Box><Text dimColor>Tab: change panel · Esc: prompt · /: commands</Text></Box>;
}

type CommandSpec = { name: string; description: string };
const HOME_COMMANDS: readonly CommandSpec[] = [
  { name: "/new", description: "create session" }, { name: "/settings", description: "CLI settings" }, { name: "/credentials", description: "AI credentials" }, { name: "/account", description: "browser account settings" }, { name: "/help", description: "keyboard help" }, { name: "/logout", description: "remove CLI login" }, { name: "/sessions", description: "session list" }, { name: "/refresh", description: "reload sessions" }, { name: "/exit", description: "quit" }, { name: "/quit", description: "quit" },
];
const SESSION_COMMANDS: readonly CommandSpec[] = [
  { name: "/floor", description: "agent floor" }, { name: "/overview", description: "session overview" }, { name: "/review", description: "changes by file or prompt" }, { name: "/settings", description: "session settings" }, { name: "/sessions", description: "all sessions" }, { name: "/chat", description: "send or manage chat" }, { name: "/queue", description: "queue prompt or manage queue" }, { name: "/agents", description: "manage agents" }, { name: "/assignments", description: "manage assignments" }, { name: "/routing", description: "routing commands" }, { name: "/invite", description: "invite commands" }, { name: "/members", description: "member commands" }, { name: "/files", description: "file commands" }, { name: "/runs", description: "run commands" }, { name: "/conflicts", description: "conflict commands" }, { name: "/skills", description: "skill commands" }, { name: "/mcp", description: "MCP commands" }, { name: "/credentials", description: "AI credentials" }, { name: "/account", description: "browser account settings" }, { name: "/refresh", description: "reload floor" }, { name: "/sync", description: "retry local sync" }, { name: "/help", description: "keyboard help" }, { name: "/logout", description: "remove CLI login" }, { name: "/exit", description: "back" }, { name: "/quit", description: "quit" },
];
const BACKGROUND_GROUPS = ["invite", "members", "agents", "assignments", "routing", "queue", "chat", "files", "runs", "conflicts", "skills", "mcp", "review"];
const BACKGROUND_DEFAULTS: Record<string, string | undefined> = { invite: "show", members: "list", agents: "list", routing: "show", queue: "list", chat: "list", files: "list", runs: "list", conflicts: "list", skills: "list", mcp: "list", review: "status" };

function HomeCommandBar({ active, setActive, page, submit, setNotice }: { active: boolean; setActive: (active: boolean) => void; page: "sessions" | "cli-settings" | "cli-help"; submit: (value: string) => Promise<void>; setNotice: (message: string) => void }) {
  const [value, setValue] = useState(""); const [selected, setSelected] = useState(0); const [inputKey, setInputKey] = useState(0);
  const suggestions = commandSuggestions(HOME_COMMANDS, value || "/");
  const activeSelection = Math.min(selected, Math.max(0, suggestions.length - 1));
  const reset = () => { setActive(false); setValue(""); setSelected(0); setInputKey((current) => current + 1); };
  useInput((input, key) => {
    if (!active) {
      if (input === "/" || (key.ctrl && input === "k")) { setValue("/"); setSelected(0); setInputKey((current) => current + 1); setActive(true); }
      return;
    }
  });
  const execute = async (raw: string) => {
    const trimmed = raw.trim();
    const token = trimmed.split(/\s/, 1)[0] ?? ""; const exact = HOME_COMMANDS.some((entry) => entry.name === token) || token === "/run";
    if (!exact && suggestions[activeSelection]) { setValue(suggestions[activeSelection].name); setInputKey((current) => current + 1); return; }
    if (!trimmed.startsWith("/")) { setNotice("Commands start with /. Press / to open commands."); return; }
    try { await submit(trimmed); reset(); }
    catch (reason) { setNotice(sanitizeTerminal(reason instanceof Error ? reason.message : String(reason)).slice(-240)); }
  };
  const label = page === "sessions" ? "sessions" : page === "cli-settings" ? "settings" : "help";
  return <Box flexDirection="column">{active && suggestions.length > 0 && <CommandSuggestions commands={suggestions} selected={activeSelection} />}<Box borderStyle={active ? "double" : "round"} borderColor="cyan" paddingX={1}><Text color="cyan">{label} › </Text><EditableInput key={inputKey} value={value} active={active} placeholder="Type / for commands" onEscape={reset} onUp={() => setSelected((current) => Math.max(0, current - 1))} onDown={() => setSelected((current) => Math.min(Math.max(0, suggestions.length - 1), current + 1))} onChange={(next) => { setValue(next); setSelected(0); }} onSubmit={(raw) => { void execute(raw); }} /></Box></Box>;
}

function CommandSuggestions({ commands, selected }: { commands: readonly CommandSpec[]; selected: number }) {
  const start = Math.max(0, Math.min(selected - 4, Math.max(0, commands.length - 9)));
  return <Box flexDirection="column" paddingX={1}>{commands.slice(start, start + 9).map((command, visibleIndex) => { const index = start + visibleIndex; return <Text key={command.name} inverse={index === selected} {...(index === selected ? { color: "cyan" as const } : {})}>{index === selected ? "›" : " "} {command.name.padEnd(16)} <Text dimColor>{command.description}</Text></Text>; })}</Box>;
}

type AgentStage = "name" | "role" | "task" | "owner" | "provider" | "credential" | "model" | "confirm" | "submitting" | "error";
function CreateAgentPage({ actions, sessionId, members, close, completed }: { actions: OpenFloorActions; sessionId: string; members: SessionMember[]; close: () => void; completed: () => void }) {
  const [stage, setStage] = useState<AgentStage>("name"); const [name, setName] = useState(""); const [role, setRole] = useState(""); const [task, setTask] = useState(""); const [owner, setOwner] = useState(0); const [provider, setProvider] = useState(0); const [kind, setKind] = useState(0); const [model, setModel] = useState(0); const [error, setError] = useState<string | null>(null); const submitted = useRef(false);
  const selectedProvider = PROVIDERS[provider]!; const kinds = PROVIDER_CREDENTIAL_KINDS[selectedProvider]; const models = [null, ...PROVIDER_MODELS[selectedProvider]] as const;
  const back = () => { if (stage === "name" || stage === "error") close(); else if (stage === "role") setStage("name"); else if (stage === "task") setStage("role"); else if (stage === "owner") setStage("task"); else if (stage === "provider") setStage("owner"); else if (stage === "credential") setStage("provider"); else if (stage === "model") setStage("credential"); else if (stage === "confirm") setStage("model"); };
  const submit = async () => {
    if (submitted.current || !members[owner]) return; submitted.current = true; setStage("submitting"); setError(null);
    try { await actions.post(`/api/sessions/${sessionId}/agents`, { name: name.trim(), role: role.trim(), task: task.trim(), ownerUserId: members[owner].id, provider: selectedProvider, credentialKind: kinds[kind], model: models[model] }); completed(); }
    catch (reason) { setError(errorMessage(reason)); setStage("error"); }
  };
  useInput((_input, key) => {
    if (key.escape && !["submitting"].includes(stage)) { back(); return; }
    const count = stage === "owner" ? members.length : stage === "provider" ? PROVIDERS.length : stage === "credential" ? kinds.length : stage === "model" ? models.length : 0;
    const value = stage === "owner" ? owner : stage === "provider" ? provider : stage === "credential" ? kind : model;
    const update = (next: number) => { if (stage === "owner") setOwner(next); else if (stage === "provider") { setProvider(next); setKind(0); setModel(0); } else if (stage === "credential") setKind(next); else setModel(next); };
    if (count && key.upArrow) update(Math.max(0, value - 1));
    else if (count && key.downArrow) update(Math.min(count - 1, value + 1));
    else if (count && key.return) setStage(stage === "owner" ? "provider" : stage === "provider" ? "credential" : stage === "credential" ? "model" : "confirm");
    else if (stage === "confirm" && key.return) void submit();
  }, { isActive: !["name", "role", "task"].includes(stage) });
  return <PageFrame title="Create agent">
    {stage === "name" && <><Text>Name</Text><EditableInput key={stage} value={name} onChange={(value) => setName(value.slice(0, 80))} placeholder="Builder" onEscape={back} onSubmit={(value) => { if (value.trim()) setStage("role"); }} /></>}
    {stage === "role" && <><Text>Role</Text><EditableInput key={stage} value={role} onChange={(value) => setRole(value.slice(0, 120))} placeholder="Software engineer" onEscape={back} onSubmit={(value) => { if (value.trim()) setStage("task"); }} /></>}
    {stage === "task" && <><Text>Task</Text><EditableInput key={stage} value={task} onChange={(value) => setTask(value.slice(0, 500))} placeholder="What should this agent own?" onEscape={back} onSubmit={(value) => { if (value.trim()) setStage("owner"); }} /></>}
    {stage === "owner" && <ChoiceList title="Owner" values={members.map((member) => `${member.displayName} · ${member.role}`)} selected={owner} />}
    {stage === "provider" && <ChoiceList title="Provider" values={PROVIDERS.map((value) => PROVIDER_LABELS[value])} selected={provider} />}
    {stage === "credential" && <ChoiceList title="Credential" values={kinds.map((value) => credentialLabel(selectedProvider, value))} selected={kind} />}
    {stage === "model" && <ChoiceList title="Model" values={models.map((value) => value ?? "Provider default")} selected={model} />}
    {stage === "confirm" && <><Text bold>{name}</Text><Text>{role}: {task}</Text><Text>Owner: {members[owner]?.displayName}</Text><Text>Provider: {PROVIDER_LABELS[selectedProvider]} · {credentialLabel(selectedProvider, kinds[kind]!)}</Text><Text>Model: {models[model] ?? "Provider default"}</Text><Text color="cyan">Enter creates once · Esc goes back</Text></>}
    {stage === "submitting" && <Text color="cyan">Creating agent…</Text>}
    {stage === "error" && <><Text color="red">{error}</Text><Text>Creation was not retried because mutation outcome may be unknown.</Text><Text dimColor>Esc returns to floor; refresh before trying again.</Text></>}
  </PageFrame>;
}

type CredentialStage = "list" | "secret" | "confirm-connect" | "confirm-disconnect" | "working" | "error";
function CredentialsPage({ actions, close, setNotice }: { actions: OpenFloorActions; close: () => void; setNotice: (message: string) => void }) {
  const queryClient = useQueryClient(); const credentials = useQuery({ queryKey: ["credentials"], queryFn: ({ signal }) => actions.credentials(signal) });
  const options = PROVIDERS.flatMap((provider) => PROVIDER_CREDENTIAL_KINDS[provider].map((kind) => ({ provider, kind })));
  const [selected, setSelected] = useState(0); const [stage, setStage] = useState<CredentialStage>("list"); const [secret, setSecret] = useState(""); const [error, setError] = useState<string | null>(null); const attempted = useRef(false);
  const option = options[selected]!; const existing = credentials.data?.credentials.find((item) => item.provider === option.provider && item.kind === option.kind);
  const clearSecret = () => setSecret("");
  const connect = async () => {
    if (!secret.trim() || attempted.current) return; attempted.current = true; setStage("working");
    try { const result = await actions.connectCredential(option.provider, credentialBody(option.provider, option.kind, secret)); clearSecret(); await queryClient.invalidateQueries({ queryKey: ["credentials"] }); setNotice(`${credentialLabel(option.provider, option.kind)} connected ····${result.credential.fingerprint}.`); setStage("list"); attempted.current = false; }
    catch (reason) { clearSecret(); setError(errorMessage(reason)); setStage("error"); }
  };
  const disconnect = async () => {
    if (attempted.current) return; attempted.current = true; setStage("working");
    try { await actions.disconnectCredential(option.provider, option.kind); await queryClient.invalidateQueries({ queryKey: ["credentials"] }); setNotice(`${credentialLabel(option.provider, option.kind)} disconnected.`); setStage("list"); attempted.current = false; }
    catch (reason) { setError(errorMessage(reason)); setStage("error"); }
  };
  useInput((_input, key) => {
    if (stage === "list") { if (key.escape) close(); else if (key.upArrow) setSelected((value) => Math.max(0, value - 1)); else if (key.downArrow) setSelected((value) => Math.min(options.length - 1, value + 1)); else if (key.return) { attempted.current = false; setStage(existing ? "confirm-disconnect" : "secret"); } return; }
    if (stage === "confirm-connect") { if (key.escape) { clearSecret(); setStage("list"); } else if (key.return) void connect(); return; }
    if (stage === "confirm-disconnect") { if (key.escape) setStage("list"); else if (key.return) void disconnect(); return; }
    if (stage === "error" && key.escape) { attempted.current = false; setError(null); setStage("list"); }
  }, { isActive: stage !== "secret" && stage !== "working" });
  return <PageFrame title="AI credentials">
    <Text>Write-only connection flow. Secrets never enter shell history, config, logs, drafts, or rendered output.</Text>
    {credentials.isLoading && <Text color="cyan">Loading credential status… · Esc stops and returns</Text>}{credentials.error && <Text color="red">{errorMessage(credentials.error)}</Text>}
    {stage === "list" && options.map((item, index) => { const found = credentials.data?.credentials.find((credential) => credential.provider === item.provider && credential.kind === item.kind); return <Text key={`${item.provider}:${item.kind}`} inverse={index === selected}>{credentialLabel(item.provider, item.kind).padEnd(28)} {found ? `Connected ····${found.fingerprint}${found.validatedAt ? "" : " · not yet verified"}` : "Not connected"}</Text>; })}
    {stage === "secret" && <><Text bold>{credentialLabel(option.provider, option.kind)}</Text><Text>{option.provider === "openai" && option.kind === "oauth" ? "Paste complete auth.json. Ctrl+J inserts newline." : "Paste credential."}</Text><EditableInput value={secret} onChange={setSecret} secret multiline={option.provider === "openai" && option.kind === "oauth"} placeholder="Secret hidden" onEscape={() => { clearSecret(); setStage("list"); }} onSubmit={(value) => { if (value.trim()) setStage("confirm-connect"); }} /></>}
    {stage === "confirm-connect" && <><Text>Connect {credentialLabel(option.provider, option.kind)}?</Text><Text>Secret is hidden and will be sent directly to openfloor for encrypted storage.</Text><Text color="cyan">Enter connects once · Esc cancels</Text></>}
    {stage === "confirm-disconnect" && <><Text>Disconnect {credentialLabel(option.provider, option.kind)} ending ····{existing?.fingerprint}?</Text><Text color="cyan">Enter disconnects · Esc cancels</Text></>}
    {stage === "working" && <Text color="cyan">Updating credential…</Text>}
    {stage === "error" && <><Text color="red">{error}</Text><Text>Mutation was not retried automatically.</Text><Text dimColor>Esc returns to credential status.</Text></>}
    {stage === "list" && <Text dimColor>↑↓ select · Enter connect/disconnect · Esc returns</Text>}
  </PageFrame>;
}

function ChoiceList({ title, values, selected }: { title: string; values: readonly string[]; selected: number }) { return <><Text bold>{title}</Text>{values.map((value, index) => <Text key={value} inverse={index === selected}>{index === selected ? "›" : " "} {value}</Text>)}<Text dimColor>↑↓ select · Enter continue · Esc back</Text></>; }

function BindWorkspaceConfirm({ workspace, repositoryName, branch, sha, close, confirm }: { workspace: LocalWorkspace; repositoryName: string; branch: string; sha: string; close: () => void; confirm: () => Promise<void> }) {
  const [working, setWorking] = useState(false); const [error, setError] = useState<string | null>(null);
  useInput((input, key) => { if (working) return; if (key.escape || input.toLowerCase() === "n") close(); else if (key.return || input.toLowerCase() === "y") { setWorking(true); setError(null); void confirm().then(close, (reason) => { setWorking(false); setError(reason instanceof Error ? reason.message : String(reason)); }); } });
  return <PageFrame title="Enable local live sync?"><Text>Repository: {repositoryName}</Text><Text>Directory: {workspace.root}</Text><Text>Candidate: {branch}</Text><Text>Expected SHA: {sha}</Text><Text color="yellow">Clean checkout will switch to this candidate branch and receive fast-forward updates. Local edits are never uploaded.</Text>{error && <Text color="red">{error}</Text>}<Text color="cyan">{working ? "Checking workspace…" : "Enter/y confirms · Esc/n keeps local sync off"}</Text></PageFrame>;
}

type CreateStage = "loading" | "empty" | "title" | "objective" | "candidate" | "repository" | "repository-search" | "confirm" | "submitting" | "load-error" | "preflight-error" | "mutation-error" | "provision-failed";
function CreateSessionWizard({ actions, baseUrl, close, workspace, onCreated }: { actions: OpenFloorActions; baseUrl: string; close: () => void; workspace?: LocalWorkspace; onCreated: (id: string, ready: boolean, message: string) => void }) {
  const [stage, setStage] = useState<CreateStage>("loading"); const [repositories, setRepositories] = useState<RepositoryOption[]>([]); const [selectedRepository, setSelectedRepository] = useState(0); const [search, setSearch] = useState(""); const [title, setTitle] = useState(""); const [objective, setObjective] = useState(""); const [candidateName, setCandidateName] = useState(""); const [error, setError] = useState<string | null>(null); const [loadAttempt, setLoadAttempt] = useState(0); const submitted = useRef(false);
  useEffect(() => { let active = true; const controller = new AbortController(); void actions.repositories(controller.signal).then(({ repositories: values }) => { if (!active) return; const available = workspace ? values.filter((repository) => repository.fullName.toLowerCase() === workspace.repositoryFullName.toLowerCase()) : values; setRepositories(available); setSelectedRepository(0); setStage(available.length ? "title" : "empty"); }, (reason) => { if (active && !controller.signal.aborted) { setError(reason instanceof Error ? reason.message : String(reason)); setStage("load-error"); } }); return () => { active = false; controller.abort(); }; }, [actions, loadAttempt, workspace]);
  const filtered = repositories.filter((repository) => repository.fullName.toLowerCase().includes(search.trim().toLowerCase())); const selected = repositories[selectedRepository];
  const submit = async () => { if (!selected || submitted.current) return; submitted.current = true; setError(null); setStage("submitting"); if (workspace) { try { await requireCleanWorkspace(workspace); } catch (reason) { submitted.current = false; setError(reason instanceof Error ? reason.message : String(reason)); setStage("preflight-error"); return; } } try { const created = await actions.createSession({ title: title.trim(), objective: objective.trim() || null, candidateName: candidateName.trim() || title.trim(), repositoryId: selected.id, accountInstallationId: selected.accountInstallationId }); const ready = created.setupStatus === "ready"; const message = ready ? "Session created." : created.setupError ?? "Session created, but repository setup needs attention."; if (!ready) { setError(message); setStage("provision-failed"); } onCreated(created.session.id, ready, message); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setStage("mutation-error"); } };
  useInput((input, key) => { if (stage === "repository") { if (key.upArrow) setSelectedRepository((value) => Math.max(0, value - 1)); else if (key.downArrow) setSelectedRepository((value) => Math.min(repositories.length - 1, value + 1)); else if (input.toLowerCase() === "s") { setSearch(""); setStage("repository-search"); } else if (key.return && selected) setStage("confirm"); else if (key.escape) setStage("candidate"); return; } if (stage === "confirm") { if (key.return) void submit(); else if (key.escape) setStage("repository"); return; } if (stage === "empty" && key.return) { void open(`${baseUrl}/home/settings?section=connections`); return; } if (stage === "load-error" && input.toLowerCase() === "r") { setError(null); setStage("loading"); setLoadAttempt((value) => value + 1); return; } if (stage === "preflight-error" && input.toLowerCase() === "r") { setError(null); setStage("confirm"); return; } if (!key.escape) return; if (stage === "objective") setStage("title"); else if (stage === "candidate") setStage("objective"); else if (stage === "repository-search") setStage("repository"); else if (stage !== "submitting") close(); });
  return <PageFrame title={workspace ? `New local session · ${workspace.repositoryFullName}` : "New session"}>
    {stage === "loading" && <Text color="cyan">Loading GitHub repositories… · Esc stops and returns</Text>}
    {stage === "empty" && <><Text>{workspace ? `${workspace.repositoryFullName} is not available to openfloor.` : "No repositories available."}</Text><Text>Press Enter to update GitHub access.</Text></>}
    {stage === "title" && <><Text>Task</Text><EditableInput key={stage} value={title} onChange={(value) => setTitle(value.slice(0, 100))} placeholder="What is this session for?" onSubmit={(value) => { const next = value.trim(); if (next) { setTitle(next); setCandidateName(next); setStage("objective"); } }} /></>}
    {stage === "objective" && <><Text>Goal <Text dimColor>(optional)</Text></Text><EditableInput key={stage} value={objective} onChange={(value) => setObjective(value.slice(0, 2_000))} placeholder="Press Enter to skip" onSubmit={() => setStage("candidate")} /></>}
    {stage === "candidate" && <><Text>Candidate branch name</Text><EditableInput key={stage} value={candidateName} onChange={(value) => setCandidateName(value.slice(0, 100))} placeholder={title} onSubmit={(value) => { setCandidateName((value.trim() || title).slice(0, 100)); setStage("repository"); }} /></>}
    {stage === "repository" && <><Text>Select repository</Text>{repositories.map((repository, index) => <Text key={`${repository.accountInstallationId}:${repository.id}`} inverse={index === selectedRepository} {...(index === selectedRepository ? { color: "cyan" as const } : {})}>{index === selectedRepository ? "›" : " "} {repository.fullName} · {repository.defaultBranch}</Text>)}<Text dimColor>↑↓ select · s search · Enter continue</Text></>}
    {stage === "repository-search" && <><Text>Search repositories</Text><EditableInput value={search} placeholder="owner/repository" onChange={setSearch} onSubmit={() => { const first = filtered[0]; if (first) { setSelectedRepository(repositories.indexOf(first)); setStage("repository"); } }} />{filtered.slice(0, 6).map((repository, index) => <Text key={repository.id} {...(index === 0 ? { color: "cyan" as const } : {})}>{index === 0 ? "›" : " "} {repository.fullName}</Text>)}</>}
    {stage === "confirm" && selected && <><Text bold>{title}</Text><Text>{objective || "No goal provided"}</Text><Text>Repository: {selected.fullName}</Text><Text>Candidate: {candidateName || title}</Text>{workspace && <Text color="yellow">Creation requires a clean worktree. It will switch to the server candidate branch, then receive fast-forward updates. Local edits are never uploaded.</Text>}<Text color="cyan">Press Enter to create once. Esc goes back.</Text></>}
    {stage === "submitting" && <Text color="cyan">Creating session and candidate branch…</Text>}
    {stage === "load-error" && <><Text color="red">{error ?? "Unable to load repositories."}</Text><Text dimColor>Press r to retry or Esc to close.</Text></>}
    {stage === "preflight-error" && <><Text color="red">{error ?? "Local workspace is not ready."}</Text><Text dimColor>Fix the worktree, then press r to check again or Esc to close.</Text></>}
    {stage === "mutation-error" && <><Text color="red">{error ?? "Unable to create session."}</Text><Text>Creation is not retried because the server outcome may be unknown.</Text><Text dimColor>Esc returns to Sessions so you can refresh before trying again.</Text></>}
    {stage === "provision-failed" && <><Text color="red">{error}</Text><Text>The session was created, but its repository needs attention.</Text><Text dimColor>Esc returns to Sessions. Select the new session to inspect Repository.</Text></>}
  </PageFrame>;
}

function LoadingView({ message, escape }: { message: string; escape: string }) { return <Box flexDirection="column"><Text color="cyan">{message}</Text><Text dimColor>{escape}</Text></Box>; }
function SessionLoadError({ error }: { error: unknown }) { return <Box flexDirection="column"><Text color="red" bold>Unable to load session floor</Text><Text>{errorMessage(error)}</Text><Text dimColor>Esc returns to Sessions · r retries</Text></Box>; }
function ErrorView({ error }: { error: unknown }) { return <Box flexDirection="column"><Text color="red" bold>Unable to load openfloor</Text><Text>{sanitizeTerminal(error instanceof Error ? error.message : String(error))}</Text><Text dimColor>Run openfloor auth login or openfloor doctor.</Text></Box>; }
function appendActivity(current: Record<string, Array<{ sequence: number; kind: string; detail: string }>>, runId: string, events: Array<{ sequence: number; kind: string; detail: string }>) { const all = [...(current[runId] ?? []), ...events].sort((left, right) => left.sequence - right.sequence); return { ...current, [runId]: all.filter((item, index) => index === 0 || item.sequence !== all[index - 1]!.sequence).slice(-100) }; }
function floorPaneCount(pane: FloorPane, floor: FloorSnapshot | undefined, drafts: TypingDraft[]): number { if (!floor) return 0; if (pane === "chat") return Math.min(10, teamMessages(floor).length); if (pane === "drafts") return Math.min(6, drafts.length); if (pane === "agents") return floor.agents.length + 1; return Math.min(14, floor.queue.length); }
function recordText(value: unknown, key: string, fallback = ""): string { if (!value || typeof value !== "object" || !(key in value)) return fallback; const entry = (value as Record<string, unknown>)[key]; return typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean" ? String(entry) : fallback; }
function recordArray(value: unknown, ...keys: string[]): Array<Record<string, unknown>> { if (!value || typeof value !== "object") return []; for (const key of keys) { const entry = (value as Record<string, unknown>)[key]; if (Array.isArray(entry)) return entry.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)); } return []; }
function sessionGroup(session: SessionSummary): number { return session.endedAt != null ? 2 : session.archivedAt != null ? 1 : 0; }
function isSessionPage(page: Page): page is SessionPage { return ["floor", "overview", "review", "settings", "help"].includes(page); }
function isHomePage(page: Page): page is "sessions" | "cli-settings" | "cli-help" { return ["sessions", "cli-settings", "cli-help"].includes(page); }
function statusColor(status: string): "green" | "yellow" | "red" | "cyan" | "white" { if (["completed", "integrated", "ready", "passed"].includes(status)) return "green"; if (["failed", "cancelled", "conflicted"].includes(status)) return "red"; if (["running", "publishing", "integrating"].includes(status)) return "cyan"; if (["paused", "queued", "pending", "awaiting_input"].includes(status)) return "yellow"; return "white"; }
function capitalize(value: string): string { return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`; }
function errorMessage(reason: unknown): string { return sanitizeTerminal(reason instanceof Error ? reason.message : String(reason)).slice(-240); }
function commandSuggestions(commands: readonly CommandSpec[], value: string): CommandSpec[] { const token = value.split(/\s/, 1)[0] || "/"; return commands.filter((command) => command.name.startsWith(token)); }
function teamMessages(floor: FloorSnapshot) { return floor.messages.filter((message) => !recordText(message, "recipientUserId")); }
const TERMINAL_QUEUE_STATUSES = new Set(["completed", "failed", "cancelled", "canceled", "integrated", "rolled_back", "discarded", "answered"]);
export function orderedQueue(floor: FloorSnapshot) { return [...floor.queue].sort((left, right) => Number(TERMINAL_QUEUE_STATUSES.has(left.status)) - Number(TERMINAL_QUEUE_STATUSES.has(right.status)) || left.position - right.position); }

async function runPalette(line: string, sessionId: string | null, baseUrl: string): Promise<void> { const args = tokenize(line); if (!args.length) return; args.push("--base-url", baseUrl, "--no-color", "--quiet"); if (sessionId) args.push("--session", sessionId); const entry = process.argv[1]; if (!entry) throw new Error("CLI entry point unavailable"); try { await exec(process.execPath, [entry, ...args], { encoding: "utf8", maxBuffer: 1024 * 1024 }); } catch (reason) { const error = reason as { stderr?: string; stdout?: string; message?: string }; throw new Error(sanitizeTerminal(`${error.stdout ?? ""}${error.stderr ?? ""}`.trim() || error.message || "Command failed.").slice(-8_000)); } }
export function tokenize(input: string): string[] { const values: string[] = []; let current = ""; let quote: string | null = null; let escaped = false; for (const char of input.trim()) { if (escaped) { current += char; escaped = false; continue; } if (char === "\\") { escaped = true; continue; } if (quote) { if (char === quote) quote = null; else current += char; continue; } if (char === '"' || char === "'") { quote = char; continue; } if (/\s/.test(char)) { if (current) { values.push(current); current = ""; } } else current += char; } if (escaped) current += "\\"; if (quote) throw new Error("Unclosed quote"); if (current) values.push(current); return values; }
export function formatDuration(seconds: number): string { const whole = Math.max(0, Math.floor(seconds)); const hours = Math.floor(whole / 3_600); const minutes = Math.floor((whole % 3_600) / 60); const remainder = whole % 60; return [hours ? `${hours}h` : "", minutes ? `${minutes}m` : "", (!hours && !minutes) || remainder ? `${remainder}s` : ""].filter(Boolean).join(" "); }
