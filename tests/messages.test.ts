import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import { chunkAnswer, chunkText } from "../src/discord/chunk";
import {
  attachmentBlocks,
  buildHistoryFromMessage,
  newBudget,
  normalizeTurns,
  parseBotAnswer,
  pruneConversationHistory,
  textBlock,
} from "../src/discord/history";
import { settingsSummary } from "../src/settings/ui";
import { DISCORD_CHUNK_LIMIT } from "../src/shared/constants";
import type { Prefs } from "../src/shared/types";

const base: Prefs = {
  ephemeral: true,
  model: "claude-sonnet-5",
  thinking: true,
  effort: "high",
  web_fetch: true,
  web_search: true,
  currency: "jpy",
};

describe("settingsSummary", () => {
  test("renders shared Gateway thinking controls", () => {
    const text = settingsSummary(base);
    expect(text).toContain("次の質問から反映");
    expect(text).toContain("品質優先");
    expect(text).toContain("検索 ON（必要なとき）");
  });

  test("does not claim unsupported controls are sent to a selected model", () => {
    const text = settingsSummary({ ...base, model: "claude-haiku-4-5" });
    expect(text).toContain("非対応モデルでは差が出ない場合");
    expect(text).toContain("品質優先");
  });

  test("public display mode", () => {
    expect(settingsSummary({ ...base, ephemeral: false })).toContain("**公開範囲**　全員に公開");
  });
});

describe("normalizeTurns", () => {
  test("merges consecutive same-role turns", () => {
    expect(
      normalizeTurns([
        { role: "user", content: [{ type: "text", text: "a" }] },
        { role: "user", content: [{ type: "text", text: "b" }] },
        { role: "assistant", content: [{ type: "text", text: "c" }] },
      ]),
    ).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "c" }] },
    ]);
  });

  test("does not mutate the turns it was handed", () => {
    const original = [
      { role: "user" as const, content: [{ type: "text", text: "a" }] },
      { role: "user" as const, content: [{ type: "text", text: "b" }] },
    ];
    normalizeTurns(original);
    expect(original[0].content).toHaveLength(1);
  });
});

test("splits long Discord tables between rows and repeats their headings", () => {
  const rows = Array.from({ length: 100 }, (_, i) => `row-${i} | \`a\\|b\` ${"日本語".repeat(5)}`);
  const chunks = chunkAnswer(
    "前置き\n\n",
    ["ID | 値", "--- | ---", ...rows].join("\n"),
    "-# モデル: test",
  ).map(({ content }) => content);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.every((chunk) => Array.from(chunk).length <= DISCORD_CHUNK_LIMIT + 100)).toBe(true);
  for (const chunk of chunks) {
    expect(chunk.match(/^```$/gm)).toHaveLength(2);
    expect(chunk).toMatch(/^\| ?ID /m);
  }
  expect(Array.from(chunks.join("\n").matchAll(/row-\d+/g), ([id]) => id)).toEqual(
    rows.map((_, i) => `row-${i}`),
  );
  expect(chunks.at(-1)).toContain("a|b");
  expect(chunks.at(-1)).toEndWith("```\n\n-# モデル: test");
});

test("wraps long Japanese cells before Discord can wrap the whole table row", () => {
  const longName = "ティーバッグ（アールグレイ）";
  const body = [
    "| 商品 | 在庫 | 価格 |",
    "| --- | ---: | ---: |",
    "| Orange | 5 | 80円 |",
    `| ${longName} | 20 | 1,200円 |`,
  ].join("\n");
  const [{ content: chunk }] = chunkAnswer("", body);
  const rows = chunk.split("\n").filter((line) => line.split("|").length === 5);
  expect(rows.length).toBeGreaterThan(3);
  expect(new Set(rows.map((row) => stringWidth(row))).size).toBe(1);
  expect(rows.every((row) => stringWidth(row) <= 34)).toBe(true);
  expect(
    rows
      .slice(2)
      .map((row) => row.split("|")[1].trim())
      .join(""),
  ).toBe(longName);
  expect(
    rows
      .slice(2)
      .map((row) => row.split("|")[3].trim())
      .filter(Boolean),
  ).toEqual(["1,200円"]);
});

test("keeps notes and citations outside a table even without a blank line", () => {
  const body =
    "| 商品 | 価格 |\n| --- | --- |\n| りんご | 150円 |\n注: 参考価格\n出典: https://example.com";
  const [{ content }] = chunkAnswer("", body);
  expect(content).toEndWith("```\n\n注: 参考価格\n出典: https://example.com");
});

test("uses a vertical list when text table headings would wrap into fragments", () => {
  const body = [
    "| プラン | 想定する利用者 | 主なメリット | 気を付けたい点 | 導入の手間 |",
    "| --- | --- | --- | --- | --- |",
    "| 標準 | 小規模なチーム | 導入しやすい | 一部の機能に制約 | 数分で完了 |",
  ].join("\n");
  const [{ content }] = chunkAnswer("", body);
  expect(content).toBe(
    "**プラン：標準**\n- 想定する利用者：小規模なチーム\n- 主なメリット：導入しやすい\n- 気を付けたい点：一部の機能に制約\n- 導入の手間：数分で完了",
  );
});

describe("chunkText", () => {
  test("splits at the Discord limit and never returns an empty list", () => {
    expect(chunkText("")).toEqual([""]);
    const long = "あ".repeat(DISCORD_CHUNK_LIMIT * 2 + 5);
    const chunks = chunkText(long);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => Array.from(c).length)).toEqual([
      DISCORD_CHUNK_LIMIT,
      DISCORD_CHUNK_LIMIT,
      5,
    ]);
    expect(chunks.join("")).toBe(long);
  });

  test("keeps surrogate pairs intact across a boundary", () => {
    const filler = "x".repeat(DISCORD_CHUNK_LIMIT - 1);
    const chunks = chunkText(`${filler}🎉y`);
    expect(chunks[0].endsWith("🎉")).toBe(true);
    expect(chunks[1]).toBe("y");
  });

  test("breaks at a newline in the second half of the window", () => {
    const first = "a".repeat(DISCORD_CHUNK_LIMIT - 100);
    const chunks = chunkText(`${first}\n${"b".repeat(300)}`);
    expect(chunks[0]).toBe(`${first}\n`);
    expect(chunks[1]).toBe("b".repeat(300));
  });

  test("never cuts through the footer, even when the body ends at the boundary", () => {
    const footer = "-# モデル: anthropic/claude-haiku-5.5";
    for (const length of [DISCORD_CHUNK_LIMIT - 20, DISCORD_CHUNK_LIMIT, 1990]) {
      const chunks = chunkText("あ".repeat(length), footer);
      const last = chunks[chunks.length - 1];
      expect(last.endsWith(footer)).toBe(true);
      expect(last.split("\n").at(-1)).toBe(footer);
      // Room remains for the confirmed cost appended later.
      expect(Array.from(`${last}｜費用 ¥0.17（確定）`).length).toBeLessThanOrEqual(2000);
    }
  });
});

