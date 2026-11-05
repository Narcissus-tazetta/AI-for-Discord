import {
  HISTORY_DEPTH,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_TOTAL_ATTACHMENT_BYTES,
  MSG_CONTINUATION_ANCHOR,
  PDF_TYPE,
  SUPPORTED_IMAGE_TYPES,
} from "../shared/constants";
import type {
  AnthropicMessage,
  ContentBlock,
  DiscordAttachment,
  DiscordMessage,
} from "../shared/types";
import type { DiscordClient } from "./api";

/** How many of the most recent user turns send their files to the model. */
const ATTACHMENT_TURNS = 2;

export function textBlock(text: string): ContentBlock {
  return { type: "text", text };
}

export interface AttachmentBudget {
  count: number;
  bytes: number;
}

export function newBudget(): AttachmentBudget {
  return { count: 0, bytes: 0 };
}

function mediaType(att: DiscordAttachment): string {
  return (att.content_type ?? "").split(";")[0].trim().toLowerCase();
}

export function isSupportedAttachment(att: DiscordAttachment): boolean {
  const type = mediaType(att);
  return (SUPPORTED_IMAGE_TYPES.has(type) || type === PDF_TYPE) && att.size <= MAX_ATTACHMENT_BYTES;
}

/**
 * Turn supported attachments into image/document content blocks.
 *
 * Store URLs rather than attachment bytes in history. Gateway forwards image URLs;
 * the JobDO converts bounded PDFs to base64 immediately before inference.
 *
 * `budget` is shared across the whole reply chain so one image-heavy thread can't blow past
 * the API's request ceiling.
 */
export function attachmentBlocks(
  attachments: DiscordAttachment[],
  budget: AttachmentBudget,
): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const att of attachments) {
    if (budget.count >= MAX_ATTACHMENTS || budget.bytes >= MAX_TOTAL_ATTACHMENT_BYTES) break;
    const type = mediaType(att);
    if (!SUPPORTED_IMAGE_TYPES.has(type) && type !== PDF_TYPE) continue;
    if (att.size > MAX_ATTACHMENT_BYTES || budget.bytes + att.size > MAX_TOTAL_ATTACHMENT_BYTES) {
      console.log(`skipping oversized attachment ${att.filename} (${att.size} bytes)`);
      continue;
    }

    budget.count += 1;
    budget.bytes += att.size;
    const source = { type: "url", url: att.url };
    // Label each file so the prompt can refer to it by name, and put the file before
    // the message text — Claude performs best with images ahead of the question.
    blocks.push(textBlock(`[添付: ${att.filename}]`));
    blocks.push({ type: type === PDF_TYPE ? "document" : "image", source });
  }
  return blocks;
}

/** Merge consecutive same-role turns so the sequence stays strictly alternating (Anthropic API requirement). */
export function normalizeTurns(turns: AnthropicMessage[]): AnthropicMessage[] {
  const merged: AnthropicMessage[] = [];
  for (const turn of turns) {
    const last = merged[merged.length - 1];
    if (last && last.role === turn.role) {
      last.content = [...last.content, ...turn.content];
    } else {
      merged.push({ role: turn.role, content: [...turn.content] });
    }
  }
  return merged;
}

