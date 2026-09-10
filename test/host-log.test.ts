import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const { hostLogFile, appendHostLogEvent, readHostLogTail, TAIL_WINDOW_BYTES } = require("../src/host-log.cts");

const now = new Date(Date.parse("2026-02-14T10:00:00.000Z"));

const sandboxes: string[] = [];

function sandbox(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-hostlog-"));
  sandboxes.push(root);
  mkdirSync(root, { recursive: true });
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("host activity log", () => {
  it("appends one machine-readable JSON object per line with a fixed core shape", () => {
    const root = sandbox();
    const appended = appendHostLogEvent(
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
    );

    const line = readFileSync(hostLogFile(root), "utf8").trimEnd().split("\n").at(-1)!;
    expect({ appended, event: JSON.parse(line) }).toEqual({
      appended: true,
      event: {
        schemaVersion: 1,
        at: "2026-02-14T10:00:00.000Z",
        kind: "automation_result",
        projectId: "demo",
        automationId: "demo:ticker",
        result: "queued",
        reason: "driver ran",
        driverAction: "done",
      },
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

describe("bounded suffix read", () => {
  const hugeCount = Number.MAX_SAFE_INTEGER;

  function writeNumberedLines(root: string, targetBytes: number): number {
    const lineFor = (n: number) => `{"kind":"tick_idle","result":"${String(n).padStart(10, "0")}"}\n`;
    const lineCount = Math.ceil(targetBytes / Buffer.byteLength(lineFor(1)));
    writeFileSync(hostLogFile(root), Array.from({ length: lineCount }, (_, index) => lineFor(index + 1)).join(""));
    return Buffer.byteLength(lineFor(1));
  }

  it("bounds the bytes read from a large log to the tail window", () => {
    const root = sandbox();
    const line = `{"kind":"tick_idle","result":"${"x".repeat(64)}"}\n`;
    writeFileSync(hostLogFile(root), line.repeat(Math.ceil((TAIL_WINDOW_BYTES + 4096) / Buffer.byteLength(line))));

    // Regression tripwire: every byte read from the log during one tail read, whether through the
    // old whole-file readFileSync or the new positional readSync, must stay inside the window.
    // readSync sums are process-wide, so overcounting can only fail the test, never pass it.
    const readSpy = vi.spyOn(fs, "readFileSync");
    const readSyncSpy = vi.spyOn(fs, "readSync");
    const logPath = hostLogFile(root);
    readHostLogTail(root, hugeCount);
    const bytesFromFileRead = readSpy.mock.results.reduce(
      (sum, result, index) =>
        result.type === "return" && readSpy.mock.calls[index][0] === logPath
          ? sum + (result.value as Buffer).byteLength
          : sum,
      0,
    );
    const bytesFromPositionalRead = readSyncSpy.mock.results.reduce(
      (sum, result) => (result.type === "return" ? sum + (result.value as number) : sum),
      0,
    );
    expect(bytesFromFileRead + bytesFromPositionalRead).toBeLessThanOrEqual(TAIL_WINDOW_BYTES);
  });

  it("discards the partial first line when the window starts mid-file", () => {
    const root = sandbox();
    const lineBytes = writeNumberedLines(root, TAIL_WINDOW_BYTES + 4096);
    const size = statSync(hostLogFile(root)).size;
    const start = size - TAIL_WINDOW_BYTES;
    const straddlingIndex = Math.floor(start / lineBytes);
    const firstCompleteIndex = start % lineBytes === 0 ? straddlingIndex : straddlingIndex + 1;

    expect(readHostLogTail(root, hugeCount)[0]?.result).toBe(String(firstCompleteIndex + 1).padStart(10, "0"));
  });

  it("ignores an incomplete final line instead of parsing it", () => {
    const root = sandbox();
    writeFileSync(hostLogFile(root), '{"kind":"tick_started"}\n{"kind":"enablement_written');

    expect(readHostLogTail(root, hugeCount).map((event) => event.kind)).toEqual(["tick_started"]);
  });

  it("survives one-byte short reads without looping forever", () => {
    const root = sandbox();
    appendHostLogEvent(root, { kind: "tick_started" }, now);
    appendHostLogEvent(root, { kind: "enablement_written" }, now);
    const originalReadSync = fs.readSync.bind(fs) as typeof fs.readSync;
    vi.spyOn(fs, "readSync").mockImplementation(((fd: number, buffer: Buffer, offset: number, _length: number, position: number | null) =>
      originalReadSync(fd, buffer, offset, 1, position)) as unknown as typeof fs.readSync);

    expect(readHostLogTail(root).map((event) => event.kind)).toEqual(["tick_started", "enablement_written"]);
  });

  it("treats appends after the size snapshot as outside the tail read", () => {
    const root = sandbox();
    appendHostLogEvent(root, { kind: "tick_started" }, now);
    const logPath = hostLogFile(root);
    const snapshotSize = statSync(logPath).size;
    const firstLine = readFileSync(logPath, "utf8");
    vi.spyOn(fs, "fstatSync").mockReturnValue({ size: snapshotSize } as unknown as ReturnType<typeof fs.fstatSync>);
    writeFileSync(logPath, `${firstLine}{"kind":"enablement_written"}\n`);

    expect(readHostLogTail(root, hugeCount).map((event) => event.kind)).toEqual(["tick_started"]);
  });

  it("closes the log descriptor after a successful tail read", () => {
    const root = sandbox();
    appendHostLogEvent(root, { kind: "tick_started" }, now);
    const openSpy = vi.spyOn(fs, "openSync");
    const closeSpy = vi.spyOn(fs, "closeSync");
    readHostLogTail(root);

    expect(closeSpy).toHaveBeenCalledWith(openSpy.mock.results[0].value);
  });

  it("closes the log descriptor even when the size snapshot fails", () => {
    const root = sandbox();
    appendHostLogEvent(root, { kind: "tick_started" }, now);
    const openSpy = vi.spyOn(fs, "openSync");
    vi.spyOn(fs, "fstatSync").mockImplementation(() => {
      throw new Error("log vanished");
    });
    const closeSpy = vi.spyOn(fs, "closeSync");
    readHostLogTail(root);

    expect(closeSpy).toHaveBeenCalledWith(openSpy.mock.results[0].value);
  });

  it("closes the log descriptor when a positional read fails", () => {
    const root = sandbox();
    appendHostLogEvent(root, { kind: "tick_started" }, now);
    const openSpy = vi.spyOn(fs, "openSync");
    vi.spyOn(fs, "readSync").mockImplementation(() => {
      throw new Error("read failed");
    });
    const closeSpy = vi.spyOn(fs, "closeSync");
    readHostLogTail(root);

    expect(closeSpy).toHaveBeenCalledWith(openSpy.mock.results[0].value);
  });

  it("returns no events when the log cannot be inspected", () => {
    const root = sandbox();
    appendHostLogEvent(root, { kind: "tick_started" }, now);
    vi.spyOn(fs, "fstatSync").mockImplementation(() => {
      throw new Error("log vanished");
    });

    expect(readHostLogTail(root, hugeCount)).toEqual([]);
  });
});
