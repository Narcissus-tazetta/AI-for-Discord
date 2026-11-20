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
  spyOn(globalThis, "fetch").mockImplementation((async (url: string, init?: RequestInit) => {
    const body = init?.body;
    if (body instanceof FormData) forms.push(body);
    else edits.push(JSON.parse(String(body)));
    return Response.json({ id: init?.method === "POST" || url.endsWith("/2") ? "2" : "1" });
  }) as typeof fetch);
  const discord = new DiscordClient(env);
  const header = "**Q:** 在庫\n\n**A:**\n";
  const body = "| 商品 | 価格 |\n| --- | ---: |\n| りんご | 100円 |\n| =1+1 | -3 |";
  const reply = new LiveReply(discord, "tok", true, header);
  const delivered = await reply.finish(body, [], "-# モデル: test");
  expect(forms).toHaveLength(2);
  expect(reply.text).toBe("");
  const [form, footerForm] = forms;
  const payload = JSON.parse(String(form.get("payload_json")));
  expect(payload.content).toContain("**表 1**");
  expect(payload.content).not.toContain("| 商品");
  expect(payload.attachments.map((file: { filename: string }) => file.filename)).toEqual([
    "table-1.png",
  ]);
  const footer = JSON.parse(String(footerForm.get("payload_json")));
  expect(footer.content).toBe("-# モデル: test");
  expect(footer.attachments.map((file: { filename: string }) => file.filename)).toEqual([
    "table-1.csv",
    "answer-source.md",
  ]);
  const image = form.get("files[0]") as File;
  const png = new Uint8Array(await image.arrayBuffer());
  expect(Array.from(png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const file = footerForm.get("files[0]") as File;
  expect(await file.text()).toContain('"りんご","100円"\r\n"\'=1+1","-3"');
  expect(await (footerForm.get("files[1]") as File).text()).toBe(header + body);

  await new LiveReply(discord, "tok", true, header, delivered.ids).finish("りんごなし", []);
  expect(edits.map(({ attachments }) => attachments)).toEqual([[], []]);
});

test("keeps six columns together and only paginates the rows", async () => {
  const body = [
    "| 商品 | 在庫 | 価格 | 倉庫 | 入荷 | メモ |",
    "| --- | --- | --- | --- | --- | --- |",
    ...Array.from({ length: 70 }, (_, i) => `| 商品 ${i + 1} | 12 | 150円 | 東京 | 11/20 | 通常 |`),
  ].join("\n");
  const [table] = parseTables(body);
  const presentation = await presentTable(table, 1, 4);
  if (presentation?.kind !== "image") throw new Error("expected an image table");
  const { pages } = presentation;
  expect(pages.map((page) => page.filename)).toEqual(["table-1-1.png", "table-1-2.png"]);
  const images = await Promise.all(pages.map((file) => file.data.arrayBuffer()));
  const widths = images.map((image) => new DataView(image).getUint32(16));
  expect(widths[0]).toBeGreaterThan(672);
  expect(widths[1]).toBe(widths[0]);
  expect(await presentation.csv.data.text()).toContain(
    '"商品 70","12","150円","東京","11/20","通常"',
  );
});

