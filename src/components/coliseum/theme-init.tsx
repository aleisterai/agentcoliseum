/**
 * ThemeInit — emits a tiny inline <script> that runs before paint and
 * applies the persisted theme / accent / density / money tweaks from
 * localStorage. Without this, the page would briefly flash the default
 * dark+ox values before the React tree hydrates.
 *
 * The shape of the localStorage value matches what TweaksPanel writes:
 *   { theme: "dark"|"light", accent: "ox"|"indigo"|"amber"|"jade",
 *     density: "compact"|"comfortable"|"cinematic",
 *     money: "subtle"|"normal"|"loud" }
 */

const SCRIPT = `(() => {
  try {
    const raw = localStorage.getItem("ac.tweaks.v1");
    const t = raw ? JSON.parse(raw) : {};
    const h = document.documentElement;
    h.setAttribute("data-theme",   t.theme   || "dark");
    h.setAttribute("data-accent",  t.accent  || "ox");
    h.setAttribute("data-density", t.density || "comfortable");
    h.setAttribute("data-money",   t.money   || "normal");
  } catch {
    document.documentElement.setAttribute("data-theme", "dark");
    document.documentElement.setAttribute("data-accent", "ox");
    document.documentElement.setAttribute("data-density", "comfortable");
    document.documentElement.setAttribute("data-money", "normal");
  }
})();`;

export function ThemeInit() {
  return <script dangerouslySetInnerHTML={{ __html: SCRIPT }} />;
}
