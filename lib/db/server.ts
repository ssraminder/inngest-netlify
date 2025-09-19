// lib/db/server.ts
import { createClient } from "@supabase/supabase-js";

export function sbAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY; // use SERVICE_ROLE on server if RLS requires
  if (!url || !key) {
    throw new Error("Supabase env missing at runtime (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY).");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}
