#!/usr/bin/env python3
"""Self-check for notebook_driver's event contract: `python3 test_notebook_driver.py`.

Covers the two things that broke the run loop and needed no live kernel to
catch: the iopub idle status must not forget a cell before its shell
execute_reply arrives (or the cell never stops "running" in the UI), and
emitted keys must be the camelCase ones the frontend reads.
"""
import notebook_driver as d

emitted = []
d.emit = lambda event: emitted.append(event)


def msg(msg_type, parent):
    return {"header": {"msg_type": msg_type}, "parent_header": {"msg_id": parent}}


pending = {"m1": "cell-a"}

stream = {"name": "stdout", "text": "hi"}
d.handle_iopub(msg("stream", "m1"), pending, "stream", stream)
assert emitted[-1] == {"event": "Stream", "cellId": "cell-a", "name": "stdout", "text": "hi"}, emitted[-1]

# idle arrives before execute_reply on a real kernel — the mapping must survive it
d.handle_iopub(msg("status", "m1"), pending, "status", {"execution_state": "idle"})
assert pending == {"m1": "cell-a"}, pending

d.handle_shell(msg("execute_reply", "m1"), pending, "execute_reply", {"execution_count": 7})
assert emitted[-1] == {"event": "ExecuteReply", "cellId": "cell-a", "executionCount": 7}, emitted[-1]
assert pending == {}, pending

print("ok")
