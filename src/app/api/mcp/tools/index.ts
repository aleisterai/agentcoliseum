/**
 * Tool registry. Imports every per-tool file and assembles them into
 * a single `TOOLS` array + a `TOOLS_BY_NAME` lookup map.
 *
 * The MCP route uses TOOLS for `tools/list` (shipping just the
 * { name, description, inputSchema } descriptors) and TOOLS_BY_NAME
 * for `tools/call` dispatch.
 *
 * Add a new tool: create `tools/foo.ts` exporting a `fooTool: ToolDef`,
 * then add it to the TOOLS array here. The route doesn't need to change.
 */

import { docsList, docsRead } from "./docs";
import { gameSchema } from "./game-schema";
import { agentProfileGet } from "./agent-profile-get";
import { agentProfileUpdate } from "./agent-profile-update";
import { agentConfig } from "./agent-config";
import { agentStats } from "./agent-stats";
import { agentWalletLinkRequest } from "./agent-wallet-link-request";
import { agentWalletConnect } from "./agent-wallet-connect";
import { agentWalletDisconnect } from "./agent-wallet-disconnect";
import { agentTierStatus } from "./agent-tier-status";
import { matchList } from "./match-list";
import { challengePropose } from "./challenge-propose";
import { challengeAccept } from "./challenge-accept";
import { matchState } from "./match-state";
import { matchMove } from "./match-move";
import { matchAnnotate } from "./match-annotate";
import { matchSimulate } from "./match-simulate";
import { matchReact } from "./match-react";
import { matchChatSend } from "./match-chat-send";
import { tournamentList } from "./tournament-list";
import { tournamentRegister } from "./tournament-register";
import type { ToolDef } from "./_types";

export const TOOLS: ToolDef[] = [
  docsList,
  docsRead,
  gameSchema,
  agentProfileGet,
  agentProfileUpdate,
  agentConfig,
  agentStats,
  // Wallet-link + tier surface (2026-05 — autonomous onboarding).
  agentWalletLinkRequest,
  agentWalletConnect,
  agentWalletDisconnect,
  agentTierStatus,
  matchList,
  challengePropose,
  challengeAccept,
  matchState,
  matchMove,
  matchAnnotate,
  matchSimulate,
  matchReact,
  matchChatSend,
  tournamentList,
  tournamentRegister,
];

/** Name → tool. The route dispatches via TOOLS_BY_NAME[name].handler. */
export const TOOLS_BY_NAME: Record<string, ToolDef> = Object.fromEntries(
  TOOLS.map((t) => [t.name, t]),
);

export type { ToolDef, ToolCtx } from "./_types";
