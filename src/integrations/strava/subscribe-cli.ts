// One-off CLI for Strava's webhook subscription (stack doc §8: registration is code).
//   npm run strava:subscribe -- list
//   npm run strava:subscribe -- create https://<app-url>   (the app must be running there)
//   npm run strava:subscribe -- delete <id>
// Strava allows one subscription per API app. Put the printed id in STRAVA_SUBSCRIPTION_ID.
import { env } from "../../config/env.js";
import { STRAVA_WEBHOOK_PATH } from "./webhook.js";

const API = "https://www.strava.com/api/v3/push_subscriptions";

function requireEnv(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const credentials = {
  client_id: requireEnv("STRAVA_CLIENT_ID", env.STRAVA_CLIENT_ID),
  client_secret: requireEnv("STRAVA_CLIENT_SECRET", env.STRAVA_CLIENT_SECRET),
};

async function call(method: string, url: string, body?: URLSearchParams): Promise<string> {
  const response = await fetch(url, { method, body });
  const text = await response.text();
  if (!response.ok) throw new Error(`Strava returned ${response.status}: ${text}`);
  return text;
}

const [command, argument] = process.argv.slice(2);

switch (command) {
  case "list": {
    console.log(await call("GET", `${API}?${new URLSearchParams(credentials)}`));
    break;
  }
  case "create": {
    if (!argument) throw new Error("usage: create <app base URL>");
    const callbackUrl = new URL(STRAVA_WEBHOOK_PATH, argument).toString();
    // Strava calls the callback's GET handshake before answering this request.
    const created = await call(
      "POST",
      API,
      new URLSearchParams({
        ...credentials,
        callback_url: callbackUrl,
        verify_token: requireEnv("STRAVA_WEBHOOK_VERIFY_TOKEN", env.STRAVA_WEBHOOK_VERIFY_TOKEN),
      }),
    );
    console.log(`${created}\nSet STRAVA_SUBSCRIPTION_ID to the id above (Railway variables).`);
    break;
  }
  case "delete": {
    if (!argument) throw new Error("usage: delete <subscription id>");
    await call("DELETE", `${API}/${argument}?${new URLSearchParams(credentials)}`);
    console.log(`Deleted subscription ${argument}.`);
    break;
  }
  default:
    console.error("usage: npm run strava:subscribe -- list | create <app URL> | delete <id>");
    process.exitCode = 1;
}
