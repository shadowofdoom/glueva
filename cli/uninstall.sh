#!/usr/bin/env bash
# Remove Glueva's CLI and paired user plugins while preserving project data.

set -uo pipefail

install_dir="${HOME}/.local/bin"
failed=0

usage() {
  printf '%s\n' \
    'Usage: uninstall.sh [--install-dir PATH]' \
    '' \
    'Removes the Glueva CLI and paired user plugins available through installed' \
    'agent CLIs. Preserves shell PATH configuration and project .glueva data.'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-dir) install_dir="${2:?--install-dir requires a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'glueva uninstaller: unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

json_has_string() {
  key="$1"
  value="$2"
  json="$3"
  compact="$(printf '%s' "${json}" | tr -d '[:space:]')"
  case "${compact}" in
    *\"${key}\":\"${value}\"*) return 0 ;;
    *) return 1 ;;
  esac
}

remove_component() {
  output=""
  if output="$("$@" 2>&1)"; then
    [ -z "${output}" ] || printf '%s\n' "${output}"
    return
  fi
  case "${output}" in
    *' is enabled at project scope'*|*' is enabled at local scope'*|*'not declared in user settings'*) return ;;
  esac
  [ -z "${output}" ] || printf '%s\n' "${output}" >&2
  printf 'glueva uninstaller: failed: %s\n' "$*" >&2
  failed=1
}

if command -v claude >/dev/null 2>&1; then
  if plugins="$(claude plugin list --json)"; then
    json_has_string id glueva@glueva "${plugins}" && \
      remove_component claude plugin uninstall glueva@glueva --scope user
  else
    printf 'glueva uninstaller: failed to inspect Claude plugins\n' >&2
    failed=1
  fi

  if marketplaces="$(claude plugin marketplace list --json)"; then
    json_has_string name glueva "${marketplaces}" && \
      remove_component claude plugin marketplace remove glueva --scope user
  else
    printf 'glueva uninstaller: failed to inspect Claude marketplaces\n' >&2
    failed=1
  fi
else
  printf 'glueva uninstaller: Claude Code not found; skipped its plugin cleanup\n' >&2
fi

if command -v codex >/dev/null 2>&1; then
  if plugins="$(codex plugin list --json)"; then
    json_has_string pluginId glueva@glueva-codex "${plugins}" && \
      remove_component codex plugin remove glueva@glueva-codex
  else
    printf 'glueva uninstaller: failed to inspect Codex plugins\n' >&2
    failed=1
  fi

  if marketplaces="$(codex plugin marketplace list --json)"; then
    json_has_string name glueva-codex "${marketplaces}" && \
      remove_component codex plugin marketplace remove glueva-codex
  else
    printf 'glueva uninstaller: failed to inspect Codex marketplaces\n' >&2
    failed=1
  fi
else
  printf 'glueva uninstaller: Codex not found; skipped its plugin cleanup\n' >&2
fi

if [ "${failed}" -ne 0 ]; then
  printf 'glueva uninstaller: plugin cleanup failed; kept the CLI so you can retry\n' >&2
  exit 1
fi

removed=0
for binary in "${install_dir}/glueva" "${install_dir}/glueva.exe"; do
  if [ -e "${binary}" ] || [ -L "${binary}" ]; then
    rm -f -- "${binary}" || {
      printf 'glueva uninstaller: failed to remove %s\n' "${binary}" >&2
      exit 1
    }
    printf 'Removed %s\n' "${binary}"
    removed=1
  fi
done

[ "${removed}" -eq 1 ] || printf 'Glueva CLI is not installed in %s\n' "${install_dir}"
printf '%s\n' \
  'Finished available Claude Code and Codex plugin cleanup.' \
  'Preserved shell PATH configuration and project .glueva data.'
