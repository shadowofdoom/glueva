import { createServer } from "node:net";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { drainCodexQueue, listLoadedThreads } from "./app-server";
import { GluevaStore } from "./store";

interface LaunchOptions {
  cwd: string;
  endpoint: string | null;
  mode: "new" | "resume" | "continue";
  yolo: boolean;
  noAltScreen: boolean;
}

interface ClaudeLaunchOptions {
  cwd: string;
  args: string[];
  mode: "new" | "resume" | "continue";
  yolo: boolean;
}

const CLAUDE_BOOTSTRAP_PROMPT =
  "Initialize Glueva for this live interactive session. Follow the Glueva SOP: " +
  "run `glueva status`. If Claude is inactive, report that clearly and do not send or arm. Otherwise, " +
  "run `glueva receive --json`, handle and close every pending envelope with `glueva reply` or `glueva ack`, then " +
  "if Codex is active, send exactly one startup pairing check with `--status continue --max-hop 1`, asking Codex to " +
  "reply once with `--status done`, briefly confirm pairing, and invite the user to give both agents a shared task. " +
  "Tell the user the check was sent, " +
  "but claim success only after that reply. If Codex is no longer active, report that and skip the check. " +
  "Launch `glueva wait` as a harness-tracked background task before going idle. When the terminal reply arrives, " +
  "close it, re-arm the watcher, tell the user pairing works, and ask what the pair should work on.";

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function hasSavedRollout(threadId: string): boolean {
  const sessionsRoot = resolve(process.env.CODEX_HOME ?? `${homedir()}/.codex`, "sessions");
  if (!existsSync(sessionsRoot)) return false;
  const pending = [sessionsRoot];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        pending.push(resolve(directory, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(threadId)) {
        return true;
      }
    }
  }
  return false;
}

async function availableLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        rejectPort(new Error("could not reserve a loopback port"));
        return;
      }
      const port = address.port;
      server.close((error) => error ? rejectPort(error) : resolvePort(port));
    });
  });
}

function healthUrl(endpoint: string): string {
  const url = new URL(endpoint);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/readyz";
  return url.toString();
}

async function waitForAppServer(endpoint: string, process_: Bun.Subprocess): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (process_.exitCode !== null) throw new Error(`Codex App Server exited with code ${process_.exitCode}`);
    try {
      const response = await fetch(healthUrl(endpoint));
      if (response.ok) return;
    } catch {
      // Startup connection failures are expected until the listener is ready.
    }
    await delay(50);
  }
  throw new Error("timed out waiting for Codex App Server readiness");
}

async function discoverThread(endpoint: string, expected: string | null): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const loaded = await listLoadedThreads(endpoint);
      if (expected && loaded.includes(expected)) return expected;
      if (!expected && loaded.length === 1) return loaded[0];
      if (!expected && loaded.length > 1) {
        throw new Error(`dedicated App Server loaded ${loaded.length} threads; refusing ambiguous registration`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("ambiguous registration")) throw error;
    }
    await delay(100);
  }
  throw new Error(expected
    ? `resumed Codex thread did not load: ${expected}`
    : "Codex TUI did not register a loaded thread");
}

async function stopProcess(process_: Bun.Subprocess): Promise<void> {
  if (process_.exitCode !== null) return;
  process_.kill("SIGTERM");
  await Promise.race([process_.exited, delay(2_000)]);
  if (process_.exitCode === null) process_.kill("SIGKILL");
}

async function reportMissingClaudeRegistration(
  store: GluevaStore,
  token: string,
  process_: Bun.Subprocess,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && process_.exitCode === null) {
    const peer = store.readClaudePeer();
    if (peer?.launcherToken === token && store.claudePeerIsLive(peer)) return;
    await delay(100);
  }
  if (process_.exitCode === null) {
    process.stderr.write(
      "glueva: Claude did not register within 10 seconds; verify that the Glueva plugin is installed and enabled\n",
    );
  }
}

