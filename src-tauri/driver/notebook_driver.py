#!/usr/bin/env python3
"""Notebook kernel driver (design.md D3, decisions.md D4).

Spawned once per open notebook by NotebookKernel::spawn (src-tauri/src/notebook.rs).
Owns a jupyter_client kernel and translates its ZeroMQ messages into
newline-delimited JSON on stdout; reads newline-delimited JSON requests from
stdin. Rust never touches ZeroMQ or the kernel wire protocol directly.

One thread (the main loop, in `run`) does all shell- and iopub-channel I/O,
both sending and receiving — pyzmq sockets aren't safe to share across
threads, and an earlier two-threads-per-channel design silently dropped
messages from a send/recv race on the shell channel. Only stdin reading runs
on a separate thread, since it never touches a zmq socket; it just queues
requests for the main loop to send.

Request (stdin, one JSON object per line):
  {"op": "execute", "cell_id": "...", "source": "..."}
  {"op": "interrupt"}
  {"op": "restart"}

Event (stdout, one JSON object per line):
  {"event": "Started"}
  {"event": "Stream", "cellId": "...", "name": "stdout"|"stderr", "text": "..."}
  {"event": "ExecuteResult", "cellId": "...", "executionCount": N, "data": {mime: value}}
  {"event": "DisplayData", "cellId": "...", "data": {mime: value}}
  {"event": "Error", "cellId": "...", "ename": "...", "evalue": "...", "traceback": [...]}
  {"event": "ExecuteReply", "cellId": "...", "executionCount": N}
  {"event": "Restarted"}
  {"event": "Crashed", "message": "..."}
"""
import argparse
import json
import queue
import sys
import threading

from jupyter_client import KernelManager


def emit(event):
    sys.stdout.write(json.dumps(event) + "\n")
    sys.stdout.flush()


def stdin_reader(requests):
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            requests.put(json.loads(line))
        except ValueError:
            continue
    requests.put(None)  # stdin closed — tells the main loop to stop


def handle_iopub(msg, pending, msg_type, content):
    cell_id = pending.get(msg["parent_header"].get("msg_id"))
    if cell_id is None:
        return  # not one of our tracked executions (e.g. another client's traffic)

    if msg_type == "stream":
        emit({
            "event": "Stream",
            "cellId": cell_id,
            "name": content.get("name", "stdout"),
            "text": content.get("text", ""),
        })
    elif msg_type == "execute_result":
        emit({
            "event": "ExecuteResult",
            "cellId": cell_id,
            "executionCount": content.get("execution_count"),
            "data": content.get("data", {}),
        })
    elif msg_type == "display_data":
        emit({"event": "DisplayData", "cellId": cell_id, "data": content.get("data", {})})
    elif msg_type == "error":
        emit({
            "event": "Error",
            "cellId": cell_id,
            "ename": content.get("ename", ""),
            "evalue": content.get("evalue", ""),
            "traceback": content.get("traceback", []),
        })
    # The mapping is dropped on the shell execute_reply, not on the iopub
    # idle status: idle usually arrives first, and popping here left
    # handle_shell with no cell to attribute the reply to, so ExecuteReply
    # was never emitted and the cell stayed "running" in the UI forever.


def handle_shell(msg, pending, msg_type, content):
    if msg_type != "execute_reply":
        return
    msg_id = msg["parent_header"].get("msg_id")
    cell_id = pending.pop(msg_id, None)
    if cell_id is None:
        return
    emit({
        "event": "ExecuteReply",
        "cellId": cell_id,
        "executionCount": content.get("execution_count"),
    })


def run(km, client, requests):
    pending = {}  # msg_id -> cell_id

    emit({"event": "Started"})
    while True:
        try:
            request = requests.get(timeout=0.05)
        except queue.Empty:
            request = "no-op"  # distinguish "nothing queued" from "stdin closed" (None)

        if request is None:
            return
        if request != "no-op":
            op = request.get("op")
            if op == "execute":
                msg_id = client.execute(request["source"])
                pending[msg_id] = request["cell_id"]
            elif op == "interrupt":
                km.interrupt_kernel()
            elif op == "restart":
                km.restart_kernel(now=True)
                pending.clear()
                emit({"event": "Restarted"})

        # iopub messages for an execution are always sent by the kernel
        # before that execution's shell execute_reply — drain iopub fully
        # first (bounded, so a very chatty cell can't starve stdin/shell
        # forever) so a cell's output is already recorded by the time the
        # frontend sees ExecuteReply and snapshots it (frontend takes
        # ExecuteReply as "this cell's output list is now final").
        try:
            for _ in range(1000):
                try:
                    msg = client.iopub_channel.get_msg(timeout=0)
                except queue.Empty:
                    break
                handle_iopub(msg, pending, msg["header"]["msg_type"], msg["content"])

            try:
                msg = client.shell_channel.get_msg(timeout=0)
            except queue.Empty:
                pass
            else:
                handle_shell(msg, pending, msg["header"]["msg_type"], msg["content"])
        except Exception as exc:
            # `km.is_alive()` wraps an async call (spins up an event loop
            # internally) — too expensive to call on every ~50ms tick of
            # this loop, so it's only checked here, on an actual channel
            # error, to decide crashed-vs-transient.
            if not km.is_alive():
                emit({"event": "Crashed", "message": "kernel process exited"})
                return


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--kernelspec", default="", help="kernelspec name, empty for jupyter_client's default")
    args = parser.parse_args()

    try:
        km = KernelManager(kernel_name=args.kernelspec) if args.kernelspec else KernelManager()
        km.start_kernel()
        client = km.client()
        client.start_channels()
        client.wait_for_ready(timeout=30)
    except Exception as err:
        emit({"event": "Crashed", "message": f"failed to start kernel: {err}"})
        sys.exit(1)

    requests = queue.Queue()
    threading.Thread(target=stdin_reader, args=(requests,), daemon=True).start()
    try:
        run(km, client, requests)
    finally:
        # The Rust parent terminates this driver when a notebook tab closes.
        # Killing only the driver leaves the kernel it spawned running in the
        # background, so tear down both the client channels and child kernel
        # whenever this process exits normally.
        client.stop_channels()
        km.shutdown_kernel(now=True)


if __name__ == "__main__":
    main()
