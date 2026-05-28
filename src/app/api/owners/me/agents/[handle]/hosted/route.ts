/**
 * Hosted Agent Mode — owner-facing REST endpoints.
 *
 *   GET    /api/owners/me/agents/[handle]/hosted   → current status + sub
 *   POST   /api/owners/me/agents/[handle]/hosted   → enable (pay $1, set up)
 *   DELETE /api/owners/me/agents/[handle]/hosted   → disable, no refund
 *
 * Auth: Privy session JWT, same pattern as the rest of /api/owners/me/*.
 * Owner identity comes from the wallet address; we verify the agent's
 * ownerId matches before doing anything.
 *
 * These endpoints delegate to the same underlying helpers as the MCP
 * tools — encryption.ts, registry.ts, pullStake — so the two surfaces
 * stay in lockstep.
 */
import { NextResponse } from "next/server";
import { and, eq, gt } from "drizzle-orm";
import { getAddress } from "viem";
import { z } from "zod";
import { db } from "@/lib/db/client";
import {
  agents,
  owners,
  hostedAgentConfigs,
  hostedAgentSubscriptions,
} from "@/lib/db/schema";
import { resolvePrivyWallet, UnauthorizedError } from "@/lib/auth";
import { errorResponse, jsonError } from "@/lib/http";
import { getProvider, isValidProviderId, isValidModel } from "@/lib/llm/registry";
import { encryptApiKey } from "@/lib/llm/encryption";
import { LlmError } from "@/lib/llm/types";
import { pullStake, StakePullError } from "@/lib/chain/stake";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
// LLM key validation + on-chain pullStake can both take 5-15s; bump
// the function ceiling to give the worst-case payment confirmation
// time to complete.
export const maxDuration = 60;

const SETUP_FEE_USDC = 1_000_000;
const SUBSCRIPTION_DAYS = 30;

const PostBody = z
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

