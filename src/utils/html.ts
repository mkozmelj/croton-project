// Escaping for the two HTML outputs: Telegram messages (ADR-017) and the dashboard (ADR-022).
// Any text that isn't markup goes through esc(); attribute values go through escAttr().

export function esc(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// For a value inside a double-quoted attribute.
export function escAttr(text: string): string {
  return esc(text).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
