import json, subprocess, sys, threading, os

def probe(name, argv, params, timeout=60):
    env = dict(os.environ)
    try:
        p = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, env=env, text=True, bufsize=1)
    except Exception as e:
        return {"agent": name, "error": f"spawn: {e}"}
    req = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": params})
    out = {}
    def reader():
        for line in p.stdout:
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                msg = json.loads(line)
            except Exception:
                continue
            if msg.get("id") == 1:
                out["resp"] = msg
                return
    t = threading.Thread(target=reader, daemon=True)
    t.start()
    try:
        p.stdin.write(req + "\n"); p.stdin.flush()
    except Exception as e:
        return {"agent": name, "error": f"write: {e}"}
    t.join(timeout)
    p.kill()
    r = out.get("resp")
    if not r:
        return {"agent": name, "error": "no response"}
    if "error" in r:
        return {"agent": name, "rpc_error": r["error"]}
    res = r.get("result", {})
    methods = res.get("authMethods", [])
    return {
        "agent": name,
        "protocolVersion": res.get("protocolVersion"),
        "authMethods": [{"id": m.get("id") or m.get("methodId"), "type": m.get("type", "agent"),
                         "name": m.get("name")} for m in methods],
    }

AGENTS = {
    "claude-acp": ["npx", "-y", "@agentclientprotocol/claude-agent-acp@0.74.0"],
    "codex-acp":  ["npx", "-y", "@agentclientprotocol/codex-acp@1.9.0"],
    "opencode":   ["opencode", "acp"],
    "devin":      ["devin", "acp"],
}

SHAPES = {
    "v1-no-caps":  {"protocolVersion": 1},
    "v1-auth-caps": {"protocolVersion": 1,
                     "clientCapabilities": {"fs": {}, "terminal": True,
                                            "auth": {"terminal": True, "_meta": {"terminal-auth": True}},
                                            "_meta": {"terminal-auth": True}}},
    "v2-auth-caps": {"protocolVersion": 2,
                     "clientInfo": {"name": "palisade-probe", "version": "0"},
                     "capabilities": {"fs": {}, "terminal": True,
                                      "auth": {"terminal": {}},
                                      "_meta": {"terminal-auth": True}}},
}

which = sys.argv[1]
for shape, params in SHAPES.items():
    print(json.dumps({"shape": shape, **probe(which, AGENTS[which], params)}))
