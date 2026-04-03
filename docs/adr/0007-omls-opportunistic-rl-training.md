# ADR-0007: OMLS — Opportunistic RL Training with VPS Burst, Confidence Routing, and Teacher Distillation

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-04-02 |
| **Deciders** | JayCodesX |

---

## Context

### The ceiling of prompt-level adaptation

ADR-0006 (SkillBank) implements MetaClaw's fast-adaptation loop: failure trajectories are distilled into skill instructions and injected into the system prompt. This works with any model, requires no GPU, and takes effect immediately. However, skill injection operates at the prompt level — it changes what the model is told, not what the model knows. The base model's weights are unchanged.

For tasks that fall outside the distribution of any open-weights model's pretraining — highly specific coding patterns, project-specific conventions, idiosyncratic tool-use sequences — prompt injection has a ceiling. The model can be reminded of a strategy it has seen before; it cannot be taught a fundamentally new capability through prompting alone.

Reinforcement learning on model weights removes this ceiling. A RL-trained model internalises strategies into its weights, generalises across task variations without explicit skill injection, and progressively approaches frontier model capability on the specific workload it has been trained on.

### The MetaClaw dual-loop architecture

MetaClaw implements two complementary learning mechanisms that operate on different timescales and require different infrastructure:

1. **Skill-driven fast adaptation** (ADR-0006) — immediate, prompt-level, zero infrastructure
2. **Opportunistic policy optimisation** — weight-level, deferred to idle windows, requires a training backend

The two loops are mutually reinforcing: a better policy generates more informative failure trajectories for skill extraction; richer skills produce higher-reward trajectories for RL training. Implementing both loops realises the full MetaClaw architecture.

### The Opportunistic Meta-Learning Scheduler (OMLS)

RL training is expensive enough that it cannot run inline with agent execution. MetaClaw's OMLS defers weight updates to windows when the user is provably idle — detected via sleep hours, keyboard inactivity, and calendar occupancy. This allows continuous learning without ever competing with active work for compute or API budget.

### Why VPS burst over local GPU

Training a LoRA adapter on a 7B–14B model via GRPO requires a GPU with ≥ 8GB VRAM for the training job itself. Most orager users do not have a dedicated local GPU, and keeping one idle between training jobs wastes electricity and money. The VPS burst model — spin up an on-demand GPU for the duration of the training job then terminate it — eliminates idle cost entirely:

| Provider | GPU | Cost/hr | Typical LoRA job (3–4 hrs) |
|---|---|---|---|
| Vast.ai | RTX 4090 | ~$0.25–0.31 | ~$0.75–1.25 |
| RunPod | RTX 4090 | ~$0.34 | ~$1.00–1.36 |
| TensorDock | RTX 4090 | ~$0.35 | ~$1.05–1.40 |

A VPS LoRA run costs **< $1.50** and produces a weight update that persists indefinitely. For comparison, calling Claude Sonnet for a single complex task costs $0.003–0.03; a VPS training run is equivalent to 50–500 Claude calls but improves every future run.

### Why not Tinker or Together AI as the training backend

Both Tinker (Thinking Machines Lab) and Together AI offer managed LoRA fine-tuning APIs:

- **Tinker**: ~$10/run, private beta with waitlist, supports Kimi-2.5 and open-weights models
- **Together AI**: ~$14/run for 7B models (LoRA), open access, serves fine-tuned models at base model prices

At **8–10× the cost per run** of VPS burst, managed APIs are not the right default for frequent OMLS cycles. However, they are valid alternatives for users who prefer zero infrastructure management. The orager OMLS backend is pluggable; Tinker and Together AI are supported as named backends alongside VPS providers.

### ToS compliance: the teacher model constraint

OpenRouter's distillation documentation states that model outputs may only be used as training data if the model's `is_trainable_text` property is `true`. Anthropic's API Terms explicitly prohibit using Claude outputs to train models that compete with Anthropic's products.

A personal fine-tuned model is arguably not a Claude competitor, but Anthropic has enforced the prohibition broadly (including revoking API access from other AI labs in 2025). To avoid ambiguity, **Claude is excluded from the teacher model role entirely**. All escalation calls that produce training data must use models with `is_trainable_text=true`.

This is not a meaningful capability limitation: DeepSeek R1, Qwen3-72B, and Llama 4 Maverick are competitive with Claude Sonnet on the code, reasoning, and structured-output tasks orager handles — and all explicitly permit distillation.

### Decision drivers

- RL training must never block or degrade active `orager run` sessions
- Training cost per cycle must be < $2 for the default VPS burst path
- The teacher model must always be a distillation-permitted model; this must be enforced by the orager pipeline, not left to the user
- Confidence routing between the RL model and the teacher model must be deterministic and auditable
- Local GPU training is a valid path but is deferred to a future ADR — this ADR targets users without a local GPU
- All components are opt-in; orager without ADR-0007 configuration behaves identically to orager today