/**
 * GET — owner reads the current hosted state for an agent. Used by the
 * dashboard page to decide whether to show the enable form or the
 * "currently hosted" surface.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ handle: string }> },
) {
  try {
    const { agent } = await resolveOwnerAgent(req, await params);

    // Pull the config + active subscription (if any) in parallel.
    const [config, activeSub] = await Promise.all([
      db.query.hostedAgentConfigs.findFirst({
        where: eq(hostedAgentConfigs.agentId, agent.id),
      }),
      db
        .select()
        .from(hostedAgentSubscriptions)
        .where(
          and(
            eq(hostedAgentSubscriptions.agentId, agent.id),
            eq(hostedAgentSubscriptions.status, "active"),
            gt(hostedAgentSubscriptions.expiresAt, new Date()),
          ),
        )
        .limit(1),
    ]);

    return NextResponse.json({
      ok: true,
      executionMode: agent.executionMode,
      linkedWalletAddress: agent.linkedWalletAddress,
      // The config row may exist even when execution_mode='mcp' (after a
      // disable that preserved credentials). Surface that distinction so
      // the dashboard can show "re-enable" vs "set up fresh".
      hasStoredConfig: !!config,
      config: config
        ? {
            provider: config.llmProvider,
            model: config.llmModel,
            systemPromptExtra: config.systemPromptExtra,
            lastCallAt: config.lastCallAt?.toISOString() ?? null,
            lastError: config.lastError,
            consecutiveErrors: config.consecutiveErrors,
          }
        : null,
      subscription: activeSub[0]
        ? {
            id: activeSub[0].id,
            status: activeSub[0].status,
            kind: activeSub[0].kind,
            paidAmountUsdc: activeSub[0].paidAmountUsdc,
            paidAmountUsd: activeSub[0].paidAmountUsdc / 1_000_000,
            startsAt: activeSub[0].startsAt.toISOString(),
            expiresAt: activeSub[0].expiresAt.toISOString(),
            paymentTxHash: activeSub[0].paymentTxHash,
          }
        : null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST — owner enables hosted mode. Mirrors coliseum_agent_hosted_enable.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ handle: string }> },
) {
  try {
    const { agent } = await resolveOwnerAgent(req, await params);
    const body = PostBody.safeParse(await req.json());
    if (!body.success) {
      return jsonError(
        400,
        "validation_failed",
        JSON.stringify(body.error.flatten()),
      );
    }
    const { provider, model, apiKey, systemPromptExtra } = body.data;

    if (!isValidProviderId(provider)) {
      return jsonError(400, "invalid_provider", `provider '${provider}' not supported`);
    }
    if (!isValidModel(provider, model)) {
      const p = getProvider(provider)!;
      return jsonError(
        400,
        "invalid_model",
        `model '${model}' not in ${p.name} catalogue. Supported: ${p.models.map((m) => m.id).join(", ")}`,
      );
    }
    if (!agent.linkedWalletAddress) {
      return jsonError(
        400,
        "no_wallet_linked",
        "Link a wallet first (you need it to pay the $1 setup fee).",
      );
    }

    // 1. Validate the API key with the provider before charging.
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
      return jsonError(400, "invalid_api_key", message);
    }

    // 2. Already-active sub guard.
    const existing = await db
      .select({ id: hostedAgentSubscriptions.id })
      .from(hostedAgentSubscriptions)
      .where(
        and(
          eq(hostedAgentSubscriptions.agentId, agent.id),
          eq(hostedAgentSubscriptions.status, "active"),
          gt(hostedAgentSubscriptions.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      return jsonError(
        409,
        "already_hosted",
        "this agent already has an active hosted subscription",
      );
    }

    // 3. Pull $1 USDC.
    let txHash: string;
    try {
      const result = await pullStake(
        agent.linkedWalletAddress as `0x${string}`,
        SETUP_FEE_USDC,
      );
      txHash = result.txHash;
    } catch (err) {
      if (err instanceof StakePullError) {
        return jsonError(402, `payment_${err.code}`, err.message);
      }
      log.error({ err, agentId: agent.id }, "hosted_enable payment failed");
      return jsonError(
        500,
        "payment_failed",
        err instanceof Error ? err.message : "unknown",
      );
    }

    // 4. Encrypt + store + create subscription + flip mode.
    const encrypted = encryptApiKey(apiKey);
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + SUBSCRIPTION_DAYS * 24 * 60 * 60 * 1000,
    );

    await db.transaction(async (tx) => {
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
      await tx.insert(hostedAgentSubscriptions).values({
        agentId: agent.id,
        status: "active",
        paidAmountUsdc: SETUP_FEE_USDC,
        paymentTxHash: txHash,
        kind: "setup",
        startsAt: now,
        expiresAt,
      });
      await tx
        .update(agents)
        .set({ executionMode: "hosted" })
        .where(eq(agents.id, agent.id));
    });

    return NextResponse.json({
      ok: true,
      message: `Hosted Agent Mode enabled. Server runs the loop with ${p.name} (${model}) until ${expiresAt.toISOString()}.`,
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
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * DELETE — owner disables hosted mode. Mirrors coliseum_agent_hosted_disable.
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ handle: string }> },
) {
  try {
    const { agent } = await resolveOwnerAgent(req, await params);

    if (agent.executionMode !== "hosted") {
      return NextResponse.json({
        ok: true,
        message: "already in MCP mode; nothing to do",
        previousMode: agent.executionMode,
        currentMode: agent.executionMode,
      });
    }

    await db.transaction(async (tx) => {
      await tx
        .update(agents)
        .set({ executionMode: "mcp" })
        .where(eq(agents.id, agent.id));
      await tx
        .update(hostedAgentSubscriptions)
        .set({ status: "cancelled" })
        .where(
          and(
            eq(hostedAgentSubscriptions.agentId, agent.id),
            eq(hostedAgentSubscriptions.status, "active"),
          ),
        );
    });

    return NextResponse.json({
      ok: true,
      message:
        "Hosted Agent Mode disabled. Agent reverts to MCP. In-flight matches continue under MCP mode.",
      previousMode: "hosted" as const,
      currentMode: "mcp" as const,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * Shared auth + lookup. Resolves the Privy session → owner row →
 * agent row, with an integrity check that the agent belongs to this
 * owner. Throws clean Response-wrapped errors via errorResponse.
 */
async function resolveOwnerAgent(
  req: Request,
  params: { handle: string },
): Promise<{ owner: typeof owners.$inferSelect; agent: typeof agents.$inferSelect }> {
  const wallet = await resolvePrivyWallet(req);
  if (!wallet) {
    throw new UnauthorizedError("unauthorized", "Privy session required");
  }
  const checksummed = getAddress(wallet);
  const owner = await db.query.owners.findFirst({
    where: eq(owners.walletAddress, checksummed),
  });
  if (!owner) {
    throw new Error("owner_not_found: POST /api/owners/me first");
  }
  const agent = await db.query.agents.findFirst({
    where: and(eq(agents.handle, params.handle), eq(agents.ownerId, owner.id)),
  });
  if (!agent) {
    throw new Error("agent_not_found");
  }
  return { owner, agent };
}