test("uploads one tall table image with long Japanese cell text", async () => {
  const messages: { content: string; attachments?: { filename: string }[] }[] = [];
  spyOn(globalThis, "fetch").mockImplementation((async (_url: string, init?: RequestInit) => {
    const raw = init?.body instanceof FormData ? init.body.get("payload_json") : init?.body;
    messages.push(JSON.parse(String(raw)));
    return Response.json({ id: String(messages.length) });
  }) as typeof fetch);
  const body = [
    "| 項目 | Gemini 4 Neonの内容 | 凄さのポイント |",
    "| --- | --- | --- |",
    "| コンテキストウィンドウ | 入力と出力（思考・関数呼び出し・最終回答を含む）で合計1,048,576トークン | 大量の文書・表計算・ログをまとめて扱える |",
    "| 長文出力 | 同期出力は1回あたり65,536トークン、バックグラウンド実行や継続トークンで最大1Mトークンまで | 大規模なコードや分析レポートを途切れず生成できる |",
    "| 思考レベル | low / medium / high（デフォルト）/ xhigh の4段階 | 速度・コスト・推論の深さを用途に応じて調整できる |",
    "| 知能指数 | Artificial Analysis Intelligence Index で61点、総合3位（xhigh設定時） | 上位モデルの一角に入る水準 |",
    "| コーディング | Artificial Analysis Coding Agent Index（58.6）で1位、Zapier AutomationBench（56.3%）で1位 | リポジトリ単位のデバッグや複数ファイルのリファクタリングに強いとされる |",
    "| コスト効率 | デフォルト設定でGemini 4 Carbonより1タスクあたりのコストが32%低い | 日常的なエージェント処理を回しやすい |",
    "| 価格 | 入力$3.00 / 100万トークン、出力$15.00 / 100万トークン、キャッシュ入力は95%割引（$0.15） | 高性能モデルとしては比較的手頃な設定 |",
    "| ハルシネーション | 社内テストで「これまでで最も低い捏造率」と発表 | 長いエージェントセッションでの信頼性向上をうたう |",
    "| 長いセッション | 冗長なファイル読み込みを減らし、コンテキスト圧縮を確実に処理 | 多数のツール呼び出しを伴う作業でも安定しやすい |",
    "| マルチモデル連携 | Hydrogen（高速・大量処理向け）と組み合わせ、Neonが計画、Hydrogenが実行を担当 | 高度な判断と高速処理を両立できる |",
    "| 位置づけ | Hydrogen（日常的な高頻度処理）とCarbon（長期・超複雑タスク）の中間 | 用途に応じた使い分けがしやすい |",
    "",
    "出典：[資料](https://example.com/reference)",
  ].join("\n");
  const reply = new LiveReply(new DiscordClient(env), "tok", false, "**A:**\n");
  const delivered = await reply.finish(body, [], "-# モデル: test");
  expect(messages.map(({ attachments }) => attachments?.map(({ filename }) => filename))).toEqual([
    ["table-1.png"],
    ["table-1.csv", "answer-source.md"],
  ]);
  expect(delivered.lastContent).toEndWith("-# モデル: test");
  expect(delivered.lastContent).toContain("出典：[資料]");
});

test("keeps all five columns of a fruit comparison in the table image", async () => {
  const body = [
    "| 果物 | 主な産地 | 旬の時期 | 価格帯 | 特徴 |",
    "| --- | --- | --- | --- | --- |",
    "| りんご | 青森県、長野県 | 9月〜12月 | 中 | 食物繊維が多く、保存がききやすい |",
    "| みかん | 和歌山県、愛媛県 | 11月〜2月 | 低〜中 | ビタミンCが豊富で、冬のこたつのお供 |",
    "| いちご | 栃木県、福岡県 | 12月〜5月 | 中〜高 | 甘みと香りが強く、生食向き |",
    "| バナナ | フィリピン、エクアドル | 通年 | 低 | 手軽に食べられ、エネルギー補給に向く |",
    "| ぶどう | 山梨県、長野県 | 8月〜10月 | 高 | 皮ごと食べられる品種もあり、贈答品にも人気 |",
  ].join("\n");
  const [table] = parseTables(body);
  const presentation = await presentTable(table, 1, 4);
  expect(presentation?.kind).toBe("image");
  if (presentation?.kind !== "image") return;
  const [png] = presentation.pages;
  const image = new DataView(await png.data.arrayBuffer());
  expect(image.getUint32(16)).toBeGreaterThan(1000);
  expect(await presentation.csv.data.text()).toContain(
    '"ぶどう","山梨県、長野県","8月〜10月","高","皮ごと食べられる品種もあり、贈答品にも人気"',
  );
});

