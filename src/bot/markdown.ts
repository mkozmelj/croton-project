import { esc } from "./html.js";

// The model writes light Markdown (system prompt); Telegram gets HTML (ADR-017). Everything is
// escaped first, and each rule inserts a complete tag pair within one line, so the output is
// always well-formed whatever the model sends. Stored conversations keep the Markdown.

// Placeholders for code spans and links, so emphasis rules don't reach into them.
const SLOT = "\u0000";

export function markdownToHtml(markdown: string): string {
  const out: string[] = [];
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i] ?? ""); i++) body.push(lines[i] ?? "");
      out.push(`<pre>${esc(body.join("\n"))}</pre>`);
      continue;
    }

    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i] ?? ""); i++) {
        body.push(inline((lines[i] ?? "").replace(/^\s*>\s?/, "")));
      }
      i--;
      out.push(`<blockquote>${body.join("\n")}</blockquote>`);
      continue;
    }

    out.push(blockLine(line));
  }
  return out.join("\n").trim();
}

function blockLine(line: string): string {
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return "";
  const heading = /^\s*#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
  if (heading) return `<b>${inline(heading[1] ?? "")}</b>`;
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (bullet) return `${bullet[1] ?? ""}• ${inline(bullet[2] ?? "")}`;
  return inline(line);
}

function inline(text: string): string {
  const slots: string[] = [];
  const stash = (html: string) => `${SLOT}${slots.push(html) - 1}${SLOT}`;

  let html = esc(text)
    .replace(/`([^`]+)`/g, (_, body: string) => stash(`<code>${body}</code>`))
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label: string, url: string) =>
      stash(`<a href="${url.replaceAll('"', "&quot;")}">${label}</a>`),
    );

  html = html
    .replace(/\*\*\*(\S(?:[^*<]*?\S)?)\*\*\*/g, "<b><i>$1</i></b>")
    .replace(/\*\*(\S(?:[^<]*?\S)?)\*\*/g, "<b>$1</b>")
    .replace(/__(\S(?:[^<]*?\S)?)__/g, "<b>$1</b>")
    .replace(/~~(\S(?:[^<]*?\S)?)~~/g, "<s>$1</s>")
    // Single * and _ only pair at word edges: "3*10 min" and snake_case stay as they are.
    .replace(
      /(^|[^\p{L}\p{N}*])\*([^\s<>*](?:[^*<]*?[^\s<>*])?)\*(?![\p{L}\p{N}*])/gu,
      "$1<i>$2</i>",
    )
    .replace(
      /(^|[^\p{L}\p{N}_])_([^\s<>_](?:[^_<]*?[^\s<>_])?)_(?![\p{L}\p{N}_])/gu,
      "$1<i>$2</i>",
    );

  return html.replace(
    new RegExp(`${SLOT}(\\d+)${SLOT}`, "g"),
    (_, n: string) => slots[Number(n)] ?? "",
  );
}
