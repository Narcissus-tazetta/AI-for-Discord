import type { AlignType, Table, TableCell } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";
import stringWidth from "string-width";
import { DISCORD_CHUNK_LIMIT } from "../shared/constants";

const options = { extensions: [gfmTable()], mdastExtensions: [gfmTableFromMarkdown()] };
const OPEN = "```\n";
const CLOSE = "\n```";
const graphemes = new Intl.Segmenter();
// The preview at 375px leaves about 34 monospace columns after message and code padding.
const TABLE_LINE_WIDTH = 34;
const MAX_TEXT_HEADING_LINES = 2;
const MAX_TEXT_ROW_LINES = 4;

type Width = { narrow: number; wide: number };
type Cell = Width & { text: string };
type Column = Width & { minNarrow: number; minWide: number };

const lineWidth = ({ narrow, wide }: Width) => narrow + wide * 2;

function columnsFor(rows: Cell[][][]): Column[] {
  const columns: Column[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      columns[i] ??= { narrow: 0, wide: 0, minNarrow: 0, minWide: 0 };
      const column = columns[i];
      let narrow = 0;
      let wide = 0;
      for (const part of cell) {
        narrow += part.narrow;
        wide += part.wide;
        column.minNarrow = Math.max(column.minNarrow, part.narrow);
        column.minWide = Math.max(column.minWide, part.wide);
      }
      column.narrow = Math.max(column.narrow, narrow);
      column.wide = Math.max(column.wide, wide);
    });
  }
  return columns;
}

function fitColumns(columns: Column[], available: number): boolean {
  let total = columns.reduce((sum, column) => sum + lineWidth(column), 0);
  while (total > available) {
    let widest: Column | undefined;
    for (const column of columns) {
      const canShrink = column.narrow > column.minNarrow || column.wide > column.minWide;
      if (canShrink && (!widest || lineWidth(column) > lineWidth(widest))) widest = column;
    }
    if (!widest) return false;
    const spareWide = widest.wide - widest.minWide;
    const spareNarrow = widest.narrow - widest.minNarrow;
    if (spareWide * 2 > spareNarrow) {
      widest.wide--;
      total -= 2;
    } else {
      widest.narrow--;
      total--;
    }
  }
  return true;
}

function wrapCell(parts: Cell[], column: Width): Cell[] {
  const lines: Cell[] = [];
  let line: Cell = { text: "", narrow: 0, wide: 0 };
  for (const part of parts) {
    if (line.narrow + part.narrow > column.narrow || line.wide + part.wide > column.wide) {
      lines.push(line);
      line = { text: "", narrow: 0, wide: 0 };
    }
    line.text += part.text;
    line.narrow += part.narrow;
    line.wide += part.wide;
  }
  lines.push(line);
  return lines;
}

function sourceRange(node: Table | Table["children"][number] | TableCell["children"][number]) {
  // mdast also types generated nodes, but the parser always sets offsets on source nodes.
  const { start, end } = node.position as { start: { offset: number }; end: { offset: number } };
  return { start: start.offset, end: end.offset };
}

export interface TableLink {
  text: string;
  url: string;
}

// An image or text table can't carry a clickable link, so cells show the label and the
// destinations are listed under the table instead.
function cellText(
  node: TableCell["children"][number],
  source: string,
  links: TableLink[] | null,
  exported: boolean,
): string {
  const inner = (children: TableCell["children"]) =>
    children.map((child) => cellText(child, source, links, exported)).join("");
  switch (node.type) {
    case "text":
    case "inlineCode":
      return node.value;
    case "emphasis":
    case "strong":
      return inner(node.children);
    case "break":
      return "\n";
    case "html":
      // Models emit <br> to put several lines in one cell.
      return /^<br\s*\/?>$/i.test(node.value) ? "\n" : node.value;
    case "link":
    case "image": {
      const label = node.type === "link" ? inner(node.children) : node.alt || "";
      const text = label || node.url;
      if (exported) return text === node.url ? text : `${text} (${node.url})`;
      links?.push({ text, url: node.url });
      return text;
    }
    default: {
      const { start, end } = sourceRange(node);
      return source.slice(start, end);
    }
  }
}

export interface AnswerTable {
  start: number;
  end: number;
  /** Cell labels as shown in the table; links are reduced to their text. */
  rows: string[][];
  /** The same cells for a spreadsheet, where a link keeps its destination. */
  exportRows: string[][];
  links: TableLink[];
  align: AlignType[];
}

// Stays well under one Discord message so the line is never split inside a link.
const LINKS_LINE_LIMIT = 1200;