test("shows tables that exceed the minimum column widths as a list with a CSV", async () => {
  const edits: { content: string; attachments?: { filename: string }[] }[] = [];
  spyOn(globalThis, "fetch").mockImplementation((async (_url: string, init?: RequestInit) => {
    const raw = init?.body instanceof FormData ? init.body.get("payload_json") : init?.body;
    edits.push(JSON.parse(String(raw)));
    return Response.json({ id: String(edits.length), channel_id: "123" });
  }) as typeof fetch);
  const details = "説明が長くなる場合にもスマホで比較できる";
  const body = [
    "| プラン | 対象 | 利点 | 制約 | 料金 | 枠 | 備考 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    `| 標準 | ${details} | ${details} | ${details} | 無料 | なし | なし |`,
    "",
    "まとめ",
  ].join("\n");
  const reply = new LiveReply(new DiscordClient(env), "tok", false, "");
  const delivered = await reply.finish(body, [], "-# モデル: test");
  expect(edits.map(({ attachments }) => attachments?.map(({ filename }) => filename))).toEqual([
    ["table-1.csv", "answer-source.md"],
  ]);
  expect(edits[0].content).toContain(`**プラン：標準**\n- 対象：${details}`);
  expect(edits[0].content).toEndWith("まとめ\n\n-# モデル: test");
  expect(delivered.lastContent).toBe(edits[0].content);
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

function followupServer(limit: number) {
  const messages = new Map<string, { content: string; attachments?: unknown[] }>();
  let refused = 0;
  spyOn(globalThis, "fetch").mockImplementation((async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" && messages.size === limit) {
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
  return { messages, refused: () => refused };
}

const smallTable = "| 項目 | 数値 |\n| --- | --- |\n| A | 1 |";

test("drops table images before the followup limit instead of sending them and rolling back", async () => {
  const { messages, refused } = followupServer(6);
  const original = ["あ".repeat(4000), ...Array(4).fill(smallTable), "回答末尾"].join("\n\n");
  const reply = new LiveReply(new DiscordClient(env), "tok", false, "");
  const delivered = await reply.finish(original, [], "-# モデル: test");
  expect(refused()).toBe(0);
  expect(delivered.failed).toBe(false);
  expect(messages.size).toBeLessThanOrEqual(6);
  expect(delivered.lastContent).toEndWith("回答末尾\n\n-# モデル: test");
});

test("recovers the end of the answer when Discord refuses a followup anyway", async () => {
  const { messages, refused } = followupServer(3);
  const original = ["あ".repeat(4000), ...Array(4).fill(smallTable), "回答末尾"].join("\n\n");
  const reply = new LiveReply(new DiscordClient(env), "tok", false, "");
  const delivered = await reply.finish(original, [], "-# モデル: test");
  expect(refused()).toBeGreaterThan(0);
  expect(delivered.failed).toBe(false);
  expect(delivered.lastContent).toEndWith("回答末尾\n\n-# モデル: test");
  expect([...messages.values()].every((message) => !message.attachments?.length)).toBe(true);
});

test("draws status emoji as look-alikes instead of dropping the table to text", async () => {
  const body = [
    "| 機能 | 対応 |",
    "| --- | --- |",
    "| 検索 | ✅ 対応 |",
    "| 画像 | ❌ 非対応 |",
    "| 音声 | ⚠️​一部 |",
  ].join("\n");
  const [table] = parseTables(body);
  const presentation = await presentTable(table, 1, 4);
  expect(presentation?.kind).toBe("image");
  expect(await presentation?.csv.data.text()).toContain('"検索","✅ 対応"');
});

test("keeps a table with an unsupported emoji as text", async () => {
  const [table] = parseTables("| 名前 | 印 |\n| --- | --- |\n| A | 🚀 |");
  expect(await presentTable(table, 1, 4)).toBeNull();
});

test("shows link labels in the table and lists their destinations under it", async () => {
  const body = [
    "| 項目 | 内容 | 出典 |",
    "| --- | --- | --- |",
    "| A | 1行目<br>2行目 | [Google](https://blog.google/a_(b)) |",
    "| B | 旧 **新** | [Google](https://blog.google/a_(b)) |",
  ].join("\n");
  const [table] = parseTables(body);
  expect(table.rows).toEqual([
    ["項目", "内容", "出典"],
    ["A", "1行目\n2行目", "Google"],
    ["B", "旧 新", "Google"],
  ]);
  expect(table.exportRows[1][2]).toBe("Google (https://blog.google/a_(b))");

  const messages: { content: string }[] = [];
  spyOn(globalThis, "fetch").mockImplementation((async (_url: string, init?: RequestInit) => {
    const raw = init?.body instanceof FormData ? init.body.get("payload_json") : init?.body;
    messages.push(JSON.parse(String(raw)));
    return Response.json({ id: String(messages.length) });
  }) as typeof fetch);
  await new LiveReply(new DiscordClient(env), "tok", false, "").finish(body, []);
  const content = messages.map((message) => message.content).join("\n");
  expect(content).not.toContain("](https://blog.google/a_(b))\n|");
  expect(content).toContain("-# リンク: [Google](https://blog.google/a_%28b%29)");
  expect(content.match(/blog\.google/g)).toHaveLength(1);
});

test("splits a medium table into readable pages and a long one into tall pages", async () => {
  const rows = (count: number) =>
    [
      "| 商品 | 在庫 |",
      "| --- | --- |",
      ...Array.from({ length: count }, (_, i) => `| 商品 ${i + 1} | 12 |`),
    ].join("\n");
  const heightOf = async (file: { data: Blob }) =>
    new DataView(await file.data.arrayBuffer()).getUint32(20);

  const medium = await presentTable(parseTables(rows(16))[0], 1, 4);
  if (medium?.kind !== "image") throw new Error("expected an image table");
  expect(medium.pages).toHaveLength(2);
  for (const page of medium.pages) expect(await heightOf(page)).toBeLessThanOrEqual(520 * 3);

  const long = await presentTable(parseTables(rows(60))[0], 1, 4);
  if (long?.kind !== "image") throw new Error("expected an image table");
  expect(long.pages.length).toBeGreaterThan(0);
  expect(await heightOf(long.pages[0])).toBeGreaterThan(520 * 2);
});
