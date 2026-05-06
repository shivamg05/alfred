/**
 * Tests for src/config.ts — Zod schema validation and defaults.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";

// Re-define the schema to test without side effects (dotenv, process.env mutation)
const schema = z.object({
  ALFRED_PHONE: z.string().min(1, "ALFRED_PHONE: the Apple ID or phone number Alfred listens on"),
  USER_PHONE: z.string().min(1, "USER_PHONE: your phone number or Apple ID to send replies to"),
  OPENAI_API_KEY: z.string().min(1),
  LLM_BASE_URL: z.string().url().optional(),
  OPENROUTER_SITE_URL: z.string().optional(),
  OPENROUTER_SITE_NAME: z.string().optional(),
  LLM_MODEL: z.string().default("gpt-4o-mini"),
  EXTRACTION_MODEL: z.string().default("gpt-4o-mini"),
  DB_PATH: z.string().default("alfred.db"),
  IMESSAGE_DB_PATH: z.string().default("/Users/alfred/Library/Messages/chat.db"),
  CHROMA_PATH: z.string().default("./chroma_data"),
  CHROMA_PORT: z.coerce.number().default(8000),
  TODOIST_API_TOKEN: z.string().optional(),
  FIRECRAWL_API_KEY: z.string().optional(),
  QUIET_HOURS_START: z.coerce.number().min(0).max(23).default(0),
  QUIET_HOURS_END: z.coerce.number().min(0).max(23).default(8),
  USER_TIMEZONE: z.string().default("America/Chicago"),
  USER_ID: z.string().default("local"),
});

describe("config schema", () => {
  const minimal = {
    ALFRED_PHONE: "+15551234567",
    USER_PHONE: "+15559876543",
    OPENAI_API_KEY: "sk-test-key",
  };

  it("parses minimal valid config with defaults", () => {
    const config = schema.parse(minimal);
    expect(config.LLM_MODEL).toBe("gpt-4o-mini");
    expect(config.DB_PATH).toBe("alfred.db");
    expect(config.QUIET_HOURS_START).toBe(0);
    expect(config.QUIET_HOURS_END).toBe(8);
    expect(config.USER_TIMEZONE).toBe("America/Chicago");
    expect(config.USER_ID).toBe("local");
  });

  it("rejects missing ALFRED_PHONE", () => {
    const { ALFRED_PHONE, ...rest } = minimal;
    expect(() => schema.parse(rest)).toThrow();
  });

  it("rejects missing USER_PHONE", () => {
    const { USER_PHONE, ...rest } = minimal;
    expect(() => schema.parse(rest)).toThrow();
  });

  it("rejects missing OPENAI_API_KEY", () => {
    const { OPENAI_API_KEY, ...rest } = minimal;
    expect(() => schema.parse(rest)).toThrow();
  });

  it("rejects empty ALFRED_PHONE", () => {
    expect(() => schema.parse({ ...minimal, ALFRED_PHONE: "" })).toThrow();
  });

  it("accepts valid LLM_BASE_URL", () => {
    const config = schema.parse({
      ...minimal,
      LLM_BASE_URL: "https://openrouter.ai/api/v1",
    });
    expect(config.LLM_BASE_URL).toBe("https://openrouter.ai/api/v1");
  });

  it("rejects invalid LLM_BASE_URL", () => {
    expect(() => schema.parse({ ...minimal, LLM_BASE_URL: "not-a-url" })).toThrow();
  });

  it("coerces QUIET_HOURS_START from string", () => {
    const config = schema.parse({ ...minimal, QUIET_HOURS_START: "22" });
    expect(config.QUIET_HOURS_START).toBe(22);
  });

  it("rejects QUIET_HOURS_START > 23", () => {
    expect(() => schema.parse({ ...minimal, QUIET_HOURS_START: "25" })).toThrow();
  });

  it("coerces CHROMA_PORT from string", () => {
    const config = schema.parse({ ...minimal, CHROMA_PORT: "9000" });
    expect(config.CHROMA_PORT).toBe(9000);
  });

  it("optional fields are undefined when not provided", () => {
    const config = schema.parse(minimal);
    expect(config.TODOIST_API_TOKEN).toBeUndefined();
    expect(config.FIRECRAWL_API_KEY).toBeUndefined();
    expect(config.LLM_BASE_URL).toBeUndefined();
  });
});
