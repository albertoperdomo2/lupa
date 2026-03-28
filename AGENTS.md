# AGENTS

## Purpose

`lupa` is a local trace viewer for:
- single-trace flame graph inspection
- agent-assisted trace explanation
- deep comparison between `baseline` and `candidate`

Keep the product technical, direct, and evidence-driven.

## Narrow Path

- Prefer the narrow path over configurable abstractions.
- Assume Deep Mode compares equivalent workloads unless the task explicitly expands scope.
- Build deterministic analysis first; let Trace Agent explain and navigate it.
- Do not add broad workflow metadata, speculative product surfaces, or generic dashboards unless clearly needed.

## Product Rules

- The UI should stay compact, legible, and fast.
- Trace Agent should be concise, technical, and to the point.
- Findings should link to visible evidence in the flame graph whenever possible.
- Persist chat lightly; persist full traces locally with explicit clear controls.
- Do not store API secrets persistently in browser storage.

## Implementation Rules

- Prefer simple data models and explicit state over clever indirection.
- Keep compare logic deterministic and testable.
- When adding agent capabilities, expose narrow tools with exact inputs and outputs.
- Preserve the local-first distribution path: `Containerfile`, GHCR image, `scripts/lupa`, `scripts/install.sh`.
- Keep GitHub repo attachments pinned and exact; avoid vague repo-wide prompt stuffing.

## Change Discipline

- Remove dead code when you find it.
- Keep docs current when behavior changes.
- Validate changes with:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```
