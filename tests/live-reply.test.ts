import { describe, expect, spyOn, test } from "bun:test";
import { DiscordClient } from "../src/discord/api";
import { LiveReply } from "../src/discord/live-reply";
import { presentTable } from "../src/discord/table-image";
import { parseTables } from "../src/discord/tables";
import { type Env, EPHEMERAL } from "../src/shared/constants";

const env = {
  DISCORD_APPLICATION_ID: "app",
  DISCORD_API_BASE: "https://discord.mock/v10",
  DISCORD_BOT_TOKEN: "bot",
} as Env;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Answers every webhook call, reporting the given bucket state in the rate-limit headers. */
function discordWith(remaining: number, resetAfter: number) {
  const writes: string[] = [];
  spyOn(globalThis, "fetch").mockImplementation((async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    writes.push(body.content);
    return new Response(JSON.stringify({ id: "1", content: body.content }), {
      headers: {
        "x-ratelimit-limit": "5",
        "x-ratelimit-remaining": String(remaining),
        "x-ratelimit-reset-after": String(resetAfter),
        "x-ratelimit-bucket": "b",
      },
    });
  }) as any);
  return writes;
}

describe("live reply pacing", () => {
  test("reads Discord's bucket from the response headers", async () => {
    discordWith(3, 1.5);
    const discord = new DiscordClient(env);
    await discord.patchOriginal("tok", "x");
    expect(discord.rateLimit("tok")).toEqual({
      limit: 5,
      remaining: 3,
      resetAfterMs: 1500,
      bucket: "b",
    });
    expect(discord.rateLimit("other")).toBeUndefined();
  });

  test("edits as often as the bucket allows, but holds back when it is nearly spent", async () => {
    const plenty = discordWith(40, 1);
    const fast = new LiveReply(new DiscordClient(env), "tok", false, "");
    await fast.setText("a");
    await sleep(350);
    await fast.setText("ab");
    await fast.stop();
    // 1s over 39 usable requests leaves about 26ms between frames.
    expect(plenty).toEqual(["a ▌", "ab ▌"]);

    const scarce = discordWith(1, 2);
    const slow = new LiveReply(new DiscordClient(env), "tok", false, "");
    await slow.setText("a");
    await sleep(350);
    await slow.setText("ab");
    await slow.stop();
    // The last request is kept for the final edit, so nothing more until the bucket resets.
    expect(scarce).toEqual(["a ▌"]);
  });
});

test("falls back to aligned text when the table upload is rejected", async () => {
  const writes: string[] = [];
  let rejected = 0;
  spyOn(globalThis, "fetch").mockImplementation((async (_url: string, init?: RequestInit) => {
    if (init?.body instanceof FormData) {
      rejected++;
      return new Response("attachments disabled", { status: 403 });
    }
    const { content } = JSON.parse(String(init?.body));
    writes.push(content);
    return Response.json({ id: "1", content });
  }) as typeof fetch);
  const reply = new LiveReply(new DiscordClient(env), "tok", false, "**A:**\n");
  const example = "```markdown\n| A | B |\n|---|---|\n```";
  const body = `| 名前 | 価格 |\n| --- | ---: |\n| **りんご** | 150円 |\n| n/a | 80円 |\n\n${example}`;
  await reply.setText(body);
  await reply.finish(body, [], "-# モデル: test");
  expect(rejected).toBe(1);
  expect(writes).toEqual([
    `**A:**\n${body} ▌`,
    `**A:**\n\n-# 表 1 はテキストで表示しています。\n\n\`\`\`\n| 名前   \u3000 |    価格 |\n|----－－－-+----－－-|\n| りんご    | \u3000150円 |\n| n/a\u3000\u3000\u3000 |  \u300080円 |\n\`\`\`\n\n${example}\n\n-# モデル: test`,
  ]);
});

