import { CLI_PROTOCOL_VERSION, BridgeStore } from "./store";

export type ClaudeHookEvent = "session-start" | "stop";

interface HookInput {
  session_id?: unknown;
  cwd?: unknown;
  stop_hook_active?: unknown;
}

type HookOutput = Record<string, unknown> | null;

function parseInput(text: string): HookInput {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid Claude hook JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Claude hook input must be a JSON object");
  }
  return value as HookInput;
}

function sessionStartContext(message: string): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: message,
    },
  };
}

function incompatible(event: ClaudeHookEvent, detail: string): Record<string, unknown> {
  const message = `glueva: ${detail}. The ingress watcher cannot be verified, so peer messages may not wake this session. Reinstall the CLI or the plugin so their protocol versions match.`;
  return event === "session-start" ? sessionStartContext(message) : { systemMessage: message };
}

function activeSessionContext(unread: number, watcherLive: boolean): Record<string, unknown> | null {
  if (unread === 0 && watcherLive) return null;
  let context = "Glueva is active for this session.";
  if (unread > 0) {
    context += ` ${unread} unprocessed envelope(s) arrived while you were not running: drain them with \`glueva receive --json\`, then close each out with \`glueva reply\` or \`glueva ack\`.`;
  }
  if (!watcherLive) {
    context += " No ingress watcher is armed: launch `glueva wait` as a harness-tracked background Bash call before going idle, or peer messages will never wake you.";
  }
  return sessionStartContext(context);
}

function stopBlock(reason: string, additionalContext: string): Record<string, unknown> {
  return {
    decision: "block",
    reason,
    hookSpecificOutput: {
      hookEventName: "Stop",
      additionalContext,
    },
  };
}

export function runClaudeHook(
  event: ClaudeHookEvent,
  inputText: string,
  pluginProtocol: number,
  store: BridgeStore,
  environment: NodeJS.ProcessEnv = process.env,
): HookOutput {
  if (pluginProtocol !== CLI_PROTOCOL_VERSION) {
    return incompatible(event, `Glueva speaks protocol ${CLI_PROTOCOL_VERSION}, this plugin requires ${pluginProtocol}`);
  }

  const input = parseInput(inputText);
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  const cwd = typeof input.cwd === "string" ? input.cwd : "";

  if (event === "session-start") {
    const ownerPid = environment.GLUEVA_OWNER_PID;
    const launcherToken = environment.GLUEVA_LAUNCH_TOKEN;
    if (ownerPid || launcherToken) {
      try {
        if (!ownerPid || !/^[1-9][0-9]*$/.test(ownerPid) || !launcherToken || !sessionId || !cwd) {
          throw new Error("explicit launcher environment or hook identity is incomplete");
        }
        store.registerClaude(sessionId, cwd, Number(ownerPid), launcherToken);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return sessionStartContext(
          `glueva: registration FAILED (${detail}). This session was started by \`glueva claude launch\` but is NOT bridged — Codex cannot reach you and its messages will not wake you. Do not assume the bridge is live.`,
        );
      }
    }
  } else if (input.stop_hook_active === true) {
    return null;
  }

  let status;
  try {
    status = store.status(sessionId || null);
  } catch (error) {
    return incompatible(event, `state is unreadable (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!status.bridgeActive) return null;

  if (event === "session-start") {
    return activeSessionContext(status.unread, status.watcherLive);
  }
  if (status.unread > 0) {
    return stopBlock(
      `glueva: ${status.unread} unprocessed envelope(s) must be handled before this session can stop.`,
      "Run `glueva receive --json` now. Handle every envelope and close each with `glueva reply` or `glueva ack`. Then launch `glueva wait` as a harness-tracked background Bash call (run_in_background) before stopping.",
    );
  }
  if (!status.watcherLive) {
    return stopBlock(
      "glueva: no ingress watcher is armed, so peer mail could arrive without waking this session.",
      "Launch `glueva wait` now as a harness-tracked background Bash call (run_in_background), verify that the background task is running, then stop. Do not background it from a shell wrapper; only a harness-tracked task can re-invoke this session.",
    );
  }
  return null;
}
