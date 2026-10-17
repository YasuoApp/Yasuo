import { defineConfig } from "nitro"

export default defineConfig({
  serverDir: "./server",

  /*
   * Every key here is overridden by `NITRO_<UPPER_SNAKE>` in the environment —
   * `.env` in development, the platform's variables in production. Only the
   * Anthropic key has no usable default.
   */
  runtimeConfig: {
    /** NITRO_ANTHROPIC_API_KEY — a Console key; every free request spends it. */
    anthropicApiKey: "",
    /** NITRO_ANTHROPIC_BASE_URL */
    anthropicBaseUrl: "https://api.anthropic.com",
    /** NITRO_FIREBASE_PROJECT_ID — the project the studio signs in to
     * (`FIREBASE_CONFIG` in the app's `src/shared/firebase.ts`). */
    firebaseProjectId: "simm-chat",
    /** NITRO_FIREBASE_JWKS_URL — the keys ID tokens are checked against.
     * Empty is Google's own; set only for a test that signs its own tokens. */
    firebaseJwksUrl: "",
    /** NITRO_ALLOWED_MODELS — comma-separated; the app's `FREE_AI_MODEL`. */
    allowedModels: "claude-haiku-5-5",
    /** NITRO_DAILY_BUDGET — per user per UTC day, in input-token equivalents
     * (`server/utils/usage.ts`). 0 turns the budget off. */
    dailyBudget: 2_000_000,
  },

  /*
   * Each user's daily spend. A directory on the server's own disk, which is
   * right for one instance; more than one instance needs a shared driver here
   * (`redis`, say) or each would count its own share of a user's day.
   */
  storage: {
    quota: { driver: "fs", base: "./.data/quota" },
  },
})
