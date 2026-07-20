import { useState, useEffect } from "react";
import { Plus, Trash2, ChevronLeft, ChevronRight, Dumbbell, History, Trophy, Check, Calendar as CalendarIcon, Search, Menu, X, Pencil, Library, Home, Sun, Moon, Activity, Timer as TimerIcon, RotateCcw, Play, Pause, Clock, Scale, TrendingUp, ListOrdered } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { calculateE1RM, getE1RMTrend, getE1RMPerSet, FORMULAS } from "./e1rm.js";
import { pullCloudState, syncWorkouts, syncRestDays, syncSettings } from "./cloudSync.js";

const STORAGE_KEY = "workouts";
const THEME_KEY = "theme";
const REST_DAYS_KEY = "restDays";
const TIME_FORMAT_KEY = "timeFormat";
const WEIGHT_UNIT_KEY = "weightUnit";
const LBS_PER_KG = 2.2046226218;

const SPLITS = [
  { name: "PPL", days: ["Push", "Pull", "Legs"] },
  { name: "Arnold Split", days: ["Push", "Pull", "Legs", "Arms", "Chest/Back"] },
  { name: "Upper/Lower", days: ["Upper Body", "Lower Body"] },
];

const EXERCISE_LIBRARY = [
  "Bench Press",
  "Incline Bench Press",
  "Barbell Squat",
  "Front Squat",
  "Deadlift",
  "Romanian Deadlift",
  "Shoulder Press",
  "Overhead Press",
  "Bent-Over Row",
  "Lat Pulldown",
  "Pull-Up",
  "Chin-Up",
  "Bicep Curl",
  "Hammer Curl",
  "Tricep Extension",
  "Tricep Pushdown",
  "Leg Press",
  "Leg Curl",
  "Leg Extension",
  "Calf Raise",
  "Lateral Raise",
  "Face Pull",
  "Dip",
  "Push-Up",
  "Plank",
  "Hip Thrust",
  "Lunge",
].sort((a, b) => a.localeCompare(b));

const CARDIO_TYPES = [
  "Treadmill",
  "Elliptical",
  "Stationary Bike",
  "Rowing Machine",
  "StairMaster",
  "Jump Rope",
  "Cycling",
  "Swimming",
  "Running (Outdoor)",
  "Walking",
];

