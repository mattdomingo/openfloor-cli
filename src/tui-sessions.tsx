import { Text, useInput } from "ink";
import React, { useRef, useState } from "react";
import type { OpenFloorActions } from "./actions.js";
import type { SessionSummary } from "./contracts.js";
import { OpenFloorError } from "./errors.js";
import { shortId } from "./id.js";
import { errorMessage, PageFrame, rowStyle } from "./tui-shared.js";
import { ACCENT, FOCUS } from "./theme.js";

export type SessionAction = "archive" | "unarchive" | "delete" | "leave" | "cancel";

export function SessionActionsPage({ session, onSelect, close }: { session: SessionSummary; onSelect: (action: SessionAction) => void; close: () => void }) {
  const archived = session.archivedAt != null;
  const owner = session.role === "owner";
  const rows: Array<{ action: SessionAction; label: string }> = [
    { action: archived ? "unarchive" : "archive", label: archived ? "Unarchive" : "Archive" },
    owner ? { action: "delete", label: "Delete" } : { action: "leave", label: "Leave" },
    { action: "cancel", label: "Cancel" },
  ];
  const [selected, setSelected] = useState(0);
  useInput((_input, key) => {
    if (key.escape) { close(); return; }
    if (key.upArrow) setSelected((value) => Math.max(0, value - 1));
    else if (key.downArrow) setSelected((value) => Math.min(rows.length - 1, value + 1));
    else if (key.return) { const row = rows[selected]!; if (row.action === "cancel") close(); else onSelect(row.action); }
  });
  return <PageFrame title={`Session actions · ${session.title}`} accent={ACCENT.sessions}>
    <Text dimColor>{shortId(session.id)} · {session.role}{archived ? " · archived" : ""}{session.endedAt != null ? " · ended" : ""}</Text>
    {rows.map((row, index) => <Text key={row.action} {...rowStyle(index === selected)}>{index === selected ? "›" : " "} {row.label}</Text>)}
    <Text dimColor>↑↓ select · Enter choose · Esc cancel</Text>
  </PageFrame>;
}

export type DeleteBlock =
  | { kind: "candidate_live"; branch: string; canDeleteBranch: boolean }
  | { kind: "branch_delete_failed"; branch: string }
  | { kind: "run_blocked"; runId: string };

/** Reads the structured 409 body openfloor's DELETE /api/sessions/:id can return. Pure; no I/O. */
export function deleteBlock(error: unknown): DeleteBlock | null {
  if (!(error instanceof OpenFloorError) || error.code !== "conflict") return null;
  if (!error.details || typeof error.details !== "object") return null;
  const record = error.details as Record<string, unknown>;
  if (record.code === "candidate_live" && typeof record.branch === "string") return { kind: "candidate_live", branch: record.branch, canDeleteBranch: Boolean(record.canDeleteBranch) };
  if (record.code === "branch_delete_failed" && typeof record.branch === "string") return { kind: "branch_delete_failed", branch: record.branch };
  if (typeof record.runId === "string") return { kind: "run_blocked", runId: record.runId };
  return null;
}

type RemovalStage = "confirm" | "working" | "candidate" | "branch-failed" | "blocked" | "error";

export function ConfirmSessionRemoval({ session, actions, mode, close, onRemoved }: {
  session: SessionSummary;
  actions: OpenFloorActions;
  mode: "delete" | "leave";
  close: () => void;
  onRemoved: (warning?: string) => void;
}) {
  const [stage, setStage] = useState<RemovalStage>("confirm");
  const [error, setError] = useState<string | null>(null);
  const [block, setBlock] = useState<DeleteBlock | null>(null);
  const submitted = useRef(false);

  const attempt = async (candidate?: "delete-branch" | "orphan") => {
    if (submitted.current) return;
    submitted.current = true;
    setStage("working"); setError(null); setBlock(null);
    try {
      if (mode === "leave") { await actions.delete(`/api/sessions/${session.id}/membership`); onRemoved(); return; }
      const result = await actions.delete(`/api/sessions/${session.id}`, candidate ? { candidate } : undefined);
      onRemoved(typeof result?.warning === "string" ? result.warning : undefined);
    } catch (reason) {
      submitted.current = false;
      if (mode === "delete") {
        const found = deleteBlock(reason);
        if (found) { setBlock(found); setStage(found.kind === "candidate_live" ? "candidate" : found.kind === "branch_delete_failed" ? "branch-failed" : "blocked"); return; }
      }
      setError(errorMessage(reason));
      setStage("error");
    }
  };

  useInput((input, key) => {
    if (stage === "working") return;
    if (key.escape) { close(); return; }
    if (stage === "confirm" && key.return) { void attempt(); return; }
    if (stage === "candidate" && block?.kind === "candidate_live") {
      const lower = input.toLowerCase();
      if (lower === "o") void attempt("orphan");
      else if (lower === "d" && block.canDeleteBranch) void attempt("delete-branch");
      return;
    }
    if (stage === "branch-failed" && block?.kind === "branch_delete_failed") {
      const lower = input.toLowerCase();
      if (lower === "o") void attempt("orphan");
      else if (lower === "r") void attempt("delete-branch");
    }
  });

  return <PageFrame title={mode === "delete" ? "Delete session" : "Leave session"} accent={ACCENT.danger}>
    {stage === "confirm" && <><Text bold>{session.title}</Text>{mode === "delete"
      ? <Text color="yellow">This permanently removes the session for every member: floor, queue, messages, and repository connection. It cannot be undone.</Text>
      : <Text color="yellow">You will lose access to this session's floor, queue, and messages.</Text>}
      <Text color={FOCUS}>{mode === "delete" ? "Enter deletes once" : "Enter leaves once"} · Esc cancels</Text></>}
    {stage === "working" && <Text color="yellow">{mode === "delete" ? "Deleting session…" : "Leaving session…"}</Text>}
    {stage === "candidate" && block?.kind === "candidate_live" && <>
      <Text>The candidate branch <Text bold>{block.branch}</Text> hasn't merged yet. Decide what happens to it before the session is deleted.</Text>
      <Text color={FOCUS}>o Leave branch, delete session{block.canDeleteBranch ? " · d Delete branch and session" : ""}</Text>
      <Text dimColor>Esc cancels</Text></>}
    {stage === "branch-failed" && block?.kind === "branch_delete_failed" && <>
      <Text color="red">Couldn't delete {block.branch} on GitHub. The session was not deleted.</Text>
      <Text color={FOCUS}>r Try again · o Leave branch, delete session</Text>
      <Text dimColor>Esc cancels</Text></>}
    {stage === "blocked" && block?.kind === "run_blocked" && <>
      <Text color="red">Run {shortId(block.runId)} is still integrating.</Text>
      <Text>Cancel it with /runs cancel {shortId(block.runId)}, then delete again.</Text>
      <Text dimColor>This was not cancelled or retried automatically. Esc returns.</Text></>}
    {stage === "error" && <>
      <Text color="red">{error}</Text>
      <Text>This was not retried because the mutation outcome may be unknown.</Text>
      <Text dimColor>Esc returns.</Text></>}
  </PageFrame>;
}
