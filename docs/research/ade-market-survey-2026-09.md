# ADE Competitive Research Notes

## Orca (OrbittechIA/orca, ~43-70K GitHub stars, 2026)
Layout: multi-panel desktop app — worktrees shown side-by-side in tab splits, WebGL terminal panes with infinite splits, embedded Chromium browser with "Design Mode" for clicking UI elements, GitHub/Linear task panels, diff view with inline annotations, file explorer with drag-drop into prompts. Mobile companion app mirrors sessions.
Praised: fan-out one prompt across 5+ agents each in isolated worktree; Ghostty-class terminal perf (WebGL, scrollback survives restarts); mobile app for monitoring/steering agents remotely.
Pain points: README/marketing has no self-reported criticism (typical of fast-growing OSS marketing pages) — treat star count and polish as vendor-reported; independent review coverage was thin at time of search.
Sources: https://github.com/OrbittechIA/orca, https://www.coddykit.com/pages/blog-detail?id=513010

## Emdash (emdash.sh / emdash.com, YC W26, open source)
Layout: task-per-worktree list (fix-login, rewrite-auth, fix-ci style cards), built-in browser preview of dev servers, diff/review view, integrated terminal, file editor with search, issue-tracker dashboard (Linear/Jira/GitHub/Asana/etc.), automation scheduler with run history.
Praised: "parallel brains, one cockpit"; 25+ supported agents with no vendor lock-in; polish/clean design called out by users.
Pain points: open GitHub issues note Windows installer problems; ACP (Agent Client Protocol) integration still pending; terminal backend selection flexibility requested.
Sources: https://emdash.com/, https://github.com/generalaction/emdash, https://news.ycombinator.com/item?id=47140322

## Superset (superset.sh, YC P26)
Layout: sidebar of agent status (working/blocked/done), central integrated terminal with tabs/splits, built-in diff viewer, in-app browser for dev-server preview, command palette, dashboard of parallel worktree workspaces.
Praised: "run 100+ agents at once" each in own worktree/branch; unified terminal+diff+browser kills context switching; multi-surface (desktop, CLI, TS SDK, MCP server).
Pain points (HN threads): rendering bugs in long sessions; ~2GB RAM footprint (Electron); reviewer skepticism that agent throughput was ever the bottleneck vs. human review capacity; 10 worktrees = 10 copies of environment (DB/settings/Solr per worktree cited as painful for Drupal-style stacks); source-available Elastic License 2.0 (not OSI open source) drew criticism; preference voiced for one-time purchase over subscription.
Sources: https://news.ycombinator.com/item?id=47171418, https://news.ycombinator.com/item?id=48236770, https://news.ycombinator.com/item?id=46368739, https://github.com/superset-sh/superset

## Conductor (conductor.build, Melty Labs)
Layout: workspace list where each workspace = branch + files + terminal + diff + review path, "see at a glance what they're working on" dashboard framing; GitHub/Linear integration for one-click PR creation.
Praised: automates worktree creation/teardown (vs. painful manual worktree management); tight GitHub/Linear loop — agent can open PRs, read diffs, respond to review comments; Mac-native feel.
Pain points: marketing content is feature-only, no self-reported issues; general worktree-fleet cost concerns apply (see cross-cutting below) but no Conductor-specific complaints surfaced in this pass — thinner independent review corpus than Superset/Crystal.
Sources: https://docs.conductor.build/, https://www.conductor.build/docs/guides/parallel-agents/run-multiple-claude-code-sessions, https://georgetaskos.medium.com/scaling-the-loop-run-5-claude-code-sessions-in-parallel-with-conductor-build-539b52888a81

## herdr (herdr.dev)
Layout: NOT a desktop GUI app — an agent-first terminal multiplexer (tmux-like: panes/tabs/splits/leader key) that runs on a machine you own; browser client "Roamgate" adds a GUI (workspace list, terminal panes, diffs, worktree management) on top.
Praised: persistent background execution — "walk away, come back from any machine"; automatic per-pane agent status detection (working/blocked/idle/done); cross-machine (laptop/desktop/rented server) via SSH.
Pain points: requires SSH setup today (a "Herdr Cloud" is "coming soon" specifically to remove this friction); agents can drift to outdated CLI versions across machines; context/token usage surfaced as ambient monitoring overhead in the UI, implying users worry about it.
Sources: https://herdr.dev/, https://github.com/herdrdev/herdr, https://dev.to/pvgomes/herdr-is-tmux-for-coding-agents-3ai0

