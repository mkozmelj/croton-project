import type { FastifyInstance } from "fastify";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import type { ActivitySummary } from "../db/activities.js";
import type { PlannedWorkoutRow, SessionRecord } from "../db/planned-workouts.js";
import { buildServer } from "../server.js";
import { SESSION_COOKIE, signSession } from "./auth.js";
import {
  AUTH_PATH,
  type DashboardDeps,
  DEV_LOGIN_PATH,
  LOGIN_PATH,
  LOGOUT_PATH,
  registerDashboard,
} from "./routes.js";
import { signedLogin, TEST_BOT_TOKEN, TEST_SESSION_SECRET, TEST_USER_ID } from "./test-helpers.js";

const NOW = new Date("2026-11-18T10:00:00Z"); // a Wednesday
const nowSeconds = NOW.getTime() / 1000;

function row(overrides: Partial<PlannedWorkoutRow>): PlannedWorkoutRow {
  return {
    id: 1,
    key: "croton:test:0",
    weekStart: "2026-11-16",
    date: "2026-11-16",
    startTime: "07:00",
    sport: "run",
    sessionType: "run_threshold",
    title: "Threshold <intervals>",
    intensity: "hard",
    durationMinutes: 50,
    activeMinutes: 50,
    structure: [{ segment: "main", description: "3x8 min Z4" }],
    steps: null,
    targets: null,
    fieldTest: null,
    notes: null,
    status: "done",
    statusSource: "match",
    activityId: 10,
    brickWith: null,
    replacedBy: null,
    calendarEventId: null,
    source: "plan",
    mainSet: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function activity(overrides: Partial<ActivitySummary>): ActivitySummary {
  return {
    id: 10,
    externalId: "1",
    source: "strava",
    sport: "run",
    name: "Morning <b>run</b>",
    startedAt: new Date("2026-11-16T06:05:00Z"),
    durationSeconds: 48 * 60,
    elapsedSeconds: 50 * 60,
    distanceMeters: 9_600,
    elevationGainMeters: 40,
    avgHr: 158,
    maxHr: 172,
    avgPacePerKm: 300,
    avgPower: null,
    trainingLoad: 80,
    zoneDistribution: null,
    laps: null,
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const run = activity({});
const unplanned = activity({
  id: 11,
  name: "Commute ride",
  sport: "bike",
  startedAt: new Date("2026-11-17T16:00:00Z"),
  durationSeconds: 1800,
});
const records: SessionRecord[] = [
  { session: row({}), activity: run, feedback: null },
  {
    session: row({
      id: 2,
      date: "2026-11-17",
      sport: "swim",
      sessionType: "swim_css",
      title: "CSS set",
      status: "skipped",
      statusSource: "timeout",
      activityId: null,
    }),
    activity: null,
    feedback: null,
  },
];

function setup(overrides: Partial<DashboardDeps> = {}) {
  const app = buildServer({ logger: pino({ level: "silent" }) });
  const routes: string[] = [];
  app.addHook("onRoute", (route) => {
    if (route.url.startsWith("/dashboard") && route.method === "GET") routes.push(route.url);
  });
  registerDashboard(app, {
    planned: {
      between: async (from, to) =>
        records.filter(({ session }) => session.date >= from && session.date < to),
      all: async () => records,
      ofType: async (type) => records.filter(({ session }) => session.sessionType === type),
      byId: async (id) => records.find(({ session }) => session.id === id) ?? null,
    },
    plans: { forWeek: async () => null },
    activities: { between: async () => [run, unplanned] },
    botToken: TEST_BOT_TOKEN,
    botUsername: async () => "croton_test_bot",
    authorizedUserId: TEST_USER_ID,
    sessionSecret: TEST_SESSION_SECRET,
    publicUrl: "https://croton.example",
    timeZone: "Europe/Ljubljana",
    secureCookie: true,
    devLogin: false,
    now: () => NOW,
    ...overrides,
  });
  return { app, routes };
}

const cookie = (value: string) => ({ cookie: `${SESSION_COOKIE}=${value}` });
const session = () => cookie(signSession(TEST_USER_ID, NOW, TEST_SESSION_SECRET));

// A concrete URL for a registered route pattern.
const sample = (url: string) =>
  url.replace(":monday", "2026-11-16").replace(":id", "1").replace(":type", "run_threshold");

async function get(app: FastifyInstance, url: string, headers: Record<string, string> = {}) {
  return app.inject({ method: "GET", url, headers });
}

describe("dashboard access", () => {
  it("redirects every page to the login without a session or with a forged one", async () => {
    const { app, routes } = setup();
    await app.ready();
    const open = new Set([LOGIN_PATH, AUTH_PATH, LOGOUT_PATH, DEV_LOGIN_PATH]);
    const protectedRoutes = routes.filter((url) => !open.has(url));
    expect(protectedRoutes.length).toBeGreaterThanOrEqual(6);
    const forged = Buffer.from(JSON.stringify({ uid: TEST_USER_ID, exp: 9e9 })).toString(
      "base64url",
    );
    for (const url of protectedRoutes) {
      for (const headers of [
        {},
        cookie(`${forged}.AAAA`),
        cookie(signSession(TEST_USER_ID, NOW, "another-secret-that-is-32-bytes-long")),
        cookie(signSession(777, NOW, TEST_SESSION_SECRET)),
      ]) {
        const response = await get(app, sample(url), headers);
        expect(response.statusCode, `${url} ${JSON.stringify(headers)}`).toBe(302);
        expect(response.headers.location).toBe(LOGIN_PATH);
      }
    }
  });

  it("serves the pages with a valid session, and never caches them", async () => {
    const { app, routes } = setup();
    await app.ready();
    for (const url of routes.filter((u) => ![LOGIN_PATH, AUTH_PATH, LOGOUT_PATH].includes(u))) {
      const response = await get(app, sample(url), session());
      expect(response.statusCode, url).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["x-frame-options"]).toBe("DENY");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.headers["content-security-policy"]).not.toContain("script-src");
      expect(response.body).toContain('<meta name="robots" content="noindex, nofollow">');
    }
  });

  it("has no dev login outside development", async () => {
    const { app } = setup();
    expect((await get(app, DEV_LOGIN_PATH)).statusCode).toBe(404);
  });

  it("signs in directly with the dev login in development", async () => {
    const { app } = setup({ devLogin: true, secureCookie: false });
    const response = await get(app, DEV_LOGIN_PATH);
    expect(response.statusCode).toBe(302);
    expect(String(response.headers["set-cookie"])).toContain(`${SESSION_COOKIE}=`);
    expect(String(response.headers["set-cookie"])).not.toContain("Secure");
  });
});

describe("dashboard login", () => {
  const fields = {
    id: String(TEST_USER_ID),
    first_name: "Test",
    auth_date: String(nowSeconds - 10),
  };

  it("shows the Telegram widget, the only page allowed to load its script", async () => {
    const { app } = setup();
    const response = await get(app, LOGIN_PATH);
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('data-telegram-login="croton_test_bot"');
    expect(response.body).toContain('data-auth-url="https://croton.example/dashboard/auth"');
    expect(response.headers["content-security-policy"]).toContain(
      "script-src https://telegram.org",
    );
  });

  it("sets a session cookie for a valid login of the athlete", async () => {
    const { app } = setup();
    const response = await get(
      app,
      `${AUTH_PATH}?${new URLSearchParams(signedLogin(fields)).toString()}`,
    );
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/dashboard");
    const setCookie = String(response.headers["set-cookie"]);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    const value = /croton_session=([^;]+)/.exec(setCookie)?.[1] ?? "";
    expect((await get(app, "/dashboard", cookie(value))).statusCode).toBe(200);
  });

  it("answers anything else with the login page and no cookie", async () => {
    const { app } = setup();
    for (const query of [
      signedLogin({ ...fields, id: "777" }),
      { ...signedLogin(fields), first_name: "Changed" },
      signedLogin({ ...fields, auth_date: String(nowSeconds - 600) }),
      {},
    ]) {
      const response = await get(app, `${AUTH_PATH}?${new URLSearchParams(query).toString()}`);
      expect(response.statusCode).toBe(403);
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.body).toContain("telegram-widget.js");
    }
  });

  it("clears the cookie on logout", async () => {
    const { app } = setup();
    const response = await get(app, LOGOUT_PATH, session());
    expect(response.headers.location).toBe(LOGIN_PATH);
    expect(String(response.headers["set-cookie"])).toContain("Max-Age=0");
  });
});

describe("dashboard pages", () => {
  it("shows the week with statuses, unplanned activities, and escaped text", async () => {
    const { app } = setup();
    const body = (await get(app, "/dashboard", session())).body;
    expect(body).toContain("Week of 16 Nov 2026");
    expect(body).toContain("Threshold &lt;intervals&gt;");
    expect(body).not.toContain("<intervals>");
    expect(body).toContain('class="row s-done"');
    expect(body).toContain('class="row s-skipped"');
    expect(body).toContain("Commute ride");
    expect(body).toContain("Unplanned");
    // 1 done of 2 counted sessions.
    expect(body).toContain("<b>50%</b>");
  });

  it("returns 404 for a date that isn't a Monday, an unknown session or type", async () => {
    const { app } = setup();
    for (const url of [
      "/dashboard/week/2026-11-17",
      "/dashboard/week/nope",
      "/dashboard/session/999",
      "/dashboard/session/abc",
      "/dashboard/types/not_a_type",
    ]) {
      expect((await get(app, url, session())).statusCode, url).toBe(404);
    }
  });

  it("shows a session's plan next to its activity", async () => {
    const { app } = setup();
    const body = (await get(app, "/dashboard/session/1", session())).body;
    expect(body).toContain("3x8 min Z4");
    expect(body).toContain("Morning &lt;b&gt;run&lt;/b&gt;");
    expect(body).toContain("158 avg / 172 max");
  });

  it("lists skipped sessions on the completion page and charts the type history", async () => {
    const { app } = setup();
    const completion = (await get(app, "/dashboard/completion", session())).body;
    expect(completion).toContain("Skipped (1)");
    expect(completion).toContain("CSS set");
    expect(completion).toContain("<svg");
    const type = (await get(app, "/dashboard/types/run_threshold", session())).body;
    expect(type).toContain("<circle");
    expect(type).toContain("5:00 /km");
    const types = (await get(app, "/dashboard/types", session())).body;
    expect(types).toContain("Run threshold");
    expect(types).toContain("Swim CSS");
  });
});