// Standard plate denominations differ by unit (kg gyms don't just use
// converted lb numbers), so each unit gets its own real-world plate set.
const PLATES_BY_UNIT = {
  lbs: [2.5, 5, 10, 25, 45, 55, 100],
  kg: [1.25, 2.5, 5, 10, 15, 20, 25],
};
const DEFAULT_BAR_BY_UNIT = { lbs: 45, kg: 20 };
const BAR_STEP_BY_UNIT = { lbs: 5, kg: 2.5 };

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function fmtDate(d) {
  const date = new Date(d + "T00:00:00");
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function fmtTime(iso, use24h) {
  if (!iso) return null;
  return new Date(iso).toLocaleTimeString(undefined, use24h
    ? { hour: "2-digit", minute: "2-digit", hour12: false }
    : { hour: "numeric", minute: "2-digit" });
}

function fmtDateTime(w, use24h) {
  const time = fmtTime(w.time, use24h);
  return time ? `${fmtDate(w.date)} · ${time}` : fmtDate(w.date);
}

function fmtPlanTime(dateStr, timeStr, use24h) {
  if (!dateStr || !timeStr) return null;
  return new Date(`${dateStr}T${timeStr}`).toLocaleTimeString(undefined, use24h
    ? { hour: "2-digit", minute: "2-digit", hour12: false }
    : { hour: "numeric", minute: "2-digit" });
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function lbsToKg(lbs) {
  return lbs / LBS_PER_KG;
}

function kgToLbs(kg) {
  return kg * LBS_PER_KG;
}

// Converts a canonical (always-lbs) stored weight into the user's preferred
// unit for display, rounded to a sane precision.
function fmtWeight(lbsValue, unit) {
  return round1(unit === "kg" ? lbsToKg(lbsValue) : lbsValue);
}

// Treats "Bench Press", "bench press", and "benchpress" as the same exercise.
function normalizeKey(name) {
  return name.toLowerCase().replace(/\s+/g, "");
}

// Looks through past workouts + the current session for an exercise whose
// normalized name matches, and returns its exact casing/spacing so the same
// exercise always displays the same way instead of fragmenting into entries.
function findCanonicalName(rawName, workouts, activeExercises) {
  const key = normalizeKey(rawName);
  for (const ex of activeExercises) {
    if (normalizeKey(ex.name) === key) return ex.name;
  }
  for (const w of workouts) {
    for (const ex of w.exercises) {
      if (normalizeKey(ex.name) === key) return ex.name;
    }
  }
  return rawName.trim().replace(/\s+/g, " ");
}

// Pure, reusable per-workout stat calculation — derived on demand from the
// workout's own exercises/sets rather than stored separately, so it can
// never drift out of sync and is easy to reuse for future aggregate features.
function getWorkoutStats(workout) {
  const isCardio = workout.type === "cardio";

  if (isCardio) {
    let totalIntervals = 0;
    let totalTimeMin = 0;
    for (const ex of workout.exercises) {
      totalIntervals += ex.sets.length;
      for (const s of ex.sets) totalTimeMin += Number(s.time) || 0;
    }
    return { type: "cardio", totalIntervals, totalTimeMin };
  }

  let totalSets = 0;
  let totalReps = 0;
  let totalWeight = 0;
  for (const ex of workout.exercises) {
    totalSets += ex.sets.length;
    for (const s of ex.sets) {
      const reps = Number(s.reps) || 0;
      const weight = Number(s.weight) || 0;
      totalReps += reps;
      totalWeight += reps * weight;
    }
  }
  return { type: "strength", totalSets, totalReps, totalWeight };
}

export default function WorkoutTracker() {
  // home | split | splitDay | customTitle | active | history | detail | prs | calendar | day | search | exerciseHistory
  const [view, setView] = useState("home");
  const [workouts, setWorkouts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [cloudReady, setCloudReady] = useState(false); // true once the initial cloud pull/reconcile has finished
  const [activeExercises, setActiveExercises] = useState([]);
  const [exerciseInput, setExerciseInput] = useState("");
  const [detailId, setDetailId] = useState(null);
  const [detailOrigin, setDetailOrigin] = useState("history"); // where "detail" should go back to
  const [saveError, setSaveError] = useState(null);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const [dayDate, setDayDate] = useState(null); // selected date string for the calendar's day view

  const [selectedSplit, setSelectedSplit] = useState(null); // { name, days } from SPLITS
  const [workoutTitle, setWorkoutTitle] = useState(""); // day name or custom text, becomes the workout's title
  const [customTitleInput, setCustomTitleInput] = useState("");
  const [activeOrigin, setActiveOrigin] = useState("splitDay"); // where "active" should go back to
  const [workoutType, setWorkoutType] = useState("strength"); // "strength" | "cardio", for the in-progress "active" session
  const [restDays, setRestDays] = useState([]); // date strings marked as rest days
  const [selectedCalendarDay, setSelectedCalendarDay] = useState(null); // highlighted empty/rest day on the calendar
  const [planDate, setPlanDate] = useState(null); // date string being planned via the calendar, or null for the normal flow
  const [planTime, setPlanTime] = useState("09:00");
  const [planBoth, setPlanBoth] = useState(false); // true while chaining strength -> cardio for a "Both" plan
  const [restDuration, setRestDuration] = useState(120); // configured rest length in seconds, adjustable in 15s steps
  const [restRemaining, setRestRemaining] = useState(120);
  const [restRunning, setRestRunning] = useState(false);
  const [editingWorkoutId, setEditingWorkoutId] = useState(null); // set while editing an existing workout
  const [selectedExercise, setSelectedExercise] = useState(null); // exercise name chosen from search
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [confirmDeleteWorkoutOpen, setConfirmDeleteWorkoutOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [customExerciseOpen, setCustomExerciseOpen] = useState(false);
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem(THEME_KEY) || "dark";
    } catch (e) {
      return "dark";
    }
  });
  const [timeFormat, setTimeFormat] = useState(() => {
    try {
      return localStorage.getItem(TIME_FORMAT_KEY) || "12h";
    } catch (e) {
      return "12h";
    }
  });
  const [weightUnit, setWeightUnit] = useState(() => {
    try {
      return localStorage.getItem(WEIGHT_UNIT_KEY) || "lbs";
    } catch (e) {
      return "lbs";
    }
  });
  const use24h = timeFormat === "24h";

  useEffect(() => {
    let cancelled = false;

    async function init() {
      let localWorkouts = [];
      let localRestDays = [];
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) localWorkouts = JSON.parse(raw);
        const rawRest = localStorage.getItem(REST_DAYS_KEY);
        if (rawRest) localRestDays = JSON.parse(rawRest);
      } catch (e) {
        // no existing local data yet
      }

      // Render from localStorage immediately so the app stays instant;
      // cloud reconciliation happens after, in the background.
      if (!cancelled) {
        setWorkouts(localWorkouts);
        setRestDays(localRestDays);
        setLoading(false);
      }

      try {
        const cloud = await pullCloudState();
        if (cancelled) return;

        if (cloud.workouts.length > 0 || cloud.restDays.length > 0 || cloud.settings) {
          // This anonymous session already has cloud data (return visit, or
          // a browser whose localStorage was cleared) — cloud wins.
          setWorkouts(cloud.workouts);
          setRestDays(cloud.restDays);
          try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(cloud.workouts));
            localStorage.setItem(REST_DAYS_KEY, JSON.stringify(cloud.restDays));
          } catch (e) {
            // ignore
          }
          if (cloud.settings) {
            setTheme(cloud.settings.theme);
            setTimeFormat(cloud.settings.timeFormat);
            setWeightUnit(cloud.settings.weightUnit);
          }
        } else if (localWorkouts.length > 0 || localRestDays.length > 0) {
          // First cloud sync for this visitor, but they already have local
          // data (e.g. upgrading from a pre-Supabase version) — push it up.
          await syncWorkouts(localWorkouts, []);
          await syncRestDays(localRestDays, []);
        }
      } catch (e) {
        console.error("Cloud pull/reconcile failed:", e);
        setSaveError("Couldn't reach the cloud. Working from your local data only.");
      } finally {
        if (!cancelled) setCloudReady(true);
      }
    }

    init();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (e) {
      // ignore
    }
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.setItem(TIME_FORMAT_KEY, timeFormat);
    } catch (e) {
      // ignore
    }
  }, [timeFormat]);

  useEffect(() => {
    try {
      localStorage.setItem(WEIGHT_UNIT_KEY, weightUnit);
    } catch (e) {
      // ignore
    }
  }, [weightUnit]);

  useEffect(() => {
    if (!cloudReady) return; // avoid pushing defaults up before the initial cloud pull resolves
    syncSettings({ theme, timeFormat, weightUnit }).catch((e) => {
      console.error("Settings cloud sync failed:", e);
      setSaveError("Saved locally, but couldn't sync settings to the cloud.");
    });
  }, [theme, timeFormat, weightUnit, cloudReady]);

  useEffect(() => {
    if (!restRunning) return;
    if (restRemaining <= 0) {
      setRestRunning(false);
      return;
    }
    const id = setTimeout(() => setRestRemaining(r => r - 1), 1000);
    return () => clearTimeout(id);
  }, [restRunning, restRemaining]);

  function adjustRestDuration(delta) {
    setRestDuration(d => Math.max(15, d + delta));
    setRestRemaining(r => Math.max(0, r + delta));
  }

  function resetRestTimer() {
    setRestRemaining(restDuration);
    setRestRunning(false);
  }

  function toggleRestRunning() {
    setRestRunning(r => (restRemaining <= 0 ? false : !r));
  }

  function openTimer() {
    setView("timer");
  }

  function openPlates() {
    setView("plates");
  }

  function persist(next) {
    const previous = workouts;
    setWorkouts(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setSaveError(null);
    } catch (e) {
      setSaveError("Couldn't save. Your data may not persist.");
    }
    syncWorkouts(next, previous).catch((e) => {
      console.error("Workouts cloud sync failed:", e);
      setSaveError("Saved locally, but couldn't sync to the cloud.");
    });
  }

  function persistRestDays(next) {
    const previous = restDays;
    setRestDays(next);
    try {
      localStorage.setItem(REST_DAYS_KEY, JSON.stringify(next));
    } catch (e) {
      // ignore
    }
    syncRestDays(next, previous).catch((e) => {
      console.error("Rest days cloud sync failed:", e);
      setSaveError("Saved locally, but couldn't sync to the cloud.");
    });
  }

  function addRestDay(dateStr) {
    if (!restDays.includes(dateStr)) {
      persistRestDays([...restDays, dateStr]);
    }
    setSelectedCalendarDay(null);
  }

  function removeRestDay(dateStr) {
    persistRestDays(restDays.filter(d => d !== dateStr));
    setSelectedCalendarDay(null);
  }

  function resetWorkoutBuilder() {
    setSelectedSplit(null);
    setWorkoutTitle("");
    setCustomTitleInput("");
    setActiveExercises([]);
    setExerciseInput("");
    setEditingWorkoutId(null);
  }

  function startWorkout() {
    setPlanDate(null);
    setWorkoutType("strength");
    resetWorkoutBuilder();
    setView("split");
  }

  function startCardio() {
    setPlanDate(null);
    setWorkoutType("cardio");
    resetWorkoutBuilder();
    setView("cardioType");
  }

  function beginPlanWorkout(dateStr) {
    setPlanDate(dateStr);
    setPlanTime("09:00");
    setPlanBoth(false);
    setSelectedCalendarDay(null);
    setView("planTime");
  }

  function choosePlanType(type) {
    setPlanBoth(type === "both");
    if (type === "cardio") {
      setWorkoutType("cardio");
      resetWorkoutBuilder();
      setView("cardioType");
    } else {
      setWorkoutType("strength");
      resetWorkoutBuilder();
      setView("split");
    }
  }

  function startEditWorkout(workout) {
    const type = workout.type || "strength";
    setWorkoutType(type);
    setEditingWorkoutId(workout.id);
    setWorkoutTitle(workout.title || "");
    setActiveExercises(workout.exercises.map(ex => ({
      id: crypto.randomUUID(),
      name: ex.name,
      sets: ex.sets.map(s => type === "cardio"
        ? { id: crypto.randomUUID(), speed: String(s.speed), time: String(s.time) }
        : { id: crypto.randomUUID(), reps: String(s.reps), weight: String(fmtWeight(s.weight, weightUnit)) }),
    })));
    setExerciseInput("");
    setActiveOrigin("detail");
    setView("active");
  }

  function chooseSplit(split) {
    if (split === "custom") {
      setCustomTitleInput("");
      setView("customTitle");
    } else {
      setSelectedSplit(split);
      setView("splitDay");
    }
  }

  function chooseDay(day) {
    setWorkoutTitle(day);
    setActiveExercises([]);
    setExerciseInput("");
    setActiveOrigin("splitDay");
    setView("active");
  }

  function confirmCustomTitle() {
    setWorkoutTitle(customTitleInput.trim() || "Workout");
    setActiveExercises([]);
    setExerciseInput("");
    setActiveOrigin("customTitle");
    setView("active");
  }

  function startCardioSession(name, origin) {
    setWorkoutTitle(name);
    setActiveExercises([{ id: crypto.randomUUID(), name, sets: [] }]);
    setActiveOrigin(origin);
    setView("active");
  }

  function chooseCardioType(name) {
    if (name === "other") {
      setCustomTitleInput("");
      setView("cardioOther");
    } else {
      startCardioSession(name, "cardioType");
    }
  }

  function confirmCardioOther() {
    startCardioSession(customTitleInput.trim() || "Cardio", "cardioOther");
  }

  function addExerciseByName(rawName) {
    const raw = rawName.trim();
    if (!raw) return;
    const key = normalizeKey(raw);
    const existing = activeExercises.find(ex => normalizeKey(ex.name) === key);
    if (existing) {
      // Already added this exercise this session (maybe under different
      // casing/spacing) — don't create a second card, just keep the one.
      return;
    }
    const name = findCanonicalName(raw, workouts, activeExercises);
    setActiveExercises([...activeExercises, { id: crypto.randomUUID(), name, sets: [] }]);
  }

  function selectLibraryExercise(name) {
    addExerciseByName(name);
    setLibraryOpen(false);
  }

  function confirmCustomExercise() {
    addExerciseByName(exerciseInput);
    setExerciseInput("");
    setCustomExerciseOpen(false);
  }

  function addSet(exId) {
    const newSet = workoutType === "cardio"
      ? { id: crypto.randomUUID(), speed: "", time: "" }
      : { id: crypto.randomUUID(), reps: "", weight: "" };
    setActiveExercises(activeExercises.map(ex =>
      ex.id === exId
        ? { ...ex, sets: [...ex.sets, newSet] }
        : ex
    ));
  }

  function updateSet(exId, setId, field, value) {
    setActiveExercises(activeExercises.map(ex =>
      ex.id === exId
        ? { ...ex, sets: ex.sets.map(s => s.id === setId ? { ...s, [field]: value } : s) }
        : ex
    ));
  }

  function removeSet(exId, setId) {
    setActiveExercises(activeExercises.map(ex =>
      ex.id === exId
        ? { ...ex, sets: ex.sets.filter(s => s.id !== setId) }
        : ex
    ));
  }

  function removeExercise(exId) {
    setActiveExercises(activeExercises.filter(ex => ex.id !== exId));
  }

  function finishWorkout() {
    const isCardio = workoutType === "cardio";
    // Sets are always stored canonically in lbs, regardless of the user's
    // display preference, so weight data stays consistent for future
    // aggregate stats even if the preference changes later.
    const cleaned = activeExercises.map(ex => ({
      ...ex,
      sets: ex.sets.length > 0
        ? ex.sets.map(s => isCardio
            ? { ...s, speed: s.speed === "" ? 0 : Number(s.speed), time: s.time === "" ? 0 : Number(s.time) }
            : {
                ...s,
                reps: s.reps === "" ? 0 : Number(s.reps),
                weight: s.weight === "" ? 0 : round1(weightUnit === "kg" ? kgToLbs(Number(s.weight)) : Number(s.weight)),
              })
        : [isCardio
            ? { id: crypto.randomUUID(), speed: 0, time: 0 }
            : { id: crypto.randomUUID(), reps: 0, weight: 0 }],
    }));

    if (editingWorkoutId) {
      if (cleaned.length === 0) {
        setView("detail");
        return;
      }
      const next = workouts.map(w =>
        w.id === editingWorkoutId
          ? { ...w, title: workoutTitle || "Workout", exercises: cleaned }
          : w
      );
      persist(next);
      setEditingWorkoutId(null);
      setView("detail");
      return;
    }

    if (cleaned.length === 0) {
      setPlanDate(null);
      setPlanBoth(false);
      setSelectedCalendarDay(null);
      setView(planDate ? "calendar" : "home");
      return;
    }

    const workout = {
      id: crypto.randomUUID(),
      date: planDate || todayStr(),
      time: planDate ? new Date(`${planDate}T${planTime || "09:00"}:00`).toISOString() : new Date().toISOString(),
      title: workoutTitle || "Workout",
      type: workoutType,
      exercises: cleaned,
    };
    const next = [workout, ...workouts];
    persist(next);

    if (planDate && planBoth && workoutType === "strength") {
      // "Both" was chosen — the strength half just saved, now chain into cardio.
      setPlanBoth(false);
      setWorkoutType("cardio");
      resetWorkoutBuilder();
      setView("cardioType");
      return;
    }

    setPlanDate(null);
    setPlanBoth(false);
    setSelectedCalendarDay(null);
    setView(planDate ? "calendar" : "home");
  }

  function deleteWorkout(id) {
    const next = workouts.filter(w => w.id !== id);
    persist(next);
    if (detailId === id) setView(detailOrigin);
  }

  function deleteAllData() {
    persist([]);
    persistRestDays([]);
    setDetailId(null);
    setDayDate(null);
    setSelectedExercise(null);
    setSelectedCalendarDay(null);
    setConfirmDeleteOpen(false);
    setMenuOpen(false);
    setView("home");
  }

  function openDetail(id, origin) {
    setDetailId(id);
    setDetailOrigin(origin);
    setView("detail");
  }

  function openDay(date, workoutsOnDate) {
    if (workoutsOnDate.length === 1) {
      openDetail(workoutsOnDate[0].id, "calendar");
    } else {
      setDayDate(date);
      setView("day");
    }
  }

  function openExercise(name) {
    setSelectedExercise(name);
    setView("exerciseHistory");
  }

  function getPRs() {
    const prs = {};
    for (const w of workouts) {
      if (w.type === "cardio") continue;
      for (const ex of w.exercises) {
        const key = normalizeKey(ex.name);
        for (const s of ex.sets) {
          if (!prs[key] || s.weight > prs[key].weight) {
            // workouts is newest-first, so the first name we see for a key
            // is the most recent casing/spacing the person used for it.
            const displayName = prs[key]?.name ?? ex.name;
            prs[key] = { name: displayName, weight: s.weight, reps: s.reps, date: w.date };
          }
        }
      }
    }
    return Object.values(prs).sort((a, b) => b.weight - a.weight);
  }

  if (loading) {
    return (
      <div className={`min-h-screen flex items-center justify-center bg-white dark:bg-neutral-950 ${theme === "dark" ? "dark" : ""}`}>
        <p className="text-neutral-600 dark:text-neutral-500 text-sm">Loading...</p>
      </div>
    );
  }

  const detail = detailId ? workouts.find(w => w.id === detailId) : null;
  const dayWorkouts = dayDate ? workouts.filter(w => w.date === dayDate) : [];
  const exerciseEntries = selectedExercise
    ? workouts.flatMap(w =>
        w.exercises
          .filter(ex => normalizeKey(ex.name) === normalizeKey(selectedExercise))
          .map(ex => ({ workoutId: w.id, date: w.date, time: w.time, title: w.title, type: w.type || "strength", sets: ex.sets }))
      )
    : [];

  const backTargets = {
    split: planDate ? "planType" : "home",
    splitDay: "split",
    customTitle: "split",
    active: activeOrigin,
    history: "home",
    calendar: "home",
    prs: "home",
    day: "calendar",
    detail: detailOrigin,
    search: "home",
    exerciseHistory: "search",
    settings: "home",
    cardioType: planDate ? "planType" : "home",
    cardioOther: "cardioType",
    planTime: "calendar",
    planType: "planTime",
    timer: "home",
    plates: "home",
    exerciseStats: "exerciseHistory",
  };

  const headerContent = {
    split: { title: "Choose a split" },
    splitDay: { title: selectedSplit?.name || "Choose a day" },
    customTitle: { title: "Custom workout" },
    active: { title: editingWorkoutId ? `Edit ${workoutTitle || "workout"}` : (workoutTitle || (workoutType === "cardio" ? "New cardio" : "New workout")) },
    history: { title: "History" },
    calendar: { title: "Calendar" },
    prs: { title: "Personal records" },
    day: { title: dayDate ? fmtDate(dayDate) : "Workouts" },
    detail: { title: detail?.title || "Workout", subtitle: detail ? fmtDateTime(detail, use24h) : null },
    search: { title: "Search exercises" },
    exerciseHistory: {
      title: selectedExercise || "Exercise",
      subtitle: `${exerciseEntries.length} session${exerciseEntries.length !== 1 ? "s" : ""} logged`,
    },
    settings: { title: "Settings" },
    cardioType: { title: "Choose cardio type" },
    cardioOther: { title: "Custom cardio" },
    planTime: { title: "What time?", subtitle: planDate ? fmtDate(planDate) : null },
    planType: {
      title: "Workout type",
      subtitle: planDate ? `${fmtDate(planDate)}${planTime ? " · " + fmtPlanTime(planDate, planTime, use24h) : ""}` : null,
    },
    timer: { title: "Rest Timer" },
    plates: { title: "Plate Calculator" },
    exerciseStats: { title: selectedExercise || "Exercise", subtitle: "Statistics" },
  }[view];

  return (
    <div className={`min-h-screen bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100 font-sans ${theme === "dark" ? "dark" : ""}`}>
      <div className="max-w-md mx-auto px-4 py-6">
        <div className="grid grid-cols-3 items-center mb-3">
          <div className="justify-self-start">
            <button
              onClick={() => setMenuOpen(true)}
              className="p-1.5 -ml-1.5 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-500 dark:text-neutral-400"
              aria-label="Open menu"
            >
              <Menu size={20} />
            </button>
          </div>

          <div className="justify-self-center">
            {view !== "home" && view !== "settings" && <Logo size="sm" />}
          </div>

          <div className="justify-self-end">
            {view === "home" ? (
              <button
                onClick={() => setView("history")}
                className="p-1.5 -mr-1.5 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-500 dark:text-neutral-400"
                aria-label="History"
              >
                <History size={20} />
              </button>
            ) : (
              <button
                onClick={() => setView("home")}
                className="p-1.5 -mr-1.5 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-500 dark:text-neutral-400"
                aria-label="Go to home"
              >
                <Home size={20} />
              </button>
            )}
          </div>
        </div>

        {view === "home" ? (
          <BrandHeader sessionCount={workouts.length} />
        ) : (
          <Header
            title={headerContent.title}
            subtitle={headerContent.subtitle}
            onBack={() => setView(backTargets[view])}
          />
        )}

        {saveError && (
          <div className="mb-4 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded px-3 py-2">
            {saveError}
          </div>
        )}

        {view === "home" && (
          <HomeView
            workouts={workouts}
            startWorkout={startWorkout}
            startCardio={startCardio}
            setView={setView}
            onOpenTimer={openTimer}
            onOpenPlates={openPlates}
            onSelectWorkout={(id) => openDetail(id, "home")}
            use24h={use24h}
          />
        )}

        {view === "split" && (
          <SplitListView onChoose={chooseSplit} />
        )}

        {view === "splitDay" && selectedSplit && (
          <SplitDayView split={selectedSplit} onChoose={chooseDay} />
        )}

        {view === "customTitle" && (
          <CustomTitleView
            value={customTitleInput}
            onChange={setCustomTitleInput}
            onConfirm={confirmCustomTitle}
            placeholder="Workout title, e.g. Upper body"
          />
        )}

        {view === "cardioType" && (
          <CardioTypeListView onChoose={chooseCardioType} />
        )}

        {view === "cardioOther" && (
          <CustomTitleView
            value={customTitleInput}
            onChange={setCustomTitleInput}
            onConfirm={confirmCardioOther}
            placeholder="Cardio type, e.g. Trail run"
          />
        )}

        {view === "planTime" && (
          <PlanTimeView date={planDate} time={planTime} onChange={setPlanTime} onConfirm={() => setView("planType")} />
        )}

        {view === "planType" && (
          <PlanTypeView onChoose={choosePlanType} />
        )}

        {view === "active" && workoutType === "cardio" && activeExercises[0] && (
          <ActiveCardio
            exercise={activeExercises[0]}
            addSet={addSet}
            updateSet={updateSet}
            removeSet={removeSet}
            finishWorkout={finishWorkout}
            isEditing={!!editingWorkoutId}
            workoutTitle={workoutTitle}
            setWorkoutTitle={setWorkoutTitle}
          />
        )}

        {view === "active" && workoutType !== "cardio" && (
          <ActiveWorkout
            exercises={activeExercises}
            onOpenLibrary={() => setLibraryOpen(true)}
            onOpenCustom={() => { setExerciseInput(""); setCustomExerciseOpen(true); }}
            addSet={addSet}
            updateSet={updateSet}
            removeSet={removeSet}
            removeExercise={removeExercise}
            finishWorkout={finishWorkout}
            isEditing={!!editingWorkoutId}
            weightUnit={weightUnit}
            workoutTitle={workoutTitle}
            setWorkoutTitle={setWorkoutTitle}
          />
        )}

        {view === "history" && (
          <HistoryView
            workouts={workouts}
            onSelect={(id) => openDetail(id, "history")}
            use24h={use24h}
          />
        )}

        {view === "calendar" && (
          <CalendarView
            workouts={workouts}
            restDays={restDays}
            calendarMonth={calendarMonth}
            setCalendarMonth={setCalendarMonth}
            onSelectDay={openDay}
            selectedDay={selectedCalendarDay}
            onSelectEmptyDay={setSelectedCalendarDay}
            onAddRestDay={addRestDay}
            onRemoveRestDay={removeRestDay}
            onAddWorkoutPlan={beginPlanWorkout}
          />
        )}

        {view === "day" && (
          <HistoryView
            workouts={dayWorkouts}
            onSelect={(id) => openDetail(id, "day")}
            use24h={use24h}
          />
        )}

        {view === "detail" && detail && (
          <DetailView
            workout={detail}
            onEdit={() => startEditWorkout(detail)}
            onDelete={() => setConfirmDeleteWorkoutOpen(true)}
            weightUnit={weightUnit}
          />
        )}

        {view === "prs" && <PRsView prs={getPRs()} weightUnit={weightUnit} />}

        {view === "search" && (
          <SearchView workouts={workouts} onSelectExercise={openExercise} />
        )}

        {view === "exerciseHistory" && (
          <ExerciseHistoryView
            entries={exerciseEntries}
            onSelectEntry={(id) => openDetail(id, "exerciseHistory")}
            onOpenStats={() => setView("exerciseStats")}
            use24h={use24h}
            weightUnit={weightUnit}
          />
        )}

        {view === "exerciseStats" && (
          <StatisticsView entries={exerciseEntries} weightUnit={weightUnit} theme={theme} use24h={use24h} />
        )}

        {view === "settings" && (
          <SettingsView
            theme={theme}
            setTheme={setTheme}
            timeFormat={timeFormat}
            setTimeFormat={setTimeFormat}
            weightUnit={weightUnit}
            setWeightUnit={setWeightUnit}
          />
        )}

        {view === "timer" && (
          <TimerView
            duration={restDuration}
            remaining={restRemaining}
            running={restRunning}
            onToggleRun={toggleRestRunning}
            onAdjust={adjustRestDuration}
            onReset={resetRestTimer}
          />
        )}

        {view === "plates" && (
          <PlateCalculatorView weightUnit={weightUnit} />
        )}
      </div>

      {menuOpen && (
        <SideMenu
          onClose={() => setMenuOpen(false)}
          onDeleteAll={() => setConfirmDeleteOpen(true)}
          onOpenSettings={() => setView("settings")}
        />
      )}

      {confirmDeleteOpen && (
        <ConfirmDeleteModal
          message="This option will delete all your workout entries permanently. Are you sure you want to do this?"
          onCancel={() => setConfirmDeleteOpen(false)}
          onConfirm={deleteAllData}
        />
      )}

      {confirmDeleteWorkoutOpen && detail && (
        <ConfirmDeleteModal
          message={`This will delete "${detail.title || "this workout"}" from ${fmtDateTime(detail, use24h)} permanently. Are you sure you want to do this?`}
          onCancel={() => setConfirmDeleteWorkoutOpen(false)}
          onConfirm={() => {
            deleteWorkout(detail.id);
            setConfirmDeleteWorkoutOpen(false);
          }}
        />
      )}

      {libraryOpen && (
        <ExercisePickerModal
          onSelect={selectLibraryExercise}
          onClose={() => setLibraryOpen(false)}
        />
      )}

      {customExerciseOpen && (
        <AddCustomExerciseModal
          value={exerciseInput}
          onChange={setExerciseInput}
          onConfirm={confirmCustomExercise}
          onClose={() => setCustomExerciseOpen(false)}
        />
      )}
    </div>
  );
}

