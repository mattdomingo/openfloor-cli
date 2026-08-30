import { describe, expect, it } from "vitest";
import { OpenFloorError } from "../src/errors.js";
import { deleteBlock } from "../src/tui-sessions.js";

describe("deleteBlock", () => {
  it("reads an unmerged candidate branch block", () => {
    const error = new OpenFloorError("Request refused", "conflict", 409, { code: "candidate_live", branch: "openfloor/session/candidate", canDeleteBranch: true });
    expect(deleteBlock(error)).toEqual({ kind: "candidate_live", branch: "openfloor/session/candidate", canDeleteBranch: true });
  });

  it("defaults canDeleteBranch to false when the server omits it", () => {
    const error = new OpenFloorError("Request refused", "conflict", 409, { code: "candidate_live", branch: "openfloor/session/candidate" });
    expect(deleteBlock(error)).toEqual({ kind: "candidate_live", branch: "openfloor/session/candidate", canDeleteBranch: false });
  });

  it("reads a failed branch delete", () => {
    const error = new OpenFloorError("Request refused", "conflict", 409, { code: "branch_delete_failed", branch: "openfloor/session/candidate" });
    expect(deleteBlock(error)).toEqual({ kind: "branch_delete_failed", branch: "openfloor/session/candidate" });
  });

  it("reads a run still integrating", () => {
    const error = new OpenFloorError("The candidate is still being updated", "conflict", 409, { runId: "run-123" });
    expect(deleteBlock(error)).toEqual({ kind: "run_blocked", runId: "run-123" });
  });

  it("returns null for an unrelated error", () => {
    expect(deleteBlock(new OpenFloorError("Only the owner can delete this session", "conflict", 403))).toBeNull();
    expect(deleteBlock(new OpenFloorError("Not found", "not_found", 404))).toBeNull();
    expect(deleteBlock(new Error("network down"))).toBeNull();
    expect(deleteBlock(null)).toBeNull();
  });
});
