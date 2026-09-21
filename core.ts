export const STATE_ENTRY_TYPE = "pi-recap/state";
export const MAX_RECAP_CHARS = 1200;

export type RecapSource = "automatic" | "manual";

export interface RecapSnapshot {
  version: 1;
  anchorEntryId: string;
  text: string;
  generatedAt: number;
  source: RecapSource;
  dismissed: boolean;
}

export interface MessageLike {
  role?: string;
  content?: unknown;
  timestamp?: number;
  stopReason?: string;
}

export interface SessionEntryLike {
  type?: string;
  id?: string;
  timestamp?: string | number;
  customType?: string;
  data?: unknown;
  message?: MessageLike;
  summary?: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
}

export interface CompletedTurn {
  entryId: string;
  timestamp: number;
  message: MessageLike;
}

const COMPLETED_STOP_REASONS = new Set(["stop", "length"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageTimestamp(entry: SessionEntryLike, message: MessageLike): number {
  if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) return message.timestamp;
  if (typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)) return entry.timestamp;
  if (typeof entry.timestamp === "string") {
    const parsed = Date.parse(entry.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function branchMessages(entries: readonly SessionEntryLike[]): Array<{ entryId: string; timestamp: number; message: MessageLike }> {
  const result: Array<{ entryId: string; timestamp: number; message: MessageLike }> = [];
  for (const entry of entries) {
    if (entry.type === "message" && entry.message && typeof entry.id === "string") {
      result.push({ entryId: entry.id, timestamp: messageTimestamp(entry, entry.message), message: entry.message });
    }
  }
  return result;
}

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (!isRecord(block)) return "";
      if (block.type === "text" && typeof block.text === "string") return block.text;
      if ((block.type === "toolCall" || block.type === "tool-call") && typeof block.name === "string") {
        return `[tool: ${block.name}]`;
      }
      if ((block.type === "toolResult" || block.type === "tool-result") && "content" in block) {
        return contentText(block.content);
      }
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

/** Convert Pi's compaction-aware entry list into recap-readable messages. */
export function conversationMessages(entries: readonly SessionEntryLike[]): MessageLike[] {
  const messages: MessageLike[] = [];
  // Real conversation only. Checkpoints travel in their own frame field so a
  // compaction summary can never be mistaken for something the human typed.
  for (const entry of entries) {
    if (entry.type === "message" && entry.message) messages.push(entry.message);
  }
  return messages;
}

/** The newest usable compaction or branch checkpoint, kept out of the user-role samples. */
export function historyCheckpoint(entries: readonly SessionEntryLike[]): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "compaction" && entry?.type !== "branch_summary") continue;
    const summary = typeof entry.summary === "string" ? stripThink(entry.summary).replace(/\s+/g, " ").trim() : "";
    if (summary) return summary;
  }
  return "";
}

/**
 * Sentence endings that leave a clause readable on its own. Commas and colons
 * deliberately do not qualify: a card that stops after "，" is a bug, not a summary.
 */
function lastSentenceEnd(text: string): number {
  let end = -1;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if ("。！？；".includes(char)) {
      end = index + 1;
      continue;
    }
    if (".!?;".includes(char) && (index === text.length - 1 || /\s/.test(text[index + 1]!))) end = index + 1;
  }
  return end;
}

/** Drop a trailing fragment so the text always ends on a finished sentence. */
export function trimToSentence(text: string): string {
  const end = lastSentenceEnd(text);
  return end < 0 ? text : text.slice(0, end).trimEnd();
}

/** The same rule with no salvage: without one finished sentence there is nothing to show. */
export function completeSentences(text: string): string | undefined {
  if (lastSentenceEnd(text) < 0) return undefined;
  return trimToSentence(text);
}

/**
 * Some chat-completions endpoints emit chain-of-thought inline in the text channel
 * instead of using a separate thinking block. That prose is never recap content, so it
 * is removed before the answer reaches the card. The tag names are matched in parts
 * because agent tool-call payloads strip the literal token.
 */
