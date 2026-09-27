// Telegram HTML (ADR-017): every text the bot sends is parsed with parse_mode "HTML", so any
// text that isn't markup goes through esc(). The inline helpers take plain text and escape it;
// quote() and section() take HTML that's already built.

export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

export function esc(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export const bold = (text: string) => `<b>${esc(text)}</b>`;
export const italic = (text: string) => `<i>${esc(text)}</i>`;
export const code = (text: string) => `<code>${esc(text)}</code>`;

export function link(text: string, url: string): string {
  return `<a href="${esc(url).replaceAll('"', "&quot;")}">${esc(text)}</a>`;
}

// An expandable quote shows its first lines and opens on tap: for detail that would bury the
// rest of the message (zones, workout structure).
export function quote(html: string, expandable = false): string {
  return `<blockquote${expandable ? " expandable" : ""}>${html}</blockquote>`;
}

// A bold heading over its lines, the building block of the longer messages.
export function section(heading: string, lines: readonly string[]): string {
  return [`<b>${heading}</b>`, ...lines].join("\n");
}

// e.g. "▰▰▰▱▱▱▱▱▱▱" for 0.3.
export function progressBar(fraction: number, width = 10): string {
  const filled = Math.min(width, Math.max(0, Math.round(fraction * width)));
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}

// The plain-text fallback when Telegram rejects the markup: our tags go, entities are decoded.
export function stripHtml(html: string): string {
  return html
    .replace(/<\/?(?:b|i|u|s|code|pre|a|blockquote|tg-spoiler)(?:\s[^>]*)?>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
}

// Room for the closing tags a cut chunk gets.
const CLOSING_RESERVE = 64;

// Splits on paragraph, then line, then word boundaries so no chunk exceeds `limit`. A tag open
// at a cut is closed at the end of its chunk and reopened at the start of the next, and a cut
// never lands inside a tag or an entity.
export function splitMessage(html: string, limit = TELEGRAM_MAX_MESSAGE_LENGTH): string[] {
  const chunks: string[] = [];
  let rest = html.trim();
  while (rest.length > limit) {
    const budget = limit - Math.min(CLOSING_RESERVE, Math.floor(limit / 8));
    const window = rest.slice(0, budget);
    const boundary = Math.max(
      window.lastIndexOf("\n\n"),
      window.lastIndexOf("\n"),
      window.lastIndexOf(" "),
    );
    const at = safeCut(rest, boundary > budget / 2 ? boundary : budget);
    const head = rest.slice(0, at).trimEnd();
    const open = openTags(head);
    chunks.push(head + open.map(closingTag).reverse().join(""));
    rest = open.join("") + rest.slice(at).trimStart();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

// Moves a cut back to before a tag or entity it would split.
function safeCut(text: string, at: number): number {
  const head = text.slice(0, at);
  const tagStart = head.lastIndexOf("<");
  if (tagStart > head.lastIndexOf(">")) return tagStart;
  const entityStart = head.lastIndexOf("&");
  if (entityStart > head.lastIndexOf(";")) return entityStart;
  return at;
}

// Opening tags (with their attributes) still open at the end of `html`, outermost first.
function openTags(html: string): string[] {
  const stack: string[] = [];
  for (const match of html.matchAll(/<(\/?)([a-z-]+)[^>]*>/g)) {
    if (match[1] === "/") stack.pop();
    else stack.push(match[0]);
  }
  return stack;
}

function closingTag(openTag: string): string {
  return `</${/^<([a-z-]+)/.exec(openTag)?.[1] ?? ""}>`;
}

const SPORT_EMOJI: Record<string, string> = {
  run: "🏃",
  trail_run: "⛰️",
  bike: "🚴",
  swim: "🏊",
  brick: "🧱",
  strength: "🏋️",
  tennis: "🎾",
  mobility: "🧘",
  hike: "🥾",
  walk: "🚶",
  all: "❤️",
};

export const sportEmoji = (sport: string) => SPORT_EMOJI[sport] ?? "🏅";

const INTENSITY_EMOJI: Record<string, string> = {
  recovery: "⚪",
  easy: "🟢",
  moderate: "🟡",
  hard: "🔴",
  race: "🏁",
};

export const intensityEmoji = (intensity: string) => INTENSITY_EMOJI[intensity] ?? "⚪";
