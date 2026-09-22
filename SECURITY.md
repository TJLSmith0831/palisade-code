# Security policy

Palisade Code runs coding agents with real permissions on real
repositories, so we treat security reports as the highest-priority issue
type.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting on this repository
(Security tab → "Report a vulnerability"). You will get an
acknowledgement within 3 business days and a triage decision within 7.

If you cannot use that form, open a plain issue that says only "security
report, please contact me" and a maintainer will reach out privately.

## What counts

Anything that lets an agent, a project, an MCP server, or a downloaded
artifact do more than the user granted it. For example:

- an agent acting outside its thread's worktree or permission mode
- a path in Palisade that writes into a repository it was not pointed at
- secrets (database passwords, tokens, signing material) reaching logs,
  IPC payloads, or the frontend
- the updater accepting an artifact that is not signed with the project's
  key, or the installer's notarization being bypassed
- the update or feedback endpoints being coerced into serving or storing
  something they should not

Bugs in the agents themselves (Claude Code, Codex, and the rest) belong
with their vendors; if Palisade makes such a bug worse, report it here too.

## Supported versions

Only the latest tagged release receives fixes. Beta builds update
automatically, so a fix reaches every install on its next launch.

## Disclosure

We coordinate disclosure with the reporter and credit them in the release
notes unless they ask otherwise.
