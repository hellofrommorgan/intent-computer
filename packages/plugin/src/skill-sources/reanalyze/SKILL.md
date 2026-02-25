---
name: reanalyze
description: Subgraph sweep — analyze and improve clusters of related thoughts
context: fork
triggers:
  - /reanalyze
  - /reanalyze --stale
  - /reanalyze --weak
  - /reanalyze --cascade [thought]
---

# /reanalyze — Subgraph Quality Sweeps

You are performing a targeted quality sweep on a subgraph of the knowledge vault at the path provided in your task context.

## Three Sweep Modes

### Mode 1: --stale (default if no flag)
Find thoughts that haven't been updated in 30+ days AND have sparse connections (<3 total links).
These are knowledge that's going cold — either update it or explicitly mark it as stable.

Steps:
1. List all thoughts in {vocabulary.notes}/ directory
2. For each thought, check:
   - Last modified date (from filesystem or frontmatter `created`/`updated` field)
   - Count incoming wiki links: `grep -rl "[[thought-name]]" {vocabulary.notes}/`
   - Count outgoing wiki links in the thought's body
3. Collect thoughts where: (days_since_modified > 30) AND (incoming + outgoing < 3)
4. For each stale thought (process up to 10):
   a. Read the thought fully
   b. Search for potential connections using semantic similarity (check titles and descriptions of all other thoughts)
   c. If connections found: add wiki links (both directions), update the thought's body
   d. If the thought's claim is still valid: update the `updated` field in frontmatter
   e. If the thought's claim is outdated: update the claim and body, or split if it now contains two ideas
   f. If truly orphaned with no connections: add to the relevant map's open questions section

### Mode 2: --weak
Find thoughts with weak structural integrity:
- Missing required schema fields (description, topics)
- Descriptions that restate the title without adding information
- Topics pointing to non-existent maps
- Confidence: felt but with evidence that could upgrade to observed/tested

Steps:
1. List all thoughts in {vocabulary.notes}/
2. For each thought, check schema compliance:
   - Has description field?
   - Description adds information beyond the title?
   - Has topics field with at least one valid wiki link?
   - Topics reference existing maps?
   - Confidence level matches evidence quality?
3. Collect non-compliant thoughts
4. For each weak thought (process up to 10):
   a. Read fully
   b. Fix missing fields — write a proper description based on the body content
   c. Fix topics — add to an appropriate map, create map if cluster warrants it
   d. Fix description quality — if it restates the title, rewrite to add context
   e. Upgrade confidence if evidence supports it

### Mode 3: --cascade [thought-name]
Start from a specific thought and sweep outward through its connections.
Useful when a thought was significantly updated and its neighbors may need updating too.

Steps:
1. Read the anchor thought fully
2. Extract all its wiki links (outgoing connections)
3. Find all thoughts that link TO the anchor (incoming connections)
4. For each connected thought (the "neighborhood"):
   a. Read it fully
   b. Check if the connection to the anchor is still accurate given the anchor's current content
   c. Check if the connected thought's claims are consistent with the anchor's claims
   d. If inconsistent: flag as a tension (create ops/tensions/ entry) or update if the resolution is clear
   e. If the connection context phrase is stale: update it
   f. Check for transitive connections — do any of the neighbor's neighbors connect to the anchor too?
5. Report: which thoughts were updated, which tensions were found, which new connections were made

## Output Format

After completing the sweep, output a summary:

```
## /reanalyze Summary

Mode: [stale|weak|cascade]
Thoughts analyzed: N
Thoughts modified: N
New connections added: N
Tensions found: N
Schema fixes: N

### Changes Made
- [[thought-name]] — [what was changed and why]
- [[thought-name]] — [what was changed and why]

### Remaining Issues
- [any issues that need human judgment]
```

## Quality Gates

Before modifying ANY thought:
1. The title must still pass the composability test: "This thought argues that [title]" must read naturally
2. The description must add information beyond the title
3. Every wiki link added must point to an existing file
4. Every map reference in topics must point to an existing map
5. Do NOT delete thoughts — only update, split, or flag

## Vault Conventions
- Vault root path is provided in the task context
- Thoughts are in {vocabulary.notes}/ (typically `thoughts/`)
- Maps are thoughts with `type: moc` in frontmatter
- Self-knowledge is in `self/`
- Operational files are in `ops/`
- Wiki links use `[[thought title]]` syntax — resolve by filename across the entire vault
