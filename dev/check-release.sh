#!/usr/bin/env bash
# Run before pushing a release: the version must be the same in config.yaml and
# package.json, and CHANGELOG.md must have release notes for it.
set -euo pipefail
cd "$(dirname "$0")/../guest_wifi"
cfg=$(sed -nE 's/^version: *"([^"]+)".*/\1/p' config.yaml)
pkg=$(sed -nE 's/^ *"version": *"([^"]+)".*/\1/p' package.json)
[ -n "$cfg" ] || { echo "No version in config.yaml"; exit 1; }
[ "$cfg" = "$pkg" ] || { echo "Version mismatch: config.yaml $cfg, package.json $pkg"; exit 1; }
grep -qE "^## ${cfg//./\\.} \(" CHANGELOG.md || { echo "CHANGELOG.md has no release notes for $cfg (add a '## $cfg (date)' section at the top)"; exit 1; }
first=$(sed -nE 's/^## ([0-9][^ ]*) .*/\1/p' CHANGELOG.md | head -1)
[ "$first" = "$cfg" ] || { echo "The newest section in CHANGELOG.md is $first, but the version is $cfg"; exit 1; }
echo "Release $cfg: versions match and CHANGELOG.md has its notes"
