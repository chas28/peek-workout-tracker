import { supabase } from "./supabaseClient.js";
import { ensureAnonSession } from "./anonSession.js";

// Background sync to Supabase. localStorage stays the instant, always-on
// source of truth for rendering (see WorkoutTracker.jsx's persist/
// persistRestDays); these calls mirror the same writes to Supabase so data
// survives a cleared browser or a new device carrying the same session,
// without blocking or slowing down the local save.

function workoutToRow(workout, userId) {
  return {
    id: workout.id,
    user_id: userId,
    date: workout.date,
    time: workout.time,
    title: workout.title,
    type: workout.type,
    exercises: workout.exercises,
    updated_at: new Date().toISOString(),
  };
}

export async function pullCloudState() {
  const userId = await ensureAnonSession();

  const [workoutsRes, restDaysRes, settingsRes] = await Promise.all([
    supabase.from("workouts").select("*").eq("user_id", userId).order("date", { ascending: false }),
    supabase.from("rest_days").select("date").eq("user_id", userId),
    supabase.from("user_settings").select("*").eq("user_id", userId).maybeSingle(),
  ]);

  if (workoutsRes.error) throw workoutsRes.error;
  if (restDaysRes.error) throw restDaysRes.error;
  if (settingsRes.error) throw settingsRes.error;

  return {
    workouts: (workoutsRes.data || []).map(row => ({
      id: row.id,
      date: row.date,
      time: row.time,
      title: row.title,
      type: row.type,
      exercises: row.exercises,
    })),
    restDays: (restDaysRes.data || []).map(row => row.date),
    settings: settingsRes.data
      ? { theme: settingsRes.data.theme, timeFormat: settingsRes.data.time_format, weightUnit: settingsRes.data.weight_unit }
      : null,
  };
}

export async function syncWorkouts(next, previous) {
  const userId = await ensureAnonSession();

  const prevIds = new Set(previous.map(w => w.id));
  const nextIds = new Set(next.map(w => w.id));
  const removedIds = [...prevIds].filter(id => !nextIds.has(id));

  if (removedIds.length > 0) {
    const { error } = await supabase.from("workouts").delete().eq("user_id", userId).in("id", removedIds);
    if (error) throw error;
  }
  if (next.length > 0) {
    const { error } = await supabase.from("workouts").upsert(next.map(w => workoutToRow(w, userId)));
    if (error) throw error;
  }
}

export async function syncRestDays(next, previous) {
  const userId = await ensureAnonSession();

  const prevSet = new Set(previous);
  const nextSet = new Set(next);
  const added = next.filter(d => !prevSet.has(d));
  const removed = previous.filter(d => !nextSet.has(d));

  if (removed.length > 0) {
    const { error } = await supabase.from("rest_days").delete().eq("user_id", userId).in("date", removed);
    if (error) throw error;
  }
  if (added.length > 0) {
    const { error } = await supabase.from("rest_days").upsert(added.map(date => ({ user_id: userId, date })));
    if (error) throw error;
  }
}

export async function syncSettings({ theme, timeFormat, weightUnit }) {
  const userId = await ensureAnonSession();
  const { error } = await supabase.from("user_settings").upsert({
    user_id: userId,
    theme,
    time_format: timeFormat,
    weight_unit: weightUnit,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}
