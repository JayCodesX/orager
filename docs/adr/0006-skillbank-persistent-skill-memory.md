# ADR-0006: SkillBank — Persistent Skill Memory and Injection

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-04-02 |
| **Deciders** | JayCodesX |

---

## Context

### Current approach

orager's memory system (ADR-0001, ADR-0002, ADR-0004, ADR-0005) stores factual knowledge — project state, file contents, conversation history, cross-agent context — and retrieves it via embedding similarity or full-text search at the start of each run. This is a passive, content-addressed store: it remembers *what happened*, not *how to behave better*.

When an agent fails — misuses a tool, produces malformed output, takes a suboptimal approach to a problem class it has seen before — that failure is logged to the session transcript and then discarded. The next run starts with the same base behaviour. There is no mechanism to extract reusable lessons from failures and apply them prospectively.

### The MetaClaw SkillRL pattern

MetaClaw (arXiv 2603.17187, AIMING Lab, March 2026) introduces a complementary memory layer called the **SkillBank**: a hierarchical library of reusable behavioural instructions distilled from failure trajectories. Where the memory system stores facts, the SkillBank stores *strategies*. At inference time, relevant skills are retrieved by embedding similarity and injected into the system prompt, improving behaviour immediately without any parameter updates.

The two mechanisms are explicitly complementary: memory provides context ("this project uses Bun, not Node"); skills provide strategy ("when editing TypeScript, always run `tsc --noEmit` before committing"). Both are injected at session start; neither requires GPU compute or cloud infrastructure.

### Decision drivers

- Must work with any model orager supports — no local GPU, no fine-tuning, no cloud dependency
- Must be non-blocking — skill extraction runs asynchronously after a run completes; it never delays the user
- Must compose with the existing memory system — skills and memory are retrieved independently and both injected into the system prompt
- Must be inspectable — users can view, edit, and delete skills via `orager skills` subcommands
- Must be opt-in at extraction — users control which runs contribute to the SkillBank
- Skill extraction failure must be fully non-fatal — the agent loop never depends on the SkillBank being populated

---

## Decision

Add a SkillBank subsystem to orager: a persistent, embedding-indexed library of behavioural skill instructions, automatically populated from failure trajectories and injected into the system prompt at session start.

### Solution

#### 1. Trajectory logging

Every `orager run` appends a structured trajectory record to `~/.orager/trajectories/<session-id>.jsonl` on completion. Each record contains the prompt, the NDJSON event stream, the final result subtype, turn count, cost, and model. Records are retained for 30 days by default (configurable via `--trajectory-retention-days`).

Trajectory logging is enabled by default. It is disabled by `--no-trajectory-log` or the `ORAGER_NO_TRAJECTORY_LOG=1` environment variable.

```
~/.orager/
  trajectories/
    <session-id>.jsonl     ← one file per run, NDJSON events
    <session-id>.meta.json ← result subtype, cost, model, timestamp
```

#### 2. Skill extraction pipeline

After a run completes (or via `orager skills extract` for historical trajectories), the extraction pipeline:

1. **Identifies failure trajectories** — result subtype is `error_max_turns`, `error_tool_budget`, or any non-`success` outcome, OR the run succeeded but exhibited a known failure pattern (tool retry loop, repeated identical tool calls, mid-run model escalation)
2. **Calls an LLM evolver** — submits the failure trajectory to the configured model with a fixed extraction prompt that asks it to produce a short (≤ 150 word), task-agnostic skill instruction describing what the agent should do differently
3. **Deduplicates** — embeds the candidate skill and checks cosine similarity against existing SkillBank entries; candidates within `0.92` similarity of an existing skill are discarded (avoids redundant entries accumulating)
4. **Writes to SkillBank** — persists the skill as a versioned entry in `~/.orager/skills/` with metadata: source session ID, extraction model, creation timestamp, version number

Extraction is asynchronous and runs in a detached background process so it never blocks the next `orager run`. Extraction failures are logged to `~/.orager/logs/skill-extract.log` and are fully non-fatal.

The LLM evolver call is cheap — a single short-context completion on any model orager is configured to use. At DeepSeek V3 pricing (~$0.27/M tokens), extracting a skill from a 10-turn failure trajectory costs approximately **$0.0001**.

#### 3. SkillBank storage

```
~/.orager/
  skills/
    index.json             ← skill metadata + embedding vectors (SQLite or flat JSON)
    <skill-id>.md          ← human-readable skill instruction text
```

Each skill entry:

```json
{
  "id": "sk_a3f9b2",
  "version": 3,
  "text": "When the target file is a TypeScript module, always verify the import path resolves before writing — use the Read tool on the parent directory first.",
  "embedding": [...],
  "sourceSession": "sess_8f3a1c",
  "model": "deepseek/deepseek-chat-v3-0324",
  "createdAt": "2026-04-02T14:30:00Z",
  "updatedAt": "2026-04-15T09:12:00Z",
  "useCount": 12,
  "successRate": 0.83
}
```

`successRate` is updated after each run that retrieved the skill: the run result subtype (`success` vs. failure) is backpropagated to the skill entry. Skills with persistent low success rates (< 0.3 over ≥ 10 uses) are automatically soft-deleted and flagged for review.