test("uploads PNG and protected CSV on completion and clears them when regenerated", async () => {
  const forms: FormData[] = [];
  const edits: Record<string, unknown>[] = [];
  spyOn(globalThis, "fetch").mockImplementation((async (_url: string, init?: RequestInit) => {
    const body = init?.body;
    if (body instanceof FormData) forms.push(body);
    else edits.push(JSON.parse(String(body)));
    return Response.json({ id: "1" });
  }) as typeof fetch);
  const discord = new DiscordClient(env);
  const header = "**Q:** 在庫\n\n**A:**\n";
  const body = "| 商品 | 価格 |\n| --- | ---: |\n| りんご | 100円 |\n| =1+1 | -3 |";
  const reply = new LiveReply(discord, "tok", true, header);
  const delivered = await reply.finish(body, [], "-# モデル: test");
  expect(forms).toHaveLength(1);
  expect(reply.text).toBe("");
  const [form] = forms;
  const payload = JSON.parse(String(form.get("payload_json")));
  expect(payload.content).toContain("**表 1**");
  expect(payload.content).not.toContain("| 商品");
  expect(payload.attachments.map((file: { filename: string }) => file.filename)).toEqual([
    "table-1.png",
    "table-1.csv",
    "answer-source.md",
  ]);
  const image = form.get("files[0]") as File;
  const png = new Uint8Array(await image.arrayBuffer());
  expect(Array.from(png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const file = form.get("files[1]") as File;
  expect(await file.text()).toContain('"りんご","100円"\r\n"\'=1+1","-3"');
  expect(await (form.get("files[2]") as File).text()).toBe(header + body);

  await new LiveReply(discord, "tok", true, header, delivered.ids).finish("りんごなし", []);
  expect(edits[0].attachments).toEqual([]);
});

test("keeps six columns together and only paginates the rows", async () => {
  const body = [
    "| 商品 | 在庫 | 価格 | 倉庫 | 入荷 | メモ |",
    "| --- | --- | --- | --- | --- | --- |",
    ...Array.from({ length: 13 }, (_, i) => `| 商品 ${i + 1} | 12 | 150円 | 東京 | 11/20 | 通常 |`),
  ].join("\n");
  const [table] = parseTables(body);
  const presentation = await presentTable(table, 1, 4);
  if (presentation?.kind !== "image") throw new Error("expected an image table");
  const { pages } = presentation;
  expect(pages.map((page) => page.map((file) => file.filename))).toEqual([
    ["table-1-1.png", "table-1.csv"],
    ["table-1-2.png"],
  ]);
  const images = await Promise.all(pages.map(([file]) => file.data.arrayBuffer()));
  const widths = images.map((image) => new DataView(image).getUint32(16));
  expect(widths[0]).toBeGreaterThan(672);
  expect(widths[1]).toBe(widths[0]);
  expect(await pages[0][1].data.text()).toContain('"商品 13","12","150円","東京","11/20","通常"');
});

test("shows wide comparisons as a list with a CSV and attaches the answer source once", async () => {
  const edits: { content: string; attachments?: { filename: string }[] }[] = [];
  spyOn(globalThis, "fetch").mockImplementation((async (_url: string, init?: RequestInit) => {
    const raw = init?.body instanceof FormData ? init.body.get("payload_json") : init?.body;
    edits.push(JSON.parse(String(raw)));
    return Response.json({ id: String(edits.length), channel_id: "123" });
  }) as typeof fetch);
  const details = "説明が長くなる場合にもスマホで比較できる";
  const body = [
    "| プラン | 対象 | 利点 | 制約 |",
    "| --- | --- | --- | --- |",
    `| 標準 | ${details} | ${details} | ${details} |`,
    "",
    "まとめ",
  ].join("\n");
  const reply = new LiveReply(new DiscordClient(env), "tok", false, "");
  const delivered = await reply.finish(body, [], "-# モデル: test");
  expect(edits.map(({ attachments }) => attachments?.map(({ filename }) => filename))).toEqual([
    ["table-1.csv", "answer-source.md"],
    undefined,
  ]);
  expect(edits[0].content).toContain(`**プラン：標準**\n- 対象：${details}`);
  expect(edits[1].content).toStartWith("まとめ\n\n");
  expect(delivered.lastContent).toBe(edits[1].content);
});

test("suppresses Discord link previews when table formatting moves citations to a followup", async () => {
  const writes: { content: string; flags: number; attachments?: { filename: string }[] }[] = [];
  spyOn(globalThis, "fetch").mockImplementation((async (_url: string, init?: RequestInit) => {
    const raw = init?.body instanceof FormData ? init.body.get("payload_json") : init?.body;
    writes.push(JSON.parse(String(raw)));
    return Response.json({ id: init?.method === "POST" ? "2" : "1" });
  }) as typeof fetch);
  const citation = "[出典](https://example.com/reference)";
  const body = [
    "前置き".repeat(550),
    "| 名前 | 個数 |\n| --- | --- |\n| りんご | 2 |",
    citation,
  ].join("\n\n");
  const reply = new LiveReply(new DiscordClient(env), "tok", true, "**A:**\n");
  await reply.setText(body);
  const delivered = await reply.finish(body, [], "-# モデル: test");
  expect(delivered.ids).toEqual(["1", "2"]);
  expect(writes[0].content).toContain(citation);
  expect(writes[1].content).not.toContain(citation);
  expect(writes[1].attachments?.map(({ filename }) => filename)).toContain("table-1.png");
  expect(writes[2].content).toContain(citation);
  expect(writes.map(({ flags }) => flags)).toEqual([4, 4, EPHEMERAL | 4]);
});

test("recovers the end of the answer when image pages exhaust the followup limit", async () => {
  const messages = new Map<string, { content: string; attachments?: unknown[] }>();
  let refused = 0;
  spyOn(globalThis, "fetch").mockImplementation((async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" && messages.size === 6) {
      refused++;
      return Response.json({ code: 40094 }, { status: 400 });
    }
    const raw = init?.body instanceof FormData ? init.body.get("payload_json") : init?.body;
    const body = JSON.parse(String(raw));
    const match = url.match(/\/messages\/(\d+)$/);
    const id = match?.[1] ?? String(messages.size + 1);
    messages.set(id, body);
    return Response.json({ id });
  }) as typeof fetch);
  const tables = Array.from({ length: 4 }, () => "| 項目 | 数値 |\n| --- | --- |\n| A | 1 |");
  const original = ["あ".repeat(4000), ...tables, "回答末尾"].join("\n\n");
  const reply = new LiveReply(new DiscordClient(env), "tok", false, "");
  const delivered = await reply.finish(original, [], "-# モデル: test");
  expect(refused).toBe(1);
  expect(delivered.failed).toBe(false);
  expect(delivered.lastContent).toEndWith("回答末尾\n\n-# モデル: test");
  expect([...messages.values()].every((message) => !message.attachments?.length)).toBe(true);
});
