# Repository Guidelines

## Project Structure & Module Organization

Glueva is a Bun/TypeScript CLI that connects interactive Codex and Claude Code sessions. Core runtime code lives in `cli/src/`: `cli.ts` handles commands, `store.ts` owns durable state, `protocol.ts` defines envelopes, and `launcher.ts` starts peers. Tests are in `cli/test/`, with protocol fixtures and schemas under `cli/fixtures/` and `cli/schema/`. Claude and Codex plugin assets live in `claude/plugins/glueva/` and `codex/plugins/glueva/`. User documentation is in `README.md` and `docs/glueva.md`; release automation is in `.github/workflows/glueva-release.yml`.

## Build, Test, and Development Commands

- `bun test cli/test` runs the TypeScript test suite from the repository root.
- `bash claude/plugins/glueva/tests/hooks.test.sh` verifies Claude hook behavior.
- `cd cli && bun run build` compiles the standalone executable to `cli/dist/glueva`.
- `bun cli/src/cli.ts --help` runs the CLI directly during development.
- `git diff --check` catches whitespace errors before review.

Bun 1.3 or newer is required. Release CI currently builds with Bun 1.3.14.

## Coding Style & Naming Conventions

Follow the existing TypeScript style: two-space indentation, semicolons, double quotes, and explicit types at public boundaries. Use `camelCase` for functions and variables, `PascalCase` for classes and interfaces, and `UPPER_SNAKE_CASE` for constants. Prefer Node standard-library APIs and small existing helpers over new dependencies or abstractions. No formatter or linter is configured, so match adjacent code and keep diffs focused. Bash scripts should quote paths and variables.

## Testing Guidelines

Use Bun's `bun:test`; name files `*.test.ts` and describe behavior rather than implementation. Add or update the smallest regression test that would fail without the change. There is no numeric coverage threshold. Changes to hooks must also pass `hooks.test.sh`; installer, launcher, protocol, or store changes should run their matching test file before the full suite.

## Commit & Pull Request Guidelines

Use short, imperative commit subjects such as `Streamline startup pairing`. Keep each commit coherent. Pull requests should explain the user-visible outcome, list verification results, and link relevant issues. Every merged change must bump the release version: use a patch bump for fixes, documentation, and small updates, or a minor bump for new user-visible capabilities. Keep `cli/package.json`, `.claude-plugin/marketplace.json`, the App Server client version, its test expectation, and the pinned version in `docs/glueva.md` synchronized. Release tags must match `cli/package.json` (for example, `v0.8.0`).

## Security Notes

Do not commit runtime state, credentials, or generated binaries. Treat `--yolo` as unsafe outside disposable, isolated environments because it disables approval and sandbox protections.
