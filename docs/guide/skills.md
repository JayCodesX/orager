# Skills & Learning

## What is SkillBank?

SkillBank (ADR-0006) is orager's self-improvement system. It observes agent runs, extracts reusable behavioural patterns ("skills"), stores them in a SQLite database, and automatically retrieves the most relevant skills for each new run.

The result: orager gets better at your specific workflows the more you use it.

## How Skills Are Captured

At the end of a successful agent run, orager optionally calls an extraction model (configurable, defaults to the session model) to distill the key lessons from the run's tool-call trajectory into short, imperative instructions:

> "When reading TypeScript files, always check for barrel index files before assuming a symbol is not exported."

These extracted skills are embedded (vector representation) and stored in the skills database at `~/.orager/skills.db`.

## How Skills Are Injected

At the start of each run, orager embeds the incoming prompt and performs a cosine similarity search over the skills database. The top-K skills (default: 5) above the similarity threshold (default: 0.65) are injected into the system prompt as a `## Learned Skills` section, just before the memory context.

The agent sees these skills as trusted instructions and applies them without further prompting.

## Deduplication

Before a new skill is saved, orager checks whether a semantically similar skill already exists (similarity > 0.92 by default). If a near-duplicate is found, the existing skill's `useCount` is incremented rather than creating a new entry.

## Skill Lifecycle

Each skill tracks:

| Field | Description |
|-------|-------------|
| `useCount` | How many times it has been retrieved and injected |
| `successRate` | Fraction of runs where it was injected and the run succeeded |
| `createdAt` / `updatedAt` | Timestamps |
| `retentionDays` | Skills unused for this many days are pruned (default: 30) |

## CLI Commands

### List skills

```bash
orager skills list
```

### Inspect a skill

```bash
orager skills show <id>
```

### Delete a skill

```bash
orager skills delete <id>
```

### View statistics

```bash
orager skills stats
```

Output includes total skill count, average success rate, top skills by use count, and underperforming skills.

### Manual extraction

Extract skills from a session manually (without waiting for auto-extract):

```bash
orager skills extract
```

## Configuration

SkillBank is configured in `settings.json` under `skillbank`:

```json
{
  "skillbank": {
    "enabled": true,
    "autoExtract": true,
    "maxSkills": 500,
    "topK": 5,
    "similarityThreshold": 0.65,
    "deduplicationThreshold": 0.92,
    "retentionDays": 30,
    "extractionModel": ""
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Enable or disable SkillBank entirely |
| `autoExtract` | `true` | Automatically extract skills after successful runs |
| `maxSkills` | `500` | Hard cap on total stored skills |
| `topK` | `5` | Number of skills injected per run |
| `similarityThreshold` | `0.65` | Minimum cosine similarity for a skill to be retrieved |
| `deduplicationThreshold` | `0.92` | Skills above this similarity are treated as duplicates |
| `retentionDays` | `30` | Days before an unused skill is pruned |
| `extractionModel` | session model | Model used for skill extraction. Leave blank to use the session model |

## OMLS: Opportunistic Model Learning System

OMLS (ADR-0007) extends SkillBank to full RL-based fine-tuning. When enabled, orager accumulates (prompt, trajectory, reward) tuples from your runs and periodically trains LoRA adapters on a VPS burst instance.

The trained adapter is then used for routing: high-confidence prompts are sent to the local adapter, low-confidence prompts fall back to a cloud provider.

OMLS is **disabled by default** and is an advanced feature. Manage training runs with:

```bash
orager skill-train           # trigger a training run
orager skill-train --status  # check training job status
orager skill-train --rollback  # roll back to the previous adapter
orager skill-train --setup-cron  # install an automatic nightly cron job
```

Enable OMLS in `settings.json`:

```json
{
  "omls": {
    "enabled": true
  }
}
```
