import { initWasm, Resvg } from "@resvg/resvg-wasm";
import wasm from "@resvg/resvg-wasm/index_bg.wasm";
import type { DiscordUpload } from "./api";
import advances from "./fonts/advances.json";
import font from "./fonts/discord-table-sans.otf";
import type { AnswerTable } from "./tables";

const MIN_WIDTH = 336;
const MIN_COLUMN_WIDTH = 64;
const MAX_COLUMN_WIDTH = 224;
const MAX_IMAGE_HEIGHT = 4096;
// Discord fits an attachment into a box about 400px tall, so a taller page is shrunk until its
// text is unreadable in the preview. About 12 single-line rows keeps it near full size.
const PREVIEW_PAGE_HEIGHT = 520;
// Beyond this many readable pages the extra messages cost more than the zoom they save.
const MAX_PREVIEW_PAGES = 2;
const MAX_IMAGE_PIXELS = 3_000_000;
const SCALE = 2;
const DETAILED_SCALE = 3;
const FONT_SIZE = 14;
const LINE_HEIGHT = 21;
const PADDING = 10;
const PREVIEW_WIDTH = 320;
const MIN_PREVIEW_FONT_SIZE = 11;
const MAX_PREVIEW_TABLE_WIDTH = Math.floor((FONT_SIZE * PREVIEW_WIDTH) / MIN_PREVIEW_FONT_SIZE);
const words = new Intl.Segmenter("ja", { granularity: "word" });
const graphemes = new Intl.Segmenter();
const family = "Discord Table Sans";
const glyphWidths = new Map<number, number>();
let initialized: Promise<void> | undefined;

// The font has no emoji. Common status marks map to look-alikes it does have; anything else
// unsupported sends the table back to text rather than drawing tofu.
const LOOKALIKES: Record<string, string> = {
  "✅": "✓",
  "✔": "✓",
  "☑": "✓",
  "❌": "×",
  "✖": "×",
  "✕": "×",
  "✗": "×",
  "✘": "×",
  "☒": "×",
  "⭕": "○",
  "⬆": "↑",
  "⬇": "↓",
  "⬅": "←",
  "⭐": "★",
  "❤": "♥",
};

const LOOKALIKE_PATTERN = new RegExp(`[${Object.keys(LOOKALIKES).join("")}]`, "gu");

function drawable(cell: string): string {
  return cell
    .replace(/\u200B|\u200C|\u200D|\u2060|\uFE0E|\uFE0F/gu, "")
    .replace(LOOKALIKE_PATTERN, (char) => LOOKALIKES[char])
    .replace(/\s+/gu, " ")
    .trim()
    .normalize("NFC");
}

function glyphWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += glyphWidths.get(char.codePointAt(0) as number) ?? Infinity;
  }
  return (width * FONT_SIZE) / 1000;
}

function escapeXml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  let used = 0;
  const flush = () => {
    lines.push(line.trimEnd());
    line = "";
    used = 0;
  };
  for (const { segment } of words.segment(text)) {
    const measure = glyphWidth(segment);
    if (line && used + measure > width) flush();
    if (!line && !segment.trim()) continue;
    if (measure <= width) {
      line += segment;
      used += measure;
      continue;
    }
    for (const part of graphemes.segment(segment)) {
      const size = glyphWidth(part.segment);
      if (line && used + size > width) flush();
      line += part.segment;
      used += size;
    }
  }
  if (line || !lines.length) flush();
  return lines;
}

function columnWidths(rows: string[][], count: number): number[] {
  const widths = Array.from({ length: count }, (_, column) => {
    const content = Math.max(...rows.map((row) => Math.ceil(glyphWidth(row[column] ?? ""))));
    return Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, content + PADDING * 2 + 2));
  });
  const total = widths.reduce((sum, width) => sum + width, 0);
  const minimum = count * MIN_COLUMN_WIDTH;
  if (minimum <= MAX_PREVIEW_TABLE_WIDTH && total > MAX_PREVIEW_TABLE_WIDTH) {
    // Keep narrow columns usable while long cells wrap instead of shrinking the preview text.
    const ratio = (MAX_PREVIEW_TABLE_WIDTH - minimum) / (total - minimum);
    return widths.map((width) => MIN_COLUMN_WIDTH + Math.floor((width - MIN_COLUMN_WIDTH) * ratio));
  }
  widths[0] += Math.max(0, MIN_WIDTH - total);
  return widths;
}

