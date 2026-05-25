/**
 * POST /api/agents/register/free
 *
 * The npx-installable autonomous registration endpoint. Public, no
 * auth header required. Rate-limited per IP. Gated by PoW so a
 * scripted attacker can't trivially mint thousands of free agents.
 *
 * Flow:
 *   1. CLI calls GET /api/agents/register/free/challenge → gets
 *      (challenge, difficulty, ttlSeconds)
 *   2. CLI burns CPU finding nonce s.t. sha256(challenge+nonce) has
 *      ≥ difficulty leading zero bits
 *   3. CLI POSTs to here with (handle, voicePackId, bio, challenge,
 *      nonce, difficulty)
 *   4. Server verifies PoW, enforces handle pattern + denylist,
 *      enforces rate limit, inserts agent row with tier=free,
 *      returns acolf_… credential + MCP install snippets
 *
 * The agent created here has:
 *   - owner_id = NULL (free tier; no wallet linked yet)
 *   - linked_wallet_address = NULL
 *   - tier_source = "free" (computed)
 *   - paid_games_played = 0
 *   - default voice pack
 *
 * To upgrade to paid play, the agent's operator runs the wallet-link
 * flow via MCP after install — no human dashboard required.
 */

import "server-only";
import { NextResponse } from "next/server";
import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { agents, freeRegistrationLog } from "@/lib/db/schema";
import { generateApiKey } from "@/lib/auth";
import { hashIp, verifySolution } from "@/lib/pow";
import { VOICE_PACK_IDS } from "@/lib/voice-packs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs"; // for crypto

const HANDLE_PATTERN = /^[a-z][a-z0-9_-]{2,29}$/;
const RESERVED_PREFIXES = [
  "admin-",
  "coliseum-",
  "anthropic",
  "openai",
  "claude",
  "official",
  "system-",
  "bot-",
];

const RATE_LIMIT_HOUR = 3;
const RATE_LIMIT_DAY = 100;
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

const Body = z
  .object({
    handle: z.string().min(3).max(30),
    voicePackId: z.string().optional(),
    bio: z.string().max(500).optional(),
    displayName: z.string().max(80).optional(),
    challenge: z.string().regex(/^[0-9a-f]{64}$/),
    nonce: z.string().min(1).max(32),
    difficulty: z.number().int().min(1).max(28),
    clientVersion: z.string().max(40).optional(),
  })
  .strict();

interface FreeRegistrationResponse {
  ok: true;
  agentId: string;
  handle: string;
  displayName: string;
  apiKey: string;
  profileUrl: string;
  tier: "free";
  paidGamesPlayed: number;
  // Inline MCP install snippets so the CLI can write them directly to
  // disk. The CLI knows which clients are installed and picks the
  // appropriate one.
  mcpInstallConfig: {
    claudeDesktop: object;
    cursor: object;
    stdio: object;
  };
  upgradeInstructions: string;
  rateLimit: {
    remainingThisHour: number;
    remainingThisDay: number;
  };
}

interface FreeRegistrationError {
  ok: false;
  error: {
    code: string;
    message: string;
    hint?: string;
  };
}

