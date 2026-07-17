#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { drainCodexQueue } from "./app-server";
import { type ClaudeHookEvent, runClaudeHook } from "./claude-hooks";
import { launchClaude, launchCodex } from "./launcher";
import { MAX_HOP_LIMIT, type EnvelopeStatus, type Peer, isUuidV7 } from "./protocol";
import { BridgeStore, type DeliveryState, resolveBridgeDir } from "./store";
import packageMetadata from "../package.json";

const CLI_VERSION = packageMetadata.version;

interface ParsedArguments {
  positionals: string[];
  options: Map<string, string | true>;
  passthrough: string[];
}

function parseArguments(argv: string[]): ParsedArguments {
  const positionals: string[] = [];
  const options = new Map<string, string | true>();
  const passthrough: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      passthrough.push(...argv.slice(index + 1));
      break;
    }
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if (!name) throw new Error("invalid empty option");
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      options.set(name, next);
      index += 1;
    } else {
      options.set(name, true);
    }
  }
  return { positionals, options, passthrough };
}

function option(arguments_: ParsedArguments, name: string, required = false): string | null {
  const value = arguments_.options.get(name);
  if (value === true) throw new Error(`--${name} requires a value`);
  if (typeof value === "string") return value;
  if (required) throw new Error(`missing required option --${name}`);
  return null;
}

function integerOption(arguments_: ParsedArguments, name: string, required = false): number | null {
  const value = option(arguments_, name, required);
  if (value === null) return null;
  if (!/^[0-9]+$/.test(value)) throw new Error(`--${name} must be a non-negative integer`);
  return Number(value);
}

function statusOption(arguments_: ParsedArguments, fallback: EnvelopeStatus): EnvelopeStatus {
  const status = option(arguments_, "status") ?? fallback;
  if (status !== "continue" && status !== "done") throw new Error("--status must be continue or done");
  return status;
}

function peerOption(arguments_: ParsedArguments, name: string): Peer {
  const peer = option(arguments_, name, true);
  if (peer !== "claude" && peer !== "codex") throw new Error(`--${name} must be claude or codex`);
  return peer;
}

