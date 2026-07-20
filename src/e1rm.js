// Estimated 1-Rep Max (e1RM) utilities.
//
// Pure functions only — e1RM is always derived on demand from a set's raw
// weight/reps, never stored, so it can't drift out of sync with the actual
// logged data and works retroactively if the formula or rep cap ever changes.

export const FORMULAS = { EPLEY: "epley", BRZYCKI: "brzycki" };

// Standard e1RM formulas lose accuracy above ~12 reps (the estimate curve
// stops behaving realistically), so reps are capped before the formula runs.
const REP_CAP = 12;

/**
 * Computes estimated 1-rep max for a single set.
 * Returns null for sets that can't produce a meaningful e1RM (zero/negative
 * weight or reps) so callers never plot a false zero/baseline point.
 */
export function calculateE1RM(weight, reps, formula = FORMULAS.EPLEY) {
  const w = Number(weight);
  const r = Number(reps);

  if (!Number.isFinite(w) || !Number.isFinite(r)) return null;
  if (w <= 0 || r <= 0) return null;

  const cappedReps = Math.min(r, REP_CAP);

  if (formula === FORMULAS.BRZYCKI) {
    const denominator = 37 - cappedReps;
    if (denominator <= 0) return null; // unreachable with the 12-rep cap, guarded anyway
    return w * (36 / denominator);
  }

  // Epley (default)
  return w * (1 + cappedReps / 30);
}

/**
 * One point per workout session, using the session's best (max) e1RM among
 * its valid sets for that exercise. Sessions with no valid sets are omitted.
 * `entries` is the same shape ExerciseHistoryView already works with:
 * [{ workoutId, date, time, sets: [{ weight, reps }, ...] }, ...]
 */
export function getE1RMTrend(entries, formula = FORMULAS.EPLEY) {
  const points = [];

  for (const entry of entries) {
    let best = null;
    for (const s of entry.sets) {
      const val = calculateE1RM(s.weight, s.reps, formula);
      if (val !== null && (best === null || val > best)) best = val;
    }
    if (best !== null) {
      points.push({ workoutId: entry.workoutId, date: entry.date, time: entry.time, e1rm: best });
    }
  }

  return points.sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")));
}

/**
 * One row per individual valid set (not aggregated per session), newest
 * first — for the raw "e1RM per set" log view.
 */
export function getE1RMPerSet(entries, formula = FORMULAS.EPLEY) {
  const rows = [];

  for (const entry of entries) {
    entry.sets.forEach((s, setIndex) => {
      const val = calculateE1RM(s.weight, s.reps, formula);
      if (val !== null) {
        rows.push({
          workoutId: entry.workoutId,
          date: entry.date,
          time: entry.time,
          setIndex,
          weight: s.weight,
          reps: s.reps,
          e1rm: val,
        });
      }
    });
  }

  return rows.sort((a, b) => (b.date + (b.time || "")).localeCompare(a.date + (a.time || "")));
}