## Crystal / Nimbalyst (stravu/crystal → nimbalyst/nimbalyst, deprecated Feb 2026)
Layout: left sidebar for session nav, kanban board of parallel sessions, central WYSIWYG panels for markdown/mockups/diagrams, step-through diff review (approve/reject per change), embedded ghostty terminal, task tracker (plans/bugs/features/todos).
Praised: "visually editable, deeply linked" human-AI iteration loop; native support for visual artifacts (mockups, Mermaid, Excalidraw, CSV) — differentiator vs. terminal-only competitors; free MIT-licensed, mobile companion.
Pain points: OpenCode and Copilot provider support still "alpha"; Linux install requires separate/extra docs (higher setup friction than macOS); the Crystal→Nimbalyst rename/migration itself was a source of user confusion (redirects, brand churn) per community wiki.
Sources: https://github.com/stravu/crystal, https://github.com/nimbalyst/nimbalyst, https://nimbalyst.com/crystal/, https://ai.miraheze.org/wiki/Nimbalyst

## Agent Orchestrator / AO (Untrivial-ai/agent-orchestrator, Apache 2.0)
Layout: kanban board with columns "Working / Needs you / In review / Ready to merge"; each card shows agent identity, branch, PR status, CI result; unified session cards combine terminal UI, chat, isolated browser preview, PR review panel.
Praised: full-automation framing — agents handle CI fixes, review-comment responses, and PR lifecycle without per-edit approval; 26 supported harnesses (Claude Code, Codex, Aider, Goose, Copilot, Kimi, etc.); replaces "disconnected terminals, branches, browser tabs" with one view.
Pain points: no self-reported criticism in README; the autonomy pitch (agents merge/respond without approval) is exactly the kind of behavior other products' reviewers flag as risky — treat "supervise, don't approve every edit" as an open trust question, not a proven pain point yet.
Sources: https://github.com/ComposioHQ/agent-orchestrator, https://ao-agents.com/, https://aoagents.dev/

## Aperant (AndyMik90/Aperant, formerly Auto Claude, AGPL-3.0)
Layout: three-part interface — kanban board (plan→build→done), agent terminals (up to 12 parallel, contextual task injection), roadmap/competitor-analysis planning view.
Praised: git-worktree isolation keeps main branch safe; "self-validating QA" loop runs checks before handoff; up to 12 concurrent agent terminals.
Pain points: requires Claude Pro/Max subscription (no BYO-model flexibility implied); project is "in maintenance mode" with PRs paused during a 3.0 rebuild; most active development happens in a private/separate repo, reducing community visibility into roadmap and fixes.
Sources: https://github.com/AndyMik90/Aperant, https://x.com/DanKornas/status/2074675831717159256, https://www.blog.brightcoding.dev/2026/07/04/aperant-the-revolutionary-multi-agent-coding-framework-every-developer-needs

## Cursor 3 "Glass" Agents Window (incumbent threat, cursor.com, launched Apr 2 2026)
Layout: Composer sidebar removed; replaced by a dedicated Agents Window — a sidebar list of every running session (task, repo, local/cloud) with Agent Tabs for side-by-side or grid chat views; `/worktree` command spins isolated checkouts; "Design Mode" overlays the in-app browser for pointing at UI elements.
Praised: four run environments per agent (local, worktree, cloud, remote SSH) in one IDE; Best-of-N — same task run in parallel across models/worktrees for side-by-side comparison; cloud agents auto-produce screenshots/demos for verification.
Pain points (from independent analysis, not vendor copy): parallelization overhead can exceed real speedup when Agent B depends on Agent A's output (sequential-dependency tasks parallelize poorly); "error cascades" — per-agent inaccuracies compound into false consensus across the fleet; large monorepos can blow each worktree's effective context budget, eroding the isolation benefit.
Sources: https://www.agentpatterns.ai/tools/cursor/agents-window/, https://cursor.com/blog/cursor-3, https://cursor.com/changelog/3-0, https://dev.to/gabrielanhaia/cursor-3-glass-replaced-composer-with-an-agents-window-1pcg

---

