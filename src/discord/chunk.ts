import { DISCORD_CHUNK_LIMIT, DISCORD_MESSAGE_LIMIT } from "../shared/constants";
import type { DiscordUpload } from "./api";
import type { TablePresentation } from "./table-image";
import { type AnswerTable, parseTables, renderTextTable } from "./tables";

/** Room left after the footer for the confirmed cost appended to it later. */
const FOOTER_RESERVE = 40;

/**
 * Split an answer into Discord-sized messages, breaking at a newline when one falls in the
 * second half of the window. `footer` is never split: it ends the last message, or gets one
 * of its own when it would not fit — otherwise a cut through it shows a stray fragment and
 * loses its small-text formatting.
 *
 * Slices by code point rather than UTF-16 unit so a surrogate pair (emoji, rarer kanji)
 * never lands across a chunk boundary and turns into a pair of replacement characters.
 */
export function chunkText(full: string, footer?: string): string[] {
  const points = Array.from(full);
  const chunks: string[] = [];
  let start = 0;
  while (start < points.length) {
    let end = Math.min(start + DISCORD_CHUNK_LIMIT, points.length);
    if (end < points.length) {
      const newline = points.lastIndexOf("\n", end - 1);
      if (newline >= start + DISCORD_CHUNK_LIMIT / 2) end = newline + 1;
    }
    chunks.push(points.slice(start, end).join(""));
    start = end;
  }
  if (!chunks.length) chunks.push("");
  return appendFooter(chunks, footer);
}

export interface AnswerChunk {
  content: string;
  files?: DiscordUpload[];
}

export function chunkAnswer(
  header: string,
  body: string,
  footer?: string,
  tables = parseTables(body),
  presentations?: Map<AnswerTable, TablePresentation>,
): AnswerChunk[] {
  if (!tables.length) return chunkText(header + body, footer).map((content) => ({ content }));

  const chunks: AnswerChunk[] = [];
  function append(part: string, files?: DiscordUpload[]): void {
    if (!part.trim()) return;
    const last = chunks.at(-1);
    if (last && !last.files) {
      const joined = `${last.content}\n\n${part}`;
      if (Array.from(joined).length <= DISCORD_CHUNK_LIMIT) {
        last.content = joined;
        last.files = files;
        return;
      }
    }
    chunks.push({ content: part, files });
  }

  let start = 0;
  for (const [index, table] of tables.entries()) {
    const before = (start === 0 ? header : "") + body.slice(start, table.start);
    for (const part of chunkText(before.trimEnd())) append(part);
    const presentation = presentations?.get(table);
    if (presentation?.kind === "image") {
      for (const [page, image] of presentation.pages.entries()) {
        const part =
          presentation.pages.length > 1 ? `（${page + 1}/${presentation.pages.length}）` : "";
        append(`**表 ${index + 1}${part}**`, [image]);
      }
    } else {
      if (presentation?.kind === "list") append(`**表 ${index + 1}**`);
      else if (presentations) append(`-# 表 ${index + 1} はテキストで表示しています。`);
      for (const page of renderTextTable(table, presentation?.kind === "list")) {
        for (const part of chunkText(page)) append(part);
      }
    }
    start = table.end;
  }
  for (const part of chunkText(body.slice(start).replace(/^(?:\r?\n)+/, ""))) append(part);
  if (footer !== undefined) {
    const last = chunks[chunks.length - 1];
    const joined = last.files ? null : footerContent(last.content, footer);
    if (joined === null) chunks.push({ content: footer });
    else last.content = joined;
  }
  return chunks;
}

function appendFooter(chunks: string[], footer?: string): string[] {
  if (footer === undefined) return chunks;
  const last = chunks.length - 1;
  const joined = footerContent(chunks[last], footer);
  if (joined === null) chunks.push(footer);
  else chunks[last] = joined;
  return chunks;
}

function footerContent(content: string, footer: string): string | null {
  const joined = `${content}\n\n${footer}`;
  return Array.from(joined).length + FOOTER_RESERVE <= DISCORD_MESSAGE_LIMIT ? joined : null;
}
