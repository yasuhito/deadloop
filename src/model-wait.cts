/**
 * The execution-runtime boundary for retrying one model-availability wait.
 *
 * A retry reuses the attempt's own agent session: it verifies the recorded agent still answers
 * under its exact name, pane, and checkout, then submits one fixed continuation text through the
 * execution runtime. No replacement workspace, worktree, pane, or agent session is ever opened,
 * and nothing here invokes the Automation host's model.
 */

type JsonObject = Record<string, any>;

type ModelWaitTurnObservation =
  | { kind: "working" }
  | { kind: "terminal"; status: string; agent: JsonObject }
  | { kind: "owner_absent" }
  | { kind: "ambiguous" };

type ModelSessionRetryDependencies = {
  turnOf(record: JsonObject): ModelWaitTurnObservation;
  submitPrompt(agentName: string, text: string): void;
};

/** The only retry input an agent session ever receives; fixed so retries stay deterministic. */
const MODEL_WAIT_RETRY_PROMPT = [
  "Model availability may have recovered.",
  "Resume your assigned task from where it stopped, complete it,",
  "and write your completion report exactly as originally instructed.",
].join(" ");

function createModelSessionRetry(dependencies: ModelSessionRetryDependencies): (record: JsonObject) => boolean {
  return (record: JsonObject): boolean => {
    let turn: ModelWaitTurnObservation;
    try {
      turn = dependencies.turnOf(record);
    } catch {
      return false;
    }
    // The agent resumed on its own while waiting: there is nothing to retry and monitoring
    // continues against the same session. Anything other than a live terminal turn cannot be
    // reused, and the attempt must stop without opening replacement runtime resources.
    if (turn.kind === "working") return true;
    if (turn.kind !== "terminal") return false;
    try {
      dependencies.submitPrompt(record.agentName, MODEL_WAIT_RETRY_PROMPT);
      return true;
    } catch {
      return false;
    }
  };
}

module.exports = { MODEL_WAIT_RETRY_PROMPT, createModelSessionRetry };
