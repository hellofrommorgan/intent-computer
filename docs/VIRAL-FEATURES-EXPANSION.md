# Viral Feature Proposals #2 and #3

This document adds two more high-leverage viral features that complement Intent Capsules.

---

## Feature #2: Intent Circles

## One-line pitch

Small invite-based groups run the same weekly intent sprint, compare outcomes, and auto-generate a shareable Circle Digest.

## Why this is high leverage

Single-player productivity tools struggle with distribution. Intent Circles create a built-in team loop: one user invites peers, peers produce outcomes, outcomes generate social proof, and that proof recruits more users.

## Core user flow

### Creator flow

1. User runs `/arscontexta:circle-create` with a weekly prompt (for example, "ship one high-impact automation").
2. Plugin creates a circle spec in `ops/circles/<circle-id>.md` with:
   - objective
   - weekly cadence
   - required evidence fields
   - invite link
3. Creator shares invite link with peers.

### Participant flow

1. Recipient runs `/arscontexta:circle-join <link>`.
2. Plugin imports the sprint into `inbox/` and creates aligned queue tasks.
3. During the week, completion signals from queue/session events are attached to the circle.
4. At week end, plugin writes a `Circle Digest` artifact with outcomes, lessons, and top reusable workflows.

## Viral mechanism

- Invite loop: each circle starts with peer invites.
- Proof loop: weekly digest becomes public/shareable social proof.
- Remix loop: top outcomes can be turned into Intent Capsules and re-shared.

## Proposed product surface

- `/arscontexta:circle-create`
- `/arscontexta:circle-join`
- `/arscontexta:circle-digest`
- `/arscontexta:circle-list`

## Architecture fit (current repo)

- Use queue lifecycle for sprint tasks (`packages/architecture/src/queue.ts`).
- Use session-end artifacts for contribution evidence (`sessionCapture` and runtime cycle logs).
- Use heartbeat scheduler for weekly digest generation (`packages/heartbeat/src/scheduler.ts`).
- Store circle manifests in vault ops space (`ops/circles/`).

## MVP scope (first release)

1. Local circle manifest + invite token generation.
2. Join/import flow to inbox + queue.
3. Weekly digest generation from task completions and selected notes.
4. Manual share of digest markdown (no hosted backend required).

## Success metrics

Primary:
- `circle_invite_accept_rate`
- `avg_participants_per_circle`
- `week2_retention_of_circle_participants`

Secondary:
- `digest_share_rate`
- `% circles producing at least one new Intent Capsule`
- `new_activated_users_from_circle_invites`

## Risks and mitigations

- Competitive dynamics could reduce note quality:
  - mitigation: require evidence + reflection fields, not raw output count.
- Privacy risk in group digests:
  - mitigation: per-entry visibility controls + redaction before share.

---

## Feature #3: Intent Bounties

## One-line pitch

Users publish blocked intents as bounties; others submit runnable solutions that can be accepted, credited, and re-shared.

## Why this is high leverage

This creates a two-sided growth loop:

1. Askers create demand by publishing real problems.
2. Solvers create supply by publishing working solutions.
3. Accepted bounties generate public proof artifacts for both sides.

The network gets stronger as more high-quality solved intents accumulate.

## Core user flow

### Asker flow

1. User runs `/arscontexta:bounty-create` from a stuck queue item.
2. Plugin generates `ops/bounties/<bounty-id>.md` containing:
   - problem statement
   - constraints
   - acceptance criteria
   - safe context snapshot
3. User shares bounty link.

### Solver flow

1. Solver runs `/arscontexta:bounty-import <link>`.
2. Plugin creates local tasks and a response workspace.
3. Solver publishes response via `/arscontexta:bounty-submit`, generating `ops/bounty-responses/<response-id>.md`.
4. Asker reviews and accepts via `/arscontexta:bounty-accept <response-id>`.

## Viral mechanism

- Demand loop: every blocked user invites solution creators.
- Supply loop: solver wins are reputational and shareable.
- Derivative loop: accepted responses become templates/capsules others can fork.

## Proposed product surface

- `/arscontexta:bounty-create`
- `/arscontexta:bounty-import`
- `/arscontexta:bounty-submit`
- `/arscontexta:bounty-accept`
- `/arscontexta:bounty-list`

## Architecture fit (current repo)

- Bounty and response records map cleanly to markdown-first storage.
- Queue and commitment state can track lifecycle (`open -> submitted -> accepted`).
- Existing skill system can execute bounty response playbooks.
- MCP server contracts can later expose discovery/search without changing core vault format.

## MVP scope (first release)

1. Markdown-based bounty and response artifacts (local-first).
2. Import/create/submit/accept commands.
3. Lightweight reputation fields in frontmatter (`accepted_count`, `solve_rate`).
4. Manual publication via GitHub repo/gist links.

## Success metrics

Primary:
- `bounties_created_per_week`
- `response_rate_per_bounty`
- `accepted_response_rate`

Secondary:
- `median_time_to_first_response`
- `% accepted responses converted into reusable capsules/templates`
- `new_users_who_first_arrive_as_solvers`

## Risks and mitigations

- Spam/low-quality submissions:
  - mitigation: acceptance criteria templates + basic trust scoring.
- Sensitive data in bounty context:
  - mitigation: enforced redaction and context minimization in publish step.
- Cold-start liquidity:
  - mitigation: seed with internal/public starter bounties.

---

## Prioritization guidance

- Prioritize **Intent Circles** first if the goal is fast invite-driven activation.
- Prioritize **Intent Bounties** first if the goal is building a durable solution marketplace and long-term network effects.
