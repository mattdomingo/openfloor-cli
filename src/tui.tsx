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
import { HistoryBuffer } from "./history.js";
import { errorMessage, PageFrame, Panel, ChoiceList, SuggestionList, rowStyle, focusFrame, useEscapeGesture, type Suggestion } from "./tui-shared.js";
import { ACCENT, accentFor, BRAND, FOCUS, IDLE, noticeColor, statusColor } from "./theme.js";
import { applyMention, commandSuggestions, mentionAt, rankNames, type CommandSpec } from "./suggest.js";
import { SessionActionsPage, ConfirmSessionRemoval, type SessionAction } from "./tui-sessions.js";
import { requireCleanWorkspace, synchronizeWorkspace, type LocalWorkspace } from "./workspace.js";

const exec = promisify(execFile);
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
type SessionPage = "floor" | "overview" | "review" | "settings" | "help";
type Page = "sessions" | "create-session" | "bind-workspace" | "create-agent" | "credentials" | "cli-settings" | "cli-help" | "session-actions" | "confirm-removal" | SessionPage;
type FloorPane = "chat" | "drafts" | "agents" | "queue";
type FloorDetail = { pane: FloorPane; index: number };
type LocalSync = "none" | "syncing" | "live" | "paused" | "mismatch";
type NoticeTone = "info" | "success" | "warn" | "error";
type Notice = { text: string; tone: NoticeTone };
type Busy = { label: string; startedAt: number };

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
  const [promptMenuOpen, setPromptMenuOpen] = useState(false);
  const [credentialsReturn, setCredentialsReturn] = useState<"sessions" | "floor">("sessions");
  const [workspaceStartupResolved, setWorkspaceStartupResolved] = useState(!workspace || !initialSessionId);
  const [notice, setNotice] = useState<Notice | null>(workspace ? { text: `Local workspace: ${workspace.repositoryFullName}`, tone: "info" } : null);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [busyElapsedSeconds, setBusyElapsedSeconds] = useState(0);
  const [exitArmed, setExitArmed] = useState(false);
  const [sessionActionTarget, setSessionActionTarget] = useState<{ session: SessionSummary; back: Page } | null>(null);
  const [removal, setRemoval] = useState<{ session: SessionSummary; mode: "delete" | "leave"; back: Page } | null>(null);
  const [homeHistory] = useState(() => new HistoryBuffer());
  const [sessionHistory] = useState(() => new HistoryBuffer());
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [connection, setConnection] = useState<ConnectionStatus>("closed");
  const [localSync, setLocalSync] = useState<LocalSync>("none");
  const [workspaceSyncEnabled, setWorkspaceSyncEnabled] = useState(Boolean(workspace && initialSessionId));
  const [boundSessionId, setBoundSessionId] = useState<string | null>(workspace ? initialSessionId ?? null : null);
  const [online, setOnline] = useState(new Set<string>());
  const [drafts, setDrafts] = useState<TypingDraft[]>([]);
  const [activities, setActivities] = useState<Record<string, Array<{ sequence: number; kind: string; detail: string }>>>({});
  const [floorFocus, setFloorFocus] = useState<"prompt" | FloorPane>("prompt");
  const [paneRows, setPaneRows] = useState<Record<FloorPane, number>>({ chat: -1, drafts: -1, agents: -1, queue: -1 });
  const [floorDetail, setFloorDetail] = useState<FloorDetail | null>(null);
  const [syncAttempt, setSyncAttempt] = useState(0);
  const startupHandled = useRef(false);
  const workspaceOfferHandled = useRef(new Set<string>());
  const syncedCandidate = useRef<string | null>(null);
  const syncQueue = useRef<Promise<unknown>>(Promise.resolve());
  const queryClient = useQueryClient();

  const notify = (text: string, tone: NoticeTone = "info") => setNotice({ text, tone });
  const withBusy = async <T,>(label: string, fn: () => Promise<T>): Promise<T> => {
    setBusy({ label, startedAt: Date.now() });
    try { return await fn(); } finally { setBusy(null); }
  };

  useEffect(() => {
    if (!notice) return;
    const timeout = notice.tone === "error" || notice.tone === "warn" ? 20_000 : 6_000;
    const timer = setTimeout(() => setNotice(null), timeout);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!busy) return;
    const startedAt = busy.startedAt;
    const timer = setInterval(() => {
      setSpinnerFrame((value) => (value + 1) % SPINNER_FRAMES.length);
      setBusyElapsedSeconds(Math.max(0, Math.round((Date.now() - startedAt) / 1_000)));
    }, 120);
    return () => clearInterval(timer);
  }, [busy]);

  useEffect(() => () => { if (exitTimer.current) clearTimeout(exitTimer.current); }, []);

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
        notify(`Session ended: ${event.reason}`, "warn");
        void queryClient.invalidateQueries({ queryKey: ["home"] });
        if (workspace && boundSessionId === sessionId) {
          void unbindWorkspaceSession(workspace.root);
          setWorkspaceSyncEnabled(false); setBoundSessionId(null); setSessionId(null); setPage("create-session");
        }
      }
      else if (event.type === "run.activity") setActivities((current) => appendActivity(current, event.runId, event.events));
    });
    presence.on("close", ({ code, reason }) => { if (code === 4001 || code === 4005) { notify(reason || "Membership ended", "warn"); setSessionId(null); setWorkspaceSyncEnabled(false); setBoundSessionId(null); setPage(workspace ? "create-session" : "sessions"); if (workspace) void unbindWorkspaceSession(workspace.root); void queryClient.invalidateQueries({ queryKey: ["home"] }); } });
    void presence.connect().catch((error) => notify(errorMessage(error), "error"));
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
    if (repositoryStatus !== "ready") { void Promise.resolve().then(() => { setLocalSync("paused"); notify(`Repository is ${repositoryStatus}; local sync paused.`, "warn"); }); return; }
    const key = `${sessionId}:${candidateBranch}:${candidateSha}`;
    if (syncedCandidate.current === key) return;
    syncedCandidate.current = key;
    syncQueue.current = syncQueue.current.then(() => { setLocalSync("syncing"); return synchronizeWorkspace(workspace, candidateBranch, candidateSha); }).then((result) => {
      setLocalSync("live");
      notify(`Local workspace updated on ${result.branch} at ${result.sha.slice(0, 12)}.`, "success");
    }, (reason) => {
      setLocalSync("paused");
      notify(errorMessage(reason), "warn");
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
      notify("Local session binding removed because its repository no longer matches this checkout.", "warn");
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
      notify("Local session binding removed because session is no longer accessible.", "warn");
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
    notify(`Local sync enabled for ${workspace.repositoryFullName}.`, "success");
    setPage("floor");
  };
  const retryWorkspaceSync = () => {
    if (!workspace) { notify("No local GitHub workspace detected.", "warn"); return; }
    if (!workspaceSyncEnabled) {
      if (repositoryName.toLowerCase() === workspace.repositoryFullName.toLowerCase() && candidateBranch && candidateSha && repositoryStatus === "ready") setPage("bind-workspace");
      else notify("Local workspace does not match a ready candidate in this session.", "warn");
      return;
    }
    syncedCandidate.current = null;
    setSyncAttempt((value) => value + 1);
  };
  const goSessions = (refresh = true) => { setSessionId(null); setPage("sessions"); setConnection("closed"); setOnline(new Set()); setDrafts([]); setLocalSync("none"); setFloorFocus("prompt"); setFloorDetail(null); setHomeCommandActive(false); setPagePanelFocused(false); if (refresh) void homeQuery.refetch(); };
  const refreshSession = () => { void sessionQuery.refetch(); void floorQuery.refetch(); void homeQuery.refetch(); };
  const runSessionAction = async (target: SessionSummary, action: Exclude<SessionAction, "cancel">, back: Page) => {
    if (action === "archive" || action === "unarchive") {
      try {
        await withBusy(action === "archive" ? "Archiving session" : "Unarchiving session", () => actions.post(`/api/sessions/${target.id}/${action}`));
        notify(`Session ${action === "archive" ? "archived" : "unarchived"}.`, "success");
        void homeQuery.refetch();
        if (sessionId === target.id) refreshSession();
      } catch (reason) { notify(errorMessage(reason), "error"); }
      setPage(back);
      return;
    }
    setRemoval({ session: target, mode: action, back });
    setPage("confirm-removal");
  };
  const handleSessionRemoved = (warning?: string) => {
    if (!removal) return;
    const removedId = removal.session.id;
    setRemoval(null);
    if (workspace && boundSessionId === removedId) void unbindWorkspaceSession(workspace.root);
    if (sessionId === removedId || boundSessionId === removedId) void updateConfig({ currentSessionId: undefined });
    if (sessionId === removedId) { setSessionId(null); setWorkspaceSyncEnabled(false); setBoundSessionId(null); setConnection("closed"); setOnline(new Set()); setDrafts([]); setLocalSync("none"); }
    notify(warning ?? (removal.mode === "delete" ? "Session deleted." : "Left session."), warning ? "warn" : "success");
    void homeQuery.refetch();
    setPage("sessions");
  };
  const runBackground = async (line: string) => {
    try { await withBusy(line, () => runCommand(line, sessionId, baseUrl)); notify("Command completed in background.", "success"); refreshSession(); }
    catch (reason) { notify(errorMessage(reason), "error"); }
  };
  const executeHomeCommand = async (raw: string) => {
    const [command = "", ...rest] = raw.trim().slice(1).split(/\s+/); const argument = rest.join(" ").trim();
    if (command === "new") { setSessionId(null); setPage("create-session"); }
    else if (command === "settings") setPage("cli-settings");
    else if (command === "credentials") { setCredentialsReturn("sessions"); setPage("credentials"); }
    else if (command === "account") { await open(`${baseUrl}/home/settings`); notify("Account settings opened in browser."); }
    else if (command === "help") setPage("cli-help");
    else if (command === "sessions") setPage("sessions");
    else if (command === "refresh") { await homeQuery.refetch(); notify("Sessions refreshed."); }
    else if (command === "archive" || command === "unarchive" || command === "delete" || command === "leave") {
      const target = sessions[homeSelection];
      if (!target) throw new Error("Select a session first.");
      await runSessionAction(target, command, "sessions");
    }
    else if (command === "run") { if (!argument) throw new Error("Usage: /run <CLI subcommand>"); await runBackground(argument); }
    else if (command === "logout") { await logout(); exit(); }
    else if (command === "quit" || command === "exit") exit();
    else throw new Error(`Unknown command: /${command}. Use /help.`);
  };

  useInput((input, key) => {
    const presence = (globalThis as Record<string, unknown>).__openfloorPresence as PresenceClient | undefined;
    presence?.noteInput();
    if (key.ctrl && input === "c") {
      if (exitArmed) { exit(); return; }
      setExitArmed(true);
      notify(busy ? `Press Ctrl+C again to exit. "${busy.label}" is still running; its outcome will be unknown if you exit now.` : "Press Ctrl+C again to exit. Remote runs keep running.", "warn");
      if (exitTimer.current) clearTimeout(exitTimer.current);
      exitTimer.current = setTimeout(() => setExitArmed(false), 2_000);
      return;
    }
    if (key.escape && page === "sessions" && homeQuery.isLoading) {
      void queryClient.cancelQueries({ queryKey: ["home"] });
      exit();
      return;
    }
    if (["create-session", "bind-workspace", "create-agent", "credentials", "session-actions", "confirm-removal"].includes(page)) return;
    if (sessionId) {
      if (key.escape && sessionLoading) {
        if (homeQuery.isLoading && !homeQuery.data) void queryClient.cancelQueries({ queryKey: ["home"] });
        void queryClient.cancelQueries({ queryKey: ["session", sessionId] });
        void queryClient.cancelQueries({ queryKey: ["floor", sessionId] });
        if (homeQuery.isLoading && !homeQuery.data) {
          exit();
          return;
        }
        notify("Session loading stopped.", "warn");
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
        if (key.tab) { if (!pagePanelFocused && promptMenuOpen) return; setPagePanelFocused((current) => !current); return; }
        if (key.escape && pagePanelFocused && page !== "review" && page !== "settings") { setPagePanelFocused(false); return; }
        return;
      }
      if (floorDetail) { if (key.escape) setFloorDetail(null); return; }
      const focusCycle: Array<"prompt" | FloorPane> = ["prompt", "chat", "drafts", "agents", "queue"];
      if (key.tab) { if (floorFocus === "prompt" && promptMenuOpen) return; const offset = key.shift ? -1 : 1; setFloorFocus((current) => focusCycle[(focusCycle.indexOf(current) + offset + focusCycle.length) % focusCycle.length]!); return; }
      if (floorFocus === "prompt") return;
      const panes: FloorPane[] = ["chat", "drafts", "agents", "queue"];
      if (key.escape) { setFloorFocus("prompt"); return; }
      if (key.leftArrow || key.rightArrow) { const index = panes.indexOf(floorFocus); const offset = key.leftArrow ? -1 : 1; setFloorFocus(panes[(index + offset + panes.length) % panes.length]!); return; }
      const count = floorPaneCount(floorFocus, floor, drafts);
      const currentRow = effectivePaneRow(floorFocus, paneRows[floorFocus], count);
      if (key.upArrow) setPaneRows((current) => ({ ...current, [floorFocus]: Math.max(0, currentRow - 1) }));
      else if (key.downArrow) setPaneRows((current) => ({ ...current, [floorFocus]: Math.min(Math.max(0, count - 1), currentRow + 1) }));
      else if (key.return && count > 0) {
        if (floorFocus === "agents" && currentRow === (floor?.agents.length ?? 0)) { setPage("create-agent"); setFloorFocus("prompt"); }
        else setFloorDetail({ pane: floorFocus, index: currentRow });
      }
      else if (input === "r") refreshSession();
      else if (input === "?") setPage("help");
      return;
    }
    if (homeCommandActive) return;
    if (page !== "sessions") { if (key.escape) setPage("sessions"); return; }
    if (input === "?") { setPage("cli-help"); return; }
    if (input === "r") { void homeQuery.refetch(); return; }
    if (key.upArrow) setSelectedSession((value) => Math.max(0, value - 1));
    if (key.downArrow) setSelectedSession((value) => Math.min(Math.max(0, sessions.length - 1), value + 1));
    if (key.return && sessions[homeSelection]) void enterSession(sessions[homeSelection].id, sessions[homeSelection].id === boundSessionId);
    if (input === "n") { setPage("create-session"); return; }
    if (input === "a" && sessions[homeSelection]) { setSessionActionTarget({ session: sessions[homeSelection], back: "sessions" }); setPage("session-actions"); return; }
    if (input && input !== "/" && !key.ctrl && !key.meta) notify("Commands start with /. Press / to open commands.");
  });

  if (width < 60) return <Box flexDirection="column"><Text bold color="red">Terminal too narrow ({width} columns)</Text><Text>Resize to at least 60 columns.</Text></Box>;
  if (homeQuery.isLoading && page === "sessions") return <LoadingView message="Loading openfloor…" escape="Esc stops and exits" />;
  if (homeQuery.error && page === "sessions") return <ErrorView error={homeQuery.error} />;

  const setNoticeText = (text: string) => notify(text);
  return <Box flexDirection="column" width="100%">
    <Header {...(homeQuery.data?.props.user ? { user: homeQuery.data.props.user } : sessionQuery.data?.props.user ? { user: sessionQuery.data.props.user } : {})} {...(sessionQuery.data?.props.session ? { session: sessionQuery.data.props.session } : {})} connection={connection} {...(workspace ? { workspace } : {})} localSync={effectiveLocalSync} busy={busy} spinnerFrame={spinnerFrame} elapsedSeconds={busyElapsedSeconds} />
    {notice && <Text color={noticeColor(notice.tone)}>{notice.text}</Text>}
    {page === "sessions" && <Home sessions={sessions} selected={homeSelection} {...(homeQuery.data?.props.usage ? { usage: homeQuery.data.props.usage } : {})} {...(workspace ? { workspace } : {})} />}
    {page === "cli-settings" && <CliSettings baseUrl={baseUrl} />}
    {page === "cli-help" && <HelpPage session={false} />}
    {page === "credentials" && <CredentialsPage actions={actions} close={() => setPage(credentialsReturn)} setNotice={setNoticeText} />}
    {page === "create-session" && <CreateSessionWizard actions={actions} baseUrl={baseUrl} close={goSessions} {...(workspace ? { workspace } : {})} onCreated={(id, ready, message) => { notify(message, ready ? "success" : "warn"); void homeQuery.refetch(); if (ready) void enterSession(id, Boolean(workspace)); }} />}
    {page === "bind-workspace" && workspace && floor && <BindWorkspaceConfirm workspace={workspace} repositoryName={repositoryName} branch={candidateBranch} sha={candidateSha} close={() => setPage("floor")} confirm={enableWorkspaceSync} />}
    {page === "bind-workspace" && (!workspace || !floor) && <PageFrame title="Local sync unavailable" accent={ACCENT.workspace}><Text>No matching local GitHub workspace is available.</Text><Text dimColor>Esc returns to the floor.</Text></PageFrame>}
    {page === "create-agent" && sessionId && <CreateAgentPage actions={actions} sessionId={sessionId} members={members} close={() => setPage("floor")} completed={() => { refreshSession(); notify("Agent created.", "success"); setPage("floor"); }} />}
    {page === "session-actions" && sessionActionTarget && <SessionActionsPage session={sessionActionTarget.session} close={() => setPage(sessionActionTarget.back)} onSelect={(action) => { if (action === "cancel") return; void runSessionAction(sessionActionTarget.session, action, sessionActionTarget.back); }} />}
    {page === "confirm-removal" && removal && <ConfirmSessionRemoval session={removal.session} actions={actions} mode={removal.mode} close={() => setPage(removal.back)} onRemoved={handleSessionRemoved} />}
    {sessionId && isSessionPage(page) && (sessionLoadError
      ? <SessionLoadError error={sessionLoadError} />
      : floor ? <>
      {page === "floor" ? floorDetail ? <FloorItemDetail detail={floorDetail} floor={floor} drafts={drafts} activities={activities} /> : <FloorDashboard width={width} floor={floor} online={online} drafts={drafts} activities={activities} focus={floorFocus} rows={paneRows} /> : <PageView page={page} floor={floor} members={members} owner={sessionQuery.data?.props.session.role === "owner"} online={online} skills={skillsQuery.data} mcp={mcpQuery.data} active={pagePanelFocused} focusPrompt={() => setPagePanelFocused(false)} actions={actions} sessionId={sessionId} refresh={refreshSession} setNotice={setNoticeText} {...(workspace ? { workspace } : {})} localSync={effectiveLocalSync} />}
      <CommandBar key={page} page={page} sessionId={sessionId} actions={actions} history={sessionHistory} agents={floor.agents} onMenu={setPromptMenuOpen} {...((globalThis as Record<string, unknown>).__openfloorPresence ? { presence: (globalThis as Record<string, unknown>).__openfloorPresence as PresenceClient } : {})} focused={page === "floor" ? floorFocus === "prompt" && !floorDetail : !pagePanelFocused} navigate={(next) => { setPage(next); setFloorDetail(null); setFloorFocus("prompt"); setPagePanelFocused(false); }} openCredentials={() => { setCredentialsReturn("floor"); setPage("credentials"); }} goSessions={goSessions} refresh={refreshSession} retryWorkspaceSync={retryWorkspaceSync} runBackground={runBackground} sessionAction={(action) => { const target = sessionQuery.data?.props.session; if (!target) { notify("Session details are not loaded yet.", "warn"); return; } void runSessionAction(target, action, "floor"); }} logout={logout} setNotice={setNoticeText} exitApp={exit} />
    </> : <LoadingView message="Loading session floor…" escape={homeQuery.isLoading && !homeQuery.data ? "Esc stops and exits" : "Esc stops and returns to Sessions"} />)}
    {isHomePage(page) && <HomeCommandBar active={homeCommandActive} setActive={setHomeCommandActive} page={page} submit={executeHomeCommand} setNotice={setNoticeText} history={homeHistory} exitApp={exit} />}
    <Text dimColor>{hintFor(page, sessionId != null, floorFocus, pagePanelFocused)}</Text>
  </Box>;
}

