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

  /** Rolling summary of all messages that fall outside the injection window. */
  private _sessionSummary: string | null = null;
  /** Messages queued for folding into the summary but not yet processed. */
  private _pendingFold: BufferMessage[] = [];
  /** How many messages (from the front of the buffer) have already been queued for folding. */
  private _foldedCount = 0;
  /** True while a summary fold is in flight. */
  private _summarizing = false;
  /** Callback: (existingSummary, newMessages) → updatedSummary. */
  private _summarizer: ((existing: string | null, evicted: BufferMessage[]) => Promise<string>) | null = null;

  /** Rolling session state — tracks decisions, open threads, mood across turns. */
  private _decisionLog: string | null = null;
  /** True while a decision log update is in flight. */
  private _updatingLog = false;
  /** Callback to update the decision log. Set via `onUpdateDecisionLog`. */
  private _logUpdater: ((currentLog: string | null, lastUser: string, lastAssistant: string) => Promise<string>) | null = null;

  push(msg: BufferMessage): void {
    const last = this.messages[this.messages.length - 1];
    if (last) {
      const gapHours =
        (new Date(msg.timestamp).getTime() - new Date(last.timestamp).getTime()) /
        (1000 * 60 * 60);
      if (gapHours > SESSION_GAP_HOURS) {
        this.messages = [];
        this._sessionSummary = null;
        this._pendingFold = [];
        this._foldedCount = 0;
        this._decisionLog = null;
      }
    }
    this.messages.push(msg);

    // Hard-evict oldest messages when buffer exceeds capacity (keeps memory bounded).
    // These messages should already be folded into the summary by this point,
    // since fold triggers at INJECTION_CAP (12) which is hit before BUFFER_SIZE (20).
    while (this.messages.length > BUFFER_SIZE) {
      this.messages.shift();
      if (this._foldedCount > 0) this._foldedCount--;
    }

    // Queue un-folded messages outside the injection window for summary folding.
    // Injection window = last INJECTION_CAP messages; everything before that
    // should be covered by the rolling summary.
    const injectionStart = Math.max(0, this.messages.length - INJECTION_CAP);
    if (injectionStart > this._foldedCount) {
      const toFold = this.messages.slice(this._foldedCount, injectionStart);
      this._pendingFold.push(...toFold);
      this._foldedCount = injectionStart;
    }

    if (this._pendingFold.length > 0 && this._summarizer && !this._summarizing) {
      this._foldIntoSummary();
    }
  }

  /** Returns the last N messages (full buffer — used for extraction). */
  getRecent(n = BUFFER_SIZE): BufferMessage[] {
    return this.messages.slice(-n);
  }

  /**
   * Returns messages for prompt injection: at most INJECTION_CAP messages.
   * Older messages are covered by the rolling sessionSummary.
   */
  getForPrompt(): BufferMessage[] {
    return this.messages.slice(-INJECTION_CAP);
  }

  /** Rolling summary of all conversation before the injection window. Null at start. */
  get sessionSummary(): string | null {
    return this._sessionSummary;
  }

  /**
   * Register the summary function.
   * Receives (existingSummary, newMessages) so it can fold new
   * messages into the running summary rather than regenerating from scratch.
   */
  onNeedsSummary(fn: (existing: string | null, evicted: BufferMessage[]) => Promise<string>): void {
    this._summarizer = fn;
  }

  /** Rolling session state log — tracks decisions, open threads, mood. Null if no turns yet. */
  get decisionLog(): string | null {
    return this._decisionLog;
  }

  /** Register the async function that updates the decision log after each turn. */
  onUpdateDecisionLog(fn: (currentLog: string | null, lastUser: string, lastAssistant: string) => Promise<string>): void {
    this._logUpdater = fn;
  }

  /**
   * Called after Alfred sends a reply. Fires the decision log updater asynchronously
   * so it's ready before the next user message arrives.
   */
  updateDecisionLog(lastUser: string, lastAssistant: string): void {
    if (!this._logUpdater || this._updatingLog) return;
    this._updatingLog = true;
    this._logUpdater(this._decisionLog, lastUser, lastAssistant)
      .then((log) => {
        this._decisionLog = log;
        console.log(`[buffer] decision log updated (${log.length} chars)`);
      })
      .catch((err) => {
        console.error("[buffer] decision log update failed:", err);
      })
      .finally(() => {
        this._updatingLog = false;
      });
  }

  seed(msgs: BufferMessage[]): void {
    this.messages = msgs.slice(-BUFFER_SIZE);
    this._sessionSummary = null;
    this._pendingFold = [];
    this._foldedCount = 0;
    this._decisionLog = null;
  }

  /** Exposed for testing — returns the injection cap constant. */
  static get INJECTION_CAP(): number {
    return INJECTION_CAP;
  }

  private _foldIntoSummary(): void {
    const batch = this._pendingFold.splice(0);
    if (batch.length === 0) return;
    this._summarizing = true;
    this._summarizer!(this._sessionSummary, batch)
      .then((summary) => {
        this._sessionSummary = summary;
        console.log(`[buffer] summary updated — folded ${batch.length} msg(s) (${summary.length} chars)`);

        // If more messages queued while we were summarizing, fold those too
        if (this._pendingFold.length > 0) {
          this._foldIntoSummary();
        }
      })
      .catch((err) => {
        console.error("[buffer] summary fold failed:", err);
        // Put them back so we can retry next time
        this._pendingFold.unshift(...batch);
      })
      .finally(() => {
        this._summarizing = false;
      });
  }
}
