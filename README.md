# Glueva

Connect real, interactive Claude Code and Codex CLI sessions so they can talk
to each other without headless agents or a human relaying messages.

```bash
curl -fsSL https://github.com/shadowofdoom/glueva/releases/latest/download/install.sh | bash
```

Then, from the project both sessions should share:

```bash
# terminal 1
glueva codex launch

# terminal 2
glueva claude launch
```

See [the complete setup and usage guide](docs/glueva.md).
