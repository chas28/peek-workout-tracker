import { supabase } from "./supabaseClient.js";

// Gives every visitor a real (invisible, no login form) Supabase auth
// session via anonymous sign-in, so Row Level Security can enforce
// "auth.uid() = user_id" on every table — a plain client-generated ID
// column can't be trusted server-side since the public anon key lets
// anyone claim any ID. supabase-js persists the session's refresh token
// in localStorage itself, so the same visitor keeps the same user id
// across reloads and return visits without us managing that separately.
let sessionPromise = null;

export function ensureAnonSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) return session.user.id;

      const { data, error } = await supabase.auth.signInAnonymously();
      if (error) throw error;
      return data.user.id;
    })();
  }
  return sessionPromise;
}