function SideMenu({ onClose, onDeleteAll, onOpenSettings }) {
  return (
    <>
      <div
        className="fixed inset-0 bg-black/60 z-40 backdrop-fade-in"
        onClick={onClose}
      />
      <div className="fixed top-0 left-0 h-full w-72 max-w-[80%] bg-neutral-50 dark:bg-neutral-900 border-r border-neutral-200 dark:border-neutral-800 z-50 drawer-bounce-in flex flex-col">
        <div className="flex items-center justify-between px-4 py-4 border-b border-neutral-200 dark:border-neutral-800">
          <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">Menu</span>
          <button
            onClick={onClose}
            className="p-1.5 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-500 dark:text-neutral-400"
            aria-label="Close menu"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 py-2">
          <button
            onClick={onClose}
            className="w-full text-left px-4 py-3 text-sm text-neutral-800 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition"
          >
            Account
          </button>
          <button
            onClick={() => { onClose(); onOpenSettings(); }}
            className="w-full text-left px-4 py-3 text-sm text-neutral-800 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition"
          >
            Settings
          </button>
        </div>

        <div className="p-4 border-t border-neutral-200 dark:border-neutral-800">
          <button
            onClick={onDeleteAll}
            className="w-full flex items-center justify-center gap-2 bg-red-600 text-white font-medium rounded-lg py-3 active:scale-[0.98] transition"
          >
            <Trash2 size={16} /> Delete All Data
          </button>
        </div>
      </div>
    </>
  );
}

