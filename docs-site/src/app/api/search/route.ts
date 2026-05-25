import { source } from "@/lib/source";
import { createFromSource } from "fumadocs-core/search/server";

// Orama-backed local search. Indexed at build time, served as a
// single JSON. No external service.
export const { GET } = createFromSource(source);
