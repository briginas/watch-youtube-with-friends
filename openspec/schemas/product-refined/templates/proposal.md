# Proposal

## Why

<!-- Problem, affected users, situation, consequences, and why now.
Cite supporting facts; distinguish assumptions. -->

## Goals / Success Criteria

<!-- Outcomes and how to observe them; no invented metrics. Acceptance scenarios belong in specs. -->

## What Changes

<!-- Describe what will change. Be specific about new capabilities, modifications, or removals. -->

## Non-goals

<!-- Adjacent work deliberately excluded from this change. -->

## Capabilities

### New Capabilities
<!-- Capabilities being introduced. Name each capability for a cohesive system
     behavior that can own related requirements as the system evolves. Do not name
     implementation tasks or proposal sections. Avoid broad catch-all names. Use
     kebab-case for path segments you introduce (e.g., user-auth or identity/user-auth)
     that follow the project's existing spec organization. Each creates
     specs/<capability-path>/spec.md. -->
- `<capability-path>`: <brief description of what this capability covers>

### Modified Capabilities
<!-- Existing capabilities whose REQUIREMENTS are changing (not just implementation).
     Only list here if spec-level behavior changes. Each needs a delta spec file.
     Use the exact existing path under openspec/specs/. Leave empty if no requirement
     changes. A change with no capabilities at all (pure refactor, tooling, docs)
     must set `skip_specs: true` in its .openspec.yaml - openspec validate rejects
     a zero-delta change without that marker. Do not invent a requirement just to
     satisfy validation. -->
- `<existing-capability-path>`: <what requirement is changing>

## Impact

<!-- Affected code, APIs, dependencies, systems -->

## Assumptions / Open Questions

<!-- Omit when empty. Minor assumptions; blockers; deferred questions with
destination (specs/design) and why deferral is safe. -->

## Readiness

<!-- One short line: Draft / Ready — basis; for Draft, a concrete blocker.
Use the instruction's readiness criteria, without a separate confirmation.
This is not a CLI gate. -->
