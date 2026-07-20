import { describe, it, expect } from "vitest";
import { calculateE1RM, getE1RMTrend, getE1RMPerSet, FORMULAS } from "./e1rm.js";

describe("calculateE1RM", () => {
  it("computes Epley e1RM correctly", () => {
    // 100 * (1 + 5/30) = 116.666...
    expect(calculateE1RM(100, 5, "epley")).toBeCloseTo(116.6667, 3);
  });

  it("computes Brzycki e1RM correctly", () => {
    // 100 * (36 / (37 - 5)) = 112.5
    expect(calculateE1RM(100, 5, "brzycki")).toBeCloseTo(112.5, 3);
  });

  it("defaults to Epley when no formula is given", () => {
    expect(calculateE1RM(100, 5)).toBeCloseTo(calculateE1RM(100, 5, FORMULAS.EPLEY), 6);
  });

  it("returns the weight itself for a 1-rep set (both formulas)", () => {
    expect(calculateE1RM(225, 1, "epley")).toBeCloseTo(225 * (1 + 1 / 30), 3);
    expect(calculateE1RM(225, 1, "brzycki")).toBeCloseTo(225 * (36 / 36), 3);
  });

  it("returns null for zero or negative reps", () => {
    expect(calculateE1RM(100, 0, "epley")).toBeNull();
    expect(calculateE1RM(100, -3, "epley")).toBeNull();
    expect(calculateE1RM(100, 0, "brzycki")).toBeNull();
  });

  it("returns null for zero or negative weight", () => {
    expect(calculateE1RM(0, 8, "epley")).toBeNull();
    expect(calculateE1RM(-45, 8, "epley")).toBeNull();
  });

  it("returns null for non-numeric input", () => {
    expect(calculateE1RM("", 5, "epley")).toBeNull();
    expect(calculateE1RM(100, "", "epley")).toBeNull();
    expect(calculateE1RM(undefined, undefined, "epley")).toBeNull();
  });

  it("caps reps at 12 so high-rep sets don't distort the estimate", () => {
    const at12 = calculateE1RM(100, 12, "epley");
    const at20 = calculateE1RM(100, 20, "epley");
    const at50 = calculateE1RM(100, 50, "epley");
    expect(at20).toBeCloseTo(at12, 6);
    expect(at50).toBeCloseTo(at12, 6);
  });

  it("caps reps at 12 for Brzycki too, avoiding the divide-by-zero at 37 reps", () => {
    const at12 = calculateE1RM(100, 12, "brzycki");
    const at40 = calculateE1RM(100, 40, "brzycki");
    expect(at40).toBeCloseTo(at12, 6);
    expect(Number.isFinite(at40)).toBe(true);
  });
});

describe("getE1RMTrend", () => {
  const entries = [
    { workoutId: "a", date: "2026-07-01", time: "2026-07-01T09:00:00.000Z", sets: [{ weight: 100, reps: 5 }, { weight: 105, reps: 3 }] },
    { workoutId: "b", date: "2026-07-10", time: "2026-07-10T09:00:00.000Z", sets: [{ weight: 0, reps: 5 }] }, // no valid sets
    { workoutId: "c", date: "2026-07-05", time: "2026-07-05T09:00:00.000Z", sets: [{ weight: 110, reps: 1 }] },
  ];

  it("returns one point per session using the session's best e1RM", () => {
    const trend = getE1RMTrend(entries, "epley");
    const a = trend.find(p => p.workoutId === "a");
    const expectedBest = Math.max(calculateE1RM(100, 5, "epley"), calculateE1RM(105, 3, "epley"));
    expect(a.e1rm).toBeCloseTo(expectedBest, 6);
  });

  it("omits sessions with no valid sets", () => {
    const trend = getE1RMTrend(entries, "epley");
    expect(trend.find(p => p.workoutId === "b")).toBeUndefined();
  });

  it("sorts chronologically ascending (oldest first)", () => {
    const trend = getE1RMTrend(entries, "epley");
    const dates = trend.map(p => p.date);
    expect(dates).toEqual(["2026-07-01", "2026-07-05"]);
  });
});

describe("getE1RMPerSet", () => {
  const entries = [
    { workoutId: "a", date: "2026-07-01", time: "2026-07-01T09:00:00.000Z", sets: [{ weight: 100, reps: 5 }, { weight: 0, reps: 5 }] },
    { workoutId: "b", date: "2026-07-05", time: "2026-07-05T09:00:00.000Z", sets: [{ weight: 110, reps: 1 }] },
  ];

  it("returns one row per valid individual set, excluding invalid ones", () => {
    const rows = getE1RMPerSet(entries, "epley");
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.e1rm !== null)).toBe(true);
  });

  it("sorts newest first", () => {
    const rows = getE1RMPerSet(entries, "epley");
    expect(rows[0].workoutId).toBe("b");
    expect(rows[1].workoutId).toBe("a");
  });

  it("carries the original weight/reps alongside the computed e1RM", () => {
    const rows = getE1RMPerSet(entries, "epley");
    const row = rows.find(r => r.workoutId === "b");
    expect(row.weight).toBe(110);
    expect(row.reps).toBe(1);
  });
});
