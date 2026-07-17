#!/usr/bin/env bash
# Stop enforcement is implemented by the compiled CLI. This shim remains inert
# when the CLI is absent and loud-but-nonblocking when integration is broken.

set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
. "${DIR}/common.sh"

run_hook stop
