import type { CallType } from "./claude.js";

// spec.md §6.1 model router, biased per review doc #13: a plan request misrouted to Haiku
// gives a worse plan the athlete may follow, a chat message misrouted to Sonnet costs a few
// cents. So anything that mentions days, sessions, sports, plans, races or thresholds, or
// asks about the athlete's own data, goes to Sonnet. Haiku only gets the clearly safe cases:
// greetings and thanks, and general training-science questions that aren't about the athlete.

export type RoutedCallType = Extract<
  CallType,
  "chat" | "plan_adjustment" | "analysis" | "quick_chat" | "knowledge_qa" | "deep"
>;

export type Route = { callType: RoutedCallType; reason: string };

export type RouteInput = {
  text: string;
  // `/deep <message>`: the athlete forced Sonnet.
  deep?: boolean;
  // The onboarding conversation runs on Sonnet (ADR-016).
  onboarding?: boolean;
  // The previous reply came from Sonnet a few minutes ago: a short follow-up ("yes, do it")
  // belongs to that conversation and may need its tools.
  followsSonnet?: boolean;
};

// Days, sessions, sports, plans, races and thresholds: any of these forces Sonnet.
const SONNET_TOPICS = [
  /\b(mon|tue|wed|thu|fri|sat|sun)(day|sday|nesday|rsday|urday)?s?\b/,
  /\b(today|tonight|tomorrow|yesterday|weekend)\b/,
  /\b(plans?|planned|planning|weeks?|weekly|schedule|calendar|sessions?|workouts?|rest day|recovery week|deload)\b/,
  /\b(runs?|running|ran|jog|long run|rides?|riding|bike|cycling|swims?|swimming|bricks?|intervals?|tempo|threshold|hills?|strides|strength|gym|tennis|hike|trail)\b/,
  /\b(races?|racing|marathon|half|ironman|70\.3|triathlon|tri|taper|goals?|event|pb|pr)\b/,
  /\b(ftp|vdot|lthr|css|zones?|paces?|watts|heart rate|hr)\b/,
];

// A plan change: an edit verb (plus a topic word, checked separately).
const PLAN_CHANGE =
  /\b(move|moving|swap|switch|shift|reschedule|skip|skipping|replace|drop|cancel|postpone|push|shorten|extend|add|remove|change|instead|can't make|cannot make|won't make|busy|travel|travelling|traveling)\b/;

// Looking at the athlete's own numbers or trends (with PERSONAL).
const ANALYSIS =
  /\b(trend|trending|progress|progressing|on track|compare|compared|analy[sz]e|analysis|volume|load|ctl|atl|acwr|hrv|fatigue|fatigued|overtrain\w*|improv\w*|fitness|form)\b/;

// About the athlete: questions with these are personal, not general knowledge.
const PERSONAL = /\b(i|i'm|im|i've|i'd|i'll|me|my|mine)\b/;

// A general question: asks what/why/how, or mentions research.
const KNOWLEDGE =
  /\?|\b(what|why|how|explain|difference|research|study|studies|science|evidence|literature|paper)\b/;

const SMALL_TALK_WORDS = new Set(
  (
    "hi hey hello yo good morning evening afternoon night thanks thank you thx ty cheers great " +
    "cool nice awesome perfect ok okay k got it noted sounds see bye a lot so much very"
  ).split(" "),
);

// Nothing but greetings, thanks or acknowledgements (emoji and punctuation ignored).
function isSmallTalk(message: string): boolean {
  const words = message
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  return words.length <= 6 && words.every((word) => SMALL_TALK_WORDS.has(word));
}

export function routeMessage({ text, deep, onboarding, followsSonnet }: RouteInput): Route {
  if (deep) return { callType: "deep", reason: "/deep" };
  if (onboarding) return { callType: "chat", reason: "onboarding" };

  const message = text.toLowerCase().replace(/[’`]/g, "'").trim();
  const topic = SONNET_TOPICS.some((pattern) => pattern.test(message));
  if (topic && PLAN_CHANGE.test(message)) {
    return { callType: "plan_adjustment", reason: "plan change" };
  }
  if (ANALYSIS.test(message) && PERSONAL.test(message)) {
    return { callType: "analysis", reason: "own data" };
  }
  if (topic) return { callType: "chat", reason: "training topic" };
  if (isSmallTalk(message)) return { callType: "quick_chat", reason: "small talk" };
  if (followsSonnet) return { callType: "chat", reason: "follow-up" };
  if (KNOWLEDGE.test(message) && !PERSONAL.test(message)) {
    return { callType: "knowledge_qa", reason: "general question" };
  }
  // Uncertain: Sonnet (review doc #13).
  return { callType: "chat", reason: "default" };
}
