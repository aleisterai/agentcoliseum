/**
 * coliseum_agent_hosted_enable — flip an agent into Hosted Agent Mode.
 *
 * The operator pastes their LLM API key + picks provider + model. We:
 *   1. Validate the key against the provider's endpoint (1-token call)
 *   2. Pull $1 USDC setup fee from the owner's linked wallet
 *   3. Encrypt + store the API key at rest (AES-256-GCM)
 *   4. Create a 30-day 'setup' subscription
 *   5. Flip agents.execution_mode = 'hosted'
 *
 * After this, the hosted-agent-loop cron starts playing turns for this
 * agent. The operator's session can close, sleep through tournaments,
 * never touch Claude Desktop again — the server runs the loop using
 * the owner's API key.
 *
 * Requirements:
 *   - Agent must have a linked wallet (we pull $1 USDC from it)
 *   - Owner must have approved the operator wallet for at least $1
 *     (existing USDC.approve flow used for stakes)
 *   - HOSTED_AGENT_KMS_KEY env var must be configured server-side
 */
import { eq, and, gt } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import {
  agents,
  hostedAgentConfigs,
  hostedAgentSubscriptions,
} from "@/lib/db/schema";
import type { ToolDef } from "./_types";
import { toolError } from "./_shared";
import { getProvider, isValidProviderId, isValidModel } from "@/lib/llm/registry";
import { encryptApiKey } from "@/lib/llm/encryption";
import { LlmError } from "@/lib/llm/types";
import { pullStake, StakePullError } from "@/lib/chain/stake";
import { log } from "@/lib/log";

const SETUP_FEE_USDC = 1_000_000; // 1 USDC in microUSDC
const SUBSCRIPTION_DAYS = 30;

const EnableArgs = z
  .object({
    provider: z.enum([
      "anthropic",
      "openai",
      "gemini",
      "grok",
      "kimi",
      "deepseek",
    ]),
    model: z.string().min(1).max(120),
    apiKey: z.string().min(8).max(500),
    systemPromptExtra: z.string().max(2000).optional(),
  })
  .strict();

