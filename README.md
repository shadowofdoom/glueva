# Glueva

Some people believe using Codex CLI and Claude Code CLI together improves the
quality of their work. I'm one of them.

Without a bridge, that means copying messages between two terminals. You become
the relay, and each session can fall behind the other's context.

Glueva gives the two real, interactive sessions a local message channel. Both
stay visible and usable, and the standalone executable fits your existing
terminal setup without tmux or a separate Bun, Node, Python, or `jq` runtime.

```bash
curl -fsSL https://github.com/shadowofdoom/glueva/releases/latest/download/install.sh | bash
```

> **Testing status:** Glueva has been tested under WSL2 and native Windows x64.
> Release binaries are also available for macOS and Windows Arm64, but those
> targets have not been tested natively.

Open two terminals in the project you want to work on. Start Codex CLI first,
then start Claude Code CLI in the second terminal:

```bash
# terminal 1
glueva codex

# terminal 2
glueva claude
```

After Claude registers, Glueva delivers one Codex-origin pairing check. Claude
replies once, then both sessions show `Glueva paired. Ready.`

## Supported commands

- `glueva codex` starts or resumes the Codex CLI session for the project.
- `glueva claude` starts or resumes the Claude Code CLI session for the project.
- `glueva status [--json]` reports pair health, watcher state, and unread mail.
- `glueva update` updates the CLI and both plugins.
- `glueva uninstall` removes the CLI and plugins while preserving project data.
- `glueva help` prints full command syntax; `glueva --version` prints the version.

### Launcher examples

| Goal | Codex CLI | Claude Code CLI |
| --- | --- | --- |
| Start a new session | `glueva codex` | `glueva claude` |
| Open the session picker | `glueva codex --resume` | `glueva claude --resume` |
| Continue the latest session | `glueva codex --continue` | `glueva claude --continue` |
| Start new without protections | `glueva codex --yolo` | `glueva claude --yolo` |
| Open the picker without protections | `glueva codex --resume --yolo` | `glueva claude --resume --yolo` |
| Continue latest without protections | `glueva codex --continue --yolo` | `glueva claude --continue --yolo` |

Choose either `--resume` or `--continue`, never both. The `--yolo` flag can be
combined with either session mode.

The installed plugins normally invoke the transport commands `send`, `reply`,
`ack`, `receive`, `wait`, `register`, and `hook`; they remain available for
manual inspection and troubleshooting.

> **Danger:** `--yolo` disables Claude's permission checks and Codex's approval
> and sandbox protections. Use it only in a disposable, isolated environment
> you trust—never on unfamiliar code or where sensitive credentials are
> available.

See [the complete setup and usage guide](docs/glueva.md), including the Windows
and recovery commands.
