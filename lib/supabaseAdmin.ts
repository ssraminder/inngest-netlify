import { createClient, SupabaseClient } from "@supabase/supabase-js";

/**
 * Create the service-role client lazily at request time.
 * Never read env at module scope (breaks Next build).
 */
export function getServiceRoleClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}