---

## Decision

Implement the OMLS opportunistic RL training system: a cron-triggered, idle-gated pipeline that collects trajectory batches, scores them with a process reward model, runs GRPO/OPSD on a VPS GPU, uploads the resulting LoRA adapter to Together AI for hosted inference, and updates orager's active model endpoint. Pair this with a confidence router that determines per-request whether the RL-trained model or the teacher model should handle the task.

### Solution

#### 1. The confidence router

Every `orager run` is evaluated by the confidence router before the model call is made. The router produces one of two outcomes: **serve locally** (use the RL-trained model endpoint) or **escalate** (use the teacher model via OpenRouter).

The router applies three signals in order of cost:

**Signal 1 — Task classifier (free, ~1ms)**
A lightweight embedding-based classifier trained on labelled examples of easy vs. hard tasks for orager's workload. Checks whether the incoming prompt matches known hard-task patterns: cross-repository reasoning, novel architecture decisions, multi-modal content, multi-constraint instruction sets. If matched, escalates immediately without an inference call.

**Signal 2 — Self-reported confidence token (free, from model output)**
After GRPO training with Self-REF (arXiv 2410.13284), the RL model is trained to emit a calibrated confidence score alongside its response. The score is extracted from the model's output before streaming to the user. If the score falls below the configured threshold (default: `0.40`), the run is re-attempted on the teacher model.

**Signal 3 — Semantic entropy gate (cheap, ~50ms, 3 short inference calls)**
For borderline cases where the task classifier is uncertain and the confidence token is near the threshold, the router samples N=3 completions from the RL model at temperature 0.8 and measures semantic agreement. High divergence (entropy > 0.7) triggers escalation. This signal is only activated when signals 1 and 2 are inconclusive, so it fires rarely in practice.

