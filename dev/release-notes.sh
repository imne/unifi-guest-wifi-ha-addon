#!/usr/bin/env bash
# Prints the release notes of one version from guest_wifi/CHANGELOG.md, for the GitHub
# release:  dev/release-notes.sh 1.3.2
set -euo pipefail
v="${1:?usage: dev/release-notes.sh <version>}"
awk -v v="$v" '
  /^## / { on = ($2 == v); next }
  on { lines[++n] = $0 }
  END {
    if (!n) { print "No notes for " v > "/dev/stderr"; exit 1 }
    s = 1; while (s <= n && lines[s] == "") s++
    while (n >= s && lines[n] == "") n--
    # GitHub shows every line break in a release, so join wrapped lines into paragraphs
    out = ""
    for (i = s; i <= n; i++) {
      l = lines[i]
      if (l == "") { print out; print ""; out = ""; continue }
      if (out != "" && l !~ /^- / && l !~ /^\*\*/) { sub(/^ +/, "", l); out = out " " l }
      else { if (out != "") print out; out = l }
    }
    if (out != "") print out
  }' "$(dirname "$0")/../guest_wifi/CHANGELOG.md"
