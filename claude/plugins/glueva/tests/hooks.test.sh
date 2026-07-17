#!/usr/bin/env bash
# Integration checks for the dependency-free hook shims. Hook decision logic is
# covered in cli/test/claude-hooks.test.ts; these checks prove the plugin
# forwards stdin and fails silent/loud at the correct boundary.

set -uo pipefail
HOOKS="$(cd "$(dirname "${BASH_SOURCE[0]}")/../hooks" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT
STUB="${TMP}/bin"
mkdir -p "${STUB}"

SAFE_PATH="$(printf '%s' "${PATH}" | tr ':' '\n' | while read -r directory; do
  [ -n "${directory}" ] && [ -x "${directory}/glueva" ] && continue
  printf '%s:' "${directory}"
done)"

install_stub() {
  {
    printf '%s\n' '#!/usr/bin/env bash'
    printf '%s\n' 'printf "%s\n" "$*" > "${STUB_CALLS}"'
    printf '%s\n' 'cat > "${STUB_STDIN}"'
    printf '%s\n' '[ "${STUB_EXIT:-0}" -eq 0 ] || exit "${STUB_EXIT}"'
    printf '%s\n' 'printf "%s" "${STUB_OUTPUT:-}"'
  } > "${STUB}/glueva"
  chmod +x "${STUB}/glueva"
}

run() {
  local hook="$1" stdin="$2"; shift 2
  printf '%s' "${stdin}" | env -u GLUEVA_BIN \
    PATH="${STUB}:${SAFE_PATH}" \
    STUB_CALLS="${TMP}/calls" \
    STUB_STDIN="${TMP}/stdin" \
    "$@" bash "${HOOKS}/${hook}" 2>/dev/null
}

pass=0
fail=0
check() {
  local name="$1" actual="$2" expected="$3"
  if printf '%s' "${actual}" | grep -qF -- "${expected}"; then
    pass=$((pass + 1)); printf '  ok   %s\n' "${name}"
  else
    fail=$((fail + 1)); printf '  FAIL %s\n     got: %s\n' "${name}" "${actual:-<empty>}"
  fi
}
empty() {
  local name="$1" actual="$2"
  if [ -z "${actual}" ]; then
    pass=$((pass + 1)); printf '  ok   %s\n' "${name}"
  else
    fail=$((fail + 1)); printf '  FAIL %s\n     got: %s\n' "${name}" "${actual}"
  fi
}

echo "== CLI absent: inert and silent =="
rm -f "${STUB}/glueva"
empty "SessionStart is silent" "$(run session-start.sh '{"session_id":"s1"}')"
empty "Stop is silent" "$(run stop.sh '{"session_id":"s1"}')"

echo "== CLI present: exact protocol call and stdin forwarding =="
install_stub
out="$(run session-start.sh '{"session_id":"s1"}' STUB_OUTPUT='{"ok":"start"}')"
check "SessionStart returns CLI output" "${out}" '"start"'
check "SessionStart argv" "$(cat "${TMP}/calls")" "hook session-start --plugin-protocol 2"
check "SessionStart stdin" "$(cat "${TMP}/stdin")" '"session_id":"s1"'
out="$(run stop.sh '{"session_id":"s2"}' STUB_OUTPUT='{"decision":"block"}')"
check "Stop returns CLI output" "${out}" '"block"'
check "Stop argv" "$(cat "${TMP}/calls")" "hook stop --plugin-protocol 2"
check "Stop stdin" "$(cat "${TMP}/stdin")" '"session_id":"s2"'

echo "== CLI broken: loud, never blocking Stop =="
out="$(run session-start.sh '{}' STUB_EXIT=7)"
check "SessionStart warns" "${out}" "NOT paired"
out="$(run stop.sh '{}' STUB_EXIT=7)"
check "Stop warns" "${out}" "hook integration failed"
if printf '%s' "${out}" | grep -q '"decision"'; then
  fail=$((fail + 1)); printf '  FAIL Stop warning must not block\n'
else
  pass=$((pass + 1)); printf '  ok   Stop warning never blocks\n'
fi

printf '\n%s passed, %s failed\n' "${pass}" "${fail}"
[ "${fail}" -eq 0 ]