function Header({ user, session, connection, workspace, localSync, busy, spinnerFrame, elapsedSeconds }: { user?: AppUser; session?: SessionSummary; connection: ConnectionStatus; workspace?: LocalWorkspace; localSync: LocalSync; busy: Busy | null; spinnerFrame: number; elapsedSeconds: number }) {
  const syncText = !workspace ? "" : localSync === "live" ? " · local live" : localSync === "syncing" ? " · syncing local" : localSync === "paused" ? " · local paused" : localSync === "mismatch" ? " · different repository" : "";
  return <Box borderStyle="round" borderColor={IDLE} paddingX={1} justifyContent="space-between"><Text bold color={BRAND}>openfloor</Text><Text>{user ? <Text dimColor>{`Logged in as ${user.displayName || user.email} · `}</Text> : ""}{session ? <Text color={ACCENT.floor}>{`${session.title} · `}</Text> : ""}<Text color={connection === "live" ? "green" : connection === "quota-exhausted" ? "red" : "yellow"}>{connection}</Text><Text color={localSync === "live" ? "green" : "yellow"}>{syncText}</Text>{busy && <Text color={ACCENT.workspace}> · {SPINNER_FRAMES[spinnerFrame]} {busy.label} · {elapsedSeconds}s</Text>}</Text></Box>;
}

