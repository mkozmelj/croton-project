# Documentation

## Guides: running and adapting Croton

1. [Accounts and services](guide/01-accounts-and-services.md): every external service and how to get its credentials
2. [Setup and deployment](guide/02-setup-and-deployment.md): local development, Railway, connecting integrations, environment variables
3. [Using the bot](guide/03-using-the-bot.md): commands, the weekly cycle, confirmations, budget
4. [Customizing](guide/04-customizing.md): your sports, language, schedule, budget, literature
5. [Architecture](guide/05-architecture.md): code layout, flows, data model
6. [Security](../SECURITY.md): threat model, authentication, known limitations, operator checklist

## Design records: why it's built this way

The project was designed before it was built. These are the planning documents, kept as written. Read them in this order:

1. [`spec.md`](../spec.md): original vision, architecture, data model, phased plan.
2. [`00-pre-implementation-review.md`](./00-pre-implementation-review.md): gaps, risks and stale assumptions found in `spec.md`.
3. [`01-stack-and-principles.md`](./01-stack-and-principles.md): the stack, pinned versions, and coding conventions.
4. [`02-architecture-decisions.md`](./02-architecture-decisions.md): ADR log of decisions that correct or sharpen `spec.md`. **Where this document and `spec.md` disagree, this document wins.**
5. [`03-build-plan.md`](./03-build-plan.md): the phase-by-phase implementation checklist and build log.

`CLAUDE.md` at the project root is the condensed version of these rules for AI coding sessions working in this repo.

### Why these exist

`spec.md` was written as a single upfront design pass. Before any code was written, it was checked against current API behavior (model IDs, pricing, caching semantics) and reviewed for gaps that would cause problems during implementation (conversation storage format, webhook security, state that has to survive restarts). Docs 00–03 are the output of that review. They don't rewrite the spec; they add corrections and decisions on top of it.