function bodyFromFile(arguments_: ParsedArguments): string {
  const path = resolve(option(arguments_, "body-file", true)!);
  const body = readFileSync(path, "utf8");
  if (body.length === 0) throw new Error("body file must not be empty");
  return body;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function send(store: BridgeStore, arguments_: ParsedArguments): Promise<void> {
  const to = peerOption(arguments_, "to");
  const status = statusOption(arguments_, "continue");
  const maxHop = integerOption(arguments_, "max-hop") ?? MAX_HOP_LIMIT;
  if (maxHop < 0 || maxHop > MAX_HOP_LIMIT) throw new Error("--max-hop must be from 0 through 6");
  const envelope = await store.createRootEnvelope(to, bodyFromFile(arguments_), status, maxHop);
  if (to === "codex") await drainCodexQueue(store);
  const receipt = store.readReceipt(to, envelope.id);
  writeJson({
    id: envelope.id,
    state: (receipt?.state ?? "queued") as DeliveryState | "queued",
  });
}

async function reply(store: BridgeStore, arguments_: ParsedArguments): Promise<void> {
  const parentId = option(arguments_, "to", true)!;
  if (!isUuidV7(parentId)) throw new Error("--to must be a lowercase UUIDv7 envelope id");
  const envelope = await store.reply(parentId, bodyFromFile(arguments_), statusOption(arguments_, "done"));
  if (envelope.to === "codex") await drainCodexQueue(store);
}

async function register(store: BridgeStore, arguments_: ParsedArguments): Promise<void> {
  const peer = peerOption(arguments_, "peer");
  if (peer === "claude") {
    const launcherToken = option(arguments_, "launcher-token", true)!;
    if (!isUuidV7(launcherToken)) throw new Error("--launcher-token must be a lowercase UUIDv7");
    const record = store.registerClaude(
      option(arguments_, "session-id", true)!,
      option(arguments_, "cwd") ?? process.cwd(),
      integerOption(arguments_, "owner-pid", true)!,
      launcherToken,
    );
    writeJson(record);
    return;
  }

  const threadId = option(arguments_, "thread-id") ?? process.env.CODEX_THREAD_ID ?? null;
  if (!threadId) throw new Error("missing required option --thread-id (and CODEX_THREAD_ID is unset)");
  const record = store.registerCodex({
    threadId,
    endpoint: option(arguments_, "endpoint", true)!,
    cwd: option(arguments_, "cwd") ?? process.cwd(),
    tuiPid: integerOption(arguments_, "tui-pid", true)!,
    appServerPid: integerOption(arguments_, "app-server-pid", true)!,
  });
  writeJson(record);
  await drainCodexQueue(store);
}

function help(): void {
  process.stdout.write(`Glueva ${CLI_VERSION} (protocol 1)\n\n` +
    `Commands:\n` +
    `  glueva status --json\n` +
    `  glueva wait\n` +
    `  glueva receive --json\n` +
    `  glueva send --to claude|codex --body-file PATH [--status continue|done] [--max-hop 0..6] --json\n` +
    `  glueva reply --to ENVELOPE_ID --body-file PATH [--status continue|done]\n` +
    `  glueva ack --id ENVELOPE_ID\n` +
    `  glueva register --peer claude --session-id ID --owner-pid PID --launcher-token TOKEN [--cwd PATH] --json\n` +
    `  glueva register --peer codex --thread-id ID --endpoint WS_URL --tui-pid PID --app-server-pid PID [--cwd PATH] --json\n` +
    `  glueva claude launch [--cwd PATH] -- [CLAUDE_ARGS...]\n` +
    `  glueva codex launch [--resume THREAD_ID] [--cwd PATH] [--endpoint LOOPBACK_WS_URL] [--yolo] [--no-alt-screen]\n\n` +
    `Plugin integration:\n` +
    `  glueva hook session-start|stop --plugin-protocol VERSION\n`);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const parsed = parseArguments(argv);
    const command = parsed.positionals[0];
    if (parsed.options.has("version")) {
      process.stdout.write(`${CLI_VERSION}\n`);
      return 0;
    }
    const isLaunch = (command === "claude" || command === "codex") && parsed.positionals[1] === "launch";
    const launchCwd = isLaunch ? option(parsed, "cwd") ?? process.cwd() : process.cwd();
    const store = new BridgeStore(isLaunch ? resolveBridgeDir(launchCwd) : undefined);
    switch (command) {
      case "status":
        writeJson(store.status());
        return 0;
      case "wait":
        process.stdout.write(`${await store.waitForClaude()}\n`);
        return 0;
      case "receive":
        writeJson({ envelopes: await store.receiveClaude() });
        return 0;
      case "reply":
        await reply(store, parsed);
        return 0;
      case "ack": {
        const id = option(parsed, "id", true)!;
        if (!isUuidV7(id)) throw new Error("--id must be a lowercase UUIDv7 envelope id");
        await store.ack(id);
        return 0;
      }
      case "send":
        await send(store, parsed);
        return 0;
      case "register":
        await register(store, parsed);
        return 0;
      case "hook": {
        const event = parsed.positionals[1] as ClaudeHookEvent | undefined;
        if (event !== "session-start" && event !== "stop") {
          throw new Error("expected: glueva hook session-start|stop");
        }
        const pluginProtocol = integerOption(parsed, "plugin-protocol", true)!;
        const output = runClaudeHook(event, readFileSync(0, "utf8"), pluginProtocol, store);
        if (output) writeJson(output);
        return 0;
      }
      case "claude":
        if (parsed.positionals[1] !== "launch") throw new Error("expected: glueva claude launch");
        if (parsed.positionals.length > 2) throw new Error("pass Claude arguments after --");
        return await launchClaude(store, {
          cwd: launchCwd,
          args: parsed.passthrough,
        });
      case "codex": {
        if (parsed.positionals[1] !== "launch") throw new Error("expected: glueva codex launch");
        const resumeThreadId = option(parsed, "resume");
        if (resumeThreadId && !isUuidV7(resumeThreadId)) {
          throw new Error("--resume must be a lowercase UUIDv7 thread id");
        }
        return await launchCodex(store, {
          cwd: launchCwd,
          endpoint: option(parsed, "endpoint"),
          resumeThreadId,
          yolo: parsed.options.has("yolo"),
          noAltScreen: parsed.options.has("no-alt-screen"),
        });
      }
      case "help":
      case "--help":
      case undefined:
        help();
        return 0;
      default:
        throw new Error(`unknown command: ${command}`);
    }
  } catch (error) {
    process.stderr.write(`glueva: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) process.exit(await main());
