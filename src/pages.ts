import type { FastifyInstance } from "fastify";

// The homepage and privacy policy the Google OAuth consent screen requires before the app
// can be published (ADR-011: "In production", so refresh tokens don't expire after 7 days).
// Static text only; nothing here reads data.

export const HOME_PATH = "/";
export const PRIVACY_PATH = "/privacy";

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;color:#222}</style></head><body>${body}</body></html>`;

const HOME = page(
  "Croton training coach",
  `<h1>Croton training coach</h1>
<p>A private training coach for a single athlete. It plans training weeks through a Telegram chat and, once the athlete confirms a plan, adds the sessions to their Google Calendar.</p>
<p>It is not a public service: only the operator's own accounts are connected. <a href="${PRIVACY_PATH}">Privacy policy</a>.</p>`,
);

const PRIVACY = page(
  "Privacy policy - Croton training coach",
  `<h1>Privacy policy</h1>
<p>Croton is a private application used by one person, its operator. No other users are accepted.</p>
<h2>Google Calendar data</h2>
<p>With the <code>calendar.events</code> permission the app reads events in the primary calendar for the week being planned, so training sessions fit around existing appointments, and creates, updates and deletes the training sessions it adds after the athlete confirms a plan. It does not change other events.</p>
<p>Event details are used only to build that week's training plan. They are sent to Anthropic's Claude API as part of the planning request and are not stored by the app or shared with anyone else.</p>
<h2>Storage and security</h2>
<p>OAuth tokens are stored encrypted (AES-256-GCM) in the app's database and used only for the actions above. Access can be revoked at any time in the Google Account settings under Security → Third-party access.</p>
<h2>Other data</h2>
<p>Training data from Strava and Intervals.icu and the Telegram conversation are stored only to coach the operator and are not sold or shared.</p>
<p>Use of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements.</p>`,
);

export function registerInfoPages(app: FastifyInstance): void {
  app.get(HOME_PATH, async (_request, reply) => reply.type("text/html").send(HOME));
  app.get(PRIVACY_PATH, async (_request, reply) => reply.type("text/html").send(PRIVACY));
}
