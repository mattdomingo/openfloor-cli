const MAX_ENTRIES = 100;

/** In-memory recall buffer for typed prompts and commands. Never persisted. */
export class HistoryBuffer {
  private entries: string[] = [];
  private cursor = -1;
  private draft = "";

  push(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this.entries[this.entries.length - 1] === trimmed) { this.reset(); return; }
    this.entries.push(trimmed);
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
    this.reset();
  }

  /** Recall the previous (older) entry. `current` is saved as the draft on first call. */
  previous(current: string): string | null {
    if (!this.entries.length) return null;
    if (this.cursor === -1) { this.draft = current; this.cursor = this.entries.length - 1; return this.entries[this.cursor]!; }
    if (this.cursor === 0) return this.entries[0]!;
    this.cursor -= 1;
    return this.entries[this.cursor]!;
  }

  /** Recall the next (newer) entry, or the saved draft once the newest entry is passed. */
  next(): string | null {
    if (this.cursor === -1) return null;
    if (this.cursor >= this.entries.length - 1) { const draft = this.draft; this.reset(); return draft; }
    this.cursor += 1;
    return this.entries[this.cursor]!;
  }

  reset(): void {
    this.cursor = -1;
    this.draft = "";
  }
}
