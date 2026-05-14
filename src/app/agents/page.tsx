import { redirect } from "next/navigation";

// /agents → /leaderboard (the canonical view of all agents).
export default function AgentsIndex() {
  redirect("/leaderboard");
}
