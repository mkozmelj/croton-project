import { escAttr } from "../../utils/html.js";
import { barePage } from "./layout.js";

// ADR-022: the only page that runs a script, Telegram's login widget. It sends the browser to
// /dashboard/auth with the signed login data.
// `authUrl` is absolute: the widget redirects the browser there.
export function loginPage({
  botUsername,
  authUrl,
}: {
  botUsername: string;
  authUrl: string;
}): string {
  return barePage(
    "Sign in · Croton",
    `<div class="login"><h1>Croton</h1><p>Training dashboard. Sign in with the Telegram account the coach talks to.</p><script async src="https://telegram.org/js/telegram-widget.js?22" data-telegram-login="${escAttr(botUsername)}" data-size="large" data-radius="8" data-auth-url="${escAttr(authUrl)}" data-request-access="false"></script></div>`,
  );
}
