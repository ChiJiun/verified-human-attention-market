#!/usr/bin/env bash
# Turns the failures in a vitest log into GitHub annotations, which are
# readable through the API. Usage: vitest-annotations.sh <log> <exit status>
# It only prints workflow commands; the calling step exits with the status.
#
# The source is the vitest github-actions reporter (see the vitest configs):
# one "::error file=..." line per failed test or suite and error, at its file
# and line. The runner only reads a line that starts with "::" as a command,
# and pnpm -r starts each line of a package's output with
# "<package dir> test: ", so the reporter lines are printed again without
# that prefix (a line that has no prefix was already read).
#
# The reporter skips an error that has no stack frame in the project:
# - When it wrote no line at all (vitest stopped before reporting, or no error
#   had such a frame), the last 40 log lines become one annotation instead.
# - When it wrote fewer lines than the failures vitest printed (one " FAIL "
#   header per failed test or suite and error, plus the "Errors  N error(s)"
#   count of unhandled errors), one more annotation lists those headers, each
#   with the line after it (the error).
# Each fallback annotation is cut to its last 4000 characters.
set -euo pipefail

log=$1
status=$2

sed -En 's/^[^ ]+ [^ ]+: (::error file=)/\1/p' "$log"
if [ "$status" -eq 0 ]; then
  exit 0
fi

# Lines on stdin -> one "::error::" annotation, newlines as %0A.
annotate() {
  sed 's/%/%25/g; s/\r//g' | awk '
    { msg = msg (NR > 1 ? "%0A" : "") $0 }
    END { if (NR) print "::error::" substr(msg, length(msg) > 4000 ? length(msg) - 3999 : 1) }'
}

read -r reported printed < <(awk '
  { sub(/\r$/, "") }
  /^([^ ]+ [^ ]+: )?::error file=/ { reported++ }
  /^([^ ]+ [^ ]+: )? FAIL  / { printed++ }
  /^([^ ]+ [^ ]+: )? +Errors +[0-9]+ errors?$/ {
    count = $0
    sub(/ errors?$/, "", count)
    sub(/.* /, "", count)
    printed += count
  }
  END { print reported + 0, printed + 0 }' "$log")

if [ "$reported" -eq 0 ]; then
  tail -40 "$log" | annotate
elif [ "$reported" -lt "$printed" ]; then
  {
    echo "$((printed - reported)) of the $printed failures vitest printed have no annotation of their own (no stack frame in the project). The failures, each with the line after it:"
    # In a pnpm-prefixed log the line after a header is the next one with the
    # same prefix (another package's output can come in between).
    awk '
      { sub(/\r$/, "") }
      /^([^ ]+ [^ ]+: )? FAIL  / {
        prefix = ""
        if (match($0, /^[^ ]+ [^ ]+: /) && substr($0, RLENGTH + 1, 6) == " FAIL ")
          prefix = substr($0, 1, RLENGTH)
        print substr($0, length(prefix) + 1)
        waiting = 1
        next
      }
      waiting && (prefix == "" || index($0, prefix) == 1) {
        print substr($0, length(prefix) + 1)
        waiting = 0
      }' "$log"
    if grep -Eq '^([^ ]+ [^ ]+: )? +Errors +[0-9]+ errors?$' "$log"; then
      echo "Unhandled errors: see the \"Unhandled Errors\" section of the log."
    fi
  } | annotate
fi
