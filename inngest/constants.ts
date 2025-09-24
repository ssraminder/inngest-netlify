/**
 * Single source of truth for Inngest function IDs and environment variables.
 */
export const FN_IDS = {
  COMPUTE_PRICING_SHIM: "cethos-quote-platform-compute-pricing",
  COMPUTE_PRICING: "compute-pricing",
  GEMINI_ANALYZE: "gemini-analyze",
  OCR_DOCUMENT: "ocr-document",
  PROCESS_UPLOAD: "process-upload",
  QUOTE_CREATED_PREPARE_JOBS: "quote-created-prepare-jobs",
  ECHO_FILES_UPLOADED: "echo-files-uploaded",
} as const;

export const ENV_VARS = {
  // Supabase
  SUPABASE_URL: "SUPABASE_URL",
  SUPABASE_SERVICE_ROLE_KEY: "SUPABASE_SERVICE_ROLE_KEY",
  SUPABASE_ANON_KEY: "SUPABASE_ANON_KEY",

  // Google Document AI
  GOOGLE_PROJECT_ID: "GOOGLE_PROJECT_ID",
  GOOGLE_LOCATION: "GOOGLE_LOCATION",
  GOOGLE_PROCESSOR_ID: "GOOGLE_PROCESSOR_ID",
  GOOGLE_APPLICATION_CREDENTIALS: "GOOGLE_APPLICATION_CREDENTIALS",

  // Gemini
  GEMINI_API_KEY: "GEMINI_API_KEY",

  // Email (Brevo)
  BREVO_API_KEY: "BREVO_API_KEY",

  // App/Pricing
  BASE_RATE_CAD: "BASE_RATE_CAD",
  EXTRA_PAGE_RATE_CAD: "EXTRA_PAGE_RATE_CAD",
} as const;
