/**
 * Tests for the extraction schema validation in src/memory/extractor.ts.
 *
 * These test the Zod schemas that parse LLM output (factSchema, reminderSchema,
 * extractionSchema) without making any LLM calls. This validates that Alfred
 * correctly handles the many weird shapes models return.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";

// We re-define the schemas here to test them in isolation without importing
// the full extractor module (which has side effects and external deps).
// These must match the schemas in src/memory/extractor.ts exactly.

const factSchema = z
  .object({
    text: z.string().optional(),
    fact: z.string().optional(),
    is_static: z.boolean(),
    abstraction_level: z.coerce.number().int().min(0).max(2).default(1),
    forget_after: z.string().optional(),
    event_date: z.string().optional(),
    contradicts_hint: z.string().optional(),
    extends_hint: z.string().optional(),
    parent_hint: z.string().optional(),
    proactive_nudge: z.object({ after_hours: z.number() }).optional().nullable(),
  })
  .transform((d) => ({
    text: (d.text ?? d.fact ?? "").trim(),
    is_static: d.is_static,
    abstraction_level: d.abstraction_level as 0 | 1 | 2,
    forget_after: d.forget_after,
    event_date: d.event_date,
    contradicts_hint: d.contradicts_hint,
    extends_hint: d.extends_hint,
    parent_hint: d.parent_hint,
    proactive_nudge: d.proactive_nudge ?? null,
  }))
  .refine((d) => d.text.length > 0, { message: "fact must have non-empty text" });

const reminderSchema = z.object({
  text: z.string(),
  due_at: z.string(),
});

const extractionSchema = z
  .object({
    facts: z.array(z.unknown()).default([]),
    reminders: z.array(z.unknown()).default([]),
    follow_up_reminders: z.array(z.unknown()).default([]),
  })
  .transform((data) => ({
    facts: data.facts
      .map((f): z.infer<typeof factSchema> | null => {
        if (typeof f === "string") {
          const text = f.trim();
          return text
            ? {
                text,
                is_static: false,
                abstraction_level: 0,
                forget_after: undefined,
                event_date: undefined,
                contradicts_hint: undefined,
                extends_hint: undefined,
                parent_hint: undefined,
                proactive_nudge: null,
              }
            : null;
        }
        const r = factSchema.safeParse(f);
        return r.success ? r.data : null;
      })
      .filter((f): f is z.infer<typeof factSchema> => f !== null && f.text.length > 0),
    reminders: data.reminders
      .map((r) => reminderSchema.safeParse(r))
      .filter((r) => r.success)
      .map((r) => (r as { success: true; data: { text: string; due_at: string } }).data),
    follow_up_reminders: data.follow_up_reminders
      .map((r) => reminderSchema.safeParse(r))
      .filter((r) => r.success)
      .map((r) => (r as { success: true; data: { text: string; due_at: string } }).data),
  }));

function extractJSON(s: string): string {
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) return s.slice(start, end + 1);
  return s.trim();
}

// ────────────────────────────────────────────────────────────────────
// factSchema
// ────────────────────────────────────────────────────────────────────

describe("factSchema", () => {
  it("accepts well-formed fact with text field", () => {
    const result = factSchema.safeParse({
      text: "User likes tacos",
      is_static: false,
      abstraction_level: 0,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.text).toBe("User likes tacos");
      expect(result.data.proactive_nudge).toBeNull();
    }
  });

  it("accepts 'fact' field as alias for 'text'", () => {
    const result = factSchema.safeParse({
      fact: "User has a dog",
      is_static: true,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.text).toBe("User has a dog");
  });

  it("rejects empty text", () => {
    const result = factSchema.safeParse({
      text: "",
      is_static: false,
    });
    expect(result.success).toBe(false);
  });

  it("rejects whitespace-only text", () => {
    const result = factSchema.safeParse({
      text: "   ",
      is_static: false,
    });
    expect(result.success).toBe(false);
  });

  it("defaults abstraction_level to 1", () => {
    const result = factSchema.safeParse({
      text: "Pattern fact",
      is_static: false,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.abstraction_level).toBe(1);
  });

  it("coerces string abstraction_level to number", () => {
    const result = factSchema.safeParse({
      text: "Fact",
      is_static: false,
      abstraction_level: "2",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.abstraction_level).toBe(2);
  });

  it("clamps abstraction_level to 0-2", () => {
    const over = factSchema.safeParse({
      text: "Fact",
      is_static: false,
      abstraction_level: 5,
    });
    expect(over.success).toBe(false);

    const under = factSchema.safeParse({
      text: "Fact",
      is_static: false,
      abstraction_level: -1,
    });
    expect(under.success).toBe(false);
  });

  it("accepts proactive_nudge with after_hours", () => {
    const result = factSchema.safeParse({
      text: "User wants to call advisor",
      is_static: false,
      abstraction_level: 0,
      proactive_nudge: { after_hours: 36 },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.proactive_nudge?.after_hours).toBe(36);
  });

  it("treats null proactive_nudge as null", () => {
    const result = factSchema.safeParse({
      text: "Fact",
      is_static: false,
      proactive_nudge: null,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.proactive_nudge).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────
// extractionSchema — the full LLM response parser
// ────────────────────────────────────────────────────────────────────

describe("extractionSchema", () => {
  it("parses a well-formed extraction response", () => {
    const raw = {
      facts: [
        { text: "User plays soccer", is_static: false, abstraction_level: 0 },
        { text: "User has exam Friday", is_static: false, abstraction_level: 0, event_date: "2026-05-09" },
      ],
      reminders: [
        { text: "Call mom", due_at: "2026-05-05T18:00:00-04:00" },
      ],
      follow_up_reminders: [],
    };
    const parsed = extractionSchema.parse(raw);
    expect(parsed.facts.length).toBe(2);
    expect(parsed.reminders.length).toBe(1);
    expect(parsed.follow_up_reminders.length).toBe(0);
  });

  it("handles plain string facts (LLM sometimes does this)", () => {
    const raw = {
      facts: ["User is tired", "User played soccer"],
      reminders: [],
      follow_up_reminders: [],
    };
    const parsed = extractionSchema.parse(raw);
    expect(parsed.facts.length).toBe(2);
    expect(parsed.facts[0].abstraction_level).toBe(0); // default for string facts
  });

  it("filters out malformed facts gracefully", () => {
    const raw = {
      facts: [
        { text: "Good fact", is_static: false },
        { is_static: false }, // missing text
        { text: "", is_static: false }, // empty text
        null, // null
        42, // number
        { text: "Another good one", is_static: true, abstraction_level: 1 },
      ],
      reminders: [],
      follow_up_reminders: [],
    };
    const parsed = extractionSchema.parse(raw);
    expect(parsed.facts.length).toBe(2);
    expect(parsed.facts[0].text).toBe("Good fact");
    expect(parsed.facts[1].text).toBe("Another good one");
  });

  it("filters out malformed reminders gracefully", () => {
    const raw = {
      facts: [],
      reminders: [
        { text: "Good reminder", due_at: "2026-05-05T18:00:00Z" },
        { text: "Missing due_at" }, // invalid
        { due_at: "2026-05-05T18:00:00Z" }, // missing text
        null,
      ],
      follow_up_reminders: [],
    };
    const parsed = extractionSchema.parse(raw);
    expect(parsed.reminders.length).toBe(1);
    expect(parsed.reminders[0].text).toBe("Good reminder");
  });

  it("defaults missing arrays to empty", () => {
    const raw = {};
    const parsed = extractionSchema.parse(raw);
    expect(parsed.facts).toEqual([]);
    expect(parsed.reminders).toEqual([]);
    expect(parsed.follow_up_reminders).toEqual([]);
  });

  it("handles empty string facts array entries", () => {
    const raw = {
      facts: ["", "  ", "Valid fact"],
      reminders: [],
      follow_up_reminders: [],
    };
    const parsed = extractionSchema.parse(raw);
    expect(parsed.facts.length).toBe(1);
    expect(parsed.facts[0].text).toBe("Valid fact");
  });
});

// ────────────────────────────────────────────────────────────────────
// extractJSON — the fence/wrapping handler
// ────────────────────────────────────────────────────────────────────

describe("extractJSON", () => {
  it("passes through clean JSON", () => {
    const json = '{"facts": [], "reminders": []}';
    expect(extractJSON(json)).toBe(json);
  });

  it("extracts JSON from text with leading/trailing noise", () => {
    const raw = 'Here is the extraction:\n{"facts": []} and some more text';
    expect(extractJSON(raw)).toBe('{"facts": []}');
  });

  it("handles markdown fence wrapping", () => {
    const raw = '```json\n{"score": 85}\n```';
    // extractJSON finds first { and last }
    expect(JSON.parse(extractJSON(raw))).toEqual({ score: 85 });
  });

  it("returns trimmed string when no JSON found", () => {
    expect(extractJSON("no json here")).toBe("no json here");
  });
});
