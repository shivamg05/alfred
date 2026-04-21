import { execSync } from "child_process";
import { createReadStream, unlinkSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import OpenAI from "openai";
import { config } from "../config.js";

let _client: OpenAI | null = null;
function openai(): OpenAI {
  if (!_client) _client = new OpenAI({ apiKey: config().OPENAI_API_KEY });
  return _client;
}

export async function transcribeAudio(filePath: string): Promise<string | null> {
  const tmpMp3 = join(tmpdir(), `alfred_${Date.now()}.mp3`);

  try {
    execSync(`ffmpeg -y -i "${filePath}" -ar 16000 -ac 1 -b:a 64k "${tmpMp3}" -loglevel quiet`, {
      timeout: 30_000,
    });
  } catch (err) {
    console.error("[transcription] ffmpeg failed:", err);
    return null;
  }

  try {
    const result = await openai().audio.transcriptions.create({
      file: createReadStream(tmpMp3),
      model: "whisper-1",
    });
    return result.text;
  } catch (err) {
    console.error("[transcription] Whisper API failed:", err);
    return null;
  } finally {
    if (existsSync(tmpMp3)) unlinkSync(tmpMp3);
  }
}
