import { z } from "zod";
import "dotenv/config";

const schema = z.object({
  // iMessage
  ALFRED_PHONE: z.string().min(1, "ALFRED_PHONE: the Apple ID or phone number Alfred listens on"),
  USER_PHONE: z.string().min(1, "USER_PHONE: your phone number or Apple ID to send replies to"),

  // AI
  OPENAI_API_KEY: z.string().min(1),
  LLM_BASE_URL: z.string().url().optional(),  // for openai-compatible providers (openrouter, etc.)
  OPENROUTER_SITE_URL: z.string().optional(), // shown on openrouter.ai rankings (optional)
  OPENROUTER_SITE_NAME: z.string().optional(), // shown on openrouter.ai rankings (optional)
  LLM_MODEL: z.string().default("gpt-4o-mini"),
  EXTRACTION_MODEL: z.string().default("gpt-4o-mini"),

  // DB
  DB_PATH: z.string().default("alfred.db"),
  IMESSAGE_DB_PATH: z.string().default("/Users/alfred/Library/Messages/chat.db"),
  CHROMA_PATH: z.string().default("./chroma_data"),
  CHROMA_PORT: z.coerce.number().default(8000),

  // Integrations
  TODOIST_API_TOKEN: z.string().optional(),
  FIRECRAWL_API_KEY: z.string().optional(),

  // Behaviour
  QUIET_HOURS_START: z.coerce.number().min(0).max(23).default(0),  // midnight
  QUIET_HOURS_END: z.coerce.number().min(0).max(23).default(8),    // 8am
  USER_TIMEZONE: z.string().default("America/Chicago"),
  USER_ID: z.string().default("local"),  // for future multi-user; hardcoded for Phase 1
});

export type Config = z.infer<typeof schema>;

let _config: Config | null = null;
export function config(): Config {
  if (!_config) _config = schema.parse(process.env);
  return _config;
}
