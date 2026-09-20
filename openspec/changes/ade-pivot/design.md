## Context

Competitor research (`docs/research/ade-market-survey-2026-09.md` and accompanying screenshots) surveyed the current field of ACP/agent-orchestration shells (Orca, Emdash, Superset, Conductor, Nimbalyst, AO) and found every one converges on the same loop: spawn a CLI agent into a worktree, show a diff. None of them center the shell on reviewing several agents at once, predicting file overlap between concurrent runs, or gating merge on recorded verification evidence. Palisade already has per-thread worktrees, a verify command tied to a recorded commit, ACP-any-agent support, and chains — this change repositions the shell around those strengths instead of adding new ones.

## Goals / Non-Goals

**Goals:**
- Reposition Palisade's written product surface (PRODUCT.md, README.md, DESIGN.md, onboarding copy) as an ADE, consistently, with no fabricated market claims.
- Define the fleet board and review lane as the shell's new center of gravity, with existing IDE tooling demoted (not removed) to a Workbench group.
- Keep every existing invariant (OpenSpec authority, verification-as-evidence, append-only sessions, Envelope events, two modes, runtime agent discovery) unchanged.

**Non-Goals:**
- No new dependencies, no pricing/testimonial/adoption claims, no deletion of editor/terminal/run/debug/database/notebook/preview functionality.
- No scheduling or event-trigger support for playbooks in this pass — deferred.
- Graphify/Codebase Map removal is implemented by a separate, parallel change; this proposal only stops referencing it in positioning copy.

## Decisions

**D1 Category.** Palisade Code is an Agentic Development Environment (ADE): one shell that drives N parallel ACP agents in isolated worktrees, reviews their output, and gates merge on verification evidence. Not an AI IDE, not a chat client. Chosen because that is what distinguishes Palisade from every shell in the competitor survey, and because the pieces (worktrees, verify-gated merge, ACP-any-agent, chains) already exist; the pivot is positioning and information architecture, not new capability.

**D2 Home = Fleet board.** Every thread/worktree with status (attention/running/idle), agent, diff stat, verify evidence, merge readiness, and cross-thread file overlap. Opening a project lands here. Chosen so a developer running several agents can tell what needs attention without opening every thread — the gap the competitor survey found nobody fills.

**D3 Review lane.** Per-thread diff review with per-file Viewed state, verify evidence strip, Merge enabled only on a green verify or an explicit override. Chosen because verification-gated merge is an existing Palisade invariant (`verify` command + commit) that today has no dedicated UI home; this gives it one.

**D4 Vibe/Editor mode toggle removed.** Editor, LSP, FIM completion, terminal, run/debug, database, notebooks, preview, search remain as "Workbench" tools reachable from the rail and from any diff/explorer file click; they are demoted in priority, not removed. Chosen because the shell-wide mode toggle competed with the fleet board for "what is home," and none of the demoted tools lose functionality by moving into a group.

**D5 Graphify / Codebase Map removed entirely.** Handled by a parallel change; this proposal only removes references to it from positioning copy so PRODUCT.md, README.md, DESIGN.md, and onboarding stay accurate once that removal lands.

**D6 Chains renamed Playbooks.** A saved multi-agent run launched from the Fleet board; each run is a fleet row with the same signals. Canvas editor stays. Triggers (schedule, PR events) deferred. Chosen for plain-language consistency with "fleet" and "review" — a playbook run is just another kind of fleet-board entry, not a separate mental model.

**D7 MCP panel becomes Connections.** Tabs Agents (registry, installed, sign-in, usage limits where the agent exposes them, honest "not available" otherwise), MCP servers, Skills (user-level skill dirs, read-only). Chosen to group everything that connects Palisade to an external agent, server, or skill source under one rail entry instead of three.

**D8 Rail groups.** Fleet · Review · Playbooks · Connections · Specs | Workbench: Explorer · Search · Source Control · Run · Debug · Database | History · Settings. Chosen to make the fleet/review/playbooks/connections/specs group primary and the Workbench group secondary, matching D1-D4's re-centering.

**D9 Unchanged invariants.** OpenSpec authoritative; verification is the only completion evidence; append-only sessions; Envelope events; two modes (spec/go); agents discovered at runtime. None of these change under this proposal — the pivot is about what the shell foregrounds, not the underlying execution model.

**D10 Competitive rationale.** Market ADEs are "spawn CLI + worktree + diff"; Palisade's wedge is review throughput, overlap prediction, and verification-gated merge. Full research notes live at `docs/research/ade-market-survey-2026-09.md`; PRODUCT.md cites that path rather than repeating external claims inline, per the Brand Commitments rule against unconfirmed market claims.

## Risks / Trade-offs

- **Positioning language can drift ahead of shipped UI** if the fleet board / review lane implementation (separate passes, see tasks.md) lags this proposal → Mitigation: PRODUCT.md's Positioning section describes the target shell, and Evidence on Hand / Capabilities and Constraints sections stay tied to what is actually implemented; this proposal's own tasks.md tracks the implementation passes as unchecked until done.
- **Renaming Chains to Playbooks in user-facing copy without a backend/frontend rename in this pass** creates a temporary mismatch between docs and running UI → Mitigation: `agent-chain-builder`'s modified spec delta describes the rename as UI-level (label and fleet-board integration), not a data-model rename; the underlying `.palisade/chains/` config path is unaffected.
- **Removing the Vibe/Editor toggle changes a default a user may rely on** (project used to open into whichever shell was last active) → Mitigation: `workspace-shell-toggle`'s delta requires Workbench tools stay one click away from any thread or diff, so no functionality is lost, only the default landing view changes.

## Migration Plan

- No data migration. This is a positioning and information-architecture change; existing thread, session, and worktree data are untouched.
- Implementation lands in the order given in `.claude/tier/plan.md`: positioning (this proposal) and fleet backend in parallel, then fleet board UI and review lane in parallel, then sidebar/header signals, then the verification gate (tests, screenshots, PR).
- No feature flag: the fleet board becomes the default landing view once its implementation pass completes; Workbench tools remain fully functional throughout via the rail, so there is no point at which functionality regresses mid-rollout.
