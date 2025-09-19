// lib/db/server.ts
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!url || !serviceRoleKey) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

// single shared admin client instance
const _supabaseAdmin = createClient(url, serviceRoleKey, { auth: { persistSession: false } });

// named export for direct use
export const supabaseAdmin = _supabaseAdmin;

// backward-compat: callers using sbAdmin() keep working
export function sbAdmin() {
  return _supabaseAdmin;
}