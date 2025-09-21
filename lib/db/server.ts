// lib/db/server.ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

function ensureClient(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  cached = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  return cached;
}

// Proxy the client so existing code using the constant keeps working while
// deferring instantiation until first use.
export const supabaseAdmin = new Proxy({} as SupabaseClient, {
  get(_target, prop, receiver) {
    const client = ensureClient();
    const value = Reflect.get(client, prop, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
});

// backward-compat: callers using sbAdmin() keep working
export function sbAdmin(): SupabaseClient {
  return ensureClient();
}
