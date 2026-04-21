export interface BufferMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

const BUFFER_SIZE = 20;
const SESSION_GAP_HOURS = 4;

export class ConversationBuffer {
  private messages: BufferMessage[] = [];

  push(msg: BufferMessage): void {
    const last = this.messages[this.messages.length - 1];
    if (last) {
      const gapHours =
        (new Date(msg.timestamp).getTime() - new Date(last.timestamp).getTime()) /
        (1000 * 60 * 60);
      if (gapHours > SESSION_GAP_HOURS) {
        this.messages = [];
      }
    }
    this.messages.push(msg);
    if (this.messages.length > BUFFER_SIZE) {
      this.messages.shift();
    }
  }

  getRecent(n = BUFFER_SIZE): BufferMessage[] {
    return this.messages.slice(-n);
  }

  seed(msgs: BufferMessage[]): void {
    this.messages = msgs.slice(-BUFFER_SIZE);
  }
}
