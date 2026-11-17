import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ActivityStore } from "../db/activities.js";
import type { PlannedWorkoutStore } from "../db/planned-workouts.js";
import type { TrainingPlanStore } from "../db/training-plans.js";
import { SESSION_TYPES } from "../training/session-types.js";
import { addDays, localDate, localMidnight, weekStart } from "../utils/dates.js";
import {
  checkTelegramLogin,
  clearedSessionCookie,
  readCookie,
  SESSION_COOKIE,
  sessionCookie,
  signSession,
  verifySession,
} from "./auth.js";
import { completionModel, typeModel, typeSummaries, weekModel } from "./models.js";
import { completionPage } from "./views/completion.js";
import { DASHBOARD_PATH } from "./views/format.js";
import { page, STYLE_HASH } from "./views/layout.js";
import { loginPage } from "./views/login.js";
import { sessionPage } from "./views/session.js";
import { typePage, typesPage } from "./views/types.js";
import { weekPage } from "./views/week.js";

// ADR-022: a read-only dashboard behind a Telegram login. Every route in this scope except the
// login routes sits behind one onRequest hook; routes.test.ts asks every registered route
// without a session and expects the login redirect, so a new route can't be left open.

export const LOGIN_PATH = `${DASHBOARD_PATH}/login`;
export const AUTH_PATH = `${DASHBOARD_PATH}/auth`;
export const LOGOUT_PATH = `${DASHBOARD_PATH}/logout`;
export const DEV_LOGIN_PATH = `${DASHBOARD_PATH}/dev-login`;

// Routes reachable without a session.
const OPEN_ROUTES = new Set([LOGIN_PATH, AUTH_PATH, LOGOUT_PATH, DEV_LOGIN_PATH]);
// Routes that can answer with the login page, the only one that loads Telegram's widget.
const LOGIN_PAGE_ROUTES = new Set([LOGIN_PATH, AUTH_PATH]);

export const COMPLETION_WEEKS = 12;

const BASE_CSP = [
  "default-src 'none'",
  `style-src ${STYLE_HASH}`,
  "img-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
];
const PAGE_CSP = BASE_CSP.join("; ");
const LOGIN_CSP = [
  ...BASE_CSP,
  "script-src https://telegram.org",
  "frame-src https://telegram.org https://oauth.telegram.org",
].join("; ");

export type DashboardDeps = {
  planned: PlannedWorkoutStore;
  plans: Pick<TrainingPlanStore, "forWeek">;
  activities: Pick<ActivityStore, "between">;
  botToken: string;
  botUsername: () => Promise<string>;
  // TELEGRAM_AUTHORIZED_CHAT_ID: in a private chat the chat ID is the user ID (ADR-006).
  authorizedUserId: number;
  sessionSecret: string;
  // Absolute base for the widget's redirect.
  publicUrl: string;
  timeZone: string;
  // False only for local http development.
  secureCookie: boolean;
  // Registers /dashboard/dev-login, which signs in without Telegram. Development only.
  devLogin: boolean;
  now?: () => Date;
};

// The refine also runs when the format check failed, so it guards itself.
const mondaySchema = z.iso
  .date()
  .refine((date) => !Number.isNaN(Date.parse(date)) && weekStart(date) === date);
const idSchema = z.coerce.number().int().positive().max(2_147_483_647);
const typeSchema = z.enum(SESSION_TYPES);

