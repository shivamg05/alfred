import { readFileSync } from "fs";
import OpenAI from "openai";
import { config } from "../config.js";

let _client: OpenAI | null = null;
function openai(): OpenAI {
  if (!_client) _client = new OpenAI({ apiKey: config().OPENAI_API_KEY });
  return _client;
}

export async function summarizeImage(filePath: string): Promise<string | null> {
  try {
    const imageData = readFileSync(filePath);
    const base64 = imageData.toString("base64");
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "jpeg";
    const mediaType = ext === "png" ? "image/png" : "image/jpeg";

    const response = await openai().chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this image in 2 sentences. Extract any visible text." },
            { type: "image_url", image_url: { url: `data:${mediaType};base64,${base64}`, detail: "low" } },
          ],
        },
      ],
      max_tokens: 200,
    });
    return response.choices[0]?.message?.content?.trim() ?? null;
  } catch (err) {
    console.error("[fileParser] image summarization failed:", err);
    return null;
  }
}

export async function summarizeFile(filePath: string): Promise<string | null> {
  let rawText = "";

  try {
    const ext = filePath.split(".").pop()?.toLowerCase();
    if (ext === "pdf") {
      const pdfParseModule = await import("pdf-parse");
      const pdfParse = (pdfParseModule as unknown as { default: (buf: Buffer) => Promise<{ text: string }> }).default ?? pdfParseModule;
      const buffer = readFileSync(filePath);
      const data = await pdfParse(buffer);
      rawText = data.text;
    } else if (ext === "docx" || ext === "doc") {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ path: filePath });
      rawText = result.value;
    } else {
      rawText = readFileSync(filePath, "utf-8");
    }
  } catch (err) {
    console.error("[fileParser] file read failed:", err);
    return null;
  }

  const truncated = rawText.slice(0, 4000);

  try {
    const response = await openai().chat.completions.create({
      model: config().EXTRACTION_MODEL,
      messages: [
        { role: "system", content: "Summarize this document in 2 sentences." },
        { role: "user", content: truncated },
      ],
      max_tokens: 150,
    });
    return response.choices[0]?.message?.content?.trim() ?? null;
  } catch (err) {
    console.error("[fileParser] summarization failed:", err);
    return null;
  }
}