async function superviseCodexQueue(
  store: GluevaStore,
  isRunning: () => boolean,
): Promise<void> {
  while (isRunning()) {
    try {
      await drainCodexQueue(store);
    } catch (error) {
      process.stderr.write(
        `glueva: Codex queue supervision failed; retrying: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    if (isRunning()) await delay(1_000);
  }
}

export function codexLaunchCommand(
  mode: "new" | "resume" | "continue",
  endpoint: string,
  cwd: string,
  threadId: string | null,
  yolo: boolean,
  noAltScreen: boolean,
): string[] {
  const launchArguments = [
    ...(yolo ? ["--dangerously-bypass-approvals-and-sandbox"] : []),
    ...(noAltScreen ? ["--no-alt-screen"] : []),
    "--remote",
    endpoint,
    "-C",
    cwd,
  ];
  if (threadId) return ["codex", "resume", ...launchArguments, threadId];
  if (mode === "resume") return ["codex", "resume", ...launchArguments];
  if (mode === "continue") return ["codex", "resume", "--last", ...launchArguments];
  return ["codex", ...launchArguments];
}

export async function launchClaude(store: GluevaStore, options: ClaudeLaunchOptions): Promise<number> {
  if (options.args.some((argument) =>
    argument === "-p" ||
    argument === "--print" ||
    argument === "--output-format" ||
    argument.startsWith("--output-format=")
  )) {
    throw new Error("glueva claude requires a real interactive session; print/output modes are unsupported");
  }
  if (options.args.includes("--")) {
    throw new Error("pass Claude flags only; glueva claude owns the initial prompt");
  }
  if (options.args.some((argument) => argument === "-" || !argument.startsWith("-"))) {
    throw new Error("pass Claude flags only and write values with long-form --option=value; glueva claude owns the initial prompt");
  }
  const cwd = realpathSync(resolve(options.cwd));
  const lease = await store.beginClaudeLaunch(cwd);
  let claude: Bun.Subprocess | null = null;
  try {
    const launchArguments = [
      ...(options.mode === "resume" ? ["--resume"] : options.mode === "continue" ? ["--continue"] : []),
      ...(options.yolo ? ["--dangerously-skip-permissions"] : []),
      ...options.args,
    ];
    claude = Bun.spawn(["claude", ...launchArguments, "--", CLAUDE_BOOTSTRAP_PROMPT], {
      cwd,
      env: {
        ...process.env,
        GLUEVA_DIR: store.root,
        GLUEVA_OWNER_PID: String(lease.pid),
        GLUEVA_LAUNCH_TOKEN: lease.token,
      },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const registrationCheck = reportMissingClaudeRegistration(store, lease.token, claude);
    const forwardSignal = (signal: NodeJS.Signals) => {
      if (claude?.exitCode === null) claude.kill(signal);
    };
    const onInterrupt = () => forwardSignal("SIGINT");
    const onTerminate = () => forwardSignal("SIGTERM");
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
    try {
      const code = await claude.exited;
      await registrationCheck;
      return code;
    } finally {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    }
  } finally {
    if (claude?.exitCode === null) await stopProcess(claude);
    store.endClaudeLaunch(lease.token);
  }
}

export async function launchCodex(store: GluevaStore, options: LaunchOptions): Promise<number> {
  const cwd = realpathSync(resolve(options.cwd));
  const endpoint = options.endpoint ?? `ws://127.0.0.1:${await availableLoopbackPort()}`;
  if (!endpoint.startsWith("ws://127.0.0.1:") && !endpoint.startsWith("ws://localhost:")) {
    throw new Error("glueva codex requires a loopback ws:// endpoint");
  }

  if (store.codexPeerIsLive()) throw new Error("a registered Codex TUI and App Server are already live");
  let threadId: string | null = null;

  while (true) {
    const appServer = Bun.spawn(["codex", "app-server", "--listen", endpoint], {
      cwd,
      env: { ...process.env, GLUEVA_DIR: store.root },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      await waitForAppServer(endpoint, appServer);
    } catch (error) {
      await stopProcess(appServer);
      throw error;
    }

    if (threadId && !hasSavedRollout(threadId)) threadId = null;
    const command = codexLaunchCommand(
      options.mode,
      endpoint,
      cwd,
      threadId,
      options.yolo,
      options.noAltScreen,
    );

    const tui = Bun.spawn(command, {
      cwd,
      env: { ...process.env, GLUEVA_DIR: store.root },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });

    try {
      threadId = await discoverThread(endpoint, threadId);
      store.registerCodex({
        threadId,
        endpoint,
        cwd,
        tuiPid: tui.pid,
        appServerPid: appServer.pid,
      });
    } catch (error) {
      await stopProcess(tui);
      await stopProcess(appServer);
      throw error;
    }

    const queueSupervisor = superviseCodexQueue(
      store,
      () => tui.exitCode === null && appServer.exitCode === null,
    );
    const firstExit = await Promise.race([
      tui.exited.then((code) => ({ process: "tui" as const, code })),
      appServer.exited.then((code) => ({ process: "app-server" as const, code })),
    ]);
    if (firstExit.process === "tui") {
      await stopProcess(appServer);
      await queueSupervisor;
      return firstExit.code;
    }

    process.stderr.write(
      `glueva: App Server exited with code ${firstExit.code}; resuming Codex thread ${threadId}\n`,
    );
    await stopProcess(tui);
    await queueSupervisor;
  }
}