## CROSS-CUTTING PAIN POINTS
1. Per-worktree environment duplication (DB, .env, services, Solr/search indexes) makes fan-out expensive for non-trivial stacks — Superset (HN, Drupal example), implicitly all worktree-based tools (Emdash, Conductor, Nimbalyst, Aperant, AO, Orca).
2. Merge-conflict/coordination tax grows superlinearly as parallel agent count rises — general finding (danielvaughan.com 33,596-PR study), applies to every fleet tool (Orca, Emdash, Superset, Conductor, AO, Aperant, Cursor).
3. Token/compute cost scales roughly linearly-to-worse with agent count, since each agent carries its own full context — cited against parallel-agent workflows generally (thedailydeveloper.substack.com, metacircuits.substack.com); relevant to Orca, Superset, Emdash, Cursor Best-of-N.
4. Human review throughput, not agent throughput, is the real bottleneck — explicit HN skepticism aimed at Superset, structurally true for any fleet tool that doesn't help you review faster (Orca, Conductor, AO).
5. Sequential/dependent tasks don't parallelize well — parallelizing Agent B-depends-on-A work adds overhead without payoff — flagged specifically against Cursor 3 Agents Window, applicable to any worktree fan-out tool.
6. Error cascades / false consensus across multiple agent outputs on the same task — flagged against Cursor Best-of-N, a risk for any "run N agents, pick the winner" pattern (Orca fan-out, Cursor Best-of-N).
7. Electron/desktop resource overhead (~2GB RAM cited for Superset) when running many terminal + browser + diff panes concurrently — likely shared by Orca, Emdash, Conductor, Nimbalyst, Aperant (all Electron-class desktop apps).
8. Cross-machine/version drift — agents on different machines end up on different CLI versions, a herdr-specific complaint but relevant to any tool that spans laptop + remote/cloud execution (herdr, Cursor cloud agents, Orca remote SSH worktrees).
9. Licensing/openness friction — Superset's Elastic License 2.0 (not OSI-approved) and Aperant's "development happens in a private repo" both drew community pushback despite being marketed as open-source-adjacent.
10. Autonomous PR/merge behavior (agents responding to reviews or merging without per-edit approval) is pitched as a feature (Agent Orchestrator, Aperant) but is an unresolved trust question — no evidence yet that users are comfortable ceding that control.

## TABLE STAKES
1. Git-worktree isolation per task/agent (every product: Orca, Emdash, Superset, Conductor, herdr, Nimbalyst, AO, Aperant, Cursor).
2. Multi-agent-CLI support (Claude Code, Codex, Cursor, Gemini/OpenCode, etc.) rather than lock-in to one vendor.
3. Built-in diff/review panel so you never leave the app to inspect a change.
4. Integrated terminal (tabs/splits) attached to each worktree/session.
5. Kanban- or list-style session board showing per-agent status (working/blocked/needs-review/done).
6. One-click PR creation / GitHub (often Linear/Jira) integration.
7. In-app browser or dev-server preview for web projects.
8. Remote/SSH or cloud execution option so sessions survive the laptop closing.
9. Desktop app (macOS-first, often Electron/Tauri) as primary surface, sometimes plus CLI/mobile companion.
10. Free tier / BYO-subscription model (bring your own Claude/Codex/Cursor subscription rather than metered API billing through the vendor).

## WHITE SPACE
1. Nobody has solved per-worktree environment duplication (DB seeding, .env, service dependencies) — every tool leaves this to the user; a shared "environment template" or ephemeral-service layer is unaddressed (evidence: Superset HN Drupal complaint).
2. No product surfaced here treats human review capacity as the bottleneck to optimize — all are agent-throughput-first; a review-speed-first UX (batched diff triage, risk scoring, auto-summarized changesets) is missing (evidence: HN skepticism on Superset).
3. No cost/token budget guardrails or fleet-wide spend dashboards were found in any product's feature list, despite token cost being a named complaint against parallel-agent workflows generally (evidence: thedailydeveloper/metacircuits Substack pieces).
4. No product exposes cross-agent conflict prediction — i.e., warning before launch that two agents' likely edit surfaces overlap — everyone resolves conflicts after the fact via diff/merge review (evidence: merge-conflict-tax research, Cursor's error-cascade caveat).
5. Version/environment drift across machines (local vs. remote vs. cloud agent) has no first-class reconciliation UI in any product surveyed — herdr names it directly as a known gap ("Herdr Cloud coming soon").
6. None of the reviewed products publish independent, structured "when NOT to parallelize" guidance in-product (task-dependency detection); this exists only as third-party blog commentary (Cursor agentpatterns.ai critique), not as a feature in any tool.
