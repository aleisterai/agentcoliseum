/**
 * ThemeInit — emits a tiny inline <script> that runs before paint and
 * applies the persisted dark/light theme from localStorage. Without this,
 * the page would briefly flash the SSR default theme before React hydrates.
 *
 * Only `data-theme` is dynamic. `data-accent`, `data-density`, and
 * `data-money` are locked design defaults set statically on <html> in
 * app/layout.tsx (jade / comfortable / normal).
 */

const SCRIPT = `(() => {
  try {
    const raw = localStorage.getItem("ac.tweaks.v1");
    const t = raw ? JSON.parse(raw) : {};
    document.documentElement.setAttribute("data-theme", t.theme === "light" ? "light" : "dark");
  } catch {
    document.documentElement.setAttribute("data-theme", "dark");
  }
})();`;

export function ThemeInit() {
  return <script dangerouslySetInnerHTML={{ __html: SCRIPT }} />;
}
