import { describe, expect, it } from "vitest";
import { routeMessage } from "./classifier.js";

const route = (text: string, options: { followsSonnet?: boolean } = {}) =>
  routeMessage({ text, ...options }).callType;

describe("routeMessage", () => {
  it.each([
    "Move Thursday's run to Friday",
    "Can I swap the long ride and the swim?",
    "Add a swim session this week",
    "I can't make tomorrow's intervals, travelling",
    "skip the gym on wed",
  ])("sends plan changes to Sonnet as plan_adjustment: %s", (text) => {
    expect(route(text)).toBe("plan_adjustment");
  });

  it.each([
    "How's my running volume trending?",
    "Am I on track?",
    "Is my fitness improving?",
    "My HRV looks low, am I fatigued?",
  ])("sends analysis of the athlete's data to Sonnet: %s", (text) => {
    expect(route(text)).toBe("analysis");
  });

  // Review doc #13: day, workout, plan, week and race words force Sonnet, whatever the length.
  it.each([
    "What's my plan for tomorrow?",
    "What's a good brick workout?",
    "Should I taper 2 or 3 weeks?",
    "race?",
    "Sunday",
    "What is FTP?",
  ])("keeps anything about days, sessions, plans or races on Sonnet: %s", (text) => {
    expect(["chat", "plan_adjustment", "analysis"]).toContain(route(text));
  });

  it.each(["Thanks!", "thank you so much 🙏", "hi", "Good morning", "ok", "👍", "cool, got it"])(
    "sends small talk to Haiku: %s",
    (text) => {
      expect(route(text)).toBe("quick_chat");
    },
  );

  it.each([
    "What does the research say is the best way to increase VO2max?",
    "Why does caffeine help endurance?",
    "Explain the difference between lactate and ventilatory thresholds",
  ])("sends general questions to Haiku as knowledge_qa: %s", (text) => {
    expect(route(text)).toBe("knowledge_qa");
  });

  it("keeps personal questions on Sonnet", () => {
    expect(route("Why do I feel so tired lately?")).toBe("chat");
    expect(route("I slept badly")).toBe("chat");
  });

  it("keeps a short follow-up to a Sonnet reply on Sonnet, but not thanks", () => {
    expect(route("yes, do it", { followsSonnet: true })).toBe("chat");
    expect(route("sounds good, thanks", { followsSonnet: true })).toBe("quick_chat");
    expect(route("Why?", { followsSonnet: true })).toBe("chat");
    expect(route("Why?")).toBe("knowledge_qa");
  });

  it("honours /deep and onboarding", () => {
    expect(routeMessage({ text: "hi", deep: true }).callType).toBe("deep");
    expect(routeMessage({ text: "thanks", onboarding: true }).callType).toBe("chat");
  });
});
