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
# Each fallback annotation is cut to 4000 characters. The tail-40 one keeps
# its end. The list keeps its first line (which says how many failures have
# no annotation) and the end of the list; the cut is marked.
#
# Known gap: the count can miss a failure. The reporter also writes a
# "::error file=..." line for a test annotation of type "error" that has a
# location (context.annotate(message, "error") in a test), and a test that
# prints a line starting with "::error file=" or " FAIL  " moves the counts
# too. Such a line is not a failure, so "reported" can reach "printed" while
# a failure without a frame in the project gets no annotation of its own
# (its "::error file=" lines are still re-emitted, and the log has it).
# Nothing in the repository calls context.annotate or prints such lines.
set -euo pipefail

log=$1
status=$2

sed -En 's/^[^ ]+ [^ ]+: (::error file=)/\1/p' "$log"
if [ "$status" -eq 0 ]; then
  exit 0
fi

# Lines on stdin -> one "::error::" annotation, newlines as %0A, at most 4000
# characters. A longer message keeps its last 4000 characters; with
# "keep-first", its first line stays in front, the lines after it are cut
# from the start at a line boundary, and a marker line shows the cut.
annotate() {
  sed 's/%/%25/g; s/\r//g' | awk -v keep_first="${1:-}" -v limit=4000 '
    keep_first && NR == 1 { head = $0; next }
    { body = body (n++ ? "%0A" : "") $0 }
    END {
      if (!NR) exit
      if (!keep_first) {
        msg = body
        if (length(msg) > limit) msg = substr(msg, length(msg) - limit + 1)
      } else if (!n) {
        msg = head
      } else {
        msg = head "%0A" body
        if (length(msg) > limit) {
          cut = "[earlier lines cut: see the log]"
          room = limit - length(head) - length(cut) - 6
          body = room > 0 ? substr(body, length(body) - room + 1) : ""
          # Start at a whole line: drop what is left of the one cut through.
          i = index(body, "%0A")
          body = i ? substr(body, i + 3) : ""
          msg = head "%0A" cut "%0A" body
        }
      }
      print "::error::" substr(msg, 1, limit)
    }'
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
  } | annotate keep-first
fi
