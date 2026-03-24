import type {
  AgentLoopOptions,
  AssistantMessage,
  Message,
  OpenRouterUsage,
  SystemMessage,
  ToolCall,
  TurnContext,
  UserMessage,
} from "./types.js";
import { loadSession, saveSession, newSessionId } from "./session.js";
import { callWithRetry } from "./retry.js";
import { loadSkillsFromDirs, buildSkillsSystemPrompt, buildSkillTools } from "./skills.js";
import { ALL_TOOLS, finishTool } from "./tools/index.js";
import { FINISH_TOOL_NAME } from "./tools/finish.js";
import { promptApproval } from "./approval.js";

// ── Concurrency helper ────────────────────────────────────────────────────────

/**
 * Run `fn` over every item with at most `limit` concurrent executions.
 * Results are returned in the same order as the input array.
 */
async function runConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    worker,
  );
  await Promise.all(workers);
  return results;
}

const MAX_PARALLEL_TOOLS = 10;

// ── Agent loop ────────────────────────────────────────────────────────────────

export async function runAgentLoop(opts: AgentLoopOptions): Promise<void> {
  const {
    prompt,
    model,
    apiKey,
    addDirs,
    maxTurns,
    cwd,
    verbose: _verbose,
    onEmit,
    onLog,
  } = opts;

  const maxRetries = opts.maxRetries ?? 3;
  const forceResume = opts.forceResume ?? false;

  // ── Safety warning ────────────────────────────────────────────────────────
  if (opts.dangerouslySkipPermissions) {
    onLog?.(
      "stderr",
      "[orager] WARNING: --dangerously-skip-permissions is active — all tool approvals are bypassed\n",
    );
  }

  // ── 1. Load or create session ─────────────────────────────────────────────
  let sessionId: string;
  let messages: Message[] = [];
  let createdAt: string = new Date().toISOString();
  let isResume = false;

  if (opts.sessionId) {
    const existing = await loadSession(opts.sessionId);
    if (existing && (forceResume || existing.cwd === cwd)) {
      sessionId = existing.sessionId;
      messages = existing.messages;
      createdAt = existing.createdAt;
      isResume = true;
      if (forceResume && existing.cwd !== cwd) {
        onLog?.(
          "stderr",
          `[orager] warning: resuming session ${opts.sessionId} from different cwd (was ${existing.cwd}, now ${cwd})\n`,
        );
      }
    } else {
      if (existing) {
        onLog?.(
          "stderr",
          `[orager] warning: session ${opts.sessionId} has a different cwd (${existing.cwd}), starting fresh (use --force-resume to override)\n`,
        );
      } else {
        onLog?.(
          "stderr",
          `[orager] warning: session ${opts.sessionId} not found, starting fresh\n`,
        );
      }
      sessionId = newSessionId();
    }
  } else {
    sessionId = newSessionId();
  }

  // ── 2. Build system prompt + tool list ────────────────────────────────────
  let systemPrompt =
    "You are an autonomous software engineering agent. Work through the user's task completely using the available tools. Think step by step. When you are done, provide a concise summary of what you accomplished.";

  const skills = await loadSkillsFromDirs(addDirs);
  const skillsSection = buildSkillsSystemPrompt(skills);
  if (skillsSection) {
    systemPrompt += "\n\n" + skillsSection;
  }

  // Merge: built-in tools + skill tools + finish tool (opt-in) + caller-supplied extra tools
  const allTools = [
    ...ALL_TOOLS,
    ...buildSkillTools(skills),
    ...(opts.useFinishTool ? [finishTool] : []),
    ...(opts.extraTools ?? []),
  ];

  // Warn about duplicate tool names (first definition wins via find())
  const seenToolNames = new Set<string>();
  for (const tool of allTools) {
    const name = tool.definition.function.name;
    if (seenToolNames.has(name)) {
      onLog?.("stderr", `[orager] warning: duplicate tool name '${name}' — first definition takes precedence\n`);
    } else {
      seenToolNames.add(name);
    }
  }

  systemPrompt += "\n\nWorking directory: " + cwd;

  // ── 3. Emit init ──────────────────────────────────────────────────────────
  onEmit({ type: "system", subtype: "init", model, session_id: sessionId });

  // ── 4. Assemble initial messages ──────────────────────────────────────────
  const userMessage: UserMessage = { role: "user", content: prompt };

  if (isResume) {
    messages = [...messages, userMessage];
  } else {
    const systemMessage: SystemMessage = { role: "system", content: systemPrompt };
    messages = [systemMessage, userMessage];
  }

  // ── 5. Agent loop ─────────────────────────────────────────────────────────
  let turn = 0;
  let cumulativeUsage: OpenRouterUsage = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
  let cumulativeCachedTokens = 0;
  let totalCostUsd = 0;
  let lastResponseModel = model;
  let lastFinishReason: string | null = null;
  let lastAssistantText = "";

  // Helper: execute a single tool call, returning its result content and error flag.
  // Never throws — all errors are captured as error tool results.
  async function executeOne(toolCall: ToolCall): Promise<{ id: string; content: string; isError: boolean }> {
    const toolName = toolCall.function.name;
    const executor = allTools.find((t) => t.definition.function.name === toolName);

    if (!executor) {
      return { id: toolCall.id, content: `Unknown tool: ${toolName}`, isError: true };
    }

    let parsedInput: Record<string, unknown>;
    try {
      parsedInput = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
    } catch {
      return {
        id: toolCall.id,
        content: `Invalid JSON arguments for tool ${toolName}: ${toolCall.function.arguments}`,
        isError: true,
      };
    }

    // ── Delegated tool ──────────────────────────────────────────────────────
    if (executor.execute === false) {
      if (opts.onToolCall) {
        try {
          const result = await opts.onToolCall(toolName, parsedInput);
          return {
            id: toolCall.id,
            content: result ?? "(delegated tool returned no result)",
            isError: result === null,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { id: toolCall.id, content: `Delegated tool '${toolName}' threw: ${msg}`, isError: true };
        }
      }
      return {
        id: toolCall.id,
        content: `Tool '${toolName}' requires external handling but no onToolCall handler was provided`,
        isError: true,
      };
    }

    // ── Approval check ──────────────────────────────────────────────────────
    if (!opts.dangerouslySkipPermissions && opts.requireApproval != null) {
      const needsApproval =
        opts.requireApproval === "all" ||
        (Array.isArray(opts.requireApproval) && opts.requireApproval.includes(toolName));

      if (needsApproval) {
        const approve = opts.onApprovalRequest
          ? await opts.onApprovalRequest(toolName, parsedInput)
          : await promptApproval(toolName, parsedInput);
        if (!approve) {
          return { id: toolCall.id, content: `Tool '${toolName}' was denied by the user`, isError: true };
        }
      }
    }

    try {
      const result = await executor.execute(parsedInput, cwd, { sandboxRoot: opts.sandboxRoot });
      return { id: toolCall.id, content: result.content, isError: result.isError };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { id: toolCall.id, content: `Tool threw an unexpected error: ${msg}`, isError: true };
    }
  }

  try {
    // maxTurns <= 0 means unlimited
    while (maxTurns <= 0 || turn < maxTurns) {
      // ── Per-turn dynamic overrides ────────────────────────────────────────
      const turnCtx: TurnContext = {
        turn,
        model: lastResponseModel,
        cumulativeTokens: {
          prompt: cumulativeUsage.prompt_tokens,
          completion: cumulativeUsage.completion_tokens,
          total: cumulativeUsage.total_tokens,
        },
        cumulativeCostUsd: totalCostUsd,
        messages,
      };
      const turnOverrides = opts.onTurnStart?.(turnCtx) ?? {};

      const response = await callWithRetry(
        {
          apiKey,
          model: turnOverrides.model ?? model,
          models: opts.models,
          messages,
          tools: allTools.map((t) => t.definition),
          temperature: turnOverrides.temperature ?? opts.temperature,
          top_p: turnOverrides.top_p ?? opts.top_p,
          top_k: turnOverrides.top_k ?? opts.top_k,
          max_tokens: turnOverrides.max_tokens,
          frequency_penalty: opts.frequency_penalty,
          presence_penalty: opts.presence_penalty,
          repetition_penalty: opts.repetition_penalty,
          min_p: opts.min_p,
          seed: opts.seed,
          stop: opts.stop,
          tool_choice: opts.tool_choice,
          parallel_tool_calls: opts.parallel_tool_calls,
          reasoning: turnOverrides.reasoning ?? opts.reasoning,
          provider: opts.provider,
          transforms: opts.transforms,
          siteUrl: opts.siteUrl,
          siteName: opts.siteName,
        },
        maxRetries,
        (msg) => onLog?.("stderr", msg),
      );

      // Mid-stream error after retries exhausted — treat as fatal loop error
      if (response.isError) {
        throw new Error(response.errorMessage ?? "OpenRouter stream error");
      }

      lastResponseModel = response.model;
      lastFinishReason = response.finishReason;

      // Accumulate usage
      cumulativeUsage.prompt_tokens += response.usage.prompt_tokens;
      cumulativeUsage.completion_tokens += response.usage.completion_tokens;
      cumulativeUsage.total_tokens += response.usage.total_tokens;
      cumulativeCachedTokens += response.cachedTokens;

      // Accumulate cost
      if (opts.costPerInputToken !== undefined || opts.costPerOutputToken !== undefined) {
        totalCostUsd +=
          (opts.costPerInputToken ?? 0) * response.usage.prompt_tokens +
          (opts.costPerOutputToken ?? 0) * response.usage.completion_tokens;
      }

      // Build assistant message and add to history
      const assistantMsg: AssistantMessage = {
        role: "assistant",
        content: response.content || null,
        tool_calls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
      };
      messages.push(assistantMsg);

      // Track last assistant text for result summary
      if (response.content) {
        lastAssistantText = response.content;
      }

      // Build content blocks for the emit event
      type ThinkingBlock = { type: "thinking"; thinking: string };
      type TextBlock = { type: "text"; text: string };
      type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
      const contentBlocks: Array<ThinkingBlock | TextBlock | ToolUseBlock> = [];

      if (response.reasoning) {
        contentBlocks.push({ type: "thinking", thinking: response.reasoning });
      }
      if (response.content) {
        contentBlocks.push({ type: "text", text: response.content });
      }
      for (const toolCall of response.toolCalls) {
        let parsedInput: Record<string, unknown> = {};
        try {
          parsedInput = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
        } catch {
          parsedInput = { _raw: toolCall.function.arguments };
        }
        contentBlocks.push({ type: "tool_use", id: toolCall.id, name: toolCall.function.name, input: parsedInput });
      }

      onEmit({ type: "assistant", message: { role: "assistant", content: contentBlocks } });

      // Only break when there are truly no tools to execute
      if (response.toolCalls.length === 0) {
        break;
      }

      // ── Execute tool calls (sequential or parallel with concurrency cap) ──
      const toolResults = opts.parallel_tool_calls
        ? await runConcurrent(response.toolCalls, MAX_PARALLEL_TOOLS, executeOne)
        : await (async () => {
            const results = [];
            for (const tc of response.toolCalls) results.push(await executeOne(tc));
            return results;
          })();

      type ToolEventItem = { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
      const toolEventContent: ToolEventItem[] = [];

      for (const { id, content: resultContent, isError } of toolResults) {
        messages.push({ role: "tool", tool_call_id: id, content: resultContent });
        toolEventContent.push({ type: "tool_result", tool_use_id: id, content: resultContent, is_error: isError || undefined });
      }

      onEmit({ type: "tool", content: toolEventContent });

      // ── Finish tool detection ─────────────────────────────────────────────
      if (opts.useFinishTool) {
        const finishCallId = response.toolCalls.find(
          (tc) => tc.function.name === FINISH_TOOL_NAME,
        )?.id;
        if (finishCallId) {
          const finishResult = toolResults.find((r) => r.id === finishCallId);
          if (finishResult && !finishResult.isError) {
            lastAssistantText = finishResult.content || lastAssistantText;
          }
          break;
        }
      }

      // ── Cost limit check ──────────────────────────────────────────────────
      if (opts.maxCostUsd !== undefined && totalCostUsd >= opts.maxCostUsd) {
        onLog?.(
          "stderr",
          `[orager] cost limit reached ($${totalCostUsd.toFixed(6)} >= $${opts.maxCostUsd}) — stopping\n`,
        );

        await saveSession({
          sessionId,
          model: lastResponseModel,
          messages,
          createdAt,
          updatedAt: new Date().toISOString(),
          turnCount: turn,
          cwd,
        }).catch(() => {});

        onEmit({
          type: "result",
          subtype: "error_max_cost",
          result: lastAssistantText,
          session_id: sessionId,
          usage: {
            input_tokens: cumulativeUsage.prompt_tokens,
            output_tokens: cumulativeUsage.completion_tokens,
            cache_read_input_tokens: cumulativeCachedTokens,
          },
          total_cost_usd: totalCostUsd,
        });
        return;
      }

      turn++;
    }

    // ── 6. After loop ─────────────────────────────────────────────────────
    const subtype = maxTurns > 0 && turn >= maxTurns ? "error_max_turns" : "success";

    // Best-effort session save — a write failure should not turn a successful run into an error
    try {
      await saveSession({
        sessionId,
        model: lastResponseModel,
        messages,
        createdAt,
        updatedAt: new Date().toISOString(),
        turnCount: turn,
        cwd,
      });
    } catch {
      // ignore save failure on success path
    }

    onEmit({
      type: "result",
      subtype,
      result: lastAssistantText,
      session_id: sessionId,
      usage: {
        input_tokens: cumulativeUsage.prompt_tokens,
        output_tokens: cumulativeUsage.completion_tokens,
        cache_read_input_tokens: cumulativeCachedTokens,
      },
      total_cost_usd: totalCostUsd,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    // Best-effort session save
    try {
      await saveSession({
        sessionId,
        model: lastResponseModel,
        messages,
        createdAt,
        updatedAt: new Date().toISOString(),
        turnCount: turn,
        cwd,
      });
    } catch {
      // ignore save failure during error handling
    }

    onEmit({
      type: "result",
      subtype: "error",
      result: message,
      session_id: sessionId,
      usage: {
        input_tokens: cumulativeUsage.prompt_tokens,
        output_tokens: cumulativeUsage.completion_tokens,
        cache_read_input_tokens: cumulativeCachedTokens,
      },
      total_cost_usd: totalCostUsd,
    });
  }

  // suppress unused variable warnings
  void lastFinishReason;
}
