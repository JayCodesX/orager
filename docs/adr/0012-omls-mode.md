# ADR-0012: OMLS Mode — Graduated Learning from Prompt to LoRA

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-04-04 |
| **Deciders** | JayCodesX |

---

## Context

OMLS (ADR-0007) has a binary on/off switch (`omls.enabled`). This creates a friction point for new users:

- **Too aggressive**: `enabled: true` immediately starts collecting trajectories for LoRA training, implying cloud spend (~$1.25/run on RunPod) even for users with only a handful of sessions.
- **No middle path**: Users who want SkillBank-only learning (free, no cloud, no VPS) have no clean config path — they must leave `omls.enabled: false`, which also disables trajectory logging.

The desired progression is:
1. **Day 1**: SkillBank accumulates strategies (prompt-level learning, zero cost).
2. **Day N** (enough data): Upgrade to LoRA training for weight-level personalization.

---

## Decision

Add an `omls.mode` field with three values:

| Mode | Behaviour |
|---|---|
| `"prompt"` | SkillBank only. Trajectory logging active, but LoRA training is permanently disabled. No cloud spend. |
| `"lora"` | Always train LoRA adapters when idle + buffer conditions are met. Previous behaviour. |
| `"auto"` | Starts in prompt mode. Transitions to LoRA training once active skill count ≥ `autoLoraThreshold`. Default. |

---

## Architecture

### Scheduler Gate (`omls/scheduler.ts`)

`checkSchedulerConditions()` reads `cfg.mode ?? "auto"` before any other check:

- `"prompt"` → return immediately with `shouldTrain: false`.
- `"auto"` → query live SkillBank skill count. If count < `autoLoraThreshold`, return `shouldTrain: false` with a descriptive reason. Once threshold is met, log a one-time notice and proceed to standard idle + buffer checks.
- `"lora"` → skip mode checks, proceed to standard checks.

### Training Pipeline Guard (`omls/training-pipeline.ts`)

Belt-and-suspenders: `runTrainingPipeline()` also checks `mode === "prompt"` and returns an error immediately. Prevents LoRA runs that bypass the scheduler (e.g., `orager skill-train --rl --force`).

### Status Display (`orager skill-train --status`)

```
OMLS mode:           auto (prompt until 150 active skills, then LoRA)
```

---

## Config

Added to `OmlsConfig` in `settings.json`:

| Field | Type | Default | Description |
|---|---|---|---|
| `mode` | `"prompt" \| "lora" \| "auto"` | `"auto"` | Learning mode. |
| `autoLoraThreshold` | `number` | `150` | Skill count at which `auto` mode transitions to LoRA training. |

Example `settings.json`:

```json
{
  "omls": {
    "enabled": true,
    "mode": "auto",
    "autoLoraThreshold": 150
  }
}
```

---

## Consequences

### Positive
- New users get SkillBank for free with zero cloud commitment.
- LoRA training becomes an explicit upgrade with a clear trigger condition.
- `"prompt"` mode documents intent — no ambiguity about whether training is accidentally disabled.
- The graduated `"auto"` path ensures users have enough training data (≥ 150 distilled skills) before the first LoRA run, improving adapter quality.

### Negative
- An extra config field to explain in docs and validate.
- `"auto"` interacts with the skill merge pipeline (ADR-0011): merging can temporarily drop active skill count below `autoLoraThreshold`, briefly reverting to prompt behaviour. Document this interaction.

### Default Behaviour Change

The default `"auto"` mode means existing users with `omls.enabled: true` and fewer than 150 active skills will see LoRA training gated. This is intentional — existing behaviour (training with few trajectories) produced weak adapters. Users who want the old behaviour can set `mode: "lora"` explicitly.