export function parseBotAnswer(content: string): { prompt: string; answer: string } | null {
  const normalized = content.replace(/\r\n/g, "\n");
  const trimmed = normalized.trim();
  const match = trimmed.match(/^\*\*Q:\*\*\s*([\s\S]*?)\n\n\*\*A:\*\*[ \t]*\n([\s\S]*)$/);
  if (!match) return null;
  const prompt = match[1].trim();
  const rawAnswer = match[2];
  const answer = rawAnswer
    .trimEnd()
    .replace(/(?:(?:\n\n?|^)-#[^\n]*)+$/, "")
    .trim();
  if (!prompt || !answer) return null;
  return { prompt, answer };
}

function decodeFilename(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch (err) {
    if (!(err instanceof URIError)) throw err;
    // A literal "%" in a filename is not valid percent-encoding; show the name as-is.
    return raw;
  }
}

function degenerateAttachments(content: ContentBlock[]): ContentBlock[] {
  const result: ContentBlock[] = [];
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (block.type === "text" && typeof block.text === "string") {
      const match = block.text.match(/^\[添付: (.+)\]$/);
      if (match && !block.text.includes("（以前のメッセージのため省略）")) {
        const next = content[i + 1];
        if (next && (next.type === "image" || next.type === "document")) {
          result.push(textBlock(`[添付: ${match[1]}（以前のメッセージのため省略）]`));
          i++;
          continue;
        }
      }
    }
    if (block.type === "image" || block.type === "document") {
      const url = block.source?.url;
      // The URL was written by attachmentBlocks from a Discord attachment, so it is always absolute.
      const filename =
        typeof url === "string"
          ? decodeFilename(new URL(url).pathname.split("/").pop() || "ファイル")
          : "ファイル";
      result.push(textBlock(`[添付: ${filename}（以前のメッセージのため省略）]`));
      continue;
    }
    result.push(block);
  }
  return result;
}

export function pruneConversationHistory(messages: AnthropicMessage[]): AnthropicMessage[] {
  let pruned = normalizeTurns(messages);
  while (pruned.length > 0 && pruned[0].role !== "user") {
    pruned = pruned.slice(1);
  }
  while (pruned.length > HISTORY_DEPTH) {
    if (pruned[0]?.role === "user" && pruned[1]?.role === "assistant") {
      pruned = pruned.slice(2);
    } else {
      pruned = pruned.slice(1);
    }
    while (pruned.length > 0 && pruned[0].role !== "user") {
      pruned = pruned.slice(1);
    }
  }

  const userIndices: number[] = [];
  for (let i = 0; i < pruned.length; i++) {
    if (pruned[i].role === "user") {
      userIndices.push(i);
    }
  }
  const keepIndices = new Set(userIndices.slice(-ATTACHMENT_TURNS));

  return pruned.map((turn, idx) => {
    if (turn.role !== "user" || keepIndices.has(idx)) {
      return turn;
    }
    return {
      role: turn.role,
      content: degenerateAttachments(turn.content),
    };
  });
}

export async function buildHistoryFromMessage(
  startMessage: DiscordMessage,
  discord: DiscordClient,
  limit: number = HISTORY_DEPTH,
): Promise<AnthropicMessage[]> {
  const appId = discord.appId;
  let turns: AnthropicMessage[] = [];
  const budget = newBudget();
  let curr: DiscordMessage | null = startMessage;
  let userTurns = 0;
  let pendingBotUserTurn: AnthropicMessage | null = null;

  for (let i = 0; i < limit; i++) {
    if (curr === null) break;
    // A bot's user id and its application id are the same value.
    const isBot = curr.author?.id === appId;
    const text = (curr.content ?? "").split(`<@${appId}>`).join("").trim();

    if (isBot) {
      pendingBotUserTurn = null;
      const parsed = parseBotAnswer(text);
      if (parsed) {
        const userTurn: AnthropicMessage = {
          role: "user",
          content: [textBlock(parsed.prompt)],
        };
        turns.unshift({ role: "assistant", content: [textBlock(parsed.answer)] });
        turns.unshift(userTurn);
        pendingBotUserTurn = userTurn;
      } else if (text) {
        turns.unshift({ role: "assistant", content: [textBlock(text)] });
      }
    } else {
      userTurns += 1;
      const atts =
        userTurns <= ATTACHMENT_TURNS
          ? attachmentBlocks(curr.attachments ?? [], budget)
          : (curr.attachments ?? [])
              .filter(isSupportedAttachment)
              .map((att) => textBlock(`[添付: ${att.filename}（以前のメッセージのため省略）]`));

      if (pendingBotUserTurn) {
        if (atts.length) {
          pendingBotUserTurn.content = [...atts, ...pendingBotUserTurn.content];
        }
        pendingBotUserTurn = null;
      } else {
        const content = [...atts];
        if (text) content.push(textBlock(text));
        if (content.length) turns.unshift({ role: "user", content });
      }
    }

    const refId = curr.message_reference?.message_id;
    const refChannel = curr.message_reference?.channel_id ?? curr.channel_id;
    if (refId && refChannel) {
      try {
        curr = await discord.fetchMessage(refChannel, refId);
      } catch (err) {
        // Common in guild channels where the app is user-installed only (no standing bot
        // presence, so history beyond the resolved message is unreachable).
        console.log(`history: stopping at ${refId}: ${err}`);
        break;
      }
    } else {
      break;
    }
  }

  turns = normalizeTurns(turns);
  if (turns.length && turns[0].role === "assistant") {
    // The Messages API requires the first turn to be `user`. Right-clicking one of
    // Claude's own replies (the primary flow) otherwise produces an assistant-first
    // array and a 400, so anchor it with a synthetic opener instead of dropping the
    // message the user actually pointed at.
    turns.unshift({ role: "user", content: [textBlock(MSG_CONTINUATION_ANCHOR)] });
  }
  return turns;
}
