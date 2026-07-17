import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const roots: string[] = [];

function executable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

async function fixture(): Promise<{
  root: string;
  home: string;
  bin: string;
  release: string;
  install: string;
  log: string;
}> {
  const root = mkdtempSync(join(tmpdir(), "glueva-installer-"));
  roots.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  const release = join(root, "release");
  const payload = join(root, "payload");
  const install = join(home, ".local", "bin");
  const log = join(root, "commands.log");
  mkdirSync(home);
  mkdirSync(bin);
  mkdirSync(release);
  mkdirSync(payload);

  executable(join(payload, "glueva"), `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then printf '0.1.0\\n'; exit 0; fi
printf 'fixture glueva\\n'
`);
  const archive = join(release, "glueva-0.1.0-linux-x64.tar.gz");
  const packed = Bun.spawnSync(["tar", "-C", payload, "-czf", archive, "glueva"]);
  expect(packed.exitCode).toBe(0);
  const digest = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(archive).arrayBuffer())
    .digest("hex");
  writeFileSync(join(release, "checksums.txt"), `${digest}  ${basename(archive)}\n`);

  executable(join(bin, "uname"), `#!/bin/sh
case "\${1:-}" in
  -s) printf 'Linux\\n' ;;
  -m) printf 'x86_64\\n' ;;
  *) exit 2 ;;
esac
`);
  executable(join(bin, "gh"), `#!/bin/sh
set -eu
if [ "\${1:-}" = auth ] && [ "\${2:-}" = status ]; then
  [ "\${GLUEVA_TEST_GH_AUTH:-1}" = 1 ]
  exit
fi
if [ "\${1:-}" = release ] && [ "\${2:-}" = list ]; then
  printf 'v0.1.0\\n'
  exit 0
fi
if [ "\${1:-}" = release ] && [ "\${2:-}" = download ]; then
  shift 2
  destination=''
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --dir ]; then destination="$2"; shift 2; else shift; fi
  done
  cp "\${GLUEVA_TEST_RELEASE_DIR}"/* "\${destination}/"
  exit 0
fi
exit 2
`);
  executable(join(bin, "curl"), `#!/bin/sh
set -eu
url=''
for argument do url="$argument"; done
case "\${url}" in
  */releases/latest) printf 'https://github.com/shadowofdoom/glueva/releases/tag/v0.1.0' ;;
  *)
    destination=''
    while [ "$#" -gt 0 ]; do
      if [ "$1" = -o ]; then destination="$2"; shift 2; else shift; fi
    done
    cp "\${GLUEVA_TEST_RELEASE_DIR}/\${url##*/}" "\${destination}"
    ;;
esac
`);
  executable(join(bin, "claude"), `#!/bin/sh
set -eu
printf 'claude %s\\n' "$*" >> "\${GLUEVA_TEST_LOG}"
case "$*" in
  'plugin marketplace list --json')
    if [ "\${GLUEVA_TEST_MODE}" = update ]; then printf '[{"name":"glueva"}]\\n'; else printf '[]\\n'; fi ;;
  'plugin list --json')
    if [ "\${GLUEVA_TEST_MODE}" = update ]; then printf '[{"id":"glueva@glueva"}]\\n'; else printf '[]\\n'; fi ;;
esac
`);
  executable(join(bin, "codex"), `#!/bin/sh
set -eu
printf 'codex %s\\n' "$*" >> "\${GLUEVA_TEST_LOG}"
case "$*" in
  'plugin marketplace list --json')
    if [ "\${GLUEVA_TEST_MODE}" = update ]; then printf '{"marketplaces":[{"name":"glueva-codex"}]}\\n'; else printf '{"marketplaces":[]}\\n'; fi ;;
  'plugin list --json')
    if [ "\${GLUEVA_TEST_MODE}" = update ]; then printf '{"installed":[{"pluginId":"glueva@glueva-codex"}]}\\n'; else printf '{"installed":[]}\\n'; fi ;;
esac
`);

  return { root, home, bin, release, install, log };
}