export function stripThink(text: string): string {
  const open = "<\\s*(?:think(?:ing)?|thought|reasoning)\\s*>";
  const close = "<\\s*/\\s*(?:think(?:ing)?|thought|reasoning)\\s*>";
  return text
    .replace(new RegExp(`${open}[\\s\\S]*?${close}`, "gi"), "")
    .replace(new RegExp(`${open}[\\s\\S]*$`, "i"), "");
}

/** Newest non-empty user messages, oldest first. Used only as language samples. */
export function languageSamples(messages: readonly MessageLike[], limit = 3): string[] {
  const samples: string[] = [];
  for (let index = messages.length - 1; index >= 0 && samples.length < limit; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "user") continue;
    const text = stripThink(contentText(message.content)).trim();
    if (text) samples.push(text);
  }
  return samples.reverse();
}

export function shortenText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 24) return text.slice(0, Math.max(0, maxChars));
  const marker = " … [truncated] … ";
  const available = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(available * 0.65);
  const tail = Math.max(0, available - head);
  return `${text.slice(0, head)}${marker}${text.slice(-tail)}`.slice(0, maxChars);
}

export function frameTranscript(
  messages: readonly MessageLike[],
  historySummary: string,
  recentMessages: number,
  maxBytes: number,
): string {
  const count = Math.max(1, Math.floor(recentMessages));
  // Pi stores every tool result as its own message holding raw command output.
  // Left in, `recentMessages` counts entries instead of conversation and tool
  // noise eats the whole byte budget, so drop them before windowing.
  const conversation = messages.filter((message) => message.role !== "toolResult");
  const start = Math.max(0, conversation.length - count);
  const selected = conversation.slice(start);
  // Anchor on the newest user request, not the session opening: sessions drift
  // across tasks, and by the time the first request falls out of the window it
  // describes work that is long finished.
  let anchorIndex = -1;
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    if (conversation[index]?.role === "user") {
      anchorIndex = index;
      break;
    }
  }
  const plain = (value: string) => stripThink(value).replace(/\s+/g, " ").trim();
  const anchor = anchorIndex < 0 ? "" : plain(contentText(conversation[anchorIndex]?.content));
  const recent = selected
    .map((message) => ({
      role: typeof message.role === "string" ? message.role : "unknown",
      text: plain(contentText(message.content)),
    }))
    .filter((entry) => entry.text.length > 0);
  const frame: { historySummary: string; goal: string; recent: Array<{ role: string; text: string }> } = {
    historySummary: plain(historySummary),
    goal: anchorIndex >= start ? "" : anchor,
    recent,
  };
  const values: Array<{ get(): string; set(value: string): void }> = [
    { get: () => frame.historySummary, set: (value) => { frame.historySummary = value; } },
    { get: () => frame.goal, set: (value) => { frame.goal = value; } },
    ...recent.map((entry) => ({ get: () => entry.text, set: (value: string) => { entry.text = value; } })),
  ];
  const stringify = () => JSON.stringify(frame);
  let json = stringify();
  const byteLimit = Math.max(0, Math.floor(maxBytes));
  while (Buffer.byteLength(json, "utf8") > byteLimit) {
    let longestIndex = -1;
    for (let index = 0; index < values.length; index += 1) {
      if (longestIndex < 0 || values[index]!.get().length > values[longestIndex]!.get().length) longestIndex = index;
    }
    if (longestIndex < 0) break;
    const longest = values[longestIndex]!;
    const current = longest.get();
    if (current.length === 0) break;
    const reduced = Math.max(0, Math.min(current.length - 1, Math.floor(current.length * 0.75)));
    longest.set(shortenText(current, reduced));
    json = stringify();
  }
  if (Buffer.byteLength(json, "utf8") <= byteLimit) return json;
  const empty = JSON.stringify({ historySummary: "", goal: "", recent: [] });
  return Buffer.byteLength(empty, "utf8") <= byteLimit ? empty : "";
}