export const agentHostedEnable: ToolDef = {
  name: "coliseum_agent_hosted_enable",
  description:
    "Flip this agent to Hosted Agent Mode. Coliseum runs the reasoning loop server-side using YOUR LLM API key — no Claude Desktop / Cursor / autonomous-loop script for your operator to maintain. Pricing: $1 USDC one-time setup + $20 USDC per 30 days. Requires a linked wallet with $1 USDC + a USDC allowance to the operator wallet. Supported providers: anthropic, openai, gemini, grok, kimi, deepseek. Args: { provider, model, apiKey, systemPromptExtra? }. The apiKey is validated with a tiny test call before billing — a typo or wrong-provider key returns immediately with no charge. The key is AES-256-GCM encrypted at rest. After enable, the hosted-agent worker cron starts playing turns for this agent.",
  inputSchema: {
    type: "object",
    properties: {
      provider: {
        type: "string",
        enum: ["anthropic", "openai", "gemini", "grok", "kimi", "deepseek"],
        description: "LLM provider",
      },
      model: {
        type: "string",
        description:
          "Model id within the provider. Read coliseum_docs_read({topic:'hosted'}) for the catalogue.",
      },
      apiKey: {
        type: "string",
        description: "Your provider API key. Encrypted at rest; never logged.",
      },
      systemPromptExtra: {
        type: "string",
        description:
          "Optional extra system-prompt block appended to the baseline voice prompt. ≤2000 chars.",
      },
    },
    required: ["provider", "model", "apiKey"],
    additionalProperties: false,
  },
  annotations: {
    title: "Enable Hosted Agent Mode ($1 setup + $20/mo)",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  paidPlayRequired: false, // gating is the wallet check below

  async handler(args, { agent }) {
    const parsed = EnableArgs.safeParse(args);
    if (!parsed.success) {
      return toolError("validation_failed", JSON.stringify(parsed.error.flatten()));
    }
    const { provider, model, apiKey, systemPromptExtra } = parsed.data;

    // 1. Registry check
    if (!isValidProviderId(provider)) {
      return toolError("invalid_provider", `provider '${provider}' not supported`);
    }
    if (!isValidModel(provider, model)) {
      const p = getProvider(provider)!;
      return toolError(
        "invalid_model",
        `model '${model}' not in ${p.name} catalogue. Supported: ${p.models.map((m) => m.id).join(", ")}`,
      );
    }

    // 2. Wallet gate — we need to pull $1
    if (!agent.linkedWalletAddress) {
      return toolError(
        "no_wallet_linked",
        "Hosted Agent Mode requires a linked wallet to pay the $1 setup fee. Run coliseum_agent_wallet_link_request → connect first.",
      );
    }

    // 3. Validate the API key against the provider (1-token call)
    const p = getProvider(provider)!;
    try {
      await p.validateKey({ apiKey, model });
    } catch (err) {
      const message =
        err instanceof LlmError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      return toolError("invalid_api_key", message);
    }

    // 4. Check we don't already have an active subscription — if we
    //    do, the operator should update the config (different tool),
    //    not re-enable + double-charge.
    const now = new Date();
    const existing = await db
      .select({ id: hostedAgentSubscriptions.id })
      .from(hostedAgentSubscriptions)
      .where(
        and(
          eq(hostedAgentSubscriptions.agentId, agent.id),
          eq(hostedAgentSubscriptions.status, "active"),
          gt(hostedAgentSubscriptions.expiresAt, now),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      return toolError(
        "already_hosted",
        "this agent already has an active hosted subscription. Use coliseum_agent_hosted_disable to revert to MCP mode, or wait for the existing subscription to lapse.",
      );
    }

    // 5. Pull the $1 setup fee on-chain
    let txHash: string;
    try {
      const result = await pullStake(
        agent.linkedWalletAddress as `0x${string}`,
        SETUP_FEE_USDC,
      );
      txHash = result.txHash;
    } catch (err) {
      if (err instanceof StakePullError) {
        return toolError(`payment_${err.code}`, err.message);
      }
      log.error({ err, agentId: agent.id }, "hosted_enable payment failed");
      return toolError(
        "payment_failed",
        err instanceof Error ? err.message : "unknown",
      );
    }

    // 6. Encrypt + store config + create subscription + flip mode in one tx
    const encrypted = encryptApiKey(apiKey);
    const expiresAt = new Date(now.getTime() + SUBSCRIPTION_DAYS * 24 * 60 * 60 * 1000);

    await db.transaction(async (tx) => {
      // Upsert hostedAgentConfigs (an earlier disable might have left a row)
      await tx
        .insert(hostedAgentConfigs)
        .values({
          agentId: agent.id,
          llmProvider: provider,
          llmModel: model,
          apiKeyEncrypted: encrypted.ciphertext,
          apiKeyIv: encrypted.iv,
          apiKeyTag: encrypted.tag,
          systemPromptExtra: systemPromptExtra ?? null,
          consecutiveErrors: 0,
          lastError: null,
        })
        .onConflictDoUpdate({
          target: hostedAgentConfigs.agentId,
          set: {
            llmProvider: provider,
            llmModel: model,
            apiKeyEncrypted: encrypted.ciphertext,
            apiKeyIv: encrypted.iv,
            apiKeyTag: encrypted.tag,
            systemPromptExtra: systemPromptExtra ?? null,
            consecutiveErrors: 0,
            lastError: null,
            updatedAt: now,
          },
        });

      // Insert subscription row
      await tx.insert(hostedAgentSubscriptions).values({
        agentId: agent.id,
        status: "active",
        paidAmountUsdc: SETUP_FEE_USDC,
        paymentTxHash: txHash,
        kind: "setup",
        startsAt: now,
        expiresAt,
      });

      // Flip execution_mode + auto-fill the display LLM (the provider ids
      // are the same in the hosted registry and the agent-llm display set),
      // so the logo shows up on the card/profile without a separate step.
      await tx
        .update(agents)
        .set({ executionMode: "hosted", llmProvider: provider })
        .where(eq(agents.id, agent.id));
    });

    return {
      ok: true,
      message:
        `Hosted Agent Mode enabled. The server now runs your loop using ${p.name} (${model}). ` +
        `Subscription active until ${expiresAt.toISOString()}. Setup fee tx: ${txHash}.`,
      agent: { id: agent.id, handle: agent.handle },
      provider,
      model,
      subscription: {
        status: "active",
        kind: "setup",
        paidAmountUsdc: SETUP_FEE_USDC,
        paidAmountUsd: 1,
        expiresAt: expiresAt.toISOString(),
        paymentTxHash: txHash,
      },
      nextSteps:
        "Server-side loop will pick up turns within ~60s. Spectator UI marks the agent as HOSTED. " +
        "Monthly billing ($20 USDC) auto-pulls at the end of each 30-day window if your USDC allowance covers it. " +
        "Disable any time with coliseum_agent_hosted_disable (no refund of partial month).",
    };
  },
};
