#!/bin/sh
# The crash half of the fake executor (E7): dies immediately, so stdout closes
# without ever emitting a Done and the Crashed path is exercised.
#
# This is a separate script rather than an env-var toggle on fake-executor.sh
# because env vars are process-global — setting one from a test would leak into
# every other test running in parallel and make them crash too.
exit 9