function Home({ sessions, selected, usage, workspace }: { sessions: SessionSummary[]; selected: number; usage?: Usage; workspace?: LocalWorkspace }) {
  const groups = [["Active", sessions.filter((session) => session.endedAt == null && session.archivedAt == null)], ["Archived", sessions.filter((session) => session.endedAt == null && session.archivedAt != null)], ["Ended", sessions.filter((session) => session.endedAt != null)]] as const;
  const groupColor: Record<string, string> = { Active: "green", Archived: "yellow", Ended: IDLE };
  const groupAccent = (label: string) => groupColor[label] ?? IDLE;
  return <PageFrame title="Sessions" accent={ACCENT.sessions}>{workspace && <Text color={ACCENT.workspace}>Git workspace detected: {workspace.repositoryFullName}</Text>}{sessions.length === 0 ? <Text dimColor>No sessions. Use /new to create one.</Text> : groups.map(([label, values]) => values.length ? <Box key={label} flexDirection="column"><Text bold color={groupAccent(label)}>{label}</Text>{values.map((session) => { const index = sessions.indexOf(session); return <Text key={session.id} {...rowStyle(index === selected)}>{index === selected ? "›" : " "} {session.title.padEnd(30).slice(0, 30)} <Text dimColor>{shortId(session.id)}</Text> {session.role}</Text>; })}</Box> : null)}{usage && <UsageSummary usage={usage} />}</PageFrame>;
}

function CliSettings({ baseUrl }: { baseUrl: string }) {
  return <PageFrame title="CLI settings" accent={ACCENT.settings}><Text>Server: {baseUrl}</Text><Text>Authentication: Cloudflare Access in an openfloor-only local cache</Text><Text dimColor>/logout removes this CLI's cached Access session and workspace bindings.</Text><Text bold>Connections</Text><Text>/credentials safely connects AI credentials without shell history.</Text><Text bold>Browser-owned settings</Text><Text>/account opens profile, billing, GitHub installations, and account controls.</Text><Text dimColor>/exit returns to Sessions.</Text></PageFrame>;
}

function HelpPage({ session }: { session: boolean }) {
  return <PageFrame title="keyboard help" accent={ACCENT.help}>{session ? <>
    <Text>Type ordinary text to queue work; use /chat &lt;message&gt; for team chat.</Text>
    <Text>@ opens the agent list and filters as you type; Tab or Enter completes the highlighted agent.</Text>
    <Text>/floor /overview /review /settings /sessions /credentials /sync /refresh /exit /quit</Text>
    <Text>/invite /members /agents /assignments /routing /queue /files /runs /conflicts /skills /mcp</Text>
    <Text>/archive /unarchive /delete /leave manage this session's lifecycle</Text>
    <Text>Tab · Shift+Tab: cycle panels · arrows: navigate and scroll · Enter: open · Esc: returns to prompt</Text>
    <Text>Esc in the prompt closes a suggestion list; Esc twice clears typed text, or goes back one page when empty</Text>
    <Text>Up/Down in the prompt bar recall command history when there are no suggestions showing</Text>
  </> : <>
    <Text>↑↓ select · Enter opens · n creates · a session actions (archive/delete/leave) · / starts a command</Text>
    <Text>/new /archive /unarchive /delete /leave /settings /credentials /account /help /logout /refresh /exit /quit</Text>
    <Text>Ctrl+K focuses commands · Up/Down recall command history · Tab completes · Esc twice clears, then closes command entry</Text>
  </>}
    <Text>Ctrl+A/E: start/end of line · Ctrl+U: clear to start · Ctrl+W / Option+Backspace: delete word</Text>
    <Text>Ctrl+C twice within 2s, or Ctrl+D on an empty prompt, exits. Neither cancels a remote run.</Text>
  </PageFrame>;
}

function UsageSummary({ usage }: { usage: Usage }) {
  const plan = `${capitalize(usage.effectivePlan)} plan`;
  const allowance = `${usage.limitHours === null ? "Unlimited session time" : `${usage.limitHours} session hours per month`} · ${usage.limitSeats === null ? "Unlimited seats" : `${usage.limitSeats} seats per session`}`;
  if (usage.limitHours === null) return <Box flexDirection="column" marginTop={1}><Text bold color={ACCENT.sessions}>{plan}</Text><Text>{allowance}</Text><Text dimColor>{formatDuration(usage.seconds)} used this month (UTC)</Text></Box>;
  const limitSeconds = usage.limitHours * 3_600; const used = limitSeconds > 0 ? Math.min(1, usage.seconds / limitSeconds) : 1; const filled = Math.round(used * 20);
  const meter = used >= 0.9 ? "red" : used >= 0.7 ? "yellow" : "green";
  return <Box flexDirection="column" marginTop={1}><Text bold color={ACCENT.sessions}>{plan}</Text><Text>{allowance}</Text><Text color={meter}>{"█".repeat(filled)}{"░".repeat(20 - filled)} {Math.round(used * 100)}%</Text><Text>{formatDuration(usage.seconds)} used · {formatDuration(Math.max(0, limitSeconds - usage.seconds))} remaining</Text></Box>;
}

