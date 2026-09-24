import { describe, expect, it } from "vitest";
import { danielsPaces, vdotFromRace } from "./vdot.js";

const time = (clock: string) =>
  clock.split(":").reduce((total, part) => total * 60 + Number(part), 0);

// Race times from the VDOT table in Daniels' Running Formula.
describe("vdotFromRace", () => {
  it.each([
    [5000, "24:08", 40],
    [10_000, "50:03", 40],
    [5000, "19:57", 50],
    [10_000, "41:21", 50],
    [21_097.5, "1:31:35", 50],
    [42_195, "3:10:49", 50],
    [5000, "17:03", 60],
    [42_195, "2:43:25", 60],
  ])("%d m in %s is VDOT %d", (distance, clock, expected) => {
    expect(vdotFromRace(distance, time(clock))).toBeCloseTo(expected, 0);
    expect(Math.abs(vdotFromRace(distance, time(clock)) - expected)).toBeLessThan(0.3);
  });

  it("rejects nonsense input", () => {
    expect(() => vdotFromRace(0, 100)).toThrow(RangeError);
  });
});

describe("danielsPaces", () => {
  // VDOT 50 in the published table: E 5:07-5:38, M 4:31, T 4:15, I 3:55 per km.
  it("matches the VDOT 50 training paces within 3 s/km", () => {
    const paces = danielsPaces(50);
    expect(Math.abs(paces.E[0] - time("5:38"))).toBeLessThan(3);
    expect(Math.abs(paces.E[1] - time("5:07"))).toBeLessThan(3);
    expect(Math.abs(paces.M[0] - time("4:31"))).toBeLessThan(3);
    expect(Math.abs(paces.T[0] - time("4:15"))).toBeLessThan(3);
    expect(Math.abs(paces.I[0] - time("3:55"))).toBeLessThan(3);
  });

  it("gets faster as VDOT rises", () => {
    expect(danielsPaces(55).T[0]).toBeLessThan(danielsPaces(50).T[0]);
  });
});
