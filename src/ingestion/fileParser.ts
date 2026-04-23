import { readFileSync, existsSync } from "fs";
import { makeOpenAIClient } from "../orchestrator/llm.js";
import { config } from "../config.js";

function visionModel(): string {
  return config().LLM_BASE_URL ? "google/gemini-2.5-flash-lite" : "gpt-4o";
}

function bufferToDataUrl(buf: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buf.toString("base64")}`;
}

/** Convert HEIC/HEIF → JPEG via heic-convert (pure Node.js, no ffmpeg). */
async function heicToJpegBuffer(inputBuf: Buffer): Promise<Buffer | null> {
  try {
    const heicConvert = (await import("heic-convert")).default;
    const outputBuf = await heicConvert({
      buffer: inputBuf as unknown as ArrayBuffer,
      format: "JPEG",
      quality: 0.85,
    });
    return Buffer.from(outputBuf);
  } catch (err) {
    console.error("[fileParser] HEIC conversion failed:", err);
    return null;
  }
}

/** Summarize an image from a file path. Handles HEIC conversion. */
export async function summarizeImageFromPath(filePath: string): Promise<string | null> {
  if (!existsSync(filePath)) {
    console.error(`[fileParser] image file not found: ${filePath}`);
    return null;
  }

  try {
    let buf: Buffer = readFileSync(filePath);
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
    let mimeType =
      ext === "png" ? "image/png" :
      ext === "gif" ? "image/gif" :
      ext === "webp" ? "image/webp" :
      "image/jpeg";

    if (ext === "heic" || ext === "heif") {
      const converted = await heicToJpegBuffer(buf);
      if (converted) {
        buf = converted;
        mimeType = "image/jpeg";
      } else {
        console.error("[fileParser] HEIC conversion failed — cannot send HEIC to vision APIs");
        return null;
      }
    }

    const response = await makeOpenAIClient().chat.completions.create({
      model: visionModel(),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this image in 2 sentences. Extract any visible text verbatim." },
            { type: "image_url", image_url: { url: bufferToDataUrl(buf, mimeType), detail: "low" } },
          ],
        },
      ],
      max_tokens: 200,
    });

    const raw = response.choices[0]?.message?.content?.trim() ?? null;
    // Strip any markdown headers the model adds (e.g. "# Image Description\n\n")
    const result = raw?.replace(/^#+\s+[^\n]*\n+/, "").trim() ?? null;
    if (result) console.log(`[fileParser] image summary: "${result.slice(0, 100)}"`);
    return result;
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
    const response = await makeOpenAIClient().chat.completions.create({
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
