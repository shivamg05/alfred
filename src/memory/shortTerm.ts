export interface BufferMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

const BUFFER_SIZE = 20;
const INJECTION_CAP = 12;
const SESSION_GAP_HOURS = 4;

export class ConversationBuffer {
  private messages: BufferMessage[] = [];
  /** Compressed summary of messages older than the injection window. */
  private _sessionSummary: string | null = null;
  /** True while a summary is being generated — prevents overlapping calls. */
  private _summarizing = false;
  /** Callback to generate summary text. Set via `onNeedsSummary`. */
  private _summarizer: ((msgs: BufferMessage[]) => Promise<string>) | null = null;

  push(msg: BufferMessage): void {
    const last = this.messages[this.messages.length - 1];
    if (last) {
      const gapHours =
        (new Date(msg.timestamp).getTime() - new Date(last.timestamp).getTime()) /
        (1000 * 60 * 60);
      if (gapHours > SESSION_GAP_HOURS) {
        this.messages = [];
        this._sessionSummary = null;
      }
    }
    this.messages.push(msg);
    if (this.messages.length > BUFFER_SIZE) {
      this.messages.shift();
    }

    // When we have more messages than the injection cap, summarize the overflow
    if (this.messages.length > INJECTION_CAP && this._summarizer && !this._summarizing) {
      this._triggerSummary();
    }
  }

  /** Returns the last N messages (full buffer — used for extraction). */
  getRecent(n = BUFFER_SIZE): BufferMessage[] {
    return this.messages.slice(-n);
  }

  /**
   * Returns messages for prompt injection: at most INJECTION_CAP messages.
   * If there are more messages in the buffer, the older ones have been
   * compressed into a session summary (available via `sessionSummary`).
   */
  getForPrompt(): BufferMessage[] {
    return this.messages.slice(-INJECTION_CAP);
  }

  /** Compressed summary of earlier conversation, or null if not needed/available. */
  get sessionSummary(): string | null {
    return this._sessionSummary;
  }

  /** Register the async function that generates summaries. Called from index.ts after LLM is available. */
  onNeedsSummary(fn: (msgs: BufferMessage[]) => Promise<string>): void {
    this._summarizer = fn;
  }

  seed(msgs: BufferMessage[]): void {
    this.messages = msgs.slice(-BUFFER_SIZE);
    this._sessionSummary = null;
  }

  /** Exposed for testing — returns the injection cap constant. */
  static get INJECTION_CAP(): number {
    return INJECTION_CAP;
  }

  private _triggerSummary(): void {
    const overflow = this.messages.slice(0, -INJECTION_CAP);
    if (overflow.length === 0) return;
    this._summarizing = true;
    this._summarizer!(overflow)
      .then((summary) => {
        this._sessionSummary = summary;
        console.log(`[buffer] session summary updated (${overflow.length} msgs → ${summary.length} chars)`);
      })
      .catch((err) => {
        console.error("[buffer] summary generation failed:", err);
      })
      .finally(() => {
        this._summarizing = false;
      });
  }
}