export function registerDashboard(app: FastifyInstance, deps: DashboardDeps): void {
  const now = deps.now ?? (() => new Date());
  const today = () => localDate(now(), deps.timeZone);
  const cookieOptions = { secure: deps.secureCookie };

  const signedIn = (request: FastifyRequest) =>
    verifySession(readCookie(request.headers.cookie, SESSION_COOKIE), {
      secret: deps.sessionSecret,
      authorizedUserId: deps.authorizedUserId,
      now: now(),
    });

  const html = (reply: FastifyReply, body: string, status = 200) =>
    reply.code(status).type("text/html; charset=utf-8").send(body);

  const notFound = (reply: FastifyReply) =>
    html(
      reply,
      page("Not found", null, '<h1>Not found</h1><p class="muted">Nothing here.</p>'),
      404,
    );

  const signIn = (reply: FastifyReply) =>
    reply
      .header(
        "set-cookie",
        sessionCookie(signSession(deps.authorizedUserId, now(), deps.sessionSecret), cookieOptions),
      )
      .redirect(DASHBOARD_PATH, 302);

  const login = async (reply: FastifyReply, status = 200) =>
    html(
      reply,
      loginPage({
        botUsername: await deps.botUsername(),
        authUrl: new URL(AUTH_PATH, deps.publicUrl).toString(),
      }),
      status,
    );

  app.register(async (scope) => {
    scope.addHook("onRequest", async (request, reply) => {
      if (OPEN_ROUTES.has(request.routeOptions.url ?? "")) return;
      if (!signedIn(request)) return reply.redirect(LOGIN_PATH, 302);
    });

    scope.addHook("onSend", async (request, reply, payload) => {
      reply.headers({
        "cache-control": "no-store",
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-robots-tag": "noindex, nofollow",
        "content-security-policy": LOGIN_PAGE_ROUTES.has(request.routeOptions.url ?? "")
          ? LOGIN_CSP
          : PAGE_CSP,
      });
      return payload;
    });

    scope.get(LOGIN_PATH, async (request, reply) =>
      signedIn(request) ? reply.redirect(DASHBOARD_PATH, 302) : login(reply),
    );

    // The widget's redirect. Anything but a fresh, valid login of the athlete gets the login
    // page again and a log line, nothing more.
    scope.get(AUTH_PATH, async (request, reply) => {
      const result = checkTelegramLogin(request.query, {
        botToken: deps.botToken,
        authorizedUserId: deps.authorizedUserId,
        now: now(),
      });
      if (!result.ok) {
        request.log.warn({ module: "dashboard", reason: result.reason }, "dashboard login refused");
        return login(reply, 403);
      }
      request.log.info({ module: "dashboard" }, "dashboard login");
      return signIn(reply);
    });

    scope.get(LOGOUT_PATH, async (_request, reply) =>
      reply.header("set-cookie", clearedSessionCookie(cookieOptions)).redirect(LOGIN_PATH, 302),
    );

    if (deps.devLogin) scope.get(DEV_LOGIN_PATH, async (_request, reply) => signIn(reply));

    const week = async (reply: FastifyReply, monday: string) => {
      const sunday = addDays(monday, 7);
      const [records, stored, activities] = await Promise.all([
        deps.planned.between(monday, sunday),
        deps.plans.forWeek(monday),
        deps.activities.between(
          localMidnight(monday, deps.timeZone),
          localMidnight(sunday, deps.timeZone),
        ),
      ]);
      const model = weekModel(monday, records, activities, (instant) =>
        localDate(instant, deps.timeZone),
      );
      return html(reply, weekPage(model, stored?.plan ?? null, { today: today() }));
    };

    scope.get(DASHBOARD_PATH, async (_request, reply) => week(reply, weekStart(today())));

    scope.get<{ Params: { monday: string } }>(
      `${DASHBOARD_PATH}/week/:monday`,
      async (request, reply) => {
        const monday = mondaySchema.safeParse(request.params.monday);
        return monday.success ? week(reply, monday.data) : notFound(reply);
      },
    );

    scope.get<{ Params: { id: string } }>(
      `${DASHBOARD_PATH}/session/:id`,
      async (request, reply) => {
        const id = idSchema.safeParse(request.params.id);
        const record = id.success ? await deps.planned.byId(id.data) : null;
        return record ? html(reply, sessionPage(record)) : notFound(reply);
      },
    );

    scope.get(`${DASHBOARD_PATH}/completion`, async (_request, reply) => {
      const last = weekStart(today());
      const first = addDays(last, -7 * (COMPLETION_WEEKS - 1));
      const records = await deps.planned.between(first, addDays(last, 7));
      return html(reply, completionPage(completionModel(last, COMPLETION_WEEKS, records)));
    });

    scope.get(`${DASHBOARD_PATH}/types`, async (_request, reply) =>
      html(reply, typesPage(typeSummaries(await deps.planned.all()))),
    );

    scope.get<{ Params: { type: string } }>(
      `${DASHBOARD_PATH}/types/:type`,
      async (request, reply) => {
        const type = typeSchema.safeParse(request.params.type);
        if (!type.success) return notFound(reply);
        return html(reply, typePage(typeModel(type.data, await deps.planned.ofType(type.data))));
      },
    );
  });
}
