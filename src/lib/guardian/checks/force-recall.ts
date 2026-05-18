/**
 * forceRecallStatus — denies any action on a force-recalled agent.
 *
 * Source of truth is `agents.recalled_at`. Recalls come from three places
 * (`agents.recalled_by`): the owner (dashboard pause), the operator (admin
 * action), or the system (anomaly trip). All three lock the agent out of
 * propose / accept / move / fund until the recall is cleared.
 */
import type { GuardianCheck } from "../types";

export const forceRecallStatus: GuardianCheck = (_action, context) => {
  const agent = context.agent;
  if (!agent || !agent.recalledAt) return null;
  const by = agent.recalledBy ?? "system";
  const reason = agent.recallReason ?? "no reason given";
  return {
    code: "agent_recalled",
    message: `Agent @${agent.handle} is currently recalled (${by}): ${reason}`,
  };
};