function tableSvg(
  rows: string[][],
  widths: number[],
  align: AnswerTable["align"],
  limit: number,
  pageHeight: number,
): { svg: string; height: number }[] | null {
  const positions = [0];
  for (const width of widths) positions.push(positions[positions.length - 1] + width);
  const tableWidth = positions[positions.length - 1];
  // Shorten pages as tables get wider so the RGBA allocation stays bounded at 2× resolution.
  const maxHeight = Math.floor(
    Math.min(pageHeight, MAX_IMAGE_HEIGHT / SCALE, MAX_IMAGE_PIXELS / (tableWidth * SCALE ** 2)),
  );
  if (maxHeight < LINE_HEIGHT + PADDING * 2) return null;
  const data = rows.slice(1);
  const anchors = widths.map((_, i) => {
    const populated = data.map((row) => row[i]).filter(Boolean);
    const numeric =
      populated.length > 0 && populated.every((value) => /^[¥￥$€£+−-]?\s*\d/u.test(value));
    if (align[i] === "center") return "middle";
    if (align[i] === "right" || (align[i] !== "left" && numeric)) return "end";
    return "start";
  });
  const wrapped = rows.map((row) =>
    widths.map((width, i) => wrap(row[i] ?? "", width - PADDING * 2 - 2)),
  );
  const heights = wrapped.map(
    (row) => Math.max(...row.map((cell) => cell.length)) * LINE_HEIGHT + PADDING * 2,
  );

  function rowSvg(index: number, y: number): string {
    const cells = wrapped[index].map((cell, column) => {
      const anchor = anchors[column];
      const start = positions[column];
      const width = widths[column];
      const x =
        anchor === "middle"
          ? start + width / 2
          : anchor === "end"
            ? start + width - PADDING
            : start + PADDING;
      return cell
        .map(
          (text, line) =>
            `<text x="${x}" y="${y + PADDING + FONT_SIZE + line * LINE_HEIGHT}" text-anchor="${anchor}" xml:space="preserve">${escapeXml(text)}</text>`,
        )
        .join("");
    });
    const rule = index > 0 ? `<path d="M0 ${y}H${tableWidth}" stroke="#36393f"/>` : "";
    return rule + cells.join("");
  }

  if (heights[0] > maxHeight) return null;
  const header = rowSvg(0, 0);
  const pages: { svg: string; height: number }[] = [];
  let height = heights[0];
  let content = header;
  const finishPage = () => {
    pages.push({
      svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${tableWidth}" height="${height}" viewBox="0 0 ${tableWidth} ${height}"><rect width="${tableWidth}" height="${height}" fill="#202225"/><rect width="${tableWidth}" height="${heights[0]}" fill="#2b2d31"/><g font-family="${family}" font-size="${FONT_SIZE}" fill="#f2f3f5">${content}</g></svg>`,
      height,
    });
  };
  for (let index = 1; index < rows.length; index++) {
    if (heights[0] + heights[index] > maxHeight) return null;
    if (height + heights[index] > maxHeight) {
      finishPage();
      if (pages.length >= limit) return null;
      height = heights[0];
      content = header;
    }
    content += rowSvg(index, height);
    height += heights[index];
  }
  finishPage();
  return pages;
}

function csv(rows: string[][], count: number): string {
  function field(input: string): string {
    // Quoting alone doesn't prevent spreadsheet apps from evaluating a formula.
    const formula =
      /^[\s\uFEFF]*[=+@\-＝＋＠－]/u.test(input) && !/^[+-]?\d+(?:\.\d+)?$/u.test(input);
    const value = formula ? `'${input}` : input;
    return `"${value.replaceAll('"', '""')}"`;
  }
  return `\uFEFF${rows.map((row) => Array.from({ length: count }, (_, i) => field(row[i] ?? "")).join(",")).join("\r\n")}\r\n`;
}

/**
 * `tall` allows pages up to the render limit. Pages are otherwise kept short enough to read in
 * the preview, which costs a message per page; `tall` is the way back when that is too many.
 */
export async function presentTable(
  table: AnswerTable,
  number: number,
  pageLimit: number,
  tall = false,
): Promise<TablePresentation | null> {
  if (!glyphWidths.size) {
    for (const [width, chars] of Object.entries(advances)) {
      for (const char of chars) glyphWidths.set(char.codePointAt(0) as number, Number(width));
    }
  }
  const count = Math.max(...table.rows.map((row) => row.length));
  const rows = table.rows.map((row) => row.map(drawable));
  if (rows.some((row) => row.some((cell) => !Number.isFinite(glyphWidth(cell))))) return null;

  const [header, ...data] = rows;
  const headings = Array.from({ length: count }, (_, i) => header[i] ?? `列 ${i + 1}`);
  const imageRows = [headings, ...data];
  const widths = columnWidths(imageRows, count);
  const width = widths.reduce((sum, column) => sum + column, 0);
  const filename = `table-${number}`;
  const csvFile = () => ({
    filename: `${filename}.csv`,
    description: `表 ${number} のデータ`,
    data: new Blob([csv(table.exportRows, count)], { type: "text/csv; charset=utf-8" }),
  });
  if (width > MAX_PREVIEW_TABLE_WIDTH) {
    return { kind: "list", csv: csvFile() };
  }
  if (!pageLimit) return null;
  const drawings =
    (tall
      ? null
      : tableSvg(
          imageRows,
          widths,
          table.align,
          Math.min(pageLimit, MAX_PREVIEW_PAGES),
          PREVIEW_PAGE_HEIGHT,
        )) ?? tableSvg(imageRows, widths, table.align, pageLimit, Infinity);
  if (!drawings) return null;

  initialized ??= initWasm(wasm);
  await initialized;
  const detailed = drawings.every(
    ({ height }) =>
      height * DETAILED_SCALE <= MAX_IMAGE_HEIGHT &&
      width * height * DETAILED_SCALE ** 2 <= MAX_IMAGE_PIXELS,
  );
  const pages = drawings.map(({ svg }, index) => {
    const renderer = new Resvg(svg, {
      font: { fontBuffers: [new Uint8Array(font)], defaultFontFamily: family },
      fitTo: { mode: "zoom", value: detailed ? DETAILED_SCALE : SCALE },
    });
    try {
      const image = renderer.render();
      try {
        return {
          filename: `${filename}${drawings.length > 1 ? `-${index + 1}` : ""}.png`,
          description: `表 ${number}${drawings.length > 1 ? `（${index + 1}/${drawings.length}）` : ""}。表データは回答末尾の ${filename}.csv を参照。`,
          data: new Blob([image.asPng().slice()], { type: "image/png" }),
        };
      } finally {
        image.free();
      }
    } finally {
      renderer.free();
    }
  });
  return { kind: "image", pages, csv: csvFile() };
}

export type TablePresentation =
  | { kind: "image"; pages: DiscordUpload[]; csv: DiscordUpload }
  | { kind: "list"; csv: DiscordUpload };