function FloorDashboard({ width, floor, online, drafts, activities, focus, rows }: { width: number; floor: FloorSnapshot; online: Set<string>; drafts: TypingDraft[]; activities: Record<string, Array<{ sequence: number; kind: string; detail: string }>>; focus: "prompt" | FloorPane; rows: Record<FloorPane, number> }) {
  const horizontal = width >= 100;
  const messages = teamMessages(floor);
  const queue = orderedQueue(floor);
  const agentsRow = effectivePaneRow("agents", rows.agents, floor.agents.length + 1);
  const chatRow = effectivePaneRow("chat", rows.chat, messages.length);
  const chatSpan = paneWindow(messages.length, 10, chatRow);
  const chatVisible = messages.slice(chatSpan.start, chatSpan.end);
  const draftsRow = effectivePaneRow("drafts", rows.drafts, drafts.length);
  const draftsSpan = paneWindow(drafts.length, 6, draftsRow);
  const draftsVisible = drafts.slice(draftsSpan.start, draftsSpan.end);
  const queueRow = effectivePaneRow("queue", rows.queue, queue.length);
  const queueSpan = paneWindow(queue.length, 14, queueRow);
  const queueVisible = queue.slice(queueSpan.start, queueSpan.end);
  const chatPanel = <Panel title="Team chat" accent={ACCENT.chat} width="100%" active={focus === "chat"}>{chatVisible.length ? <>
    {chatSpan.start > 0 && <Text dimColor>↑ {chatSpan.start} more above</Text>}
    {chatVisible.map((message, index) => <Text key={recordText(message, "id", String(chatSpan.start + index))} {...rowStyle(chatSpan.start + index === chatRow, focus === "chat")}><Text bold color={ACCENT.chat}>{recordText(message, "authorName", "Member")}</Text>: {recordText(message, "text")}</Text>)}
    {chatSpan.end < messages.length && <Text dimColor>↓ {messages.length - chatSpan.end} more below</Text>}
  </> : <Text dimColor>No public messages. Use /chat message.</Text>}{online.size > 0 && <Text dimColor>{online.size} online</Text>}</Panel>;
  const draftsPanel = <Panel title="Live teammate prompts" accent={ACCENT.drafts} width="100%" active={focus === "drafts"}>{draftsVisible.length ? <>
    {draftsSpan.start > 0 && <Text dimColor>↑ {draftsSpan.start} more above</Text>}
    {draftsVisible.map((draft, index) => <Text key={draft.userId} {...rowStyle(draftsSpan.start + index === draftsRow, focus === "drafts")} color={focus === "drafts" && draftsSpan.start + index === draftsRow ? FOCUS : ACCENT.drafts}><Text bold>{draft.displayName}</Text>: {draft.text.slice(0, 100)}</Text>)}
    {draftsSpan.end < drafts.length && <Text dimColor>↓ {drafts.length - draftsSpan.end} more below</Text>}
  </> : <Text dimColor>No teammates drafting.</Text>}</Panel>;
  return <Box flexDirection={horizontal ? "row" : "column"} minHeight={22}>
    {horizontal ? <Box flexDirection="column" width="28%">{chatPanel}{draftsPanel}</Box> : <>{chatPanel}{draftsPanel}</>}
    <Panel title="Agent floor" accent={ACCENT.agents} width={horizontal ? "44%" : "100%"} active={focus === "agents"}>{floor.agents.map((agent, index) => { const run = floor.runs.filter((item) => item.agentId === agent.id).sort((left, right) => right.updatedAt - left.updatedAt)[0]; const live = run ? activities[run.id]?.at(-1) : undefined; const status = agent.pausedAt ? "paused" : run?.status ?? "idle"; return <Box key={agent.id} flexDirection="column" marginBottom={1}><Text {...rowStyle(index === agentsRow, focus === "agents")} bold {...(focus === "agents" && index === agentsRow ? {} : { color: statusColor(status) })}>● {agent.name} <Text dimColor>{agent.provider}/{agent.model ?? "default"}</Text></Text><Text>{agent.role}: {agent.task}</Text><Text color={statusColor(status)}>{status}{live ? ` · ${live.detail}` : ""}</Text></Box>; })}<Text {...rowStyle(agentsRow === floor.agents.length, focus === "agents")} {...(focus === "agents" && agentsRow === floor.agents.length ? {} : { color: ACCENT.create })}>＋ Create agent</Text></Panel>
    <Panel title="Prompt queue" accent={ACCENT.queue} width={horizontal ? "28%" : "100%"} active={focus === "queue"}>{queueVisible.length ? <>
      {queueSpan.start > 0 && <Text dimColor>↑ {queueSpan.start} more above</Text>}
      {queueVisible.map((item, index) => <Box key={item.id} flexDirection="column" marginBottom={1}><Text {...rowStyle(queueSpan.start + index === queueRow, focus === "queue")} {...(focus === "queue" && queueSpan.start + index === queueRow ? {} : { color: statusColor(item.status) })}>{String(item.position + 1).padStart(2)} · {item.status} · {item.agentName ?? "unassigned"}</Text><Text>{item.prompts.map((prompt) => prompt.text).join(" / ").slice(0, 100)}</Text></Box>)}
      {queueSpan.end < queue.length && <Text dimColor>↓ {queue.length - queueSpan.end} more below</Text>}
    </> : <Text dimColor>Queue empty. Type a prompt below.</Text>}</Panel>
  </Box>;
}

function FloorItemDetail({ detail, floor, drafts, activities }: { detail: FloorDetail; floor: FloorSnapshot; drafts: TypingDraft[]; activities: Record<string, Array<{ sequence: number; kind: string; detail: string }>> }) {
  if (detail.pane === "chat") { const message = teamMessages(floor)[detail.index]; return <Detail title="Team message"><Text bold>{recordText(message, "authorName", "Member")}</Text><Text>{recordText(message, "text")}</Text><Text dimColor>Esc returns to floor</Text></Detail>; }
  if (detail.pane === "drafts") { const draft = drafts[detail.index]; return <Detail title="Live teammate prompt"><Text bold>{draft?.displayName ?? "Teammate"}</Text><Text>{draft?.text ?? "Draft ended."}</Text><Text dimColor>Ephemeral · Esc returns to floor</Text></Detail>; }
  if (detail.pane === "agents") { const agent = floor.agents[detail.index]; if (!agent) return <Detail title="Agent">Agent no longer available.</Detail>; const run = floor.runs.filter((item) => item.agentId === agent.id).sort((left, right) => right.updatedAt - left.updatedAt)[0]; const live = run ? activities[run.id]?.at(-1) : undefined; return <Detail title={agent.name}><Text>{agent.role}: {agent.task}</Text><Text>Provider: {agent.provider}/{agent.model ?? "default"}</Text><Text>Owner: {agent.ownerName}</Text><Text>Status: {agent.pausedAt ? "paused" : run?.status ?? "idle"}</Text>{live && <Text>Latest: {live.detail}</Text>}<Text dimColor>ID {agent.id} · Esc returns to floor</Text></Detail>; }
  const item = orderedQueue(floor)[detail.index]; if (!item) return <Detail title="Prompt">Prompt no longer available.</Detail>; return <Detail title={`Queue ${item.position + 1}`}><Text>Status: {item.status} · {item.agentName ?? "unassigned"}</Text>{item.prompts.map((prompt) => <Text key={prompt.id}><Text bold>{prompt.authorName}:</Text> {prompt.text}</Text>)}<Text dimColor>ID {item.id} · Esc returns to floor</Text></Detail>;
}

function Detail({ title, children }: { title: string; children: React.ReactNode }) { return <Panel title={title} accent={ACCENT.floor} minHeight={22} width="100%">{children}</Panel>; }