**Standing gates (always active, from orager's existing `turnModelRules`)**
```yaml
turnModelRules:
  - costAbove: 0.05          # run cost exceeded → escalate
    model: "${teacherModel}"
  - afterTurn: 8             # unresolved after N turns → escalate
    model: "${teacherModel}"
```

The router is fully auditable: every routing decision is logged with the triggering signal and the selected model. `orager stats` surfaces routing ratios (% RL model vs. teacher) over any time window.

#### 2. Teacher model escalation with distillation tagging

When the router escalates to the teacher model, the call is made via OpenRouter with:

```
enforce_distillable_text: true   ← OpenRouter API parameter
```

This guarantees the request is only routed to models where `is_trainable_text=true`. If no distillable model meets the quality threshold for the request, OpenRouter returns an error and orager falls back to the RL model with a warning. Claude and any other `is_trainable_text=false` model are never selected.

The teacher model preference order (configurable):
```yaml
omls:
  teacherModels:
    - deepseek/deepseek-r1          # default: strong reasoning, distillable
    - qwen/qwen3-72b                # fallback: GPT-4o class, distillable
    - meta-llama/llama-4-maverick   # fallback: general, distillable
```

Every teacher model response is tagged in the trajectory log:
```json
{ "distillable": true, "teacherModel": "deepseek/deepseek-r1", "signal": "confidence_token" }
```

Only trajectories tagged `distillable: true` are eligible for OPSD training. This is enforced by the training pipeline, not left to configuration.

#### 3. The OMLS scheduler

A cron job runs every 15 minutes and evaluates three idle signals before proceeding:

```
*/15 * * * * orager skill-train --rl --require-idle
```

**Idle signal evaluation:**

| Signal | Detection method | Platform |
|---|---|---|
| Sleep hours | Configurable window: `sleepStart`/`sleepEnd` | All |
| Keyboard idle | `ioreg -c IOHIDSystem` idle time | macOS |
| Keyboard idle | `xprintidle` | Linux |
| Calendar occupancy | Google Calendar API (optional) | All |

If any signal indicates the user is idle, the training window opens. If the user becomes active mid-job (keystroke detected), the VPS job is not interrupted — it runs to completion — but the next cron invocation re-checks idleness before starting a new job. Training jobs are idempotent; a completed job that was interrupted before upload simply re-uploads on the next idle window.

**Minimum batch requirement:**
Training is only triggered when the distillable trajectory buffer contains ≥ 32 samples. Below this threshold, GRPO gradient estimates are too noisy to produce stable weight updates (per MetaClaw paper §4.2). The cron job exits silently if the buffer is below threshold.

```yaml
omls:
  schedule: "*/15 * * * *"       # how often OMLS checks idle state
  sleepStart: "23:00"            # start of guaranteed idle window
  sleepEnd: "07:00"              # end of guaranteed idle window
  idleThresholdMinutes: 10       # keyboard idle duration before training starts
  minBatchSize: 32               # minimum trajectory buffer before RL fires
  calendarCredentials: ""        # path to Google Calendar credentials (optional)
```

#### 4. VPS burst training pipeline

When the OMLS scheduler opens a training window and the buffer is sufficient:

```
Step 1: Package trajectory batch
  orager packages the 32+ distillable trajectories into a training bundle:
  prompts, teacher responses, PRM reward scores, skill version tags
  Output: ~/.orager/training/batch-<timestamp>.tar.gz (~5–50MB)

Step 2: PRM scoring (process reward model)
  Each trajectory turn is scored by a judge LLM call (configurable model,
  default: same as teacher model). Score = [0.0, 1.0] per turn.
  Scored batch is appended to the training bundle.
  Cost: ~$0.002–0.01 per batch (32 trajectories × ~5 turns each)

Step 3: Spin up VPS GPU
  orager calls the configured VPS provider API (Vast.ai or RunPod):
  - Request: RTX 4090, prebuilt Unsloth image, spot/interruptible
  - Wait for instance ready (typically 60–120s)
  - Upload training bundle via scp

Step 4: Run GRPO/OPSD training
  Remote execution of Unsloth GRPO or OPSD depending on batch composition:
  - GRPO: used when batch contains only RL model trajectories (no teacher signal)
  - OPSD: used when batch contains teacher model responses (preferred — 8–12x
    more sample-efficient, token-level supervision from teacher)
  Training duration: 2–4 hours on RTX 4090 for a 7B model, 1 epoch
  Output: LoRA adapter checkpoint (~200MB–1GB)

Step 5: Download adapter + terminate GPU
  scp the adapter back to ~/.orager/adapters/v<N>/
  Terminate the VPS instance immediately — no idle GPU time
  Total GPU cost: ~$0.75–1.50

Step 6: Upload adapter to Together AI
  POST adapter to Together AI fine-tune hosting API
  Together AI serves the fine-tuned model at base model inference prices
  Returns a hosted model endpoint: together/orager-ft-v<N>

Step 7: Atomic endpoint swap
  orager updates ~/.orager/config.yaml:
    model: "together/orager-ft-v<N>"
  All subsequent runs use the new weights automatically
  No restart required

Step 8: Log and notify
  Structured log entry: version, cost, training duration, PRM score delta
  Terminal notification (if configured): "RL update v{N} complete — $1.23 spent"
  Purge stale trajectories: clear buffer of trained samples (support-query separation)
```

#### 5. Support-query trajectory separation

To prevent gradient pollution (per MetaClaw §5.1), trajectories are versioned by the SkillBank generation active when they were produced. When a new skill generation is written (ADR-0006 SkillBank update), the trajectory buffer is partitioned:

- **Pre-adaptation trajectories** (produced under the old skill generation) are excluded from the next RL batch
- **Post-adaptation trajectories** are retained for RL
- The buffer is tagged with `skillGeneration: N` and the training pipeline enforces that only the latest generation's trajectories enter the GRPO/OPSD job

This ensures RL trains on the best available behaviour — not on failures that the SkillBank has already addressed.

#### 6. VPS backend configuration

```yaml
omls:
  rl:
    enabled: true
    backend: "vastai"              # vastai | runpod | tinker | together | mint
    vastai:
      apiKey: ""                   # VASTAI_API_KEY env var
      gpuType: "RTX_4090"
      imageId: "unsloth/unsloth:latest"
      spot: true                   # use interruptible instances for lowest cost
    runpod:
      apiKey: ""                   # RUNPOD_API_KEY env var
      gpuType: "NVIDIA RTX 4090"
      spot: true
    training:
      baseModel: "unsloth/Qwen2.5-7B-Instruct"
      method: "auto"               # auto | grpo | opsd
      loraRank: 16
      loraAlpha: 32
      epochs: 1
      batchSize: 4
      learningRate: 2e-5
    hosting:
      provider: "together"         # together | fireworks
      together:
        apiKey: ""                 # TOGETHER_API_KEY env var
```

#### 7. Manual trigger

For users who want to run a training cycle on demand without waiting for idle detection:

```bash
orager skill-train --rl                    # full pipeline: PRM score → VPS → upload
orager skill-train --rl --dry-run          # estimate cost, print plan, do nothing
orager skill-train --rl --backend runpod   # override backend for this run
orager skill-train --status                # show current RL model version + batch size
orager skill-train --rollback              # revert to previous adapter version
```

---

## Alternatives Considered

### 1. Local GPU training

Run GRPO/OPSD locally using Unsloth + vLLM, with LoRA hot-swap via vLLM's REST API (`/v1/load_lora_adapter`). Eliminates VPS cost entirely for users with a local GPU (≥ 8GB VRAM for 7B model, ≥ 24GB for 14B).

**Deferred, not rejected.** Local GPU training is the ideal path for power users with appropriate hardware and will be implemented in a future ADR. The VPS burst path is the default because it works for all users regardless of hardware, and the architecture is identical — only the training execution location differs. The two paths share the same OMLS scheduler, PRM scoring, trajectory logging, and adapter upload steps.

### 2. Use Tinker or Together AI as the managed training backend (no VPS)

Offload all training to a managed LoRA API. No VPS, no scp, no remote execution.

**Available as a named backend, not the default.** At $10–14/run vs. ~$1.25/run for VPS burst, managed APIs are 8–10× more expensive. For users running weekly RL cycles, this difference is $500–700/year. VPS burst is the cost-efficient default. Users who prioritise zero infrastructure over cost can set `rl.backend: tinker` or `rl.backend: together`.

### 3. Use Claude as the teacher model

Route escalations to Claude (via OpenRouter) and use Claude's responses as OPSD training data for the RL model.

**Rejected.** Anthropic's API Terms prohibit using Claude outputs to train models that compete with Anthropic's products. While a personal fine-tuned model is arguably not a competitor, Anthropic has enforced this prohibition broadly and without a personal-use carve-out. The capability loss is negligible: DeepSeek R1 and Qwen3-72B match Claude Sonnet on code and reasoning tasks and explicitly permit distillation. The risk is not worth taking.

### 4. Confidence routing via post-generation self-consistency (majority vote)

Sample the RL model N=5 times per request and route to the teacher only when outputs disagree.

**Rejected as the primary signal.** Post-generation sampling adds latency proportional to N and increases cost by N×. Self-REF confidence tokens (trained into the model via GRPO) provide equivalent calibration signal at zero additional inference cost. Semantic entropy (N=3 samples) is retained as a secondary signal for borderline cases where the confidence token is inconclusive, but is never the primary routing gate.

### 5. Proxy local vLLM server to OpenRouter (apply LoRA to API calls)

Run a local vLLM server that intercepts orager's model calls, applies a LoRA adapter, then forwards to OpenRouter.

**Not feasible.** LoRA is a weight-level modification — it alters tensor values during the model's forward pass. vLLM executes the forward pass locally using the model's weights. OpenRouter executes the forward pass on their infrastructure using their copy of the model weights. There is no surface on which to inject a LoRA into a remote API call. This architecture would require vLLM to run the model locally, at which point it is no longer forwarding to OpenRouter — it is the inference server.

---

## Consequences

**Positive**
- Every RL training cycle produces a model that is measurably better on the user's specific workload — improvement compounds over weeks and months
- The teacher distillation loop means every escalation to DeepSeek R1 / Qwen3-72B is self-amortising: the RL model learns to handle that class of task autonomously, reducing future escalation costs
- Training cost is < $1.50/run on the VPS burst path — accessible to individual developers, not just teams with cloud budgets
- The confidence router makes the cost reduction trajectory explicit and auditable: routing ratios shift toward the RL model over time as capability improves
- Full ToS compliance: `enforce_distillable_text=true` is an API-enforced constraint, not a documentation note
- The local GPU path (future ADR) slots in by changing one config field (`rl.backend: local`)

**Negative / Trade-offs**
- OMLS requires VPS API credentials and a Together AI account — two external service dependencies not required today
- A failed VPS job (instance preemption, network error) loses the training round but not the trajectory data; the next OMLS cycle retries automatically. Robust error handling is required in the pipeline
- The RL-trained model is a fine-tuned open-weights model hosted on Together AI, not a zero-latency local binary — inference latency is network-dependent
- LoRA adapters are specific to the base model; changing the base model (e.g., Qwen2.5-7B → Qwen3-14B) requires retraining from scratch. Version management (`orager skill-train --rollback`) mitigates this but does not eliminate it
- PRM scoring quality depends on the judge model; a weak judge produces noisy rewards and unstable training. The judge model should be at least as capable as the teacher model

**Neutral**
- ADR-0006 (SkillBank) trajectory logging is a prerequisite; this ADR adds no new logging infrastructure, only the training pipeline on top of existing trajectory files
- `orager run` behaviour is unchanged when OMLS is not configured — this is a fully opt-in system
- OpenRouter prompt logging must be disabled for training runs to prevent OpenRouter from claiming commercial rights to the trajectory data (see OpenRouter ToS §4). orager sets this by default when `omls.rl.enabled: true`
