#!/usr/bin/env bash
# SessionStart registration and cold-start recovery are implemented by the
# compiled CLI so this hook has no jq, Node, Python, or Bun runtime dependency.

set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./bridge-common.sh
. "${DIR}/bridge-common.sh"

run_bridge_hook session-start
