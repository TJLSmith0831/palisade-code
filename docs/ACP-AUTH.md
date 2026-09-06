# ACP agent authentication — how it actually works

Findings from #19, verified by probing every installed agent directly.
Re-runnable: `python3 scripts/acp-probe.py <agent-id>`.

## The two login shapes

ACP agents advertise logins in `initialize`'s `authMethods`. There are two
kinds, and a client that handles only one will conclude — wrongly — that most
agents offer no login at all.

| `type` | Who runs it | What the client does |
|---|---|---|
| `terminal` | the **client** | Run the agent's own binary with the advertised `args` and `env`. Deliberately **not** passed to the auth endpoints — sending one to `authenticate` is a protocol error. |
| `agent` (the default when `type` is absent) | the **agent** | Call `authenticate` (v1) / `auth/login` (v2) with the method id. The agent runs its own flow and keeps the credential. |

An agent that advertises at least one method MUST support `auth/login` and
`auth/logout`. An agent that advertises none has no auth surface at all, and
the client MUST NOT call `authenticate`.

## `terminal` methods are gated on a client capability

This is the trap. Agents only advertise `terminal` methods when the client
says it can run one:

```json
{ "clientCapabilities": { "auth": { "terminal": true } } }
```

Palisade sent **no client capabilities**, so `authMethods` came back empty from
the Claude agent and there was no way to sign in from inside the app. Measured,
same agent, same machine:

| initialize params | `authMethods` returned |
|---|---|
| `{protocolVersion: 1}` (what Palisade used to send) | `[]` |
| `{protocolVersion: 1, clientCapabilities: {auth: {terminal: true}}}` | `claude-ai-login`, `console-login` |

`agent`-typed methods are **not** gated this way — they are advertised
unconditionally.

## What each installed agent advertises (2026-09-04)

| Agent | Method id | Type |
|---|---|---|
| `claude-acp` | `claude-ai-login` "Claude Subscription" | `terminal` |
| `claude-acp` | `console-login` "Anthropic Console" | `terminal` |
| `codex-acp` | `api-key` "API Key" | `agent` |
| `codex-acp` | `chat-gpt` "ChatGPT" | `agent` |
| `opencode` | `opencode-login` "Login with opencode" | `agent` |
| `devin` | `windsurf-api-key` "API Key" | `agent` |

Every agent offers a login. Only Claude's is client-run — which is why
supporting just the `terminal` shape made the other three look like they had
none.

## Protocol version

Palisade requests `ProtocolVersion::V1`. All four agents answer
`protocolVersion: 1`, **including when asked for v2** — a v2 request is
downgraded, and v2-shaped capabilities (`capabilities.auth.terminal: {}`)
are then not understood, so the Claude agent advertises nothing. v1 with v1
capabilities is the only shape that works today.

Other v1/v2 differences that matter if this is ever bumped:

- client capabilities: `clientCapabilities` (v1) vs `capabilities` (v2)
- terminal `env`: object `{"K": "v"}` (v1) vs array `[{name, value}]` (v2)
- auth capability: `true` (v1) vs `{}` (v2)
- `auth/login` + `auth/logout` are the v2 names for v1's `authenticate`
- v2's `AuthMethod` has an explicit `Other` variant for unknown types; v1
  falls back to `agent` via an untagged variant

## Version tolerance

`authMethods` deserializes with `VecSkipError`, so a method type from a future
revision is skipped rather than failing the handshake. In v1 an unknown `type`
carrying `id` + `name` deserializes as `agent` (untagged fallback), so Palisade
treats it as a protocol login — one failed `authenticate`, surfaced, not a
crash.

## Status of the spec

The terminal-auth RFD is at **Preview**. `auth.terminal` is still marked
UNSTABLE in `agent-client-protocol-schema`, which is why the crate needs
`features = ["unstable_auth_methods"]`. The experimental `env_var` method has
been **removed** from the SDK and schema upstream — nothing to implement there.