#### 4. Skill retrieval and injection

At the start of every `orager run`, the retrieval pipeline:

1. Embeds the incoming prompt using the same embedding model as the memory system (ADR-0002)
2. Performs ANN similarity search against the SkillBank index (top-K, K=5 by default)
3. Filters to skills with similarity ≥ `0.65` (configurable via `--skill-threshold`)
4. Appends retrieved skills to the system prompt in a dedicated `## Learned Skills` section, before the memory context block

```
[system prompt]
  ...base instructions...

## Learned Skills
The following strategies have been learned from previous runs on similar tasks.
Apply them where relevant:

1. When the target file is a TypeScript module, always verify the import path
   resolves before writing — use the Read tool on the parent directory first.

2. For bash commands that may block indefinitely, set a timeout via the
   BashTool timeout parameter; default is no timeout.

## Memory Context
  ...retrieved memory entries...
```

If no skills meet the similarity threshold, the `## Learned Skills` section is omitted entirely — no empty section is injected.

Retrieval adds negligible latency: the ANN search on a SkillBank of 1,000 entries completes in < 5ms.

#### 5. CLI interface

```bash
orager skills list                   # list all skills with metadata
orager skills show <skill-id>        # display full skill text + stats
orager skills edit <skill-id>        # open skill in $EDITOR
orager skills delete <skill-id>      # soft-delete a skill
orager skills extract [--session <id>]  # manually trigger extraction on a session
orager skills extract --all          # re-run extraction on all retained trajectories
orager skills stats                  # SkillBank health: size, avg success rate, top skills
```

#### 6. Configuration

```yaml
# ~/.orager/config.yaml
skillbank:
  enabled: true                      # default: true
  extractionModel: ""                # default: inherits from --model
  maxSkills: 500                     # soft cap; oldest low-success skills pruned first
  similarityThreshold: 0.65          # minimum retrieval similarity
  deduplicationThreshold: 0.92       # minimum similarity to suppress a new skill
  topK: 5                            # max skills injected per run
  retentionDays: 30                  # trajectory retention window
  autoExtract: true                  # extract after every failed run automatically
```

---

## Alternatives Considered

### 1. Store skills in the existing memory system

Skills could be stored as memory entries with a `type: skill` tag, retrieved alongside factual memory.

**Rejected because:** Skills and facts have different retrieval semantics. Facts are retrieved by content similarity to the prompt topic; skills should be retrieved by task similarity — what kind of operation is being attempted. Conflating them into one index degrades retrieval quality for both. Separate indices with separate thresholds is cleaner.

### 2. Inject skills as additional user turns (few-shot examples)

Instead of injecting skills into the system prompt, prepend them as synthetic conversation turns showing the agent succeeding at the task.

**Rejected because:** Few-shot injection consumes context budget proportional to the example length and degrades for long examples. System prompt injection is compact (< 150 words per skill), consistent, and does not consume the conversation history window.

### 3. Require explicit user approval before writing a skill

Prompt the user after each failed run: "I extracted a skill — approve it?"

**Rejected for the default path because:** This interrupts flow. The success rate feedback loop (§3 above) and the `orager skills list` / `edit` / `delete` interface give the user full control without requiring interactive approval. Approval-gated extraction is available via `--skill-approval` for users who want it.

### 4. Use a vector database (Qdrant, Chroma) instead of flat JSON + ANN

A dedicated vector database for the SkillBank.

**Rejected because:** At the scale of a personal SkillBank (< 1,000 entries), the existing ANN index from ADR-0002 is sufficient. Introducing a vector database process dependency for a secondary index is disproportionate. The upgrade path to Qdrant is open if multi-user or team SkillBank sharing becomes a requirement.

---

## Consequences

**Positive**
- Every failed run makes orager measurably better on similar future tasks — compounding improvement with zero user effort
- Skills persist across model changes — switching from DeepSeek to Claude does not reset learned behaviour
- Fully offline, no cloud dependency, no GPU, no additional infrastructure
- Users can inspect and curate the SkillBank — it is not a black box
- Composes cleanly with ADR-0007 (OMLS): the SkillBank is the fast-adaptation layer; RL weight updates are the slow-adaptation layer. Together they implement MetaClaw's dual-loop architecture

**Negative / Trade-offs**
- System prompt grows by up to ~750 tokens per run (5 skills × 150 words) — negligible for modern context windows but visible in cost accounting at high volume
- Extraction LLM calls add ~$0.0001 per failed run — effectively free at any reasonable usage level
- Low-quality skills (hallucinated strategies, overly narrow rules) can accumulate if success rate feedback is insufficient; the `orager skills stats` command and manual curation are the remediation path
- Trajectory storage consumes disk space: a 30-day window at 20 runs/day × ~50KB per trajectory = ~30MB. Configurable and bounded.

**Neutral**
- The memory system (ADR-0001 through ADR-0005) is unchanged — SkillBank is an additive layer
- No changes to the agent loop protocol, subprocess transport, or existing CLI flags
- ADR-0007 (OMLS) depends on the trajectory logging introduced in this ADR; trajectory files are the shared substrate
