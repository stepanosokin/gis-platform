# Domain docs

## Layout and reading rules

This is a single-context repository.

Before exploring the codebase:

- Read the root `GLOSSARY.md`, if present.
- Read decisions in `docs/adr/` relevant to the area being explored.

If these documents are absent, proceed silently.
Create them lazily through `/domain-modeling` when terms or decisions
are resolved, including through `/grill-with-docs` or
`/improve-codebase-architecture`.

## Use the glossary's vocabulary

Use the glossary's terms in issue titles, proposals, hypotheses, and tests.
For a missing concept, reconsider the wording or note the gap for
`/domain-modeling`.

## Surface ADR conflicts

Explicitly identify any existing ADR that a proposal contradicts and explain
why reopening the decision is warranted.
