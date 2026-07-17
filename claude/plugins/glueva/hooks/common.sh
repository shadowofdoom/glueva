#!/usr/bin/env bash
# Dependency-free shim from Claude's hook runner into the compiled Glueva CLI.

set -uo pipefail

readonly PLUGIN_PROTOCOL=2

resolve_cli_bin() {
  if [ -n "${GLUEVA_BIN:-}" ] && [ -x "${GLUEVA_BIN}" ]; then
    printf '%s' "${GLUEVA_BIN}"
    return 0
  fi
  command -v glueva 2>/dev/null
}

run_hook() {
  local event="$1" bin output
  bin="$(resolve_cli_bin)" || return 0

  if output="$("${bin}" hook "${event}" --plugin-protocol "${PLUGIN_PROTOCOL}")"; then
    [ -n "${output}" ] && printf '%s\n' "${output}"
    return 0
  fi

  # An absent CLI is silent above. A present but broken/incompatible CLI is
  # loud but never blocks Stop, so tooling failure cannot hold a session hostage.
  if [ "${event}" = "session-start" ]; then
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"glueva: the CLI is installed but its hook integration failed. This session is NOT paired; reinstall the CLI and plugin so their protocol versions match."}}'
  else
    printf '%s\n' '{"systemMessage":"glueva: the CLI is installed but its hook integration failed. The ingress watcher cannot be verified, so peer messages may not wake this session. Reinstall the CLI and plugin so their protocol versions match."}'
  fi
}