describe("attachmentBlocks", () => {
  const att = (over: Record<string, unknown> = {}) => ({
    id: "1",
    filename: "a.png",
    size: 1000,
    url: "https://cdn.discordapp.com/attachments/1/2/a.png?ex=1&is=2&hm=3",
    content_type: "image/png",
    ...over,
  });

  test("labels the file and puts it before the prompt, using a url source", () => {
    expect(attachmentBlocks([att()], newBudget())).toEqual([
      { type: "text", text: "[添付: a.png]" },
      { type: "image", source: { type: "url", url: att().url } },
    ]);
  });

  test("PDFs become document blocks", () => {
    const blocks = attachmentBlocks(
      [att({ filename: "d.pdf", content_type: "application/pdf" })],
      newBudget(),
    );
    expect(blocks[1].type).toBe("document");
  });

  test("parameterised content types still match", () => {
    const blocks = attachmentBlocks(
      [att({ content_type: "image/png; charset=binary" })],
      newBudget(),
    );
    expect(blocks).toHaveLength(2);
  });

  test("rejects unsupported types and oversized files", () => {
    expect(attachmentBlocks([att({ content_type: "text/plain" })], newBudget())).toEqual([]);
    expect(attachmentBlocks([att({ size: 6 * 1024 * 1024 })], newBudget())).toEqual([]);
  });

  test("stops at eight files across the whole chain", () => {
    const budget = newBudget();
    const many = Array.from({ length: 12 }, () => att());
    expect(attachmentBlocks(many, budget)).toHaveLength(16);
    expect(budget.count).toBe(8);
  });
});

describe("parseBotAnswer", () => {
  test("extracts prompt and answer from a standard bot answer and removes the footer", () => {
    const content = "**Q:** 日本の首都は？\n\n**A:**\n東京です。\n\n-# モデル: auto｜費用 ¥0.01";
    expect(parseBotAnswer(content)).toEqual({
      prompt: "日本の首都は？",
      answer: "東京です。",
    });
  });

  test("extracts multiline prompt and multiline answer", () => {
    const content = "**Q:** 1行目\n2行目\n\n**A:**\n回答1行目\n回答2行目\n\n-# モデル: claude";
    expect(parseBotAnswer(content)).toEqual({
      prompt: "1行目\n2行目",
      answer: "回答1行目\n回答2行目",
    });
  });

  test("handles answer without footer", () => {
    const content = "**Q:** こんにちは\n\n**A:**\nこんにちは！";
    expect(parseBotAnswer(content)).toEqual({
      prompt: "こんにちは",
      answer: "こんにちは！",
    });
  });

  test("handles CRLF line endings and trailing whitespace on A line", () => {
    const content =
      "**Q:** 日本の首都は？\r\n\r\n**A:**  \r\n東京です。\r\n\r\n-# モデル: auto｜費用 ¥0.01";
    expect(parseBotAnswer(content)).toEqual({
      prompt: "日本の首都は？",
      answer: "東京です。",
    });
  });

  test("returns null for non-bot messages or empty prompt/answer", () => {
    expect(parseBotAnswer("ただのユーザーメッセージ")).toBeNull();
    expect(parseBotAnswer("**Q:** \n\n**A:**\n回答")).toBeNull();
    expect(parseBotAnswer("**Q:** 質問\n\n**A:**\n-# 準備中… 1秒")).toBeNull();
    expect(parseBotAnswer("")).toBeNull();
  });
});

