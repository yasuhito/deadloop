type JsonObject = Record<string, any>;

class StaleLaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleLaunchError";
  }
}

function labelNames(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((label) => typeof label === "string" ? label : String(label?.name || "")).filter(Boolean).sort()
    : [];
}

function assertSameLaunchTarget(selected: JsonObject, live: JsonObject | undefined, kind: "issue" | "pr"): void {
  const number = Number(selected.number || 0);
  if (!live || Number(live.number || 0) !== number) throw new StaleLaunchError(`${kind} #${number} is no longer selected`);
  const fields = kind === "issue"
    ? ["title", "body", "url"]
    : ["state", "headRefName", "headRefOid", "isCrossRepository", "isDraft", "mergeStateStatus"];
  for (const field of fields) {
    if (String(live[field] ?? "") !== String(selected[field] ?? "")) {
      throw new StaleLaunchError(`${kind} #${number} ${field} changed before launch`);
    }
  }
  if (JSON.stringify(labelNames(live.labels)) !== JSON.stringify(labelNames(selected.labels))) {
    throw new StaleLaunchError(`${kind} #${number} labels changed before launch`);
  }
}

function isStaleLaunchError(error: unknown): boolean {
  return error instanceof StaleLaunchError || (error instanceof Error && error.name === "StaleLaunchError");
}

module.exports = { StaleLaunchError, assertSameLaunchTarget, isStaleLaunchError, labelNames };
