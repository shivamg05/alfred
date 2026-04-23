import { execSync } from "child_process";
import { createReadStream, unlinkSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { makeOpenAIClient } from "../orchestrator/llm.js";
import { config } from "../config.js";

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

  // Whisper model ID — OpenRouter proxies it as "openai/whisper-1"
  const cfg = config();
  const model = cfg.LLM_BASE_URL ? "openai/whisper-1" : "whisper-1";

  try {
    const result = await makeOpenAIClient().audio.transcriptions.create({
      file: createReadStream(tmpWav),
      model,
    });
    console.log(`[transcription] transcript: "${result.text.slice(0, 100)}"`);
    return result.text;
  } catch (err) {
    console.error("[transcription] Whisper API failed:", err);
    return null;
  } finally {
    if (existsSync(tmpWav)) unlinkSync(tmpWav);
  }
}