function PageView({ page, floor, members, owner, online, skills, mcp, workspace, localSync, active, focusPrompt, actions, sessionId, refresh, setNotice }: { page: Exclude<SessionPage, "floor">; floor: FloorSnapshot; members: SessionMember[]; owner: boolean; online: Set<string>; skills: unknown; mcp: unknown; workspace?: LocalWorkspace; localSync: LocalSync; active: boolean; focusPrompt: () => void; actions: OpenFloorActions; sessionId: string; refresh: () => void; setNotice: (message: string) => void }) {
  if (page === "review") return <ReviewPage actions={actions} sessionId={sessionId} floor={floor} active={active} focusPrompt={focusPrompt} />;
  if (page === "settings") return <SessionSettingsPage actions={actions} sessionId={sessionId} floor={floor} owner={owner} skills={skills} mcp={mcp} active={active} focusPrompt={focusPrompt} refresh={refresh} setNotice={setNotice} />;
  return <Panel title={`/${page}`} accent={accentFor(page)} active={active} minHeight={22} width="100%">
    {page === "overview" && <><Text bold color={ACCENT.overview}>Members</Text>{members.map((member) => <Text key={member.id} color={online.has(member.id) ? "green" : "white"}>● {member.displayName} · {member.role}{online.has(member.id) ? " · online" : ""}</Text>)}<Text bold color={ACCENT.overview}>Assignments</Text>{floor.assignments.length ? floor.assignments.map((assignment) => <Text key={recordText(assignment, "userId")}>{recordText(assignment, "userName")}: {recordText(assignment, "task", "Unassigned")}</Text>) : <Text dimColor>No assignments.</Text>}<Text bold color={ACCENT.workspace}>Repository</Text><Text>{recordText(floor.repository, "repositoryFullName", "No repository")} · {recordText(floor.activeCandidate, "branchName", "No candidate")}</Text>{workspace && <Text>Local: {workspace.root} · {localSync}</Text>}</>}
    {page === "help" && <HelpPage session />}
    <Text dimColor>{active ? "Esc returns to command bar" : "Tab enters this page · Esc Esc returns to the floor"}</Text>
  </Panel>;
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
  return <Panel title={`/review · ${status === "active" ? "Active" : "History"} · ${capitalize(mode)}`} accent={ACCENT.review} active={active} minHeight={22} width="100%">
    {!review && !list.isLoading && (list.data?.items.length ?? 0) === 0 && <Text dimColor>No review available.</Text>}
    {list.isLoading && !loadingStopped && <Text color={ACCENT.review}>Loading review contributions… · Esc stops</Text>}{loadingStopped && !list.data && <Text color="yellow">Review loading stopped. Tab into Review and press r to retry.</Text>}{list.error && <Text color="red">{errorMessage(list.error)}</Text>}
    {phase === "list" && mode === "files" && fileRows.slice(0, 18).map((row, index) => <Text key={`${row.runId}:${row.file.path}`} {...rowStyle(index === selected, active)}>{row.file.changeKind.padEnd(9)} {row.file.path} <Text dimColor>+{row.file.additions} -{row.file.deletions} · {row.agentName}</Text></Text>)}
    {phase === "list" && mode === "prompts" && (list.data?.items ?? []).slice(0, 18).map((item, index) => <Text key={item.runId} {...rowStyle(index === selected, active)}>{shortId(item.runId)} · {item.agentName} · {item.prompts.map((prompt) => prompt.text).join(" / ").slice(0, 100)}</Text>)}
    {phase === "files" && <><Text bold>{contribution?.prompts.map((prompt) => prompt.text).join(" / ") ?? "Loading prompt…"}</Text>{files.map((file, index) => <Text key={file.path} {...rowStyle(index === fileSelected, active)}>{file.changeKind.padEnd(9)} {file.path} <Text dimColor>+{file.additions} -{file.deletions}</Text></Text>)}</>}
    {phase === "diff" && <><Text bold>{diffFile?.path ?? "Loading diff…"} · wrap {wrap ? "on" : "off"}</Text>{diff.slice(offset, offset + 16).map((line, index) => <Text key={`${offset}:${index}`} color={line.type === "add" ? "green" : line.type === "remove" ? "red" : "white"}>{String(offset + index + 1).padStart(4)} {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "} {wrap ? line.text : line.text.slice(0, 120)}</Text>)}</>}
    <Text dimColor>{active ? "↑↓ select/scroll · Enter open · v Files/Prompts · h Active/History · w wrap · Esc back/prompt" : "Tab enters review · Esc Esc returns to the floor"}</Text>
  </Panel>;
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
  return <Panel title="/settings" accent={ACCENT.settings} active={active} minHeight={22} width="100%">
    {rows.map((row, index) => <Text key={row.field} {...rowStyle(selected === index, active)}>{row.label.padEnd(22)} {typeof row.value === "boolean" ? <Text color={row.value ? "green" : IDLE}>{row.value ? "on" : "off"}</Text> : PROVIDER_LABELS[provider]}</Text>)}
    <Text>Skills: {recordArray(skills, "skills").length} · MCP servers: {recordArray(mcp, "servers").length}</Text>
    <Text dimColor>{owner ? working ? "Saving…" : active ? "↑↓ select · Enter toggle/cycle · Esc returns to command bar" : "Tab enters settings · Esc Esc returns to the floor" : "Session settings are owner-only."}</Text>
  </Panel>;
}

function CommandBar({ page, sessionId, actions, presence, focused, agents, onMenu, navigate, openCredentials, goSessions, refresh, retryWorkspaceSync, runBackground, sessionAction, logout, setNotice, history, exitApp }: { page: SessionPage; sessionId: string; actions: OpenFloorActions; presence?: PresenceClient; focused: boolean; agents: FloorSnapshot["agents"]; onMenu: (open: boolean) => void; navigate: (page: SessionPage) => void; openCredentials: () => void; goSessions: () => void; refresh: () => void; retryWorkspaceSync: () => void; runBackground: (line: string) => Promise<void>; sessionAction: (action: Exclude<SessionAction, "cancel">) => void; logout: () => Promise<void>; setNotice: (message: string) => void; history: HistoryBuffer; exitApp: () => void }) {
  const { exit } = useApp(); const [value, setValue] = useState(""); const [cursor, setCursor] = useState(0); const [selected, setSelected] = useState(0); const [inputKey, setInputKey] = useState(0); const [caret, setCaret] = useState<number | undefined>(undefined); const [menuHidden, setMenuHidden] = useState(false);
  const escapeGesture = useEscapeGesture();
  const mention = menuHidden ? null : mentionAt(value, cursor);
  const mentionNames = mention ? rankNames(agents.map((agent) => agent.name), mention.query) : [];
  const suggestions: Suggestion[] = mention
    ? mentionNames.map((name) => { const agent = agents.find((item) => item.name === name)!; return { name: `@${name}`, description: `${agent.role} · ${agent.pausedAt ? "paused" : `${agent.provider}/${agent.model ?? "default"}`}` }; })
    : !menuHidden && value.startsWith("/") ? commandSuggestions(SESSION_COMMANDS, value) : [];
  const activeSelection = Math.min(selected, Math.max(0, suggestions.length - 1));
  const menuOpen = focused && suggestions.length > 0;
  useEffect(() => { onMenu(menuOpen); return () => onMenu(false); }, [menuOpen, onMenu]);
  const rewrite = (next: string, nextCursor?: number) => { setValue(next); setCursor(nextCursor ?? next.length); setCaret(nextCursor); setSelected(0); setInputKey((current) => current + 1); };
  /** Accepts the highlighted suggestion. Returns false when there is nothing to accept. */
  const complete = (): boolean => {
    if (!suggestions.length) return false;
    if (mention) { const name = mentionNames[activeSelection]; if (!name) return false; const applied = applyMention(value, mention, name); rewrite(applied.value, applied.cursor); return true; }
    const chosen = suggestions[activeSelection]!; const argument = value.trim().split(/\s+/).slice(1).join(" ");
    rewrite(`${chosen.name}${argument ? ` ${argument}` : ""}`);
    return true;
  };
  const back = () => { if (page === "floor") goSessions(); else navigate("floor"); };
  const reset = () => { setValue(""); setCursor(0); setCaret(undefined); setSelected(0); setMenuHidden(false); setInputKey((current) => current + 1); presence?.sendDraft("", false); };
  const submit = async (raw: string) => {
    const text = raw.trim(); if (!text) return;
    history.push(text);
    if (text.startsWith("/")) {
      const [command = "", ...rest] = text.slice(1).split(/\s+/); const argument = rest.join(" ").trim();
      const exact = SESSION_COMMANDS.some((entry) => entry.name === `/${command}`) || command === "run";
      if (!exact && !mention && complete()) return;
      if (["floor", "overview", "settings"].includes(command)) navigate(command as SessionPage);
      else if (command === "review" && !argument) navigate("review");
      else if (command === "sessions") goSessions();
      else if (command === "refresh") { refresh(); setNotice("Session refreshed."); }
      else if (command === "sync") retryWorkspaceSync();
      else if (command === "commands" || command === "help") navigate("help");
      else if (command === "credentials") openCredentials();
      else if (command === "archive" || command === "unarchive" || command === "delete" || command === "leave") sessionAction(command);
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
  useInput((input, key) => { if (key.ctrl && input === "d" && !value) exitApp(); }, { isActive: focused });
  return <Box flexDirection="column">
    {menuOpen && <SuggestionList items={suggestions} selected={activeSelection} hint={mention ? "Tab or Enter completes the agent · Esc closes" : "Tab or Enter completes · Esc closes"} />}
    <Box {...focusFrame(focused)} paddingX={1}>
      <Text bold color={focused ? FOCUS : IDLE}>{page} › </Text>
      <EditableInput key={inputKey} value={value} active={focused} {...(caret != null ? { initialCursor: caret } : {})} placeholder="Prompt agents, @mention one, or type /help"
        onUp={() => { if (suggestions.length > 0) { setSelected((current) => Math.max(0, current - 1)); return; } const previous = history.previous(value); if (previous != null) rewrite(previous); }}
        onDown={() => { if (suggestions.length > 0) { setSelected((current) => Math.min(Math.max(0, suggestions.length - 1), current + 1)); return; } const next = history.next(); if (next != null) rewrite(next); }}
        onTab={() => { complete(); }}
        onEscape={() => {
          if (menuOpen) { setMenuHidden(true); return; }
          escapeGesture(
            () => setNotice(value ? "Press Esc again to clear the prompt." : page === "floor" ? "Press Esc again to return to Sessions." : "Press Esc again to return to the floor."),
            () => { if (value) reset(); else back(); },
          );
        }}
        onCursor={setCursor}
        onChange={(next, nextCursor) => { setValue(next); setCursor(nextCursor); setCaret(undefined); setSelected(0); setMenuHidden(false); if (next.startsWith("/")) presence?.sendDraft("", false); else presence?.sendDraft(next); }}
        onSubmit={(next) => { if (mention && mentionNames.length && !mentionNames.includes(mention.query)) { complete(); return; } void submit(next).catch((reason) => setNotice(errorMessage(reason))); }} />
    </Box>
  </Box>;
}

const HOME_COMMANDS: readonly CommandSpec[] = [
  { name: "/new", description: "create session" }, { name: "/archive", description: "archive selected session" }, { name: "/unarchive", description: "unarchive selected session" }, { name: "/delete", description: "delete selected session (owner)" }, { name: "/leave", description: "leave selected session" }, { name: "/settings", description: "CLI settings" }, { name: "/credentials", description: "AI credentials" }, { name: "/account", description: "browser account settings" }, { name: "/help", description: "keyboard help" }, { name: "/logout", description: "remove CLI login" }, { name: "/sessions", description: "session list" }, { name: "/refresh", description: "reload sessions" }, { name: "/exit", description: "quit" }, { name: "/quit", description: "quit" },
];
const SESSION_COMMANDS: readonly CommandSpec[] = [
  { name: "/floor", description: "agent floor" }, { name: "/overview", description: "session overview" }, { name: "/review", description: "changes by file or prompt" }, { name: "/settings", description: "session settings" }, { name: "/sessions", description: "all sessions" }, { name: "/chat", description: "send or manage chat" }, { name: "/queue", description: "queue prompt or manage queue" }, { name: "/agents", description: "manage agents" }, { name: "/assignments", description: "manage assignments" }, { name: "/routing", description: "routing commands" }, { name: "/invite", description: "invite commands" }, { name: "/members", description: "member commands" }, { name: "/files", description: "file commands" }, { name: "/runs", description: "run commands" }, { name: "/conflicts", description: "conflict commands" }, { name: "/skills", description: "skill commands" }, { name: "/mcp", description: "MCP commands" }, { name: "/credentials", description: "AI credentials" }, { name: "/account", description: "browser account settings" }, { name: "/archive", description: "archive this session" }, { name: "/unarchive", description: "unarchive this session" }, { name: "/delete", description: "delete this session (owner)" }, { name: "/leave", description: "leave this session" }, { name: "/refresh", description: "reload floor" }, { name: "/sync", description: "retry local sync" }, { name: "/help", description: "keyboard help" }, { name: "/logout", description: "remove CLI login" }, { name: "/exit", description: "back" }, { name: "/quit", description: "quit" },
];
const BACKGROUND_GROUPS = ["invite", "members", "agents", "assignments", "routing", "queue", "chat", "files", "runs", "conflicts", "skills", "mcp", "review"];
const BACKGROUND_DEFAULTS: Record<string, string | undefined> = { invite: "show", members: "list", agents: "list", routing: "show", queue: "list", chat: "list", files: "list", runs: "list", conflicts: "list", skills: "list", mcp: "list", review: "status" };

function HomeCommandBar({ active, setActive, page, submit, setNotice, history, exitApp }: { active: boolean; setActive: (active: boolean) => void; page: "sessions" | "cli-settings" | "cli-help"; submit: (value: string) => Promise<void>; setNotice: (message: string) => void; history: HistoryBuffer; exitApp: () => void }) {
  const [value, setValue] = useState(""); const [selected, setSelected] = useState(0); const [inputKey, setInputKey] = useState(0);
  const escapeGesture = useEscapeGesture();
  const suggestions = commandSuggestions(HOME_COMMANDS, value || "/");
  const activeSelection = Math.min(selected, Math.max(0, suggestions.length - 1));
  const reset = () => { setActive(false); setValue(""); setSelected(0); setInputKey((current) => current + 1); };
  const rewrite = (next: string) => { setValue(next); setSelected(0); setInputKey((current) => current + 1); };
  const complete = (): boolean => { const chosen = suggestions[activeSelection]; if (!chosen) return false; rewrite(chosen.name); return true; };
  useInput((input, key) => {
    if (!active) {
      if (input === "/" || (key.ctrl && input === "k")) { setValue("/"); setSelected(0); setInputKey((current) => current + 1); setActive(true); }
      return;
    }
    if (key.ctrl && input === "d" && !value) exitApp();
  });
  const execute = async (raw: string) => {
    const trimmed = raw.trim();
    const token = trimmed.split(/\s/, 1)[0] ?? ""; const exact = HOME_COMMANDS.some((entry) => entry.name === token) || token === "/run";
    if (!exact && complete()) return;
    if (!trimmed.startsWith("/")) { setNotice("Commands start with /. Press / to open commands."); return; }
    history.push(trimmed);
    try { await submit(trimmed); reset(); }
    catch (reason) { setNotice(sanitizeTerminal(reason instanceof Error ? reason.message : String(reason)).slice(-240)); }
  };
  const label = page === "sessions" ? "sessions" : page === "cli-settings" ? "settings" : "help";
  return <Box flexDirection="column">
    {active && suggestions.length > 0 && <SuggestionList items={suggestions} selected={activeSelection} hint="Tab or Enter completes · Esc twice closes commands" />}
    <Box {...focusFrame(active)} paddingX={1}>
      <Text bold color={active ? FOCUS : IDLE}>{label} › </Text>
      <EditableInput key={inputKey} value={value} active={active} placeholder="Type / for commands"
        onEscape={() => { const typed = value.trim() !== "" && value.trim() !== "/"; escapeGesture(
          () => setNotice(typed ? "Press Esc again to clear the command bar." : "Press Esc again to close commands."),
          () => { if (typed) rewrite("/"); else reset(); },
        ); }}
        onTab={() => { complete(); }}
        onUp={() => { if (suggestions.length > 0) { setSelected((current) => Math.max(0, current - 1)); return; } const previous = history.previous(value); if (previous != null) rewrite(previous); }}
        onDown={() => { if (suggestions.length > 0) { setSelected((current) => Math.min(Math.max(0, suggestions.length - 1), current + 1)); return; } const next = history.next(); if (next != null) rewrite(next); }}
        onChange={(next) => { setValue(next); setSelected(0); }} onSubmit={(raw) => { void execute(raw); }} />
    </Box>
  </Box>;
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
  return <PageFrame title="Create agent" accent={ACCENT.create}>
    {stage === "name" && <><Text>Name</Text><EditableInput key={stage} value={name} onChange={(value) => setName(value.slice(0, 80))} placeholder="Builder" onEscape={back} onSubmit={(value) => { if (value.trim()) setStage("role"); }} /></>}
    {stage === "role" && <><Text>Role</Text><EditableInput key={stage} value={role} onChange={(value) => setRole(value.slice(0, 120))} placeholder="Software engineer" onEscape={back} onSubmit={(value) => { if (value.trim()) setStage("task"); }} /></>}
    {stage === "task" && <><Text>Task</Text><EditableInput key={stage} value={task} onChange={(value) => setTask(value.slice(0, 500))} placeholder="What should this agent own?" onEscape={back} onSubmit={(value) => { if (value.trim()) setStage("owner"); }} /></>}
    {stage === "owner" && <ChoiceList title="Owner" values={members.map((member) => `${member.displayName} · ${member.role}`)} selected={owner} />}
    {stage === "provider" && <ChoiceList title="Provider" values={PROVIDERS.map((value) => PROVIDER_LABELS[value])} selected={provider} />}
    {stage === "credential" && <ChoiceList title="Credential" values={kinds.map((value) => credentialLabel(selectedProvider, value))} selected={kind} />}
    {stage === "model" && <ChoiceList title="Model" values={models.map((value) => value ?? "Provider default")} selected={model} />}
    {stage === "confirm" && <><Text bold>{name}</Text><Text>{role}: {task}</Text><Text>Owner: {members[owner]?.displayName}</Text><Text>Provider: {PROVIDER_LABELS[selectedProvider]} · {credentialLabel(selectedProvider, kinds[kind]!)}</Text><Text>Model: {models[model] ?? "Provider default"}</Text><Text color={FOCUS}>Enter creates once · Esc goes back</Text></>}
    {stage === "submitting" && <Text color={statusColor("running")}>Creating agent…</Text>}
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
  return <PageFrame title="AI credentials" accent={ACCENT.credentials}>
    <Text>Write-only connection flow. Secrets never enter shell history, config, logs, drafts, or rendered output.</Text>
    {credentials.isLoading && <Text color={statusColor("running")}>Loading credential status… · Esc stops and returns</Text>}{credentials.error && <Text color="red">{errorMessage(credentials.error)}</Text>}
    {stage === "list" && options.map((item, index) => { const found = credentials.data?.credentials.find((credential) => credential.provider === item.provider && credential.kind === item.kind); return <Text key={`${item.provider}:${item.kind}`} {...rowStyle(index === selected)}>{credentialLabel(item.provider, item.kind).padEnd(28)} {found ? `Connected ····${found.fingerprint}${found.validatedAt ? "" : " · not yet verified"}` : "Not connected"}</Text>; })}
    {stage === "secret" && <><Text bold>{credentialLabel(option.provider, option.kind)}</Text><Text>{option.provider === "openai" && option.kind === "oauth" ? "Paste complete auth.json. Ctrl+J inserts newline." : "Paste credential."}</Text><EditableInput value={secret} onChange={setSecret} secret multiline={option.provider === "openai" && option.kind === "oauth"} placeholder="Secret hidden" onEscape={() => { clearSecret(); setStage("list"); }} onSubmit={(value) => { if (value.trim()) setStage("confirm-connect"); }} /></>}
    {stage === "confirm-connect" && <><Text>Connect {credentialLabel(option.provider, option.kind)}?</Text><Text>Secret is hidden and will be sent directly to openfloor for encrypted storage.</Text><Text color={FOCUS}>Enter connects once · Esc cancels</Text></>}
    {stage === "confirm-disconnect" && <><Text>Disconnect {credentialLabel(option.provider, option.kind)} ending ····{existing?.fingerprint}?</Text><Text color={FOCUS}>Enter disconnects · Esc cancels</Text></>}
    {stage === "working" && <Text color={statusColor("running")}>Updating credential…</Text>}
    {stage === "error" && <><Text color="red">{error}</Text><Text>Mutation was not retried automatically.</Text><Text dimColor>Esc returns to credential status.</Text></>}
    {stage === "list" && <Text dimColor>↑↓ select · Enter connect/disconnect · Esc returns</Text>}
  </PageFrame>;
}

function BindWorkspaceConfirm({ workspace, repositoryName, branch, sha, close, confirm }: { workspace: LocalWorkspace; repositoryName: string; branch: string; sha: string; close: () => void; confirm: () => Promise<void> }) {
  const [working, setWorking] = useState(false); const [error, setError] = useState<string | null>(null);
  useInput((input, key) => { if (working) return; if (key.escape || input.toLowerCase() === "n") close(); else if (key.return || input.toLowerCase() === "y") { setWorking(true); setError(null); void confirm().then(close, (reason) => { setWorking(false); setError(reason instanceof Error ? reason.message : String(reason)); }); } });
  return <PageFrame title="Enable local live sync?" accent={ACCENT.workspace}><Text>Repository: {repositoryName}</Text><Text>Directory: {workspace.root}</Text><Text>Candidate: {branch}</Text><Text>Expected SHA: {sha}</Text><Text color="yellow">Clean checkout will switch to this candidate branch and receive fast-forward updates. Local edits are never uploaded.</Text>{error && <Text color="red">{error}</Text>}<Text color={working ? ACCENT.workspace : FOCUS}>{working ? "Checking workspace…" : "Enter/y confirms · Esc/n keeps local sync off"}</Text></PageFrame>;
}

type CreateStage = "loading" | "empty" | "title" | "objective" | "candidate" | "repository" | "repository-search" | "confirm" | "submitting" | "load-error" | "preflight-error" | "mutation-error" | "provision-failed";
function CreateSessionWizard({ actions, baseUrl, close, workspace, onCreated }: { actions: OpenFloorActions; baseUrl: string; close: () => void; workspace?: LocalWorkspace; onCreated: (id: string, ready: boolean, message: string) => void }) {
  const [stage, setStage] = useState<CreateStage>("loading"); const [repositories, setRepositories] = useState<RepositoryOption[]>([]); const [selectedRepository, setSelectedRepository] = useState(0); const [search, setSearch] = useState(""); const [title, setTitle] = useState(""); const [objective, setObjective] = useState(""); const [candidateName, setCandidateName] = useState(""); const [error, setError] = useState<string | null>(null); const [loadAttempt, setLoadAttempt] = useState(0); const submitted = useRef(false);
  useEffect(() => { let active = true; const controller = new AbortController(); void actions.repositories(controller.signal).then(({ repositories: values }) => { if (!active) return; const available = workspace ? values.filter((repository) => repository.fullName.toLowerCase() === workspace.repositoryFullName.toLowerCase()) : values; setRepositories(available); setSelectedRepository(0); setStage(available.length ? "title" : "empty"); }, (reason) => { if (active && !controller.signal.aborted) { setError(reason instanceof Error ? reason.message : String(reason)); setStage("load-error"); } }); return () => { active = false; controller.abort(); }; }, [actions, loadAttempt, workspace]);
  const filtered = repositories.filter((repository) => repository.fullName.toLowerCase().includes(search.trim().toLowerCase())); const selected = repositories[selectedRepository];
  const submit = async () => { if (!selected || submitted.current) return; submitted.current = true; setError(null); setStage("submitting"); if (workspace) { try { await requireCleanWorkspace(workspace); } catch (reason) { submitted.current = false; setError(reason instanceof Error ? reason.message : String(reason)); setStage("preflight-error"); return; } } try { const created = await actions.createSession({ title: title.trim(), objective: objective.trim() || null, candidateName: candidateName.trim() || title.trim(), repositoryId: selected.id, accountInstallationId: selected.accountInstallationId }); const ready = created.setupStatus === "ready"; const message = ready ? "Session created." : created.setupError ?? "Session created, but repository setup needs attention."; if (!ready) { setError(message); setStage("provision-failed"); } onCreated(created.session.id, ready, message); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setStage("mutation-error"); } };
  useInput((input, key) => { if (stage === "repository") { if (key.upArrow) setSelectedRepository((value) => Math.max(0, value - 1)); else if (key.downArrow) setSelectedRepository((value) => Math.min(repositories.length - 1, value + 1)); else if (input.toLowerCase() === "s") { setSearch(""); setStage("repository-search"); } else if (key.return && selected) setStage("confirm"); else if (key.escape) setStage("candidate"); return; } if (stage === "confirm") { if (key.return) void submit(); else if (key.escape) setStage("repository"); return; } if (stage === "empty" && key.return) { void open(`${baseUrl}/home/settings?section=connections`); return; } if (stage === "load-error" && input.toLowerCase() === "r") { setError(null); setStage("loading"); setLoadAttempt((value) => value + 1); return; } if (stage === "preflight-error" && input.toLowerCase() === "r") { setError(null); setStage("confirm"); return; } if (!key.escape) return; if (stage === "objective") setStage("title"); else if (stage === "candidate") setStage("objective"); else if (stage === "repository-search") setStage("repository"); else if (stage !== "submitting") close(); });
  return <PageFrame title={workspace ? `New local session · ${workspace.repositoryFullName}` : "New session"} accent={ACCENT.create}>
    {stage === "loading" && <Text color={statusColor("running")}>Loading GitHub repositories… · Esc stops and returns</Text>}
    {stage === "empty" && <><Text>{workspace ? `${workspace.repositoryFullName} is not available to openfloor.` : "No repositories available."}</Text><Text>Press Enter to update GitHub access.</Text></>}
    {stage === "title" && <><Text>Task</Text><EditableInput key={stage} value={title} onChange={(value) => setTitle(value.slice(0, 100))} placeholder="What is this session for?" onSubmit={(value) => { const next = value.trim(); if (next) { setTitle(next); setCandidateName(next); setStage("objective"); } }} /></>}
    {stage === "objective" && <><Text>Goal <Text dimColor>(optional)</Text></Text><EditableInput key={stage} value={objective} onChange={(value) => setObjective(value.slice(0, 2_000))} placeholder="Press Enter to skip" onSubmit={() => setStage("candidate")} /></>}
    {stage === "candidate" && <><Text>Candidate branch name</Text><EditableInput key={stage} value={candidateName} onChange={(value) => setCandidateName(value.slice(0, 100))} placeholder={title} onSubmit={(value) => { setCandidateName((value.trim() || title).slice(0, 100)); setStage("repository"); }} /></>}
    {stage === "repository" && <><Text>Select repository</Text>{repositories.map((repository, index) => <Text key={`${repository.accountInstallationId}:${repository.id}`} {...rowStyle(index === selectedRepository)}>{index === selectedRepository ? "›" : " "} {repository.fullName} · {repository.defaultBranch}</Text>)}<Text dimColor>↑↓ select · s search · Enter continue</Text></>}
    {stage === "repository-search" && <><Text>Search repositories</Text><EditableInput value={search} placeholder="owner/repository" onChange={setSearch} onSubmit={() => { const first = filtered[0]; if (first) { setSelectedRepository(repositories.indexOf(first)); setStage("repository"); } }} />{filtered.slice(0, 6).map((repository, index) => <Text key={repository.id} {...(index === 0 ? { color: FOCUS } : {})}>{index === 0 ? "›" : " "} {repository.fullName}</Text>)}</>}
    {stage === "confirm" && selected && <><Text bold>{title}</Text><Text>{objective || "No goal provided"}</Text><Text>Repository: {selected.fullName}</Text><Text>Candidate: {candidateName || title}</Text>{workspace && <Text color="yellow">Creation requires a clean worktree. It will switch to the server candidate branch, then receive fast-forward updates. Local edits are never uploaded.</Text>}<Text color={FOCUS}>Press Enter to create once. Esc goes back.</Text></>}
    {stage === "submitting" && <Text color={statusColor("running")}>Creating session and candidate branch…</Text>}
    {stage === "load-error" && <><Text color="red">{error ?? "Unable to load repositories."}</Text><Text dimColor>Press r to retry or Esc to close.</Text></>}
    {stage === "preflight-error" && <><Text color="red">{error ?? "Local workspace is not ready."}</Text><Text dimColor>Fix the worktree, then press r to check again or Esc to close.</Text></>}
    {stage === "mutation-error" && <><Text color="red">{error ?? "Unable to create session."}</Text><Text>Creation is not retried because the server outcome may be unknown.</Text><Text dimColor>Esc returns to Sessions so you can refresh before trying again.</Text></>}
    {stage === "provision-failed" && <><Text color="red">{error}</Text><Text>The session was created, but its repository needs attention.</Text><Text dimColor>Esc returns to Sessions. Select the new session to inspect Repository.</Text></>}
  </PageFrame>;
}

function LoadingView({ message, escape }: { message: string; escape: string }) { return <Box flexDirection="column"><Text color={statusColor("running")}>{message}</Text><Text dimColor>{escape}</Text></Box>; }
function SessionLoadError({ error }: { error: unknown }) { return <Box flexDirection="column"><Text color="red" bold>Unable to load session floor</Text><Text>{errorMessage(error)}</Text><Text dimColor>Esc returns to Sessions · r retries</Text></Box>; }
function ErrorView({ error }: { error: unknown }) { return <Box flexDirection="column"><Text color="red" bold>Unable to load openfloor</Text><Text>{sanitizeTerminal(error instanceof Error ? error.message : String(error))}</Text><Text dimColor>Run openfloor auth login or openfloor doctor.</Text></Box>; }
function appendActivity(current: Record<string, Array<{ sequence: number; kind: string; detail: string }>>, runId: string, events: Array<{ sequence: number; kind: string; detail: string }>) { const all = [...(current[runId] ?? []), ...events].sort((left, right) => left.sequence - right.sequence); return { ...current, [runId]: all.filter((item, index) => index === 0 || item.sequence !== all[index - 1]!.sequence).slice(-100) }; }
function floorPaneCount(pane: FloorPane, floor: FloorSnapshot | undefined, drafts: TypingDraft[]): number { if (!floor) return 0; if (pane === "chat") return teamMessages(floor).length; if (pane === "drafts") return drafts.length; if (pane === "agents") return floor.agents.length + 1; return floor.queue.length; }
/** Clamps a cursor-centered window of `size` items into [0, length). Pure. */
export function paneWindow(length: number, size: number, cursor: number): { start: number; end: number } {
  if (length <= 0) return { start: 0, end: 0 };
  if (length <= size) return { start: 0, end: length };
  let start = cursor - Math.floor(size / 2);
  if (start < 0) start = 0;
  if (start + size > length) start = length - size;
  return { start, end: start + size };
}
/** Resolves a pane's stored cursor (-1 = never navigated) to an absolute index into its full list. Chat/drafts default to the newest item; agents/queue default to the first. */
function effectivePaneRow(pane: FloorPane, raw: number, count: number): number {
  if (count <= 0) return 0;
  if (raw < 0) return pane === "chat" || pane === "drafts" ? count - 1 : 0;
  return Math.min(Math.max(raw, 0), count - 1);
}
function recordText(value: unknown, key: string, fallback = ""): string { if (!value || typeof value !== "object" || !(key in value)) return fallback; const entry = (value as Record<string, unknown>)[key]; return typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean" ? String(entry) : fallback; }
function recordArray(value: unknown, ...keys: string[]): Array<Record<string, unknown>> { if (!value || typeof value !== "object") return []; for (const key of keys) { const entry = (value as Record<string, unknown>)[key]; if (Array.isArray(entry)) return entry.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)); } return []; }
function sessionGroup(session: SessionSummary): number { return session.endedAt != null ? 2 : session.archivedAt != null ? 1 : 0; }
function isSessionPage(page: Page): page is SessionPage { return ["floor", "overview", "review", "settings", "help"].includes(page); }
function isHomePage(page: Page): page is "sessions" | "cli-settings" | "cli-help" { return ["sessions", "cli-settings", "cli-help"].includes(page); }
function capitalize(value: string): string { return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`; }
function hintFor(page: Page, hasSession: boolean, floorFocus: "prompt" | FloorPane, pagePanelFocused: boolean): string {
  if (!hasSession) return page === "sessions" ? "↑↓ select · Enter open · n new · a session actions · / commands · Ctrl+C twice or Ctrl+D exits" : "Esc: back to Sessions";
  if (page === "floor") return floorFocus === "prompt" ? "@: mention an agent · /: commands · Tab: change panel · Esc Esc: back to Sessions · Ctrl+C twice or Ctrl+D exits" : "Tab: change panel · arrows: move · Enter: open · Esc: prompt";
  return pagePanelFocused ? "Esc: returns to command bar" : "Tab: focus this page · Esc Esc: back to floor";
}
function teamMessages(floor: FloorSnapshot) { return floor.messages.filter((message) => !recordText(message, "recipientUserId")); }
const TERMINAL_QUEUE_STATUSES = new Set(["completed", "failed", "cancelled", "canceled", "integrated", "rolled_back", "discarded", "answered"]);
export function orderedQueue(floor: FloorSnapshot) { return [...floor.queue].sort((left, right) => Number(TERMINAL_QUEUE_STATUSES.has(left.status)) - Number(TERMINAL_QUEUE_STATUSES.has(right.status)) || left.position - right.position); }

async function runPalette(line: string, sessionId: string | null, baseUrl: string): Promise<void> { const args = tokenize(line); if (!args.length) return; args.push("--base-url", baseUrl, "--no-color", "--quiet"); if (sessionId) args.push("--session", sessionId); const entry = process.argv[1]; if (!entry) throw new Error("CLI entry point unavailable"); try { await exec(process.execPath, [entry, ...args], { encoding: "utf8", maxBuffer: 1024 * 1024 }); } catch (reason) { const error = reason as { stderr?: string; stdout?: string; message?: string }; throw new Error(sanitizeTerminal(`${error.stdout ?? ""}${error.stderr ?? ""}`.trim() || error.message || "Command failed.").slice(-8_000)); } }
export function tokenize(input: string): string[] { const values: string[] = []; let current = ""; let quote: string | null = null; let escaped = false; for (const char of input.trim()) { if (escaped) { current += char; escaped = false; continue; } if (char === "\\") { escaped = true; continue; } if (quote) { if (char === quote) quote = null; else current += char; continue; } if (char === '"' || char === "'") { quote = char; continue; } if (/\s/.test(char)) { if (current) { values.push(current); current = ""; } } else current += char; } if (escaped) current += "\\"; if (quote) throw new Error("Unclosed quote"); if (current) values.push(current); return values; }
export function formatDuration(seconds: number): string { const whole = Math.max(0, Math.floor(seconds)); const hours = Math.floor(whole / 3_600); const minutes = Math.floor((whole % 3_600) / 60); const remainder = whole % 60; return [hours ? `${hours}h` : "", minutes ? `${minutes}m` : "", (!hours && !minutes) || remainder ? `${remainder}s` : ""].filter(Boolean).join(" "); }