describe("pruneConversationHistory", () => {
  test("maintains alternating turns and keeps role: user as the first turn", () => {
    const messages = [
      { role: "assistant" as const, content: [textBlock("最初の回答")] },
      { role: "user" as const, content: [textBlock("質問")] },
    ];
    const pruned = pruneConversationHistory(messages);
    expect(pruned[0].role).toBe("user");
    expect(pruned).toHaveLength(1);
  });

  test("trims older turns in user-assistant pairs when history exceeds HISTORY_DEPTH", () => {
    const messages = [
      { role: "user" as const, content: [textBlock("Q1")] },
      { role: "assistant" as const, content: [textBlock("A1")] },
      { role: "user" as const, content: [textBlock("Q2")] },
      { role: "assistant" as const, content: [textBlock("A2")] },
      { role: "user" as const, content: [textBlock("Q3")] },
      { role: "assistant" as const, content: [textBlock("A3")] },
      { role: "user" as const, content: [textBlock("Q4")] },
    ];
    const pruned = pruneConversationHistory(messages);
    expect(pruned).toHaveLength(5);
    expect(pruned[0]).toEqual({ role: "user", content: [textBlock("Q2")] });
    expect(pruned[pruned.length - 1]).toEqual({ role: "user", content: [textBlock("Q4")] });
  });

  test("preserves attachments in the last 2 user turns and degenerates older ones", () => {
    const attBlock = (file: string) => [
      textBlock(`[添付: ${file}]`),
      { type: "image", source: { type: "url", url: `https://example.com/${file}` } },
      textBlock(`この${file}は何？`),
    ];
    const messages = [
      { role: "user" as const, content: attBlock("old.png") },
      { role: "assistant" as const, content: [textBlock("昔の回答")] },
      { role: "user" as const, content: attBlock("mid.png") },
      { role: "assistant" as const, content: [textBlock("中間の回答")] },
      { role: "user" as const, content: attBlock("new.png") },
    ];
    const pruned = pruneConversationHistory(messages);
    expect(pruned).toHaveLength(5);
    expect(pruned[0].content).toEqual([
      textBlock("[添付: old.png（以前のメッセージのため省略）]"),
      textBlock("このold.pngは何？"),
    ]);
    expect(pruned[2].content[1].type).toBe("image");
    expect(pruned[4].content[1].type).toBe("image");
  });

  test("decodes URL-encoded filenames when degenerating standalone attachments", () => {
    const messages = [
      {
        role: "user" as const,
        content: [
          {
            type: "image" as const,
            source: { type: "url", url: "https://discord.mock/%E7%8C%AB.png?size=1024" },
          },
          textBlock("猫の画像です"),
        ],
      },
      { role: "assistant" as const, content: [textBlock("かわいい猫ですね")] },
      { role: "user" as const, content: [textBlock("次")] },
      { role: "assistant" as const, content: [textBlock("回答")] },
      { role: "user" as const, content: [textBlock("最新")] },
    ];
    const pruned = pruneConversationHistory(messages);
    expect(pruned[0].content[0]).toEqual(textBlock("[添付: 猫.png（以前のメッセージのため省略）]"));
  });
});

describe("buildHistoryFromMessage", () => {
  test("does not duplicate prompt when bot message references the original user message, and attaches files", async () => {
    const messages: Record<string, any> = {
      m1: {
        id: "m1",
        channel_id: "c",
        author: { id: "user1" },
        content: "日本の首都は？",
        attachments: [
          {
            id: "att1",
            filename: "tokyo.png",
            size: 1024,
            url: "https://example.com/tokyo.png",
            content_type: "image/png",
          },
        ],
      },
      m2: {
        id: "m2",
        channel_id: "c",
        author: { id: "app" },
        content: "**Q:** 日本の首都は？\n\n**A:**\n東京です。\n\n-# モデル: auto",
        attachments: [],
        message_reference: { message_id: "m1" },
      },
    };
    const discord = {
      appId: "app",
      fetchMessage: async (_channel: string, id: string) => messages[id],
    };
    const turns = await buildHistoryFromMessage(messages.m2, discord as any);
    expect(turns).toHaveLength(2);
    expect(turns[0].role).toBe("user");
    expect(turns[1].role).toBe("assistant");
    expect(turns[1].content).toEqual([textBlock("東京です。")]);
    expect(turns[0].content).toHaveLength(3);
    expect(turns[0].content[0]).toEqual(textBlock("[添付: tokyo.png]"));
    expect(turns[0].content[1].type).toBe("image");
    expect(turns[0].content[2]).toEqual(textBlock("日本の首都は？"));
  });
});
