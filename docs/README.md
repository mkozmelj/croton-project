# Training Agent — Planning Docs

Read in this order before writing any code:

1. [`spec.md`](../spec.md) — original vision, architecture, data model, phased plan. Still the primary reference for *what* the agent does.
2. [`00-pre-implementation-review.md`](./00-pre-implementation-review.md) — gaps, risks, and stale assumptions found in `spec.md`. **Read this first if you've already read `spec.md`.**
3. [`01-stack-and-principles.md`](./01-stack-and-principles.md) — the tech stack, pinned versions, and per-technology conventions for writing clean, maintainable code in this repo.
4. [`02-architecture-decisions.md`](./02-architecture-decisions.md) — ADR-style log of the specific decisions that correct or sharpen `spec.md`. **Where this document and `spec.md` disagree, this document wins.**
5. [`03-build-plan.md`](./03-build-plan.md) — the actionable, phase-by-phase implementation checklist. This is what an implementation session should work from.

`CLAUDE.md` at the project root carries the condensed version of all of this for every future Claude Code session working in this repo — read the docs above for the reasoning, `CLAUDE.md` for the quick-reference rules.

## Why these exist

`spec.md` was written as a single upfront design pass. Before writing code, it was pressure-tested against current API behavior (model IDs, pricing, caching semantics) and reviewed for gaps that would bite during implementation (conversation storage format, webhook security, state persistence across restarts). Docs 00–03 are the output of that review — not a rewrite of the spec, but the corrections and decisions layered on top of it.
