import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

function getEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

export function supabase(): SupabaseClient {
  if (cached) return cached;
  const url = getEnv("SUPABASE_URL");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;
  if (!key || !key.trim()) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SERVICE_KEY");
  }
  cached = createClient(url, key, { auth: { persistSession: false } });
  return cached;
}
