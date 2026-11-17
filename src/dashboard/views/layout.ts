import { createHash } from "node:crypto";
import { esc } from "../../utils/html.js";
import { DASHBOARD_PATH } from "./format.js";

// ADR-022: one stylesheet, inline, allowed by its hash in the CSP (pages run no JavaScript and
// carry no style attributes). Light and dark through prefers-color-scheme.

const CSS = `
:root{color-scheme:light dark;
--bg:#f5f5f2;--surface:#fff;--text:#1d1d1b;--muted:#6b6a65;--line:#e3e2dc;--accent:#2f62c8;
--done:#2e9457;--partial:#c98f12;--skipped:#cc4a3f;--unconfirmed:#7d6fd0;--upcoming:#9a9993;--unplanned:#bdbcb5;
--bar1:#2f62c8;--bar2:#6fa3ef}
@media (prefers-color-scheme:dark){:root{
--bg:#131312;--surface:#1d1d1b;--text:#ecebe6;--muted:#9d9c95;--line:#2f2f2c;--accent:#7da6f5;
--done:#4cbf7c;--partial:#e2ad3a;--skipped:#e8695e;--unconfirmed:#a397ec;--upcoming:#77766f;--unplanned:#55544f;
--bar1:#7da6f5;--bar2:#3c5f9e}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-text-size-adjust:100%}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
header{background:var(--surface);border-bottom:1px solid var(--line)}
.bar{max-width:760px;margin:0 auto;padding:10px 16px;display:flex;gap:4px 16px;align-items:center;flex-wrap:wrap}
.brand{font-weight:650;color:var(--text);margin-right:auto}
nav a{color:var(--muted);padding:4px 0}
nav a.on{color:var(--text);font-weight:600}
nav{display:flex;gap:14px;flex-wrap:wrap}
.logout{color:var(--muted);font-size:13px}
main{max-width:760px;margin:0 auto;padding:16px 16px 48px}
h1{font-size:22px;margin:4px 0 2px;line-height:1.25}
h2{font-size:16px;margin:28px 0 8px}
.sub{color:var(--muted);margin:0 0 14px}
.pager{display:flex;justify-content:space-between;gap:12px;margin:0 0 12px;font-size:14px}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 0}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.tile b{display:block;font-size:22px;font-variant-numeric:tabular-nums;line-height:1.2}
.tile span{color:var(--muted);font-size:12.5px}
.focus{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:0 0 8px}
.day{margin:18px 0 0}
.day h3{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:0 0 6px;font-weight:600}
.day.today h3{color:var(--accent)}
.rest{color:var(--muted);font-size:14px;padding:2px 0}
.row{display:flex;gap:10px;align-items:center;background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:9px 12px;margin:0 0 6px;color:var(--text)}
a.row:hover{text-decoration:none;border-color:var(--muted)}
.row .icon{font-size:18px;width:24px;text-align:center;flex:none}
.row .main{flex:1;min-width:0}
.row .title{display:block;font-weight:600;overflow-wrap:anywhere}
.row .meta,.row .side small{display:block;color:var(--muted);font-size:13px}
.row .side{text-align:right;flex:none;font-variant-numeric:tabular-nums;font-size:14px}
.row .side .v{display:block}
.row.unplanned{border-style:dashed;color:var(--muted);background:transparent}
.row.unplanned .title{font-weight:500}
.chip{display:inline-block;font-size:12px;font-weight:600;border-radius:999px;padding:1px 8px;margin-top:2px;border:1px solid currentColor}
.s-done .chip,.chip.s-done{color:var(--done)}
.s-partial .chip,.chip.s-partial{color:var(--partial)}
.s-skipped .chip,.chip.s-skipped{color:var(--skipped)}
.s-unconfirmed .chip,.chip.s-unconfirmed{color:var(--unconfirmed)}
.s-upcoming .chip,.chip.s-upcoming,.s-replaced .chip,.chip.s-replaced{color:var(--muted)}
.card{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:0 0 10px}
.card h2{margin:0 0 8px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:0}
dt{color:var(--muted)}dd{margin:0;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.cols{display:grid;gap:10px}
@media (min-width:640px){.cols{grid-template-columns:1fr 1fr}}
ul.plain{margin:0;padding-left:18px}
.table{overflow-x:auto;margin:0 0 10px}
table{border-collapse:collapse;width:100%;font-size:14px;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--muted);font-weight:600;font-size:12.5px}
td.wrap{white-space:normal;min-width:140px}
.note{white-space:pre-wrap;overflow-wrap:anywhere}
.muted{color:var(--muted)}
.legend{display:flex;gap:14px;font-size:13px;color:var(--muted);margin:4px 0 0}
.key{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.key.k1{background:var(--bar1)}.key.k2{background:var(--bar2)}
.chart{width:100%;height:auto;display:block}
.chart .grid{stroke:var(--line);stroke-width:1}
.chart .grid.base{stroke:var(--muted)}
.chart .axis{fill:var(--muted);font-size:11px}
.chart .bar-sessions{fill:var(--bar1)}.chart .bar-hours{fill:var(--bar2)}
.chart .line{stroke:var(--accent);stroke-width:2}
.chart .dot{fill:var(--done);stroke:var(--surface);stroke-width:1.5}
.chart .dot.partial{fill:var(--partial)}
.login{max-width:360px;margin:12vh auto 0;text-align:center;padding:0 16px}
.login p{color:var(--muted)}
@media (max-width:480px){.tile b{font-size:19px}.row{padding:8px 10px}}
`;

export const STYLE_HASH = `'sha256-${createHash("sha256").update(CSS).digest("base64")}'`;

export type Section = "week" | "completion" | "types";

const NAV: readonly [Section, string, string][] = [
  ["week", "Week", DASHBOARD_PATH],
  ["completion", "Completion", `${DASHBOARD_PATH}/completion`],
  ["types", "Session types", `${DASHBOARD_PATH}/types`],
];

function document(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${esc(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`;
}

// A signed-in page: header with the three views, then `body` (already-built HTML).
export function page(title: string, section: Section | null, body: string): string {
  const links = NAV.map(
    ([key, label, href]) => `<a href="${href}"${key === section ? ' class="on"' : ""}>${label}</a>`,
  ).join("");
  return document(
    `${title} · Croton`,
    `<header><div class="bar"><a class="brand" href="${DASHBOARD_PATH}">Croton</a><nav>${links}</nav><a class="logout" href="${DASHBOARD_PATH}/logout">Sign out</a></div></header><main>${body}</main>`,
  );
}

// The page without the signed-in header, for the login screen.
export function barePage(title: string, body: string): string {
  return document(title, body);
}
