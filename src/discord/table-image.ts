import { initWasm, Resvg } from "@resvg/resvg-wasm";
import wasm from "@resvg/resvg-wasm/index_bg.wasm";
import type { DiscordUpload } from "./api";
import advances from "./fonts/advances.json";
import font from "./fonts/discord-table-sans.otf";
import type { AnswerTable } from "./tables";

const MIN_WIDTH = 336;
const MIN_COLUMN_WIDTH = 64;
const MAX_COLUMN_WIDTH = 224;
const MAX_HEIGHT = 520;
const MAX_IMAGE_PIXELS = 3_000_000;
const SCALE = 2;
const FONT_SIZE = 14;
const LINE_HEIGHT = 21;
const PADDING = 10;
const PREVIEW_WIDTH = 320;
const MIN_PREVIEW_FONT_SIZE = 11;
const words = new Intl.Segmenter("ja", { granularity: "word" });
const graphemes = new Intl.Segmenter();
const family = "Discord Table Sans";
const glyphWidths = new Map<number, number>();
let initialized: Promise<void> | undefined;

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
  widths[0] += Math.max(0, MIN_WIDTH - total);
  return widths;
}

function tableSvg(
  rows: string[][],
  widths: number[],
  align: AnswerTable["align"],
  limit: number,
): string[] | null {
  const positions = [0];
  for (const width of widths) positions.push(positions[positions.length - 1] + width);
  const tableWidth = positions[positions.length - 1];
  // Shorten pages as tables get wider so the RGBA allocation stays bounded at 2× resolution.
  const maxHeight = Math.min(MAX_HEIGHT, Math.floor(MAX_IMAGE_PIXELS / (tableWidth * SCALE ** 2)));
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
    const height = heights[index];
    const background = index === 0 ? "#252f59" : index % 2 === 1 ? "#141b2e" : "#1a233b";
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
      const color = index === 0 ? "#dce2ff" : "#f3f6ff";
      return cell
        .map(
          (text, line) =>
            `<text x="${x}" y="${y + PADDING + FONT_SIZE + line * LINE_HEIGHT}" text-anchor="${anchor}" fill="${color}" xml:space="preserve">${escapeXml(text)}</text>`,
        )
        .join("");
    });
    return `<rect y="${y}" width="${tableWidth}" height="${height}" fill="${background}"/>${cells.join("")}`;
  }

  if (heights[0] > maxHeight) return null;
  const header = rowSvg(0, 0);
  const pages: string[] = [];
  let height = heights[0];
  let content = header;
  const finishPage = () => {
    const rules = positions
      .slice(1, -1)
      .map((x) => `M${x} 0V${height}`)
      .join("");
    pages.push(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${tableWidth}" height="${height}" viewBox="0 0 ${tableWidth} ${height}"><defs><clipPath id="frame"><rect width="${tableWidth}" height="${height}" rx="10"/></clipPath></defs><g clip-path="url(#frame)" font-family="${family}" font-size="${FONT_SIZE}">${content}<path d="${rules}" fill="none" stroke="#435172" stroke-opacity="0.55"/></g></svg>`,
    );
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

export async function presentTable(
  table: AnswerTable,
  number: number,
  pageLimit: number,
): Promise<TablePresentation | null> {
  if (!glyphWidths.size) {
    for (const [width, chars] of Object.entries(advances)) {
      for (const char of chars) glyphWidths.set(char.codePointAt(0) as number, Number(width));
    }
  }
  const count = Math.max(...table.rows.map((row) => row.length));
  const rows = table.rows.map((row) =>
    row.map((cell) => cell.replace(/\s+/gu, " ").trim().normalize("NFC")),
  );
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
    data: new Blob([csv(table.rows, count)], { type: "text/csv; charset=utf-8" }),
  });
  if (FONT_SIZE * PREVIEW_WIDTH < MIN_PREVIEW_FONT_SIZE * width) {
    return { kind: "list", csv: csvFile() };
  }
  if (!pageLimit) return null;
  const drawings = tableSvg(imageRows, widths, table.align, pageLimit);
  if (!drawings) return null;

  initialized ??= initWasm(wasm);
  await initialized;
  const pages = drawings.map((drawing, index) => {
    const renderer = new Resvg(drawing, {
      font: { fontBuffers: [new Uint8Array(font)], defaultFontFamily: family },
      fitTo: { mode: "zoom", value: SCALE },
    });
    try {
      const image = renderer.render();
      try {
        const files = [
          {
            filename: `${filename}${drawings.length > 1 ? `-${index + 1}` : ""}.png`,
            description: `表 ${number}${drawings.length > 1 ? `（${index + 1}/${drawings.length}）` : ""}。表データは ${filename}.csv を参照。`,
            data: new Blob([image.asPng().slice()], { type: "image/png" }),
          },
        ];
        if (index === 0) files.push(csvFile());
        return files;
      } finally {
        image.free();
      }
    } finally {
      renderer.free();
    }
  });
  return { kind: "image", pages };
}

export type TablePresentation =
  | { kind: "image"; pages: DiscordUpload[][] }
  | { kind: "list"; csv: DiscordUpload };
