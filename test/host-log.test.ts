import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const { hostLogFile, appendHostLogEvent, readHostLogTail } = require("../src/host-log.cts");

const now = new Date(Date.parse("2026-02-14T10:00:00.000Z"));

const sandboxes: string[] = [];

function sandbox(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-hostlog-"));
  sandboxes.push(root);
  mkdirSync(root, { recursive: true });
  return root;
}

afterEach(() => {
  for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("host activity log", () => {
  it("appends one machine-readable JSON object per line with a fixed core shape", () => {
    const root = sandbox();
    expect(
      appendHostLogEvent(
        root,
        {
          kind: "automation_result",
          projectId: "demo",
          automationId: "demo:ticker",
          result: "queued",
          reason: "driver ran",
          driverAction: "done",
        },
        now,
      ),
    ).toBe(true);

    const line = readFileSync(hostLogFile(root), "utf8").trimEnd().split("\n").at(-1)!;
    expect(JSON.parse(line)).toEqual({
      schemaVersion: 1,
      at: "2026-02-14T10:00:00.000Z",
      kind: "automation_result",
      projectId: "demo",
      automationId: "demo:ticker",
      result: "queued",
      reason: "driver ran",
      driverAction: "done",
    });
  });

  it("keeps every line's core fields present even when the source omits them", () => {
    const root = sandbox();
    appendHostLogEvent(root, { kind: "tick_started" }, now);
    const parsed = readHostLogTail(root, 1)[0];
    expect(parsed).toEqual({
      schemaVersion: 1,
      at: "2026-02-14T10:00:00.000Z",
      kind: "tick_started",
      projectId: "",
      automationId: "",
      result: "",
      reason: "",
    });
  });

  it("reads back only the most recent N events in chronological order", () => {
    const root = sandbox();
    for (let index = 1; index <= 5; index += 1) {
      appendHostLogEvent(root, { kind: "attempt_launched", result: String(index) }, now);
    }
    expect(readHostLogTail(root, 2).map((event) => event.result)).toEqual(["4", "5"]);
  });

  it("skips damaged lines instead of failing the tail read", () => {
    const root = sandbox();
    appendHostLogEvent(root, { kind: "tick_idle" }, now);
    rmSync(hostLogFile(root));
    writeFileSync(hostLogFile(root), '{broken\n{"kind":"enablement_written"}\n');
    expect(readHostLogTail(root).map((event) => event.kind)).toEqual(["enablement_written"]);
  });

  it("returns no events while nothing was logged yet", () => {
    expect(readHostLogTail(sandbox())).toEqual([]);
  });

  it("reports failure without throwing when the log path cannot be written", () => {
    const root = sandbox();
    // The log path itself is occupied by a directory: appending can only fail.
    mkdirSync(hostLogFile(root));
    expect(appendHostLogEvent(root, { kind: "tick_started" }, now)).toBe(false);
  });

  it("records the failure beside the log so degradation stays visible", () => {
    const root = sandbox();
    mkdirSync(hostLogFile(root));
    appendHostLogEvent(root, { kind: "tick_started" }, now);
    const errorLine = JSON.parse(readFileSync(path.join(root, "host-log-errors.jsonl"), "utf8").trimEnd());
    expect(errorLine).toMatchObject({ at: "2026-02-14T10:00:00.000Z", error: expect.stringContaining("illegal") });
  });
});