function ConfirmDeleteModal({ message, onCancel, onConfirm }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center px-6 bg-black/70 backdrop-fade-in">
      <div className="w-full max-w-xs bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-xl p-5 text-center">
        <p className="text-xl font-bold text-neutral-900 dark:text-white">Are you sure???</p>
        <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-2">{message}</p>
        <div className="flex gap-2 mt-5">
          <button
            onClick={onCancel}
            className="flex-1 bg-neutral-100 dark:bg-neutral-800 text-neutral-800 dark:text-neutral-200 font-medium rounded-lg py-2.5 active:scale-[0.98] transition"
          >
            No
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 bg-red-600 text-white font-medium rounded-lg py-2.5 active:scale-[0.98] transition"
          >
            Yes
          </button>
        </div>
      </div>
    </div>
  );
}

function ExercisePickerModal({ onSelect, onClose }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const results = q
    ? EXERCISE_LIBRARY.filter(name => name.toLowerCase().startsWith(q))
    : EXERCISE_LIBRARY;

  return (
    <div className="fixed inset-0 z-[60] bg-black/70 backdrop-fade-in flex items-end justify-center">
      <div className="w-full max-w-md max-h-[80vh] bg-neutral-50 dark:bg-neutral-900 border-t border-neutral-200 dark:border-neutral-800 rounded-t-xl flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 shrink-0">
          <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">Exercise Library</span>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-500 dark:text-neutral-400" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="p-3 border-b border-neutral-200 dark:border-neutral-800 shrink-0">
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search exercises, e.g. Bench"
            autoFocus
            className="w-full bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-lg px-3 py-2.5 text-sm placeholder-neutral-400 dark:placeholder-neutral-600 focus:outline-none focus:border-blue-600"
          />
        </div>

        <div className="flex-1 overflow-y-auto py-1">
          {results.length === 0 && (
            <p className="text-sm text-neutral-600 dark:text-neutral-500 text-center py-8 px-4">
              No matches. Close this and use "Add Custom" instead.
            </p>
          )}
          {results.map(name => (
            <button
              key={name}
              onClick={() => onSelect(name)}
              className="w-full text-left px-4 py-3 text-sm text-neutral-800 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition"
            >
              {name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function AddCustomExerciseModal({ value, onChange, onConfirm, onClose }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center px-6 bg-black/70 backdrop-fade-in">
      <div className="w-full max-w-xs bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-xl p-5">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">Add custom exercise</span>
          <button onClick={onClose} className="p-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-500 dark:text-neutral-400" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <input
          value={value}
          onChange={e => onChange(e.target.value)}
          onKeyDown={e => e.key === "Enter" && onConfirm()}
          placeholder="Exercise name"
          autoFocus
          className="w-full bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-lg px-3 py-2.5 text-sm placeholder-neutral-400 dark:placeholder-neutral-600 focus:outline-none focus:border-blue-600"
        />
        <button
          onClick={onConfirm}
          className="w-full mt-3 flex items-center justify-center gap-2 bg-blue-600 text-white font-medium rounded-lg py-2.5 active:scale-[0.98] transition"
        >
          <Plus size={16} /> Add
        </button>
      </div>
    </div>
  );
}

function SettingsView({ theme, setTheme, timeFormat, setTimeFormat, weightUnit, setWeightUnit }) {
  const isDark = theme === "dark";
  const is24h = timeFormat === "24h";
  const isKg = weightUnit === "kg";
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg px-4 py-3.5">
        <div className="flex items-center gap-3">
          {isDark ? <Moon size={18} className="text-blue-600 dark:text-blue-500" /> : <Sun size={18} className="text-amber-500" />}
          <div>
            <p className="text-sm font-medium">Appearance</p>
            <p className="text-xs text-neutral-600 dark:text-neutral-500 mt-0.5">{isDark ? "Dark mode" : "Light mode"}</p>
          </div>
        </div>
        <button
          onClick={() => setTheme(isDark ? "light" : "dark")}
          role="switch"
          aria-checked={isDark}
          aria-label="Toggle dark mode"
          className={`relative w-12 h-7 shrink-0 rounded-full transition-colors ${isDark ? "bg-blue-600" : "bg-neutral-300"}`}
        >
          <span
            className={`absolute top-1 left-1 w-5 h-5 rounded-full bg-white shadow transition-transform ${isDark ? "translate-x-5" : "translate-x-0"}`}
          />
        </button>
      </div>

      <div className="flex items-center justify-between bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg px-4 py-3.5">
        <div className="flex items-center gap-3">
          <Clock size={18} className="text-blue-600 dark:text-blue-500" />
          <div>
            <p className="text-sm font-medium">Time Format</p>
            <p className="text-xs text-neutral-600 dark:text-neutral-500 mt-0.5">{is24h ? "24-hour" : "12-hour (AM/PM)"}</p>
          </div>
        </div>
        <button
          onClick={() => setTimeFormat(is24h ? "12h" : "24h")}
          role="switch"
          aria-checked={is24h}
          aria-label="Toggle 24-hour time format"
          className={`relative w-12 h-7 shrink-0 rounded-full transition-colors ${is24h ? "bg-blue-600" : "bg-neutral-300"}`}
        >
          <span
            className={`absolute top-1 left-1 w-5 h-5 rounded-full bg-white shadow transition-transform ${is24h ? "translate-x-5" : "translate-x-0"}`}
          />
        </button>
      </div>

      <div className="flex items-center justify-between bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg px-4 py-3.5">
        <div className="flex items-center gap-3">
          <Scale size={18} className="text-blue-600 dark:text-blue-500" />
          <div>
            <p className="text-sm font-medium">Weight Unit</p>
            <p className="text-xs text-neutral-600 dark:text-neutral-500 mt-0.5">{isKg ? "Kilograms (kg)" : "Pounds (lbs)"}</p>
          </div>
        </div>
        <button
          onClick={() => setWeightUnit(isKg ? "lbs" : "kg")}
          role="switch"
          aria-checked={isKg}
          aria-label="Toggle kilograms"
          className={`relative w-12 h-7 shrink-0 rounded-full transition-colors ${isKg ? "bg-blue-600" : "bg-neutral-300"}`}
        >
          <span
            className={`absolute top-1 left-1 w-5 h-5 rounded-full bg-white shadow transition-transform ${isKg ? "translate-x-5" : "translate-x-0"}`}
          />
        </button>
      </div>
    </div>
  );
}

function fmtClock(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function TimerView({ duration, remaining, running, onToggleRun, onAdjust, onReset }) {
  const isDone = remaining <= 0;
  const isFresh = remaining === duration;
  return (
    <div className="flex flex-col items-center gap-6 pt-8 pb-4">
      <div
        className={`text-6xl font-bold tabular-nums ${isDone ? "text-blue-600 dark:text-blue-500" : "text-neutral-900 dark:text-neutral-100"}`}
      >
        {fmtClock(remaining)}
      </div>

      {isDone ? (
        <div className="w-full text-center space-y-3">
          <p className="text-sm font-medium text-blue-600 dark:text-blue-500">Rest's over — begin your workout!</p>
          <button
            onClick={onReset}
            className="w-full flex items-center justify-center gap-2 bg-blue-600 text-white font-medium rounded-lg py-3.5 active:scale-[0.98] transition"
          >
            <RotateCcw size={18} /> Reset Timer
          </button>
        </div>
      ) : (
        <div className="w-full flex items-center gap-3">
          <button
            onClick={onToggleRun}
            className="flex-1 flex items-center justify-center gap-2 bg-blue-600 text-white font-medium rounded-lg py-3.5 active:scale-[0.98] transition"
          >
            {running ? <Pause size={18} /> : <Play size={18} />}
            {running ? "Pause" : isFresh ? "Start" : "Resume"}
          </button>
          <button
            onClick={onReset}
            className="p-3.5 bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg text-neutral-600 dark:text-neutral-500 active:scale-[0.98] transition"
            aria-label="Reset timer"
          >
            <RotateCcw size={18} />
          </button>
        </div>
      )}

      <div className="flex items-center gap-3 mt-2">
        <button
          onClick={() => onAdjust(-15)}
          className="px-4 py-2.5 bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg text-sm font-medium active:scale-[0.98] transition"
        >
          -15s
        </button>
        <span className="text-xs text-neutral-600 dark:text-neutral-500 w-20 text-center">
          Rest: {fmtClock(duration)}
        </span>
        <button
          onClick={() => onAdjust(15)}
          className="px-4 py-2.5 bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg text-sm font-medium active:scale-[0.98] transition"
        >
          +15s
        </button>
      </div>
    </div>
  );
}

function PlateCalculatorView({ weightUnit }) {
  const unit = weightUnit === "kg" ? "kg" : "lbs";
  const plateOptions = PLATES_BY_UNIT[unit];
  const barStep = BAR_STEP_BY_UNIT[unit];

  const [barWeight, setBarWeight] = useState(DEFAULT_BAR_BY_UNIT[unit]);
  const [plateCounts, setPlateCounts] = useState({}); // { [plateWeight]: pairsAdded }

  const platesWeight = Object.entries(plateCounts).reduce(
    (sum, [w, count]) => sum + Number(w) * count * 2,
    0
  );
  const total = round1(barWeight + platesWeight);

  function adjustBar(delta) {
    setBarWeight(w => Math.max(0, round1(w + delta)));
  }

  function addPlate(w) {
    setPlateCounts(prev => ({ ...prev, [w]: (prev[w] || 0) + 1 }));
  }

  function removePlate(w) {
    setPlateCounts(prev => {
      if (!prev[w]) return prev;
      const next = { ...prev, [w]: prev[w] - 1 };
      if (next[w] <= 0) delete next[w];
      return next;
    });
  }

  function clearPlates() {
    setPlateCounts({});
  }

  // Heaviest plates sit closest to the bar, matching how you'd actually load it.
  const stackHeaviestFirst = Object.entries(plateCounts)
    .map(([w, count]) => [Number(w), count])
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[0] - a[0])
    .flatMap(([w, count]) => Array(count).fill(w));

  const maxPlate = plateOptions[plateOptions.length - 1];
  const sideBreakdown = [...stackHeaviestFirst]
    .sort((a, b) => b - a)
    .join(" + ");

  return (
    <div className="flex flex-col items-center gap-5 pb-4">
      <div className="text-6xl font-bold tabular-nums text-neutral-900 dark:text-neutral-100">
        {total.toLocaleString()}
        <span className="text-xl font-medium text-neutral-500 dark:text-neutral-400 ml-1">{unit}</span>
      </div>

      <BarbellDiagram stackHeaviestFirst={stackHeaviestFirst} maxPlate={maxPlate} onRemove={removePlate} unit={unit} />

      <p className="text-xs text-neutral-600 dark:text-neutral-500 text-center min-h-[16px]">
        {stackHeaviestFirst.length > 0
          ? `Each side: ${sideBreakdown} ${unit}`
          : "Tap a plate below to load the bar"}
      </p>

      <div className="w-full flex items-center justify-between bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg px-4 py-3">
        <span className="text-sm font-medium">Bar weight</span>
        <div className="flex items-center gap-3">
          <button
            onClick={() => adjustBar(-barStep)}
            className="w-8 h-8 flex items-center justify-center bg-neutral-100 dark:bg-neutral-800 rounded-lg text-lg font-medium active:scale-[0.98] transition"
            aria-label="Decrease bar weight"
          >
            −
          </button>
          <span className="text-sm font-semibold tabular-nums w-14 text-center">{barWeight} {unit}</span>
          <button
            onClick={() => adjustBar(barStep)}
            className="w-8 h-8 flex items-center justify-center bg-neutral-100 dark:bg-neutral-800 rounded-lg text-lg font-medium active:scale-[0.98] transition"
            aria-label="Increase bar weight"
          >
            +
          </button>
        </div>
      </div>

      <div className="w-full">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium">Add plates (per side)</span>
          {stackHeaviestFirst.length > 0 && (
            <button
              onClick={clearPlates}
              className="text-xs text-red-600 dark:text-red-400 flex items-center gap-1"
            >
              <Trash2 size={12} /> Clear all
            </button>
          )}
        </div>
        <div className="grid grid-cols-4 gap-2">
          {plateOptions.map(w => (
            <button
              key={w}
              onClick={() => addPlate(w)}
              className="relative flex flex-col items-center justify-center gap-0.5 bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg py-2.5 active:scale-[0.98] transition"
            >
              {plateCounts[w] > 0 && (
                <span className="absolute -top-1.5 -right-1.5 bg-blue-600 text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
                  {plateCounts[w]}
                </span>
              )}
              <span className="text-sm font-semibold">+{w}</span>
              <span className="text-[10px] text-neutral-600 dark:text-neutral-500">{unit}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function BarbellDiagram({ stackHeaviestFirst, maxPlate, onRemove, unit }) {
  const leftStack = [...stackHeaviestFirst].reverse();
  const rightStack = stackHeaviestFirst;

  function plateSize(w) {
    const minH = 28, maxH = 88;
    const ratio = Math.min(1, w / maxPlate);
    const height = Math.round(minH + (maxH - minH) * ratio);
    const width = Math.round(10 + 10 * ratio);
    return { height, width };
  }

  function Plate({ w, edge }) {
    const { height, width } = plateSize(w);
    return (
      <button
        onClick={() => onRemove(w)}
        aria-label={`Remove ${w} ${unit} plate`}
        className={`shrink-0 flex items-center justify-center bg-blue-600 dark:bg-blue-500 active:scale-95 transition ${edge === "left" ? "rounded-l-sm" : "rounded-r-sm"}`}
        style={{ height, width }}
      >
        <span className="text-white text-[8px] font-semibold [writing-mode:vertical-rl]">{w}</span>
      </button>
    );
  }

  return (
    <div className="w-full flex items-center justify-center h-24">
      <div className="flex-1 flex items-center justify-end">
        {leftStack.map((w, i) => (
          <Plate key={`l-${i}`} w={w} edge="left" />
        ))}
        <div className="w-4 h-2.5 bg-neutral-400 dark:bg-neutral-600 shrink-0" />
      </div>
      <div className="w-16 h-1.5 bg-neutral-400 dark:bg-neutral-600 shrink-0" />
      <div className="flex-1 flex items-center justify-start">
        <div className="w-4 h-2.5 bg-neutral-400 dark:bg-neutral-600 shrink-0" />
        {rightStack.map((w, i) => (
          <Plate key={`r-${i}`} w={w} edge="right" />
        ))}
      </div>
    </div>
  );
}

function Logo({ size = "lg" }) {
  const isLg = size === "lg";
  return (
    <div className="inline-flex flex-col items-center leading-none">
      <span className={`${isLg ? "text-2xl" : "text-sm"} font-bold tracking-[0.25em] text-blue-600 dark:text-blue-500`}>
        PEEK
      </span>
      <span className={`${isLg ? "h-0.5 mt-1.5" : "h-0.5 mt-1"} w-full bg-blue-600 dark:bg-blue-500 rounded-full`} />
    </div>
  );
}

function BrandHeader({ sessionCount }) {
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return (
    <div className="mb-6">
      <div className="flex items-center gap-2">
        <Logo size="lg" />
        <span className="text-sm text-neutral-600 dark:text-neutral-500">Workout Tracker</span>
      </div>
      <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-2">
        {greeting} — you've logged {sessionCount} session{sessionCount !== 1 ? "s" : ""}.
      </p>
    </div>
  );
}

function Header({ title, subtitle, onBack }) {
  return (
    <div className="mb-6">
      <div className="flex items-center gap-2">
        <button
          onClick={onBack}
          className="p-1.5 -ml-1.5 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-500 dark:text-neutral-400"
          aria-label="Back"
        >
          <ChevronLeft size={20} />
        </button>
        <h1 className="text-lg font-medium">{title}</h1>
      </div>
      {subtitle && <p className="text-xs text-neutral-600 dark:text-neutral-500 ml-8 mt-0.5">{subtitle}</p>}
    </div>
  );
}

function HomeView({ workouts, startWorkout, startCardio, setView, onOpenTimer, onOpenPlates, onSelectWorkout, use24h }) {
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <button
          onClick={startWorkout}
          className="w-full flex items-center justify-center gap-2 bg-blue-600 text-white font-medium rounded-lg py-3.5 active:scale-[0.98] transition"
        >
          <Plus size={18} /> Start workout
        </button>
        <button
          onClick={startCardio}
          className="w-full flex items-center justify-center gap-2 bg-neutral-50 dark:bg-neutral-900 border border-blue-600 text-blue-600 dark:text-blue-500 font-medium rounded-lg py-3.5 active:scale-[0.98] transition"
        >
          <Activity size={18} /> Start cardio
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 pt-2">
        <button
          onClick={onOpenTimer}
          className="flex flex-col items-center gap-1.5 bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg py-3.5 px-1 active:scale-[0.98] transition"
        >
          <TimerIcon size={18} className="text-blue-600 dark:text-blue-500" />
          <span className="text-xs">Timer</span>
          <span className="text-[11px] text-neutral-600 dark:text-neutral-500">rest period</span>
        </button>
        <button
          onClick={() => setView("calendar")}
          className="flex flex-col items-center gap-1.5 bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg py-3.5 px-1 active:scale-[0.98] transition"
        >
          <CalendarIcon size={18} className="text-blue-600 dark:text-blue-500" />
          <span className="text-xs">Calendar</span>
          <span className="text-[11px] text-neutral-600 dark:text-neutral-500">by date</span>
        </button>
        <button
          onClick={() => setView("prs")}
          className="flex flex-col items-center gap-1.5 bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg py-3.5 px-1 active:scale-[0.98] transition"
        >
          <Trophy size={18} className="text-blue-600 dark:text-blue-500" />
          <span className="text-xs">Records</span>
          <span className="text-[11px] text-neutral-600 dark:text-neutral-500">best lifts</span>
        </button>
        <button
          onClick={() => setView("search")}
          className="flex flex-col items-center gap-1.5 bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg py-3.5 px-1 active:scale-[0.98] transition"
        >
          <Search size={18} className="text-blue-600 dark:text-blue-500" />
          <span className="text-xs">Search</span>
          <span className="text-[11px] text-neutral-600 dark:text-neutral-500">by exercise</span>
        </button>
      </div>

      {/* Odd widget out: keeps the same two-wide tile size, centered on its
          own row. Add future single widgets the same way; pair them up into
          the grid above once there are two. */}
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={onOpenPlates}
          className="col-span-2 w-1/2 mx-auto flex flex-col items-center gap-1.5 bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg py-3.5 px-1 active:scale-[0.98] transition"
        >
          <Dumbbell size={18} className="text-blue-600 dark:text-blue-500" />
          <span className="text-xs">Plate Calculator</span>
          <span className="text-[11px] text-neutral-600 dark:text-neutral-500">load your bar</span>
        </button>
      </div>

      {workouts.length === 0 && (
        <div className="text-center pt-10 pb-4">
          <Dumbbell size={28} className="mx-auto text-neutral-300 dark:text-neutral-700 mb-3" />
          <p className="text-sm text-neutral-600 dark:text-neutral-500">No workouts yet. Log your first one above.</p>
        </div>
      )}

      {workouts.length > 0 && (
        <div className="pt-4">
          <p className="text-xs uppercase tracking-wide text-neutral-600 dark:text-neutral-500 mb-2">Recent</p>
          <div className="space-y-2">
            {workouts.slice(0, 3).map(w => (
              <button
                key={w.id}
                onClick={() => onSelectWorkout(w.id)}
                className="w-full text-left bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg px-4 py-3 active:scale-[0.98] transition"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-sm font-medium">{w.title || "Workout"}</p>
                  <p className="text-xs text-neutral-600 dark:text-neutral-500 shrink-0">{fmtDateTime(w, use24h)}</p>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SplitListView({ onChoose }) {
  return (
    <div className="space-y-2">
      {SPLITS.map(split => (
        <button
          key={split.name}
          onClick={() => onChoose(split)}
          className="w-full flex items-center justify-between bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg px-4 py-3.5 active:scale-[0.98] transition"
        >
          <span className="text-sm font-medium">{split.name}</span>
          <ChevronRight size={16} className="text-neutral-400 dark:text-neutral-600" />
        </button>
      ))}
      <button
        onClick={() => onChoose("custom")}
        className="w-full flex items-center justify-between bg-neutral-50 dark:bg-neutral-900 border border-dashed border-neutral-300 dark:border-neutral-700 rounded-lg px-4 py-3.5 active:scale-[0.98] transition"
      >
        <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">Custom</span>
        <ChevronRight size={16} className="text-neutral-400 dark:text-neutral-600" />
      </button>
    </div>
  );
}

function SplitDayView({ split, onChoose }) {
  return (
    <div className="space-y-2">
      {split.days.map(day => (
        <button
          key={day}
          onClick={() => onChoose(day)}
          className="w-full flex items-center justify-between bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg px-4 py-3.5 active:scale-[0.98] transition"
        >
          <span className="text-sm font-medium">{day}</span>
          <ChevronRight size={16} className="text-neutral-400 dark:text-neutral-600" />
        </button>
      ))}
    </div>
  );
}

function CardioTypeListView({ onChoose }) {
  return (
    <div className="space-y-2">
      {CARDIO_TYPES.map(name => (
        <button
          key={name}
          onClick={() => onChoose(name)}
          className="w-full flex items-center justify-between bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg px-4 py-3.5 active:scale-[0.98] transition"
        >
          <span className="text-sm font-medium">{name}</span>
          <ChevronRight size={16} className="text-neutral-400 dark:text-neutral-600" />
        </button>
      ))}
      <button
        onClick={() => onChoose("other")}
        className="w-full flex items-center justify-between bg-neutral-50 dark:bg-neutral-900 border border-dashed border-neutral-300 dark:border-neutral-700 rounded-lg px-4 py-3.5 active:scale-[0.98] transition"
      >
        <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">Other</span>
        <ChevronRight size={16} className="text-neutral-400 dark:text-neutral-600" />
      </button>
    </div>
  );
}

function CustomTitleView({ value, onChange, onConfirm, placeholder }) {
  return (
    <div className="space-y-3">
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => e.key === "Enter" && onConfirm()}
        placeholder={placeholder}
        autoFocus
        className="w-full bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg px-3 py-2.5 text-sm placeholder-neutral-400 dark:placeholder-neutral-600 focus:outline-none focus:border-blue-600"
      />
      <button
        onClick={onConfirm}
        className="w-full flex items-center justify-center gap-2 bg-blue-600 text-white font-medium rounded-lg py-3.5 active:scale-[0.98] transition"
      >
        Continue
      </button>
    </div>
  );
}

function ActiveWorkout({ exercises, onOpenLibrary, onOpenCustom, addSet, updateSet, removeSet, removeExercise, finishWorkout, isEditing, weightUnit, workoutTitle, setWorkoutTitle }) {
  return (
    <div className="space-y-4 pb-4">
      {isEditing && (
        <input
          value={workoutTitle}
          onChange={e => setWorkoutTitle(e.target.value)}
          placeholder="Workout title"
          className="w-full bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg px-3 py-2.5 text-sm placeholder-neutral-400 dark:placeholder-neutral-600 focus:outline-none focus:border-blue-600"
        />
      )}

      <div className="flex gap-2">
        <button
          onClick={onOpenLibrary}
          className="flex-1 flex items-center justify-center gap-2 bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg py-2.5 text-sm active:scale-[0.98] transition"
        >
          <Library size={16} className="text-blue-600 dark:text-blue-500" /> Add from Library
        </button>
        <button
          onClick={onOpenCustom}
          className="flex-1 flex items-center justify-center gap-2 bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg py-2.5 text-sm active:scale-[0.98] transition"
        >
          <Plus size={16} className="text-blue-600 dark:text-blue-500" /> Add Custom
        </button>
      </div>

      {exercises.map(ex => (
        <div key={ex.id} className="bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-3">
          <div className="flex items-center justify-between mb-2">
            <p className="font-medium text-sm">{ex.name}</p>
            <button onClick={() => removeExercise(ex.id)} className="text-neutral-400 dark:text-neutral-600 hover:text-red-600 dark:hover:text-red-400 p-1">
              <Trash2 size={15} />
            </button>
          </div>

          {ex.sets.length > 0 && (
            <div className="space-y-1.5 mb-2">
              {ex.sets.map((s, i) => (
                <div key={s.id} className="flex items-center gap-2">
                  <span className="text-xs text-neutral-600 dark:text-neutral-500 w-4">{i + 1}</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    value={s.weight}
                    onChange={e => updateSet(ex.id, s.id, "weight", e.target.value)}
                    placeholder={weightUnit}
                    className="w-20 bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded px-2 py-1.5 text-sm text-center focus:outline-none focus:border-blue-600"
                  />
                  <span className="text-neutral-400 dark:text-neutral-600 text-xs">×</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    value={s.reps}
                    onChange={e => updateSet(ex.id, s.id, "reps", e.target.value)}
                    placeholder="reps"
                    className="w-20 bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded px-2 py-1.5 text-sm text-center focus:outline-none focus:border-blue-600"
                  />
                  <button onClick={() => removeSet(ex.id, s.id)} className="ml-auto text-neutral-300 dark:text-neutral-700 hover:text-red-600 dark:hover:text-red-400 p-1">
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <button
            onClick={() => addSet(ex.id)}
            className="w-full text-xs text-blue-600 dark:text-blue-500 border border-dashed border-neutral-200 dark:border-neutral-800 rounded py-1.5 hover:border-blue-700 transition"
          >
            + Add set
          </button>
        </div>
      ))}

      {exercises.length > 0 && (
        <button
          onClick={finishWorkout}
          className="w-full flex items-center justify-center gap-2 bg-blue-600 text-white font-medium rounded-lg py-3.5 active:scale-[0.98] transition mt-2"
        >
          <Check size={18} /> {isEditing ? "Save changes" : "Finish workout"}
        </button>
      )}
    </div>
  );
}

function ActiveCardio({ exercise, addSet, updateSet, removeSet, finishWorkout, isEditing, workoutTitle, setWorkoutTitle }) {
  return (
    <div className="space-y-4 pb-4">
      {isEditing && (
        <input
          value={workoutTitle}
          onChange={e => setWorkoutTitle(e.target.value)}
          placeholder="Cardio title"
          className="w-full bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg px-3 py-2.5 text-sm placeholder-neutral-400 dark:placeholder-neutral-600 focus:outline-none focus:border-blue-600"
        />
      )}

      <div className="bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-3">
        <p className="font-medium text-sm mb-2">{exercise.name}</p>

        {exercise.sets.length > 0 && (
          <div className="space-y-1.5 mb-2">
            {exercise.sets.map((s, i) => (
              <div key={s.id} className="flex items-center gap-2">
                <span className="text-xs text-neutral-600 dark:text-neutral-500 w-4">{i + 1}</span>
                <input
                  type="number"
                  inputMode="decimal"
                  value={s.speed}
                  onChange={e => updateSet(exercise.id, s.id, "speed", e.target.value)}
                  placeholder="speed"
                  className="w-20 bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded px-2 py-1.5 text-sm text-center focus:outline-none focus:border-blue-600"
                />
                <span className="text-neutral-400 dark:text-neutral-600 text-xs">×</span>
                <input
                  type="number"
                  inputMode="decimal"
                  value={s.time}
                  onChange={e => updateSet(exercise.id, s.id, "time", e.target.value)}
                  placeholder="minutes"
                  className="w-20 bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded px-2 py-1.5 text-sm text-center focus:outline-none focus:border-blue-600"
                />
                <button onClick={() => removeSet(exercise.id, s.id)} className="ml-auto text-neutral-300 dark:text-neutral-700 hover:text-red-600 dark:hover:text-red-400 p-1">
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}

        <button
          onClick={() => addSet(exercise.id)}
          className="w-full text-xs text-blue-600 dark:text-blue-500 border border-dashed border-neutral-200 dark:border-neutral-800 rounded py-1.5 hover:border-blue-700 transition"
        >
          + Add interval
        </button>
      </div>

      <button
        onClick={finishWorkout}
        className="w-full flex items-center justify-center gap-2 bg-blue-600 text-white font-medium rounded-lg py-3.5 active:scale-[0.98] transition mt-2"
      >
        <Check size={18} /> {isEditing ? "Save changes" : "Finish cardio"}
      </button>
    </div>
  );
}

function HistoryView({ workouts, onSelect, use24h }) {
  if (workouts.length === 0) {
    return <p className="text-sm text-neutral-600 dark:text-neutral-500 text-center pt-10">No workouts logged yet.</p>;
  }
  return (
    <div className="space-y-2">
      {workouts.map(w => (
        <button
          key={w.id}
          onClick={() => onSelect(w.id)}
          className="w-full text-left bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg px-4 py-3 active:scale-[0.98] transition"
        >
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-sm font-medium">{w.title || "Workout"}</p>
            <p className="text-xs text-neutral-600 dark:text-neutral-500 shrink-0">{fmtDateTime(w, use24h)}</p>
          </div>
        </button>
      ))}
    </div>
  );
}

function CalendarView({
  workouts, restDays, calendarMonth, setCalendarMonth, onSelectDay,
  selectedDay, onSelectEmptyDay, onAddRestDay, onRemoveRestDay, onAddWorkoutPlan,
}) {
  const { year, month } = calendarMonth;
  const monthLabel = new Date(year, month, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const pad = n => String(n).padStart(2, "0");
  const todayKey = todayStr();

  const workoutsByDate = {};
  for (const w of workouts) {
    (workoutsByDate[w.date] ||= []).push(w);
  }

  const cells = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) {
    cells.push(`${year}-${pad(month + 1)}-${pad(day)}`);
  }

  function prevMonth() {
    setCalendarMonth(month === 0 ? { year: year - 1, month: 11 } : { year, month: month - 1 });
  }
  function nextMonth() {
    setCalendarMonth(month === 11 ? { year: year + 1, month: 0 } : { year, month: month + 1 });
  }

  const selectedIsExplicitRest = selectedDay && restDays.includes(selectedDay);
  const selectedIsAutoRest = selectedDay && !selectedIsExplicitRest && selectedDay < todayKey;

  return (
    <div className="pb-4">
      <div className="flex items-center justify-between mb-4">
        <button onClick={prevMonth} className="p-1.5 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-500 dark:text-neutral-400" aria-label="Previous month">
          <ChevronLeft size={18} />
        </button>
        <p className="text-sm font-medium">{monthLabel}</p>
        <button onClick={nextMonth} className="p-1.5 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-500 dark:text-neutral-400" aria-label="Next month">
          <ChevronRight size={18} />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center text-xs text-neutral-400 dark:text-neutral-600 mb-1">
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => <div key={i}>{d}</div>)}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {cells.map((dateStr, i) => {
          if (!dateStr) return <div key={`pad-${i}`} />;
          const dayWorkouts = workoutsByDate[dateStr] || [];
          const has = dayWorkouts.length > 0;
          const isExplicitRest = restDays.includes(dateStr);
          const isAutoRest = !has && !isExplicitRest && dateStr < todayKey;
          const isRest = isExplicitRest || isAutoRest;
          const isToday = dateStr === todayKey;
          const isSelected = selectedDay === dateStr;
          return (
            <button
              key={dateStr}
              onClick={() => {
                if (has) {
                  onSelectEmptyDay(null);
                  onSelectDay(dateStr, dayWorkouts);
                } else {
                  onSelectEmptyDay(isSelected ? null : dateStr);
                }
              }}
              className={`aspect-square flex flex-col items-center justify-center rounded-lg text-sm relative transition
                ${has
                  ? "bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-950/70 active:scale-[0.95]"
                  : isRest
                  ? "bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-950/50 active:scale-[0.95]"
                  : "text-neutral-400 dark:text-neutral-600 hover:bg-neutral-100 dark:hover:bg-neutral-800 active:scale-[0.95]"}
                ${isToday ? "ring-1 ring-blue-600" : ""}
                ${isSelected ? "ring-2 ring-neutral-900 dark:ring-white" : ""}`}
            >
              {Number(dateStr.slice(-2))}
              {has && <span className="absolute bottom-1 w-1 h-1 rounded-full bg-blue-500 dark:bg-blue-400" />}
              {isExplicitRest && <span className="absolute bottom-1 w-1 h-1 rounded-full bg-red-500 dark:bg-red-400" />}
            </button>
          );
        })}
      </div>

      {selectedDay && (
        <div className="mt-4 bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-3">
          <p className="text-sm font-medium mb-2">{fmtDate(selectedDay)}</p>
          {selectedIsExplicitRest ? (
            <button
              onClick={() => onRemoveRestDay(selectedDay)}
              className="w-full flex items-center justify-center gap-2 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-950 bg-red-50 dark:bg-red-950/20 rounded-lg py-2.5 text-sm active:scale-[0.98] transition"
            >
              <Trash2 size={15} /> Remove rest day
            </button>
          ) : selectedIsAutoRest ? (
            <>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-2">No workout logged — counted as a rest day.</p>
              <button
                onClick={() => onAddWorkoutPlan(selectedDay)}
                className="w-full flex items-center justify-center gap-2 bg-blue-600 text-white font-medium rounded-lg py-2.5 text-sm active:scale-[0.98] transition"
              >
                Add workout
              </button>
            </>
          ) : (
            <div className="flex gap-2">
              <button
                onClick={() => onAddRestDay(selectedDay)}
                className="flex-1 flex items-center justify-center gap-2 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-950 bg-red-50 dark:bg-red-950/20 rounded-lg py-2.5 text-sm active:scale-[0.98] transition"
              >
                Add rest day
              </button>
              <button
                onClick={() => onAddWorkoutPlan(selectedDay)}
                className="flex-1 flex items-center justify-center gap-2 bg-blue-600 text-white font-medium rounded-lg py-2.5 text-sm active:scale-[0.98] transition"
              >
                Add workout
              </button>
            </div>
          )}
        </div>
      )}

      {workouts.length === 0 && restDays.length === 0 && (
        <p className="text-sm text-neutral-600 dark:text-neutral-500 text-center pt-10">No workouts logged yet.</p>
      )}
    </div>
  );
}

function PlanTimeView({ date, time, onChange, onConfirm }) {
  const isPast = date < todayStr();
  return (
    <div className="space-y-3">
      <p className="text-sm text-neutral-600 dark:text-neutral-500">
        {isPast ? `What time did you train on ${fmtDate(date)}?` : `What time will you train on ${fmtDate(date)}?`}
      </p>
      <input
        type="time"
        value={time}
        onChange={e => onChange(e.target.value)}
        className="w-full bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-blue-600"
      />
      <button
        onClick={onConfirm}
        className="w-full flex items-center justify-center gap-2 bg-blue-600 text-white font-medium rounded-lg py-3.5 active:scale-[0.98] transition"
      >
        Continue
      </button>
    </div>
  );
}

function PlanTypeView({ onChoose }) {
  return (
    <div className="space-y-2">
      <button
        onClick={() => onChoose("strength")}
        className="w-full flex items-center justify-between bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg px-4 py-3.5 active:scale-[0.98] transition"
      >
        <span className="flex items-center gap-2 text-sm font-medium">
          <Dumbbell size={16} className="text-blue-600 dark:text-blue-500" /> Workout
        </span>
        <ChevronRight size={16} className="text-neutral-400 dark:text-neutral-600" />
      </button>
      <button
        onClick={() => onChoose("cardio")}
        className="w-full flex items-center justify-between bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg px-4 py-3.5 active:scale-[0.98] transition"
      >
        <span className="flex items-center gap-2 text-sm font-medium">
          <Activity size={16} className="text-blue-600 dark:text-blue-500" /> Cardio
        </span>
        <ChevronRight size={16} className="text-neutral-400 dark:text-neutral-600" />
      </button>
      <button
        onClick={() => onChoose("both")}
        className="w-full flex items-center justify-between bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg px-4 py-3.5 active:scale-[0.98] transition"
      >
        <span className="text-sm font-medium">Both</span>
        <ChevronRight size={16} className="text-neutral-400 dark:text-neutral-600" />
      </button>
    </div>
  );
}

function StatTile({ label, value }) {
  return (
    <div className="bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-lg px-2 py-2.5 text-center">
      <p className="text-base font-semibold tabular-nums">{value}</p>
      <p className="text-[11px] text-neutral-600 dark:text-neutral-500 mt-0.5">{label}</p>
    </div>
  );
}

function DetailView({ workout, onEdit, onDelete, weightUnit }) {
  const [showStats, setShowStats] = useState(false);
  const isCardio = workout.type === "cardio";
  const stats = getWorkoutStats(workout);

  return (
    <div className="space-y-3 pb-4">
      {workout.exercises.map((ex, i) => (
        <div key={i} className="bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-3">
          <p className="font-medium text-sm mb-2">{ex.name}</p>
          <div className="space-y-1">
            {ex.sets.map((s, j) => (
              <div key={j} className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
                <span className="text-xs text-neutral-400 dark:text-neutral-600 w-4">{j + 1}</span>
                {isCardio
                  ? <span>Speed {s.speed} · {s.time} min</span>
                  : <span>{fmtWeight(s.weight, weightUnit)} {weightUnit} × {s.reps} reps</span>}
              </div>
            ))}
          </div>
        </div>
      ))}

      <div className="bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg overflow-hidden">
        <button
          onClick={() => setShowStats(v => !v)}
          className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium active:scale-[0.98] transition"
        >
          Workout Statistics
          <ChevronRight
            size={16}
            className={`text-neutral-400 dark:text-neutral-600 transition-transform ${showStats ? "rotate-90" : ""}`}
          />
        </button>
        {showStats && (
          <div className={`px-4 pb-4 pt-1 grid ${isCardio ? "grid-cols-2" : "grid-cols-3"} gap-2`}>
            {isCardio ? (
              <>
                <StatTile label="Intervals" value={stats.totalIntervals} />
                <StatTile label="Total Time" value={`${stats.totalTimeMin} min`} />
              </>
            ) : (
              <>
                <StatTile label="Total Sets" value={stats.totalSets} />
                <StatTile label="Total Reps" value={stats.totalReps} />
                <StatTile label="Total Weight Lifted" value={`${fmtWeight(stats.totalWeight, weightUnit).toLocaleString()} ${weightUnit}`} />
              </>
            )}
          </div>
        )}
      </div>

      <div className="flex gap-2 mt-2">
        <button
          onClick={onEdit}
          className="flex-1 flex items-center justify-center gap-2 bg-neutral-100 dark:bg-neutral-800 text-neutral-800 dark:text-neutral-200 font-medium rounded-lg py-2.5 text-sm active:scale-[0.98] transition"
        >
          <Pencil size={15} /> Edit
        </button>
        <button
          onClick={onDelete}
          className="flex-1 flex items-center justify-center gap-2 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-950 bg-red-50 dark:bg-red-950/20 rounded-lg py-2.5 text-sm active:scale-[0.98] transition"
        >
          <Trash2 size={15} /> Delete
        </button>
      </div>
    </div>
  );
}

function PRsView({ prs, weightUnit }) {
  if (prs.length === 0) {
    return <p className="text-sm text-neutral-600 dark:text-neutral-500 text-center pt-10">Log some workouts to see your personal records.</p>;
  }
  return (
    <div className="space-y-2">
      {prs.map(pr => (
        <div key={pr.name} className="flex items-center justify-between bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg px-4 py-3">
          <div>
            <p className="text-sm font-medium">{pr.name}</p>
            <p className="text-xs text-neutral-600 dark:text-neutral-500">{fmtDate(pr.date)}</p>
          </div>
          <p className="text-sm font-medium text-blue-600 dark:text-blue-500">{fmtWeight(pr.weight, weightUnit)} {weightUnit} × {pr.reps}</p>
        </div>
      ))}
    </div>
  );
}

function SearchView({ workouts, onSelectExercise }) {
  const [query, setQuery] = useState("");

  // Build a de-duplicated exercise list, keyed by normalized name, using the
  // most recent casing/spacing (workouts is newest-first) as the display name.
  const seen = new Map();
  for (const w of workouts) {
    for (const ex of w.exercises) {
      const key = normalizeKey(ex.name);
      if (!seen.has(key)) seen.set(key, { name: ex.name, count: 0 });
      seen.get(key).count += 1;
    }
  }
  const allExercises = Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));

  const q = query.trim().toLowerCase();
  const filtered = q ? allExercises.filter(e => e.name.toLowerCase().includes(q)) : allExercises;

  return (
    <div className="space-y-3">
      <input
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder="Search exercises, e.g. Bench press"
        autoFocus
        className="w-full bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg px-3 py-2.5 text-sm placeholder-neutral-400 dark:placeholder-neutral-600 focus:outline-none focus:border-blue-600"
      />

      {allExercises.length === 0 && (
        <p className="text-sm text-neutral-600 dark:text-neutral-500 text-center pt-10">Log a workout to start building your exercise list.</p>
      )}

      {allExercises.length > 0 && filtered.length === 0 && (
        <p className="text-sm text-neutral-600 dark:text-neutral-500 text-center pt-10">No exercises match "{query}".</p>
      )}

      <div className="space-y-2">
        {filtered.map(e => (
          <button
            key={e.name}
            onClick={() => onSelectExercise(e.name)}
            className="w-full flex items-center justify-between bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg px-4 py-3 active:scale-[0.98] transition"
          >
            <span className="text-sm font-medium">{e.name}</span>
            <span className="text-xs text-neutral-600 dark:text-neutral-500">{e.count} logged</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ExerciseHistoryView({ entries, onSelectEntry, onOpenStats, use24h, weightUnit }) {
  if (entries.length === 0) {
    return <p className="text-sm text-neutral-600 dark:text-neutral-500 text-center pt-10">No history for this exercise yet.</p>;
  }
  const hasStrengthData = entries.some(e => e.type !== "cardio");
  return (
    <div className="space-y-2">
      {hasStrengthData && (
        <button
          onClick={onOpenStats}
          className="w-full flex items-center justify-center gap-2 bg-blue-600 text-white font-medium rounded-lg py-3 text-sm active:scale-[0.98] transition"
        >
          <TrendingUp size={16} /> Statistics
        </button>
      )}
      {entries.map((entry, i) => (
        <button
          key={`${entry.workoutId}-${i}`}
          onClick={() => onSelectEntry(entry.workoutId)}
          className="w-full text-left bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg px-4 py-3 active:scale-[0.98] transition"
        >
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-sm font-medium">{entry.title || "Workout"}</p>
            <p className="text-xs text-neutral-600 dark:text-neutral-500 shrink-0">{fmtDateTime(entry, use24h)}</p>
          </div>
          <div className="mt-1.5 space-y-0.5">
            {entry.sets.map((s, j) => (
              <p key={j} className="text-xs text-neutral-500 dark:text-neutral-400">
                {entry.type === "cardio" ? `Speed ${s.speed} · ${s.time} min` : `${fmtWeight(s.weight, weightUnit)} ${weightUnit} × ${s.reps} reps`}
              </p>
            ))}
          </div>
        </button>
      ))}
    </div>
  );
}

function StatisticsView({ entries, weightUnit, theme, use24h }) {
  const [formula, setFormula] = useState(FORMULAS.EPLEY);
  const [mode, setMode] = useState("trend"); // "trend" | "perSet"

  const strengthEntries = entries.filter(e => e.type !== "cardio");
  const trendPoints = getE1RMTrend(strengthEntries, formula);
  const perSetRows = getE1RMPerSet(strengthEntries, formula);

  const isDark = theme === "dark";
  const gridColor = isDark ? "#27272a" : "#e5e5e5";
  const axisColor = isDark ? "#a1a1aa" : "#525252";
  const lineColor = isDark ? "#3b82f6" : "#2563eb";
  const tooltipBg = isDark ? "#171717" : "#fafafa";
  const tooltipBorder = isDark ? "#27272a" : "#e5e5e5";
  const tooltipText = isDark ? "#f5f5f5" : "#171717";

  const chartData = trendPoints.map(p => ({ ...p, label: fmtDate(p.date) }));

  return (
    <div className="space-y-4 pb-4">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setMode("trend")}
          className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg py-2.5 text-sm font-medium transition ${
            mode === "trend"
              ? "bg-blue-600 text-white"
              : "bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 text-neutral-700 dark:text-neutral-300"
          }`}
        >
          <TrendingUp size={15} /> Trend
        </button>
        <button
          onClick={() => setMode("perSet")}
          className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg py-2.5 text-sm font-medium transition ${
            mode === "perSet"
              ? "bg-blue-600 text-white"
              : "bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 text-neutral-700 dark:text-neutral-300"
          }`}
        >
          <ListOrdered size={15} /> Per Set
        </button>
      </div>

      <div className="flex items-center justify-center gap-2">
        <button
          onClick={() => setFormula(FORMULAS.EPLEY)}
          className={`px-4 py-1.5 rounded-full text-xs font-medium transition ${
            formula === FORMULAS.EPLEY
              ? "bg-blue-600 text-white"
              : "bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400"
          }`}
        >
          Epley
        </button>
        <button
          onClick={() => setFormula(FORMULAS.BRZYCKI)}
          className={`px-4 py-1.5 rounded-full text-xs font-medium transition ${
            formula === FORMULAS.BRZYCKI
              ? "bg-blue-600 text-white"
              : "bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400"
          }`}
        >
          Brzycki
        </button>
      </div>

      {mode === "trend" ? (
        trendPoints.length === 0 ? (
          <p className="text-sm text-neutral-600 dark:text-neutral-500 text-center pt-10">
            Log at least one valid set (weight and reps both above zero) to see your trend.
          </p>
        ) : (
          <div>
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke={gridColor} strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: axisColor }} axisLine={{ stroke: gridColor }} tickLine={false} />
                  <YAxis
                    tick={{ fontSize: 11, fill: axisColor }}
                    axisLine={false}
                    tickLine={false}
                    width={44}
                    domain={[
                      (dataMin) => Math.floor(dataMin - Math.max(2, dataMin * 0.05)),
                      (dataMax) => Math.ceil(dataMax + Math.max(2, dataMax * 0.05)),
                    ]}
                  />
                  <Tooltip
                    contentStyle={{ background: tooltipBg, border: `1px solid ${tooltipBorder}`, borderRadius: 8, fontSize: 12 }}
                    labelStyle={{ color: tooltipText }}
                    itemStyle={{ color: lineColor }}
                    formatter={(value) => [`${round1(value)} ${weightUnit}`, "e1RM"]}
                  />
                  <Line type="monotone" dataKey="e1rm" stroke={lineColor} strokeWidth={2.5} dot={{ r: 3, fill: lineColor }} activeDot={{ r: 5 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <p className="text-xs text-neutral-600 dark:text-neutral-500 text-center mt-2">
              One point per session · best set's e1RM ({formula === FORMULAS.EPLEY ? "Epley" : "Brzycki"})
            </p>
          </div>
        )
      ) : perSetRows.length === 0 ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-500 text-center pt-10">
          Log at least one valid set (weight and reps both above zero) to see e1RM per set.
        </p>
      ) : (
        <div className="space-y-2">
          {perSetRows.map((row, i) => (
            <div
              key={`${row.workoutId}-${row.setIndex}-${i}`}
              className="flex items-center justify-between bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg px-4 py-3"
            >
              <div>
                <p className="text-sm font-medium">{fmtWeight(row.e1rm, weightUnit)} {weightUnit} e1RM</p>
                <p className="text-xs text-neutral-600 dark:text-neutral-500 mt-0.5">
                  {fmtWeight(row.weight, weightUnit)} {weightUnit} × {row.reps} reps
                </p>
              </div>
              <p className="text-xs text-neutral-600 dark:text-neutral-500 shrink-0">{fmtDateTime(row, use24h)}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
