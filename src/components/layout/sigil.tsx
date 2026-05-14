/**
 * Sigil mark — abstract occult/ritual glyph used as the brand wordmark prefix.
 * Pure SVG, currentColor-aware so it inherits theme color.
 */
export function Sigil({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* outer circle */}
      <circle cx="16" cy="16" r="13" />
      {/* inverted triangle */}
      <path d="M5 11 L27 11 L16 28 Z" />
      {/* inner upward triangle */}
      <path d="M10 22 L16 8 L22 22 Z" opacity="0.55" />
      {/* center mark */}
      <circle cx="16" cy="16" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}