/** One line under a table naming the destinations its cells linked to. */
export function linksLine(links: TableLink[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  let length = 0;
  let omitted = 0;
  for (const { text, url } of links) {
    if (seen.has(url)) continue;
    seen.add(url);
    const label = text.replace(/[[\]\\]/g, "\\$&").replace(/\s+/g, " ");
    // encodeURIComponent leaves parentheses alone, which would end the link early.
    const target = url.replace(
      /[()\s<>]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
    );
    const part = `[${label}](${target})`;
    if (length + part.length > LINKS_LINE_LIMIT) {
      omitted++;
      continue;
    }
    parts.push(part);
    length += part.length + 3;
  }
  if (!parts.length) return "";
  return `-# リンク: ${parts.join(" ・ ")}${omitted ? ` ほか${omitted}件` : ""}`;
}

export function renderTextTable({ rows, align }: AnswerTable, asVerticalList = false): string[] {
  function formatCell(cell: Cell, column: Width, i: number): string {
    const narrow = column.narrow - cell.narrow;
    const wide = column.wide - cell.wide;
    const alignment = align[i];
    const leftNarrow =
      alignment === "right" ? narrow : alignment === "center" ? Math.floor(narrow / 2) : 0;
    const leftWide =
      alignment === "right" ? wide : alignment === "center" ? Math.floor(wide / 2) : 0;
    // Discord may render CJK using a fallback font whose glyphs aren't twice the Latin width.
    const left = " ".repeat(leftNarrow) + "\u3000".repeat(leftWide);
    const right = " ".repeat(narrow - leftNarrow) + "\u3000".repeat(wide - leftWide);
    return left + cell.text + right;
  }

  function asList(): string[] {
    const [headings, ...data] = rows.map((row) =>
      row.map((cell) =>
        cell
          .replace(/[\\`*_~|]/g, "\\$&")
          .replace(/[\r\n]+/g, " ")
          .trim(),
      ),
    );
    if (!data.length) return [headings.map((name) => `- ${name}`).join("\n")];
    return [
      data
        .map(([title, ...cells], index) =>
          [
            `**${headings[0] && title ? `${headings[0]}：` : ""}${title || `行 ${index + 1}`}**`,
            ...cells.map((cell, i) => `- ${headings[i + 1] || `列 ${i + 2}`}：${cell}`),
          ].join("\n"),
        )
        .join("\n\n"),
    ];
  }

  if (asVerticalList || rows.some((row) => row.some((cell) => /```|[\r\n]/.test(cell))))
    return asList();

  const measuredRows = rows.map((row) =>
    row.map((cell) =>
      Array.from(graphemes.segment(cell), ({ segment }) => {
        const width = stringWidth(segment);
        return { text: segment, narrow: width === 2 ? 0 : width, wide: width === 2 ? 1 : 0 };
      }),
    ),
  );
  const columns = columnsFor(measuredRows);
  const fullWidth =
    3 * columns.length + 1 + columns.reduce((sum, column) => sum + lineWidth(column), 0);
  const compact = fullWidth > TABLE_LINE_WIDTH;
  if (compact && !fitColumns(columns, TABLE_LINE_WIDTH - columns.length - 1)) return asList();

  const rules = columns.map(({ narrow, wide }) => "-".repeat(narrow) + "－".repeat(wide));
  const separator = compact ? `|${rules.join("+")}|` : `|-${rules.join("-+-")}-|`;
  const emptyCell = { text: "", narrow: 0, wide: 0 };
  const formattedRows = measuredRows.map((row) => {
    const cells = columns.map((column, i) => wrapCell(row[i] ?? [], column));
    const height = Math.max(...cells.map((cell) => cell.length));
    return Array.from({ length: height }, (_, line) => {
      const parts = cells.map((cell, i) => formatCell(cell[line] ?? emptyCell, columns[i], i));
      return compact ? `|${parts.join("|")}|` : `| ${parts.join(" | ")} |`;
    });
  });
  if (
    formattedRows[0].length > MAX_TEXT_HEADING_LINES ||
    formattedRows.some((row) => row.length > MAX_TEXT_ROW_LINES)
  )
    return asList();
  const separateRows = formattedRows.some((row) => row.length > 1);
  const header = `${OPEN}${formattedRows[0].join("\n")}\n${separator}`;
  const overhead = Array.from(header + CLOSE).length;
  if (overhead > DISCORD_CHUNK_LIMIT) return asList();

  const pages: string[] = [];
  let page = header;
  let length = overhead;
  // Every Discord message must carry its own fences, so split between rows and repeat the header.
  for (const row of formattedRows.slice(1)) {
    const line = `\n${row.join("\n")}${separateRows ? `\n${separator}` : ""}`;
    const size = Array.from(line).length;
    if (overhead + size > DISCORD_CHUNK_LIMIT) return asList();
    if (length + size > DISCORD_CHUNK_LIMIT) {
      pages.push(page + CLOSE);
      page = header;
      length = overhead;
    }
    page += line;
    length += size;
  }
  pages.push(page + CLOSE);
  return pages;
}

export function parseTables(source: string): AnswerTable[] {
  if (!source.includes("|") || !source.includes("\n")) return [];
  return fromMarkdown(source, options).children.flatMap((node) => {
    if (node.type !== "table") return [];
    const range = sourceRange(node);
    const trailingProse = node.children.findIndex((row, i) => {
      if (i === 0 || row.children.length > 1) return false;
      const { start, end } = sourceRange(row);
      return !/^\s*\||(?<!\\)\|\s*$/.test(source.slice(start, end));
    });
    // GFM allows table rows without pipes, so prose without a blank line would become a cell.
    const tableRows = trailingProse < 0 ? node.children : node.children.slice(0, trailingProse);
    const end = trailingProse < 0 ? range.end : sourceRange(node.children[trailingProse]).start;
    const links: TableLink[] = [];
    const cells = (exported: boolean) =>
      tableRows.map((row) =>
        row.children.map((cell) =>
          cell.children
            .map((child) => cellText(child, source, exported ? null : links, exported))
            .join("")
            .replaceAll("\t", "    "),
        ),
      );
    return [
      {
        start: range.start,
        end,
        align: node.align ?? [],
        rows: cells(false),
        exportRows: cells(true),
        links,
      },
    ];
  });
}