function runInstaller(
  setup: Awaited<ReturnType<typeof fixture>>,
  mode: "fresh" | "update",
  extraArguments: string[] = [],
  ghAuthenticated = true,
  environment: Record<string, string> = {},
): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync([
    "bash",
    join(import.meta.dir, "..", "install.sh"),
    ...extraArguments,
  ], {
    env: {
      ...process.env,
      HOME: setup.home,
      PATH: `${setup.bin}:/usr/bin:/bin`,
      SHELL: "/bin/zsh",
      ZDOTDIR: setup.home,
      GLUEVA_TEST_RELEASE_DIR: setup.release,
      GLUEVA_TEST_LOG: setup.log,
      GLUEVA_TEST_MODE: mode,
      GLUEVA_TEST_GH_AUTH: ghAuthenticated ? "1" : "0",
      ...environment,
    },
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe("release installer", () => {
  test("installs fresh plugins, updates existing plugins, and supports CLI-only mode", async () => {
    const setup = await fixture();
    const fresh = runInstaller(setup, "fresh");
    expect(fresh.exitCode).toBe(0);
    expect(fresh.stderr.toString()).toBe("");
    expect(fresh.stdout.toString()).toContain("Installed the paired Claude Code and Codex plugins.");
    expect(readFileSync(join(setup.home, ".zshrc"), "utf8")).toBe(
      '\nexport PATH="$HOME/.local/bin:$PATH"\n',
    );
    expect(Bun.spawnSync([join(setup.install, "glueva"), "--version"]).stdout.toString()).toBe("0.1.0\n");
    expect(readFileSync(setup.log, "utf8")).toBe([
      "claude plugin marketplace list --json",
      "claude plugin marketplace add shadowofdoom/glueva",
      "claude plugin list --json",
      "claude plugin install glueva@glueva --scope user",
      "codex plugin marketplace list --json",
      "codex plugin marketplace add shadowofdoom/glueva",
      "codex plugin list --json",
      "codex plugin add glueva@glueva-codex",
      "",
    ].join("\n"));

    writeFileSync(setup.log, "");
    const update = runInstaller(setup, "update");
    expect(update.exitCode).toBe(0);
    expect(update.stderr.toString()).toBe("");
    expect(readFileSync(join(setup.home, ".zshrc"), "utf8")).toBe(
      '\nexport PATH="$HOME/.local/bin:$PATH"\n',
    );
    expect(readFileSync(setup.log, "utf8")).toBe([
      "claude plugin marketplace list --json",
      "claude plugin marketplace update glueva",
      "claude plugin list --json",
      "claude plugin update glueva@glueva --scope user",
      "codex plugin marketplace list --json",
      "codex plugin marketplace upgrade glueva-codex",
      "codex plugin list --json",
      "",
    ].join("\n"));

    writeFileSync(setup.log, "");
    const cliOnly = runInstaller(setup, "fresh", ["--cli-only"]);
    expect(cliOnly.exitCode).toBe(0);
    expect(readFileSync(setup.log, "utf8")).toBe("");
  });

  test("uses public downloads when GitHub CLI is unauthenticated", async () => {
    const setup = await fixture();
    const result = runInstaller(setup, "fresh", ["--cli-only"], false);
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(Bun.spawnSync([join(setup.install, "glueva"), "--version"]).stdout.toString()).toBe("0.1.0\n");
  });

  test("configures the default PATH for common shells", async () => {
    for (const [shell, profile, line] of [
      ["/bin/bash", ".bashrc", 'export PATH="$HOME/.local/bin:$PATH"'],
      ["/usr/bin/fish", ".config/fish/config.fish", 'fish_add_path "$HOME/.local/bin"'],
      ["/bin/sh", ".profile", 'export PATH="$HOME/.local/bin:$PATH"'],
    ]) {
      const setup = await fixture();
      const result = runInstaller(setup, "fresh", ["--cli-only"], true, { SHELL: shell });
      expect(result.exitCode).toBe(0);
      expect(readFileSync(join(setup.home, profile), "utf8")).toContain(line);
    }
  });
});
