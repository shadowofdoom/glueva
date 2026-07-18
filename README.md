# Glueva

Connect real, interactive Claude Code and Codex CLI sessions so they can talk
to each other without headless agents or a human relaying messages.

```bash
curl -fsSL https://github.com/shadowofdoom/glueva/releases/latest/download/install.sh | bash
```

Then, from the project both sessions should share:

```bash
# terminal 1
glueva codex

# terminal 2
glueva claude
```

After Claude registers, Glueva delivers one Codex-origin pairing check. Claude
replies once, then both sessions show `Glueva paired. Ready.`

Add `--resume` to open either session picker, or `--continue` to resume its
most recent session.

> **Danger:** `--yolo` disables Claude's permission checks and Codex's approval
> and sandbox protections. Use it only in a disposable, isolated environment
> you trust—never on unfamiliar code or where sensitive credentials are
> available.

Update or uninstall later on macOS and Linux:

```bash
glueva update
glueva uninstall
```

See [the complete setup and usage guide](docs/glueva.md), including the Windows
and recovery commands.
