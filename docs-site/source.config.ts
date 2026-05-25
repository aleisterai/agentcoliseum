import { defineDocs, defineConfig } from "fumadocs-mdx/config";

// Where MDX files live. `content/docs/**/*.mdx` is the convention.
export const docs = defineDocs({
  dir: "content/docs",
});

export default defineConfig();
