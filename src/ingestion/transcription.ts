import { execSync } from "child_process";
import { readFileSync, unlinkSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { makeOpenAIClient } from "../orchestrator/llm.js";

export async function transcribeAudio(filePath: string): Promise<string | null> {
  // Use macOS built-in afconvert to produce a 16kHz mono WAV — no ffmpeg needed.
  const tmpWav = join(tmpdir(), `alfred_${Date.now()}.wav`);

  try {
    execSync(
      `/usr/bin/afconvert -f WAVE -d LEI16 -r 16000 -c 1 "${filePath}" "${tmpWav}"`,
      { timeout: 30_000 },
    );
  } catch (err) {
    console.error("[transcription] afconvert failed:", err);
    return null;
  }

  try {
    const audioBase64 = readFileSync(tmpWav).toString("base64");

    const response = await makeOpenAIClient().chat.completions.create({
      model: "google/gemini-2.5-flash-lite",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Transcribe this audio exactly. Output only the spoken words, nothing else." },
            { type: "input_audio", input_audio: { data: audioBase64, format: "wav" } },
          ] as never,
        },
      ],
      max_tokens: 500,
      temperature: 0,
    });

    const text = response.choices[0]?.message?.content?.trim() ?? "";
    if (!text) return null;
    console.log(`[transcription] transcript: "${text.slice(0, 100)}"`);
    return text;
  } catch (err) {
    console.error("[transcription] transcription failed:", err);
    return null;
  } finally {
    if (existsSync(tmpWav)) unlinkSync(tmpWav);
  }
}