/** True when the frame still carries something a recap can be written from. */
export function framedTranscriptHasContent(framed: string): boolean {
  if (!framed) return false;
  try {
    const value = JSON.parse(framed) as Partial<{ historySummary: string; goal: string; recent: unknown[] }>;
    return (value.historySummary ?? "") !== ""
      || (value.goal ?? "") !== ""
      || (Array.isArray(value.recent) && value.recent.length > 0);
  } catch {
    return false;
  }
}

export function completedTurnCount(entries: readonly SessionEntryLike[]): number {
  return branchMessages(entries).filter(
    ({ message }) => message.role === "assistant" && COMPLETED_STOP_REASONS.has(message.stopReason ?? ""),
  ).length;
}

export function findLatestCompletedTurn(entries: readonly SessionEntryLike[]): CompletedTurn | undefined {
  const messages = branchMessages(entries);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index]!;
    if (candidate.message.role === "assistant" && COMPLETED_STOP_REASONS.has(candidate.message.stopReason ?? "")) {
      return candidate;
    }
  }
  return undefined;
}

export function hasOpenTurn(entries: readonly SessionEntryLike[]): boolean {
  const messages = branchMessages(entries);
  const last = messages.at(-1);
  if (!last) return false;
  return !(last.message.role === "assistant" && COMPLETED_STOP_REASONS.has(last.message.stopReason ?? ""));
}

export function normalizeRecapState(raw: unknown, maxChars = MAX_RECAP_CHARS): RecapSnapshot | undefined {
  if (!isRecord(raw)) return undefined;
  const value = isRecord(raw.snapshot) ? raw.snapshot : raw;
  if (
    value.version !== 1 ||
    typeof value.anchorEntryId !== "string" ||
    value.anchorEntryId.length === 0 ||
    typeof value.text !== "string" ||
    value.text.trim().length === 0 ||
    value.text.length > maxChars ||
    typeof value.generatedAt !== "number" ||
    !Number.isFinite(value.generatedAt) ||
    (value.source !== "automatic" && value.source !== "manual") ||
    typeof value.dismissed !== "boolean"
  ) return undefined;
  return {
    version: 1,
    anchorEntryId: value.anchorEntryId,
    text: value.text,
    generatedAt: value.generatedAt,
    source: value.source,
    dismissed: value.dismissed,
  };
}

export function loadRecapState(entries: readonly SessionEntryLike[], maxChars = MAX_RECAP_CHARS): RecapSnapshot | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
    const snapshot = normalizeRecapState(entry.data, maxChars);
    if (snapshot) return snapshot;
  }
  return undefined;
}

export function isSnapshotCurrent(snapshot: RecapSnapshot | undefined, entries: readonly SessionEntryLike[]): boolean {
  if (!snapshot || snapshot.dismissed) return false;
  const latest = findLatestCompletedTurn(entries);
  return latest !== undefined && latest.entryId === snapshot.anchorEntryId && !hasOpenTurn(entries);
}

export function hasSnapshotForAnchor(snapshot: RecapSnapshot | undefined, anchorEntryId: string): boolean {
  return snapshot?.anchorEntryId === anchorEntryId;
}

export function formatRecapLine(text: string): string {
  return `↩ recap: ${text.replace(/\s+/g, " ").trim()}`;
}

export function formatStatusLine(enabled: boolean, mode: string, error?: string): string {
  return `recap ${enabled ? "on" : "off"} · ${mode}${error ? ` · failed: ${error}` : ""}`;
}

/** Prefix a user-facing message once, never twice. */
export function withRecapPrefix(message: string): string {
  return message.startsWith("pi-recap:") ? message : `pi-recap: ${message}`;
}

export function isCompletedAssistant(message: MessageLike | undefined): boolean {
  return message?.role === "assistant" && COMPLETED_STOP_REASONS.has(message.stopReason ?? "");
}
