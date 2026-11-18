#!/usr/bin/env bash
# Convenience wrapper for Linux/Crostini: same as `npm start`.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
exec npm start -- "$@"
