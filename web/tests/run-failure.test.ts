import { describe, expect, it } from "vitest";
import { buildChat } from "@/lib/chat";
import { runEndView } from "@/lib/run-failure";

describe("runEndView", () => {
  it("shows the engine's plain message and hint, with the setup first for a wrong column", () => {
    const v = runEndView({
      status: "failed",
      error: 'The column "qualty" isn’t in this file.',
      errorCode: "target_missing",
      hint: 'Did you mean "quality"?',
      source: "url",
    });
    expect(v).toMatchObject({
      label: "The run failed",
      title: "That column isn’t in the file",
      text: 'The column "qualty" isn’t in this file.',
      hint: 'Did you mean "quality"?',
      retry: true,
      edit: true,
      primary: "edit",
      note: null,
    });
  });

  it("makes Retry the main action for failures a retry can fix", () => {
    for (const code of ["download_failed", "llm_unavailable", "out_of_memory", "out_of_time", "unexpected"])
      expect(runEndView({ status: "failed", error: "x", errorCode: code, hint: "h", source: "url" }).primary).toBe("retry");
    for (const code of ["not_csv", "target_empty", "too_few_rows"])
      expect(runEndView({ status: "failed", error: "x", errorCode: code, hint: "h", source: "url" }).primary).toBe("edit");
  });

  it("rewords a bare exit code from an older backend and treats unknown codes as unexpected", () => {
    const v = runEndView({ status: "failed", error: "The engine exited with code 2.", source: "url" });
    expect(v.text).not.toMatch(/exit/);
    expect(v.hint).toBeTruthy();
    expect(runEndView({ status: "failed", error: "boom", errorCode: "made_up" }).title).toBe("Something went wrong");
  });

  it("can't retry an uploaded file (it isn't kept) and says so", () => {
    const v = runEndView({ status: "failed", error: "x", errorCode: "unexpected", source: "file" });
    expect(v.retry).toBe(false);
    expect(v.edit).toBe(false);
    expect(v.note).toMatch(/attach the file again/);
  });

  it("keeps the cancelled and timed-out wording", () => {
    expect(runEndView({ status: "cancelled", error: "Cancelled by user.", source: "url" }).text).toBe("The run was cancelled before the locked test.");
    expect(runEndView({ status: "timed_out", error: null, source: "url" })).toMatchObject({ label: "Timed out", retry: true });
  });
});

describe("buildChat run_end", () => {
  it("carries the failure code and hint from the run meta", () => {
    const items = buildChat(
      [{ id: "r1", events: [], status: "failed", error: "The column isn’t in this file.", errorCode: "target_missing", hint: "Pick quality." }],
      [],
    );
    expect(items.at(-1)).toMatchObject({ kind: "run_end", status: "failed", errorCode: "target_missing", hint: "Pick quality." });
  });
});
