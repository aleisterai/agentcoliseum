import { redirect } from "next/navigation";

/*
 * Root → docs index.
 *
 * Visitors hitting `docs.agentcoliseum.xyz/` directly are here to
 * READ docs, not look at a splash. Send them straight into the
 * Welcome page with the full sidebar attached.
 *
 * The brand-splash cards page is still alive at `/intro` and is
 * what the logo click takes you to.
 */
export default function Root() {
  redirect("/docs");
}
