import type {
  JSONOutputFormat,
  Message,
  MessageCreateParamsNonStreaming,
  MessageParam,
  OutputConfig,
  Tool,
  ToolChoice,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type { Logger } from "pino";
import { MODELS, type ModelId } from "../config/env.js";
import type { UsageStore } from "../db/llm-usage.js";
import { localDate, monthStart } from "../utils/dates.js";
import {
  BudgetExceededError,
  type BudgetLevel,
  budgetLevel,
  calculateCostEur,
  crossedLevels,
} from "./budget.js";
import { buildSystemPrompt } from "./system-prompt.js";

// The single entry point for every Claude API call (CLAUDE.md, stack doc §6).
// No other module calls `messages.create` / `messages.stream`.

type Effort = NonNullable<OutputConfig["effort"]>;

type CallPolicy = {
  model: ModelId;
  // Sonnet only — Haiku has no adaptive thinking / effort controls.
  effort?: Effort;
  maxTokens: number;
};

// ADR-005. `chat` is what the router (classifier.ts) picks when a message touches training
// but isn't clearly a plan change or an analysis: Sonnet (when uncertain, default to
// Sonnet) at low effort. `deep` is `/deep <message>`.
export const CALL_POLICIES = {
  chat: { model: MODELS.sonnet, effort: "low", maxTokens: 16_000 },
  plan_generation: { model: MODELS.sonnet, effort: "medium", maxTokens: 16_000 },
  plan_adjustment: { model: MODELS.sonnet, effort: "low", maxTokens: 16_000 },
  analysis: { model: MODELS.sonnet, effort: "medium", maxTokens: 16_000 },
  deep: { model: MODELS.sonnet, effort: "medium", maxTokens: 16_000 },
  quick_chat: { model: MODELS.haiku, maxTokens: 4_000 },
  activity_summary: { model: MODELS.haiku, maxTokens: 2_000 },
  knowledge_qa: { model: MODELS.haiku, maxTokens: 4_000 },
  // Monthly memory job (memory.ts).
  conversation_summary: { model: MODELS.haiku, maxTokens: 2_000 },
} as const satisfies Record<string, CallPolicy>;

export type CallType = keyof typeof CALL_POLICIES;

export type MessagesApi = {
  create(body: MessageCreateParamsNonStreaming): PromiseLike<Message>;
};

export type ClaudeDeps = {
  messages: MessagesApi;
  usage: Pick<UsageStore, "record" | "spendSince">;
  logger: Logger;
  monthlyBudgetEur: number;
  timeZone: string;
  disableThinking: boolean;
  // Fired once per threshold crossed by a call (e.g. to send a Telegram alert).
  onBudgetLevel?: (level: BudgetLevel, spendEur: number) => Promise<void>;
  now?: () => Date;
};

export type ClaudeRequest = {
  callType: CallType;
  messages: MessageParam[];
  dynamicContext?: string;
  // Rendered before the system prompt, so part of the cached prefix: pass a fixed list.
  tools?: Tool[];
  // `auto` or `none` only: forced tool choice doesn't combine with thinking.
  toolChoice?: Extract<ToolChoice, { type: "auto" | "none" }>;
  // Structured output (stack doc §6): the reply's text block is JSON matching the schema.
  outputFormat?: JSONOutputFormat;
};

export type ClaudeResult = {
  message: Message;
  model: ModelId;
  costEur: number;
};

export type Claude = {
  call(request: ClaudeRequest): Promise<ClaudeResult>;
  monthSpendEur(): Promise<number>;
};

export function createClaude(deps: ClaudeDeps): Claude {
  const log = deps.logger.child({ module: "claude" });
  const now = deps.now ?? (() => new Date());

  const today = () => localDate(now(), deps.timeZone);
  const monthSpendEur = () => deps.usage.spendSince(monthStart(today()));

  function buildParams(
    request: ClaudeRequest,
    model: ModelId,
    policy: CallPolicy,
  ): MessageCreateParamsNonStreaming {
    const params: MessageCreateParamsNonStreaming = {
      model,
      max_tokens: policy.maxTokens,
      system: buildSystemPrompt(request.dynamicContext),
      messages: request.messages,
    };
    if (request.tools) params.tools = request.tools;
    if (request.toolChoice) params.tool_choice = request.toolChoice;
    const outputConfig: OutputConfig = {};
    if (request.outputFormat) outputConfig.format = request.outputFormat;

    // Sonnet 5 thinks adaptively when `thinking` is omitted, so "off" must be explicit.
    if (model === MODELS.sonnet) {
      if (deps.disableThinking || !policy.effort) {
        params.thinking = { type: "disabled" };
      } else {
        params.thinking = { type: "adaptive" };
        outputConfig.effort = policy.effort;
      }
    }
    if (Object.keys(outputConfig).length > 0) params.output_config = outputConfig;
    return params;
  }

  return {
    monthSpendEur,

    async call(request) {
      const spendBefore = await monthSpendEur();
      const level = budgetLevel(spendBefore, deps.monthlyBudgetEur);
      if (level === "minimal" || level === "stopped") {
        throw new BudgetExceededError(level, spendBefore);
      }

      const policy: CallPolicy = CALL_POLICIES[request.callType];
      const model = level === "haiku_only" ? MODELS.haiku : policy.model;
      const message = await deps.messages.create(buildParams(request, model, policy));

      const { usage } = message;
      const costEur = calculateCostEur(model, usage);
      await deps.usage.record({
        date: today(),
        model,
        callType: request.callType,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
        cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
        costEur,
      });

      log.info(
        {
          callType: request.callType,
          model,
          stopReason: message.stop_reason,
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cacheCreationInputTokens: usage.cache_creation_input_tokens,
          cacheReadInputTokens: usage.cache_read_input_tokens,
          costEur,
        },
        "claude call",
      );

      const spendAfter = spendBefore + costEur;
      for (const crossed of crossedLevels(spendBefore, spendAfter, deps.monthlyBudgetEur)) {
        log.warn({ level: crossed, spendEur: spendAfter }, "budget threshold crossed");
        await deps.onBudgetLevel?.(crossed, spendAfter);
      }

      return { message, model, costEur };
    },
  };
}
