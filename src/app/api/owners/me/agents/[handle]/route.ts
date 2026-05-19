/**
 * PATCH /api/owners/me/agents/[handle]
 *
 * Owner-only mutation of an agent's profile. Use cases right now:
 *   - Pick / customize the voice pack from the manage page
 *   - (future) Owner overrides for fields the LLM is allowed to touch
 *
 * The patchable surface is the same `AgentSelfPatchSchema` the LLM uses
 * via /api/mcp's `coliseum.agent.profile_update`. Sharing the schema
 * keeps owner-edits and LLM-edits in lockstep — anything the owner
 * can write here, the LLM can also write (and vice versa). Security-
 * sensitive fields (apiKey, elo, ownerId, recall state) are still
 * excluded by the schema's `.strict()` mode.
 *
 * For recall toggling (owner-only, NOT in AgentSelfPatchSchema) we'll
 * add a separate POST /recall + POST /recall/clear later.
 *
 * Auth: `Authorization: Bearer <privy-jwt>`.
 */
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getAddress } from "viem";
import { db } from "@/lib/db/client";
import { agents, owners } from "@/lib/db/schema";
import { resolvePrivyWallet, UnauthorizedError } from "@/lib/auth";
import { errorResponse, jsonError } from "@/lib/http";
import { slugifyHandle } from "@/lib/utils";
import { OwnerAgentPatchSchema } from "@/app/api/agents/me/schema";
import { voicePackById } from "@/lib/voice-packs";
import { readErc20Metadata } from "@/lib/chain/erc20-token";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ handle: string }> },
) {
  try {
    const wallet = await resolvePrivyWallet(req);
    if (!wallet) {
      throw new UnauthorizedError("unauthorized", "Privy session required");
    }
    const checksummed = getAddress(wallet);

    const owner = await db.query.owners.findFirst({
      where: eq(owners.walletAddress, checksummed),
    });
    if (!owner) {
      return jsonError(404, "owner_not_found", "Owner row not seeded — POST /api/owners/me first");
    }

    const { handle } = await params;
    const agent = await db.query.agents.findFirst({
      where: and(eq(agents.handle, handle), eq(agents.ownerId, owner.id)),
    });
    if (!agent) {
      return jsonError(404, "agent_not_found", "Agent not found or not owned by you");
    }
    if (agent.recalledAt) {
      return jsonError(
        409,
        "agent_recalled",
        "Recalled agents can't be edited. Clear the recall first.",
      );
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonError(400, "bad_request", "Body must be valid JSON");
    }
    const parsed = OwnerAgentPatchSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(400, "bad_request", "Body failed validation", parsed.error.flatten());
    }
    const patch = parsed.data;
    if (Object.keys(patch).length === 0) {
      return jsonError(400, "bad_request", "Empty patch — supply at least one field");
    }

    // Cap-consistency rules:
    //   - Lowering the hard cap auto-clips the soft cap (if owner pulls
    //     the ceiling down below where the LLM had it, soft snaps to
    //     match — otherwise the LLM's intent silently exceeds the new
    //     ceiling, which we don't want).
    //   - Raising the soft cap above the hard cap is rejected (owner
    //     would have to raise hard first).
    const effectiveHard =
      patch.stakeCapHardUsdc ?? agent.stakeCapHardUsdc;
    if (
      patch.stakeCapSoftUsdc != null &&
      patch.stakeCapSoftUsdc > effectiveHard
    ) {
      return jsonError(
        400,
        "soft_exceeds_hard",
        `Soft cap (${patch.stakeCapSoftUsdc}) exceeds hard cap (${effectiveHard}). Raise the hard cap first.`,
      );
    }
    if (
      patch.stakeCapHardUsdc != null &&
      agent.stakeCapSoftUsdc != null &&
      agent.stakeCapSoftUsdc > patch.stakeCapHardUsdc &&
      patch.stakeCapSoftUsdc === undefined
    ) {
      patch.stakeCapSoftUsdc = patch.stakeCapHardUsdc;
    }

    if (patch.handle != null) {
      const slug = slugifyHandle(patch.handle);
      if (slug.length < 2) {
        return jsonError(400, "bad_request", "Handle too short after slugify");
      }
      if (slug !== agent.handle) {
        const collision = await db.query.agents.findFirst({
          where: eq(agents.handle, slug),
        });
        if (collision && collision.id !== agent.id) {
          return jsonError(409, "handle_taken", `Handle '${slug}' already taken`);
        }
      }
      patch.handle = slug;
    }

    // tokenCa on-chain validation: if the patch supplies a non-null
    // address, read ERC-20 metadata on Base. A non-ERC-20 or a token
    // on the wrong chain returns null → 400.
    if (patch.tokenCa) {
      const meta = await readErc20Metadata(patch.tokenCa as `0x${string}`);
      if (!meta) {
        return jsonError(
          400,
          "not_erc20",
          "tokenCa is not a readable ERC-20 on Base. Verify the address + chain + that the token is deployed.",
        );
      }
    }

    // Voice-pack convenience — same behavior as the MCP tool: setting
    // voicePackId alone copies the preset's four lines. Explicit lines
    // in the same patch win.
    if (patch.voicePackId) {
      const preset = voicePackById(patch.voicePackId);
      if (!preset) {
        return jsonError(
          400,
          "bad_request",
          `Unknown voicePackId '${patch.voicePackId}'. Valid: calm-professor, trash-talker, stoic-samurai, anxious-nerd, degen.`,
        );
      }
      if (patch.catchphrase === undefined) patch.catchphrase = preset.catchphrase;
      if (patch.winLine === undefined) patch.winLine = preset.winLine;
      if (patch.lossLine === undefined) patch.lossLine = preset.lossLine;
      if (patch.trashTalkTemplates === undefined)
        patch.trashTalkTemplates = preset.trashTalkTemplates;
    }

    const [updated] = await db
      .update(agents)
      .set(patch)
      .where(eq(agents.id, agent.id))
      .returning();

    return NextResponse.json({
      handle: updated.handle,
      displayName: updated.displayName,
      voicePackId: updated.voicePackId,
      catchphrase: updated.catchphrase,
      winLine: updated.winLine,
      lossLine: updated.lossLine,
      trashTalkTemplates: updated.trashTalkTemplates,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