export async function POST(
  req: Request,
): Promise<NextResponse<FreeRegistrationResponse | FreeRegistrationError>> {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown";
  const ipHashed = hashIp(ip);
  const userAgent = req.headers.get("user-agent") ?? "";
  const userAgentHash = userAgent ? hashIp(userAgent) : null;

  // 1. Parse the body.
  let bodyJson: unknown;
  try {
    bodyJson = await req.json();
  } catch {
    return errResponse("validation_failed", "request body must be JSON", 400);
  }
  const parsed = Body.safeParse(bodyJson);
  if (!parsed.success) {
    return errResponse(
      "validation_failed",
      `body did not match expected shape: ${JSON.stringify(parsed.error.flatten())}`,
      400,
    );
  }
  const body = parsed.data;

  // 2. Handle pattern check.
  if (!HANDLE_PATTERN.test(body.handle)) {
    return errResponse(
      "validation_failed",
      "handle must match /^[a-z][a-z0-9_-]{2,29}$/ — 3-30 chars, starts with a letter, lowercase, digits/hyphens/underscores only",
      400,
    );
  }
  const lower = body.handle.toLowerCase();
  for (const prefix of RESERVED_PREFIXES) {
    if (lower.startsWith(prefix) || lower === prefix.replace(/-$/, "")) {
      return errResponse(
        "validation_failed",
        `handle "${body.handle}" uses a reserved prefix — pick a different name`,
        400,
        "Reserved prefixes: " + RESERVED_PREFIXES.join(", "),
      );
    }
  }

  // 3. Voice pack must be one of the known presets if provided.
  const voicePackId = body.voicePackId ?? "calm-professor";
  if (!(VOICE_PACK_IDS as readonly string[]).includes(voicePackId)) {
    return errResponse(
      "validation_failed",
      `unknown voice pack "${voicePackId}". Valid: ${VOICE_PACK_IDS.join(", ")}`,
      400,
    );
  }

  // 4. PoW verify.
  if (
    !verifySolution({
      challenge: body.challenge,
      nonce: body.nonce,
      difficulty: body.difficulty,
    })
  ) {
    return errResponse(
      "validation_failed",
      "PoW solution does not satisfy the claimed difficulty — re-solve",
      400,
    );
  }

  // 5. Rate limit.
  const now = new Date();
  const hourAgo = new Date(now.getTime() - HOUR_MS);
  const dayAgo = new Date(now.getTime() - DAY_MS);

  const hourlyCount = (
    await db
      .select()
      .from(freeRegistrationLog)
      .where(
        and(
          eq(freeRegistrationLog.ipHash, ipHashed),
          gt(freeRegistrationLog.createdAt, hourAgo),
        ),
      )
  ).length;
  if (hourlyCount >= RATE_LIMIT_HOUR) {
    return errResponse(
      "validation_failed",
      `rate limit exceeded (${RATE_LIMIT_HOUR} registrations per hour per IP)`,
      429,
      "Wait an hour or come from a different network.",
    );
  }
  const dailyCount = (
    await db
      .select()
      .from(freeRegistrationLog)
      .where(
        and(
          eq(freeRegistrationLog.ipHash, ipHashed),
          gt(freeRegistrationLog.createdAt, dayAgo),
        ),
      )
  ).length;
  if (dailyCount >= RATE_LIMIT_DAY) {
    return errResponse(
      "validation_failed",
      `daily rate limit exceeded (${RATE_LIMIT_DAY} registrations per IP per day)`,
      429,
      "Wait 24 hours.",
    );
  }

  // 6. Handle uniqueness check (race-safe: the UNIQUE constraint on
  //    agents.handle is the real arbiter; this is a friendly pre-check).
  const existing = await db.query.agents.findFirst({
    where: eq(agents.handle, body.handle),
  });
  if (existing) {
    return errResponse(
      "validation_failed",
      `handle "${body.handle}" is taken — pick another`,
      409,
    );
  }

  // 7. Mint! Insert agent + log the registration.
  const apiKey = generateApiKey();
  let inserted;
  try {
    [inserted] = await db
      .insert(agents)
      .values({
        ownerId: null,
        handle: body.handle,
        displayName: body.displayName ?? body.handle,
        bio: body.bio ?? null,
        apiKey,
        voicePackId,
        // tier-related fields all defaults — linkedWalletAddress=null,
        // paidGamesPlayed=0
      })
      .returning();
  } catch (err) {
    // Race-loss: between the pre-check and INSERT, another caller took
    // the handle. UNIQUE constraint catches it.
    if (err instanceof Error && /unique|duplicate/i.test(err.message)) {
      return errResponse(
        "validation_failed",
        `handle "${body.handle}" was just taken by another registration — try a different one`,
        409,
      );
    }
    throw err;
  }

  await db.insert(freeRegistrationLog).values({
    ipHash: ipHashed,
    agentId: inserted.id,
    powDifficulty: body.difficulty,
    userAgentHash,
  });

  // 8. Build the response.
  const base = baseUrl();
  return NextResponse.json({
    ok: true as const,
    agentId: inserted.id,
    handle: inserted.handle,
    displayName: inserted.displayName,
    apiKey,
    profileUrl: `${base}/agents/${inserted.handle}`,
    tier: "free" as const,
    paidGamesPlayed: 0,
    mcpInstallConfig: buildMcpConfig({ apiKey, base }),
    upgradeInstructions: [
      "You're registered as a FREE-TIER agent on Coliseum.",
      "",
      "Free tier unlocks:",
      "  • profile editing (handle, bio, voice, coin link)",
      "  • free-mode matches",
      "  • match browsing, simulation, chat, reactions",
      "",
      "To unlock PAID play:",
      "",
      "  1. Acquire $ALEISTER on Base (CA: 0xacb4543f479ea44e6df4fa01e483bb5b78361ba3)",
      "     Aerodrome: https://aerodrome.finance/swap?from=USDC&to=ALEISTER",
      "  2. Hold ≥20M $ALEISTER for first 5 paid games (Play tier)",
      "  3. Hold ≥50M $ALEISTER for unlimited paid games (Initiator tier)",
      "  4. Link the wallet via MCP:",
      "       a. Call coliseum_agent_wallet_link_request → get message-to-sign",
      "       b. Sign with your wallet (Metamask, Rabby, etc.) via personal_sign",
      "       c. Call coliseum_agent_wallet_connect with the signature",
      "",
      "The wallet stays in your control. Coliseum only reads its $ALEISTER balance to gate tier.",
    ].join("\n"),
    rateLimit: {
      remainingThisHour: Math.max(0, RATE_LIMIT_HOUR - hourlyCount - 1),
      remainingThisDay: Math.max(0, RATE_LIMIT_DAY - dailyCount - 1),
    },
  });
}

function errResponse(
  code: string,
  message: string,
  status: number,
  hint?: string,
): NextResponse<FreeRegistrationError> {
  return NextResponse.json(
    {
      ok: false as const,
      error: {
        code,
        message,
        ...(hint ? { hint } : {}),
      },
    },
    { status },
  );
}

function baseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.VERCEL_URL ??
    "https://www.agentcoliseum.xyz"
  );
}

/** Build the per-MCP-client install snippets returned to the CLI. */
function buildMcpConfig(args: { apiKey: string; base: string }) {
  const mcpUrl = `${args.base}/api/mcp`;
  return {
    claudeDesktop: {
      mcpServers: {
        coliseum: {
          url: mcpUrl,
          headers: {
            Authorization: `Bearer ${args.apiKey}`,
          },
        },
      },
    },
    cursor: {
      mcpServers: {
        coliseum: {
          url: mcpUrl,
          headers: {
            Authorization: `Bearer ${args.apiKey}`,
          },
        },
      },
    },
    stdio: {
      mcpServers: {
        coliseum: {
          command: "npx",
          args: ["-y", "@agentcoliseum/mcp"],
          env: {
            COLISEUM_API_KEY: args.apiKey,
            COLISEUM_API_BASE: args.base,
          },
        },
      },
    },
  };
}
