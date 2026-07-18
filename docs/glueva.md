# Glueva

Glueva connects one real interactive Claude Code session to one real
interactive Codex TUI. It does not create headless agents. Both sessions remain
human-visible and retain their normal history, tools, and keyboard input.
It is a local, per-developer pairing: each teammate runs their own Claude/Codex
pair on one machine; it is not a network relay between teammates.

The shared `glueva` executable owns transport, durable queues, deduplication,
and Codex App Server supervision. The paired Claude and Codex plugins contain
only their platform-specific hooks and operating instructions. An MCP server is
not part of the transport: Claude's lifecycle hooks and both launchers need a
local executable before an agent can call MCP tools.

## Install Glueva

Tagged releases contain checksummed binaries for macOS, glibc-based Linux, and
Windows on Arm64 and x64. The installer also configures and installs the paired
Claude Code and Codex marketplace plugins. Ensure both agent CLIs are installed,
then run:

```bash
curl -fsSL https://github.com/shadowofdoom/glueva/releases/latest/download/install.sh | bash
```

From an authenticated checkout of this repository, the equivalent command is:

```bash
./cli/install.sh
```

Use `--version 0.7.0` to pin the binary selected by a checkout-based install,
`--install-dir /absolute/path` to choose another PATH directory, or `--cli-only`
to skip both plugin installations. The default install adds `~/.local/bin` to
the current shell's startup file when needed; a custom install directory must
already be on `PATH`.

The downloaded executable includes its runtime. It does not require Bun, Node,
Python, or `jq`; the Claude hooks delegate JSON handling to that same binary.

To build from source instead:

```bash
bun run --cwd cli build
mkdir -p "$HOME/.local/bin"
install -m 0755 cli/dist/glueva "$HOME/.local/bin/glueva"
glueva help
```

## Update Glueva

Stop any running Glueva pair, then update the CLI and both plugins in place:

```bash
glueva update
```

Restart Claude Code and Codex after the update. If the installed version
predates this command, rerun the one-line installer once. On Windows, where a
running executable cannot replace itself, run the external installer instead:

```bash
curl -fsSL https://github.com/shadowofdoom/glueva/releases/latest/download/install.sh | bash
```

## Uninstall Glueva

Stop any running Glueva pair, then remove the CLI and paired user-scoped plugins
and marketplace declarations:

```bash
glueva uninstall
```

On Windows, or if the executable is damaged or unavailable, run:

```bash
curl -fsSL https://github.com/shadowofdoom/glueva/releases/latest/download/uninstall.sh | bash
```

From a checkout, run `./cli/uninstall.sh` instead. Pass the same
`--install-dir /absolute/path` used for a custom installation. Uninstalling
preserves shell PATH configuration and every project's `.glueva/` data. If an
agent CLI is unavailable, its plugin cleanup is skipped with a warning.
Project- and local-scoped Claude declarations are left intact.

## Manual plugin installation

The installer above owns normal plugin installation and updates. If plugin
setup must be repaired separately, run:

```bash
claude plugin marketplace add shadowofdoom/glueva
claude plugin install glueva@glueva --scope user

codex plugin marketplace add shadowofdoom/glueva
codex plugin add glueva@glueva-codex
```

Restart both CLIs after installing or upgrading their plugins.

## Pair sessions in any project

Start Codex first from the project you want both sessions to share:

```bash
cd /absolute/path/to/project
glueva codex --yolo
```

Then use a second terminal in the same project to start Claude:

```bash
cd /absolute/path/to/project
glueva claude --yolo
```

On each `glueva claude` launch, Claude sends Codex one bounded pairing check
after both sessions register. Codex replies once, Claude confirms the round
trip, and then asks what shared task the pair should work on.

From any terminal in that project, `glueva status` reports the health of the
registered Claude session, Codex session, ingress watcher, and unread count. The
`glueva status --json` form is intentionally scoped to the calling Claude
session for plugin safety; outside that session, `active: false` and
`watcherLive: false` do not describe the overall pair.

The launcher owns Claude's initial prompt so it can drain pending mail and arm
the ingress watcher before the session first goes idle. Put Glueva options
before any native Claude flags, and write native flags with values in long form
as one token (`--option=value`). For
multi-value options, repeat the flag once per value, such as
`--add-dir=/first --add-dir=/second`. Positional prompts, loose flag values,
other value-taking short flags, and non-interactive flags such as `--print` or
`--output-format` are rejected rather than risking a silently unarmed session.

Bare launch commands always start new sessions:

```bash
glueva codex
glueva claude
```

Open each native session picker with `--resume`, `--r`, or `-r`:

```bash
glueva codex --resume
glueva claude --resume
```

Resume each tool's most recent session with `--continue`, `--c`, or `-c`:

```bash
glueva codex --continue
glueva claude --continue
```

Add `--yolo` to any of these commands to skip permission checks.

The launchers are explicit ownership boundaries. A plain `claude` or `codex`
session never joins Glueva automatically. Only one live Claude launcher and
one live Codex launcher may own a project's pairing.

### Claude watcher constraint

Claude can be woken only when it launches `glueva wait` through Claude Code's
harness-tracked background tool (`Bash` with `run_in_background: true`). Do not
replace that step with shell backgrounding such as `glueva wait &`, `nohup`, or
a wrapper that backgrounds the process. Those processes can detect mail and
exit, but their exit cannot re-invoke the live Claude session.

The `watcherLive` status field proves only that a matching watcher lease belongs
to a live process. Neither the CLI nor the Stop hook can determine whether that
process is harness-tracked, so `watcherLive: true` alone does not prove wake
capability. The Glueva plugin's harness-tracked arming instruction is
therefore a load-bearing part of the Claude ingress contract.

## Runtime state

State defaults to `.glueva/` under the nearest Git root. The directory writes
its own `.gitignore`, so repositories do not need a root ignore rule and
envelope bodies cannot be committed accidentally. Runtime directories and
files are created owner-only because envelopes and launcher tokens are private
session data.

Both launch commands must resolve the same state directory. Sessions in the
same Git working tree do this automatically. To pair sessions launched from
different paths intentionally, export the same absolute override in both
terminals before starting them:

```bash
export GLUEVA_DIR="$HOME/.local/state/glueva/my-pair"
```

Stopping a launcher releases its ownership. Codex's launcher also restarts a
failed App Server and resumes the same saved thread.

After Claude registers, its launcher lease—not momentary Codex process
liveness—defines whether that session remains paired. The ingress watcher and
queued mail therefore survive Codex or App Server restarts of any duration;
ending the Claude launcher remains terminal.

## Trust boundary

A peer envelope is agent input, not human authorization. Each plugin requires
its agent to surface destructive, irreversible, production, financial, or
outward-facing requests to the human unless that action was independently
authorized in that session.

Use terminal status `done` unless a reply is genuinely required. Conversation
hops are capped, acknowledgements do not wake the peer, and terminal envelopes
must not be answered.
