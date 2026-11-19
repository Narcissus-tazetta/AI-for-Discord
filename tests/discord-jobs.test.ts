import { describe, expect, spyOn, test } from "bun:test";
import { handleInteraction } from "../src/discord/interactions";
import { JobDO } from "../src/durable-objects/job-do";
import { deferSettings, isSettingsInteraction } from "../src/settings/dispatch";
import {
  CID_FILTER,
  CID_MODE,
  CID_MODEL,
  CID_PAGE,
  CID_QUALITY,
  CID_REFRESH,
  CID_VIEW,
  CID_VISIBILITY,
} from "../src/settings/ui";
import { context, json, model, registry, setup } from "./helpers/durable-fixtures";
import { decision } from "./helpers/gateway-fixtures";

describe("Discord delivery and regeneration", () => {
  test("refreshing a recent catalog reveals newly eligible models without paid evaluation", async () => {
    const { state, env, ready, kv } = setup();
    await ready();
    kv.set("ai_registry", registry());
    const fetcher = spyOn(globalThis, "fetch").mockImplementation((async (url: string) => {
      expect(url).toContain("/models?include_availability=true");
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "openai/gpt-6.1-sol",
              name: "GPT 6.1 Sol",
              type: "language",
              context_window: 100000,
              max_tokens: 4096,
              pricing: { input: "0.000002", output: "0.00001" },
              model_eligibility: { status: "eligible" },
            },
            {
              id: "anthropic/claude-sonnet-5.5",
              name: "Sonnet 5.5",
              type: "language",
              context_window: 100000,
              max_tokens: 4096,
              pricing: { input: "0.000002", output: "0.00001" },
              model_eligibility: { status: "eligible" },
            },
            {
              id: "mistral/test",
              name: "Mistral",
              type: "language",
              context_window: 100000,
              max_tokens: 4096,
              pricing: { input: "0.000001", output: "0.000002" },
              model_eligibility: { status: "eligible" },
            },
          ],
        }),
      );
    }) as any);
    const interaction = {
      id: "i",
      type: 3,
      token: "t",
      application_id: "app",
      user: { id: "123" },
      data: { custom_id: `${CID_REFRESH}models:123:all:0` },
    };
    expect(isSettingsInteraction(interaction)).toBe(true);
    const response = (await (await handleInteraction(interaction, env)).json()) as any;
    expect(response.type).toBe(7);
    expect(response.data.components[1].components[0].options.map((o: any) => o.value)).toContain(
      "openai/gpt-6.1-sol",
    );
    expect(JSON.parse(await state.getRegistryJson()).models).toHaveLength(3);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(state.getPrefs("123").model).toBe("auto");
    await handleInteraction(
      { ...interaction, data: { custom_id: `${CID_REFRESH}models:999:all:0` } },
      env,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  test("settings ACK does not wait for a slow Durable Object and remains private", async () => {
    const { env, ready } = setup();
    await ready();
    let finish: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const jobs: any[] = [];
    env.JOB_DO = {
      idFromName: (name: string) => name,
      get: () => ({
        start: async (job: any) => {
          jobs.push(job);
          await pending;
        },
      }),
    } as any;
    const tasks: Promise<any>[] = [];
    const ctx = { waitUntil: (task: Promise<any>) => tasks.push(task) } as any;
    const interaction = {
      id: "i",
      type: 3,
      token: "t",
      application_id: "app",
      user: { id: "123" },
      data: { custom_id: `${CID_MODE}123`, values: ["manual"] },
    };
    expect(isSettingsInteraction(interaction)).toBe(true);
    expect<unknown>(await deferSettings(interaction, env, ctx).json()).toEqual({ type: 6 });
    expect(jobs[0].kind).toBe("settings");
    expect<unknown>(
      await deferSettings({ ...interaction, type: 2, data: { name: "settings" } }, env, ctx).json(),
    ).toEqual({ type: 5, data: { flags: 64 } });
    expect(
      await deferSettings({ ...interaction, user: { id: "999" } }, env, ctx).json(),
    ).toMatchObject({ type: 4, data: { flags: 64 } });
    expect(jobs.length).toBe(2);
    finish?.();
    await Promise.all(tasks);
    expect(isSettingsInteraction({ ...interaction, type: 2, data: { name: "ai" } })).toBe(false);
  });
  test("queued settings jobs render components after acknowledgement and preserve owner errors", async () => {
    const { env, ready, kv } = setup();
    await ready();
    kv.set("ai_registry", registry());
    const requests: any[] = [];
    spyOn(globalThis, "fetch").mockImplementation((async (url: string, init: RequestInit) => {
      requests.push({ url, method: init.method, body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify({ id: "settings-message" }));
    }) as any);
    const interaction = {
      id: "i",
      type: 3,
      token: "t",
      application_id: "app",
      user: { id: "123" },
      data: { custom_id: `${CID_MODE}123`, values: ["manual"] },
    };
    for (const custom_id of [`${CID_MODE}123`, `${CID_MODE}999`]) {
      const storage = context();
      const job = new JobDO(storage.ctx as any, env);
      await job.start({
        kind: "settings",
        token: "t",
        userId: "123",
        interactionJson: JSON.stringify({
          ...interaction,
          data: { ...interaction.data, custom_id },
        }),
      });
      await job.alarm();
    }
    expect(requests[0].method).toBe("PATCH");
    expect(requests[0].body.components).toHaveLength(3);
    expect(requests[0].body.content).toContain("手動モデルを選択");
    expect(requests[0].body.flags).toBeUndefined();
    expect(requests[1].method).toBe("POST");
    expect(requests[1].body.flags).toBe(64);
    expect(requests[1].body.content).toContain("あなたの設定画面ではありません");
  });
  test("settings delivery failure preserves the original controls and sends a private error", async () => {
    const { env, ready, kv } = setup();
    await ready();
    kv.set("ai_registry", registry());
    const requests: any[] = [];
    spyOn(globalThis, "fetch").mockImplementation((async (_url: string, init: RequestInit) => {
      requests.push({ method: init.method, body: JSON.parse(init.body as string) });
      return init.method === "PATCH"
        ? new Response(JSON.stringify({ message: "Invalid Form Body" }), { status: 400 })
        : new Response(JSON.stringify({ id: "private-error" }));
    }) as any);
    const storage = context();
    const job = new JobDO(storage.ctx as any, env);
    await job.start({
      kind: "settings",
      token: "t",
      userId: "123",
      interactionJson: JSON.stringify({
        id: "i",
        type: 3,
        token: "t",
        application_id: "app",
        user: { id: "123" },
        data: { custom_id: `${CID_FILTER}123`, values: ["google"] },
      }),
    });
    await job.alarm();
    expect(requests.map((request) => request.method)).toEqual(["PATCH", "POST"]);
    expect(requests[1].body.flags).toBe(64);
    expect(requests[1].body.content).toContain("エラーが発生");
    expect(requests[1].body.components).toBeUndefined();
  });
  test("model browsing and filtering never overwrite the selected model, and selecting returns home", async () => {
    const { state, env, ready, kv } = setup();
    await ready();
    kv.set("ai_registry", registry());
    const interact = async (custom_id: string, values: string[] = []) =>
      (await (
        await handleInteraction(
          {
            id: "i",
            type: 3,
            token: "t",
            application_id: "app",
            user: { id: "123" },
            data: { custom_id, values },
          },
          env,
        )
      ).json()) as any;
    const manual = await interact(`${CID_MODE}123`, ["manual"]);
    expect(manual.data.content).toContain("手動モデルを選択");
    expect(state.getPrefs("123").model).toBe("auto");
    const filtered = await interact(`${CID_FILTER}123`, ["google"]);
    expect(
      filtered.data.components[0].components[0].options.find((o: any) => o.default).value,
    ).toBe("google");
    const page = await interact(`${CID_PAGE}1:123:google`);
    expect(
      page.data.components[1].components[0].options.some((o: any) => o.value === model().id),
    ).toBe(true);
    expect(state.getPrefs("123").model).toBe("auto");
    const picked = await interact(`${CID_MODEL}123`, [model().id]);
    expect(picked.data.content).toContain("AIの設定");
    expect(state.getPrefs("123").model).toBe(model().id);
    await interact(`${CID_MODE}123`, ["auto"]);
    expect(state.getPrefs("123").model).toBe("auto");
    const freeMode = await interact(`${CID_MODE}123`, ["auto-free"]);
    expect(state.getPrefs("123").model).toBe("auto-free");
    expect(freeMode.data.content).toContain("無料モデルのみ");
    expect(freeMode.data.content).toContain("無料モードでは検索・リンク読み込みOFF");
  });
  test("quality and visibility save the intended state and reject forged settings", async () => {
    const { state, env, ready, kv } = setup();
    await ready();
    kv.set("ai_registry", registry());
    const interact = async (custom_id: string, values: string[] = []) =>
      (await (
        await handleInteraction(
          {
            id: "i",
            type: 3,
            token: "t",
            application_id: "app",
            user: { id: "123" },
            data: { custom_id, values },
          },
          env,
        )
      ).json()) as any;
    await interact(`${CID_QUALITY}123`, ["high"]);
    expect(state.getPrefs("123")).toMatchObject({ thinking: true, effort: "high" });
    await interact(`${CID_QUALITY}123`, ["off"]);
    expect(state.getPrefs("123")).toMatchObject({ thinking: false, effort: "high" });
    await interact(`${CID_QUALITY}123`, ["medium"]);
    expect(state.getPrefs("123")).toMatchObject({ thinking: true, effort: "medium" });
    await interact(`${CID_VISIBILITY}123`, ["public"]);
    expect(state.getPrefs("123").ephemeral).toBe(false);
    await interact(`${CID_VISIBILITY}123`, ["private"]);
    expect(state.getPrefs("123").ephemeral).toBe(true);
    const saved = state.getPrefs("123");
    for (const [prefix, value] of [
      [CID_QUALITY, "high"],
      [CID_VISIBILITY, "public"],
      [CID_FILTER, "google"],
      [CID_MODE, "manual"],
    ]) {
      expect((await interact(`${prefix}999`, [value])).data.content).toContain(
        "あなたの設定画面ではありません",
      );
    }
    await interact(`${CID_QUALITY}123`, ["invalid"]);
    await interact(`${CID_VISIBILITY}123`, ["invalid"]);
    await interact(`${CID_FILTER}123`, ["invalid"]);
    expect(state.getPrefs("123")).toEqual(saved);
    expect((await interact(`${CID_VIEW}main:999`)).data.content).toContain(
      "あなたの設定画面ではありません",
    );
  });
  /** Webhook messages by id; `@original` resolves per interaction token. */
  function fakeDiscord() {
    const messages = new Map<string, any>();
    const originals = new Map<string, string>();
    const log: { method: string; id: string; body: any }[] = [];
    let next = 0;
    const handle = (url: string, options?: RequestInit) => {
      const method = options?.method ?? "GET";
      const payload =
        options?.body instanceof FormData ? options.body.get("payload_json") : options?.body;
      const body = payload ? JSON.parse(String(payload)) : null;
      const channelMatch = url.match(/channels\/([^/?]+)\/messages\/([^?]+)/);
      if (channelMatch) {
        const [, , msgId] = channelMatch;
        const msg = messages.get(msgId);
        if (msg) return json(msg);
        return json({ message: "Unknown Message" }, 404);
      }
      const [, token, target] = url.match(/webhooks\/app\/([^/?]+)(?:\/messages\/([^?]+))?/) ?? [];
      let id: string;
      if (method === "POST") id = String(++next);
      else if (target === "@original") {
        id = originals.get(token) ?? String(++next);
        originals.set(token, id);
      } else id = target;
      log.push({ method, id, body });
      if (method !== "GET")
        messages.set(id, {
          ...messages.get(id),
          ...body,
          id,
          channel_id: "channel",
          author: { id: "app" },
          attachments: body?.attachments ?? messages.get(id)?.attachments ?? [],
        });
      return json(messages.get(id));
    };
    return { messages, log, handle };
  }

  test("answers stream in with a status, end with buttons, and gain the billed cost later", async () => {
    const { state, env, kv, ready } = setup();
    await ready();
    kv.set("ai_registry", registry());
    const discord = fakeDiscord();
    let paid = 0;
    spyOn(globalThis, "fetch").mockImplementation((async (url: string, options?: RequestInit) => {
      if (url.includes("/generation")) return json({ data: { total_cost: 0.001 } });
      if (url.includes("/chat/completions")) {
        paid++;
        return json({
          id: `g${paid}`,
          model: model().id,
          choices: [
            {
              message: { content: paid === 1 ? "あ".repeat(3000) : "再生成した回答です。" },
              finish_reason: "stop",
            },
          ],
        });
      }
      if (url.startsWith("https://discord.mock/")) return discord.handle(url, options);
      throw new Error("unexpected request");
    }) as any);
    const jobStorage = context();
    const job = new JobDO(jobStorage.ctx as any, env);
    await job.start({
      kind: "slash",
      token: "tok",
      userId: "123",
      ephemeral: true,
      prompt: "こんにちは",
      attachment: null,
    });
    await job.alarm();
    expect(discord.log[0].body.content).toMatch(
      /^\*\*Q:\*\* こんにちは\n\n\*\*A:\*\*\n-# .+… \d+秒$/,
    );
    const [first, second] = [discord.messages.get("1"), discord.messages.get("2")];
    expect(first.content.startsWith("**Q:** こんにちは")).toBe(true);
    expect(first.components).toEqual([]);
    expect(second.flags).toBe(64 | 4);
    expect(second.content).toEndWith(`-# モデル: ${model().id}`);
    expect(second.components[0].components.map((c: any) => c.custom_id)).toEqual([
      "ans:regen",
      "ans:cont",
    ]);
    expect(discord.log.every((d) => !d.body || d.body.allowed_mentions.parse.length === 0)).toBe(
      true,
    );
    const record = state.getRegenRecord("2");
    expect(record?.chunkIds).toEqual(["1", "2"]);
    expect(JSON.parse(record?.messagesJson ?? "[]")[0].content[0].text).toBe("こんにちは");

    // The billing record exists, so the next alarm appends the confirmed cost.
    expect(jobStorage.kv.get("costWatch")).toBeDefined();
    await job.alarm();
    expect(discord.messages.get("2").content).toMatch(/｜費用 ¥0\.16$/);
    expect(discord.messages.get("2").flags).toBe(64 | 4);
    expect(discord.messages.get("2").components).toHaveLength(1);
    expect(jobStorage.kv.size).toBe(0);

    state.setPref("123", "model", model().id);
    const regenStorage = context();
    const regen = new JobDO(regenStorage.ctx as any, env);
    await regen.start({ kind: "regen", token: "regen", userId: "123", messageId: "2" });
    await regen.alarm();
    expect(paid).toBe(2);
    expect(discord.messages.get("1").content).toContain("再生成した回答です。");
    expect(discord.messages.get("1").components).toHaveLength(1);
    expect(discord.messages.get("2").content).toContain("再生成後は不要");
    expect(discord.messages.get("2").components).toEqual([]);
    const ack = discord.messages.get("3");
    expect(ack.content).toBe("🔄 再生成しました。");
    expect(state.getRegenRecord("1")?.chunkIds).toEqual(["1"]);
    expect(state.getRegenRecord("2")).toBeNull();
  });

  test("an unconfirmed cost falls back to the estimate, and a replaced answer is left alone", async () => {
    const { env, kv, ready, state } = setup();
    await ready();
    kv.set("ai_registry", registry());
    const discord = fakeDiscord();
    spyOn(globalThis, "fetch").mockImplementation((async (url: string, options?: RequestInit) => {
      if (url.includes("/generation")) return json({}, 404);
      if (url.includes("/decisions")) return decision("balanced", "d");
      if (url.includes("/chat/completions"))
        return json({
          id: "g",
          model: model().id,
          choices: [{ message: { content: "回答" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1000, completion_tokens: 500 },
        });
      if (url.startsWith("https://discord.mock/")) return discord.handle(url, options);
      throw new Error("unexpected request");
    }) as any);
    const run = async () => {
      const storage = context();
      const job = new JobDO(storage.ctx as any, env);
      await job.start({
        kind: "slash",
        token: `tok${Math.random()}`,
        userId: "123",
        ephemeral: false,
        prompt: "q",
        attachment: null,
      });
      await job.alarm();
      await job.alarm();
      // Billing is still missing: keep polling until the deadline.
      expect(storage.kv.get("costWatch").attempt).toBe(1);
      storage.kv.get("costWatch").deadline = 0;
      return { job, storage };
    };
    const late = await run();
    const id = late.storage.kv.get("costWatch").messageId;
    await late.job.alarm();
    expect(discord.messages.get(id).content).toMatch(/｜概算 ¥0\.0\d+$/);

    const replaced = await run();
    const otherId = replaced.storage.kv.get("costWatch").messageId;
    discord.messages.get(otherId).content = "再生成された別の回答";
    await replaced.job.alarm();
    expect(discord.messages.get(otherId).content).toBe("再生成された別の回答");
    expect(replaced.storage.kv.size).toBe(0);

    const sameContent = await run();
    const watch = sameContent.storage.kv.get("costWatch");
    watch.answerUpdatedAt -= 1;
    const before = discord.messages.get(watch.messageId).content;
    expect(state.getRegenRecord(watch.messageId)?.updatedAt).toBeGreaterThan(watch.answerUpdatedAt);
    await sameContent.job.alarm();
    expect(discord.messages.get(watch.messageId).content).toBe(before);
  });

  test("forged model selections and someone else's settings do not change prefs", async () => {
    const { state, env, ready, kv } = setup();
    await ready();
    kv.set("ai_registry", registry());
    const interaction = {
      id: "i",
      type: 3,
      token: "t",
      application_id: "app",
      user: { id: "123" },
      data: { custom_id: `${CID_MODEL}123`, values: ["evil/model"] },
    };
    expect(
      ((await (await handleInteraction(interaction, env)).json()) as any).data.content,
    ).toContain("モデル一覧");
    expect(state.getPrefs("123").model).toBe("auto");
    interaction.data.custom_id = `${CID_MODEL}999`;
    interaction.data.values = [model().id];
    expect(
      ((await (await handleInteraction(interaction, env)).json()) as any).data.content,
    ).toContain("あなたの設定画面ではありません");
    expect(state.getPrefs("123").model).toBe("auto");
  });

  test("continue job carries over history from RegenRecord including multi-chunk answer", async () => {
    const { state, env, kv, ready } = setup();
    await ready();
    kv.set("ai_registry", registry());
    state.setPref("123", "model", model().id);
    const discord = fakeDiscord();
    const chatRequests: any[] = [];
    const tableAnswer = `${"あ".repeat(3000)}\n\n| 首都 | 国 |\n| --- | --- |\n| 東京 | 日本 |`;
    spyOn(globalThis, "fetch").mockImplementation((async (url: string, options?: RequestInit) => {
      if (url.includes("/generation")) return json({ data: { total_cost: 0.001 } });
      if (url.includes("/chat/completions")) {
        const body = options?.body ? JSON.parse(String(options.body)) : null;
        chatRequests.push(body);
        return json({
          id: `g${chatRequests.length}`,
          model: model().id,
          choices: [
            {
              message: {
                content:
                  chatRequests.length === 1
                    ? tableAnswer
                    : "日本の首都は東京で、人口は約1400万人です。",
              },
              finish_reason: "stop",
            },
          ],
        });
      }
      if (url.startsWith("https://discord.mock/")) return discord.handle(url, options);
      throw new Error(`unexpected request: ${url}`);
    }) as any);

    const slashStorage = context();
    const slashJob = new JobDO(slashStorage.ctx as any, env);
    await slashJob.start({
      kind: "slash",
      token: "tok1",
      userId: "123",
      ephemeral: true,
      prompt: "日本の首都は？",
      attachment: null,
    });
    await slashJob.alarm();

    expect(discord.messages.has("1")).toBe(true);
    expect(discord.messages.has("2")).toBe(true);
    expect(discord.messages.get("1").attachments[0].filename).toBe("answer-source.md");
    expect(
      discord.messages.get("2").attachments.map((file: { filename: string }) => file.filename),
    ).toEqual(["table-1.png", "table-1.csv"]);
    const rec1 = state.getRegenRecord("2");
    expect(rec1?.answerText).toBe(tableAnswer);

    const contStorage = context();
    const contJob = new JobDO(contStorage.ctx as any, env);
    await contJob.start({
      kind: "continue",
      token: "tok2",
      userId: "123",
      ephemeral: true,
      prompt: "人口は？",
      channelId: "channel",
      messageId: "2",
    });
    await contJob.alarm();

    expect(chatRequests).toHaveLength(2);
    const contMessages = chatRequests[1].messages.slice(1);
    expect(contMessages).toHaveLength(3);
    expect(contMessages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "日本の首都は？" }],
    });
    expect(contMessages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: tableAnswer }],
    });
    expect(contMessages[2]).toEqual({
      role: "user",
      content: [{ type: "text", text: "人口は？" }],
    });

    const rec2 = state.getRegenRecord("3");
    expect(rec2?.answerText).toBe("日本の首都は東京で、人口は約1400万人です。");
  });

  test("continue job trims history to HISTORY_DEPTH across multiple turns", async () => {
    const { state, env, kv, ready } = setup();
    await ready();
    kv.set("ai_registry", registry());
    state.setPref("123", "model", model().id);
    const discord = fakeDiscord();
    const chatRequests: any[] = [];
    spyOn(globalThis, "fetch").mockImplementation((async (url: string, options?: RequestInit) => {
      if (url.includes("/generation")) return json({ data: { total_cost: 0.001 } });
      if (url.includes("/chat/completions")) {
        const body = options?.body ? JSON.parse(String(options.body)) : null;
        chatRequests.push(body);
        return json({
          id: `g${chatRequests.length}`,
          model: model().id,
          choices: [{ message: { content: `回答 ${chatRequests.length}` }, finish_reason: "stop" }],
        });
      }
      if (url.startsWith("https://discord.mock/")) return discord.handle(url, options);
      throw new Error(`unexpected request: ${url}`);
    }) as any);

    const j1 = new JobDO(context().ctx as any, env);
    await j1.start({
      kind: "slash",
      token: "t1",
      userId: "123",
      ephemeral: false,
      prompt: "Q1",
      attachment: null,
    });
    await j1.alarm();

    const j2 = new JobDO(context().ctx as any, env);
    await j2.start({
      kind: "continue",
      token: "t2",
      userId: "123",
      ephemeral: false,
      prompt: "Q2",
      channelId: "channel",
      messageId: "1",
    });
    await j2.alarm();

    const j3 = new JobDO(context().ctx as any, env);
    await j3.start({
      kind: "continue",
      token: "t3",
      userId: "123",
      ephemeral: false,
      prompt: "Q3",
      channelId: "channel",
      messageId: "2",
    });
    await j3.alarm();

    const j4 = new JobDO(context().ctx as any, env);
    await j4.start({
      kind: "continue",
      token: "t4",
      userId: "123",
      ephemeral: false,
      prompt: "Q4",
      channelId: "channel",
      messageId: "3",
    });
    await j4.alarm();

    expect(chatRequests).toHaveLength(4);
    const turn4Messages = chatRequests[3].messages.slice(1);
    expect(turn4Messages).toHaveLength(5);
    expect(turn4Messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "Q2" }] });
    expect(turn4Messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "回答 2" }],
    });
    expect(turn4Messages[2]).toEqual({ role: "user", content: [{ type: "text", text: "Q3" }] });
    expect(turn4Messages[3]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "回答 3" }],
    });
    expect(turn4Messages[4]).toEqual({ role: "user", content: [{ type: "text", text: "Q4" }] });
  });

  test("continue job degenerates attachments older than the last 2 user turns", async () => {
    const { state, env, kv, ready } = setup();
    await ready();
    const m = model();
    m.tags = ["vision"];
    kv.set("ai_registry", { ...registry(), models: [m] });
    state.setPref("123", "model", m.id);
    const discord = fakeDiscord();
    const chatRequests: any[] = [];
    spyOn(globalThis, "fetch").mockImplementation((async (url: string, options?: RequestInit) => {
      if (url.includes("/generation")) return json({ data: { total_cost: 0.001 } });
      if (url.includes("/chat/completions")) {
        const body = options?.body ? JSON.parse(String(options.body)) : null;
        chatRequests.push(body);
        return json({
          id: `g${chatRequests.length}`,
          model: m.id,
          choices: [{ message: { content: `回答 ${chatRequests.length}` }, finish_reason: "stop" }],
        });
      }
      if (url.startsWith("https://discord.mock/")) return discord.handle(url, options);
      throw new Error(`unexpected request: ${url}`);
    }) as any);

    const j1 = new JobDO(context().ctx as any, env);
    await j1.start({
      kind: "slash",
      token: "t1",
      userId: "123",
      ephemeral: false,
      prompt: "この画像は何？",
      attachment: {
        id: "att1",
        filename: "cat.png",
        size: 1024,
        url: "https://discord.mock/cat.png",
        content_type: "image/png",
      },
    });
    await j1.alarm();

    const j2 = new JobDO(context().ctx as any, env);
    await j2.start({
      kind: "continue",
      token: "t2",
      userId: "123",
      ephemeral: false,
      prompt: "Q2",
      channelId: "channel",
      messageId: "1",
    });
    await j2.alarm();

    expect(
      chatRequests[1].messages.slice(1)[0].content.some((b: any) => b.type === "image_url"),
    ).toBe(true);

    const j3 = new JobDO(context().ctx as any, env);
    await j3.start({
      kind: "continue",
      token: "t3",
      userId: "123",
      ephemeral: false,
      prompt: "Q3",
      channelId: "channel",
      messageId: "2",
    });
    await j3.alarm();

    const turn3Messages = chatRequests[2].messages.slice(1);
    expect(turn3Messages[0].content.some((b: any) => b.type === "image_url")).toBe(false);
    expect(turn3Messages[0].content[0].text).toContain("（以前のメッセージのため省略）");
  });

  test.each(["text", "source", "linked", "missing-original", "csv", "missing"])(
    "continues without a cache using %s",
    async (mode) => {
      const { state, env, kv, ready } = setup();
      await ready();
      kv.set("ai_registry", registry());
      state.setPref("123", "model", model().id);
      const discord = fakeDiscord();
      const header = "**Q:** キャッシュ外の質問\n\n**A:**\n";
      const table = "| 商品 | 在庫 |\n| --- | --- |\n| りんご | 12 |\n\n-# 回答に元からある注記";
      const csv = '\uFEFF"商品","在庫"\r\n"りんご","12"\r\n';
      const followup = mode === "linked" || mode === "missing-original";
      const sourceMode = mode === "source" || mode === "linked";
      const file = sourceMode ? "answer-source.md" : "table-1.csv";
      const attachment = `https://cdn.discordapp.com/attachments/1/2/${file}?ex=1`;
      const exported = sourceMode ? header + table : csv;
      const visible =
        mode === "source"
          ? "在庫が足りるかも確認してください。"
          : followup
            ? "**表 1（2/2）**"
            : header + (mode === "text" ? "キャッシュ外の回答" : "**表 1**");
      const files = [{ id: "2", filename: file, url: attachment, size: new Blob([exported]).size }];
      if (mode === "linked") {
        discord.messages.set("98", {
          id: "98",
          channel_id: "channel",
          author: { id: "app" },
          attachments: files,
        });
      }
      discord.messages.set("99", {
        id: "99",
        channel_id: "channel",
        author: { id: "app" },
        content: `${visible}\n\n-# モデル: auto`,
        attachments: mode === "text" || followup ? [] : files,
        ...(followup ? { interaction_metadata: { original_response_message_id: "98" } } : {}),
      });
      const chatRequests: any[] = [];
      spyOn(globalThis, "fetch").mockImplementation((async (url: string, options?: RequestInit) => {
        if (url === attachment)
          return mode === "missing" ? new Response(null, { status: 404 }) : new Response(exported);
        if (url.includes("/generation")) return json({ data: { total_cost: 0.001 } });
        if (url.includes("/chat/completions")) {
          const body = options?.body ? JSON.parse(String(options.body)) : null;
          chatRequests.push(body);
          return json({
            id: "g",
            model: model().id,
            choices: [{ message: { content: "フォールバック回答" }, finish_reason: "stop" }],
          });
        }
        if (url.startsWith("https://discord.mock/")) return discord.handle(url, options);
        throw new Error(`unexpected request: ${url}`);
      }) as any);

      const job = new JobDO(context().ctx as any, env);
      await job.start({
        kind: "continue",
        token: "tok-fallback",
        userId: "123",
        ephemeral: true,
        prompt: "フォールバックの継続質問",
        channelId: "channel",
        messageId: "99",
      });
      await job.alarm();

      expect(chatRequests).toHaveLength(1);
      const msgs = chatRequests[0].messages.slice(1);
      expect(msgs).toHaveLength(3);
      expect(msgs[0].role).toBe("user");
      if (mode !== "missing-original") {
        expect(msgs[0].content).toEqual([{ type: "text", text: "キャッシュ外の質問" }]);
      }
      expect(msgs[1]).toEqual({
        role: "assistant",
        content: [
          {
            type: "text",
            text: sourceMode
              ? table
              : mode === "csv"
                ? `**表 1**\n${csv.slice(1).trimEnd().replaceAll("\r\n", "\n")}`
                : mode === "missing"
                  ? "**表 1**\n（元の表データを取得できませんでした）"
                  : mode === "missing-original"
                    ? "**表 1（2/2）**\n（元の表データを取得できませんでした）\n\n-# モデル: auto"
                    : "キャッシュ外の回答",
          },
        ],
      });
      expect(msgs[2]).toEqual({
        role: "user",
        content: [{ type: "text", text: "フォールバックの継続質問" }],
      });
      if (mode === "missing" || mode === "missing-original")
        expect(discord.messages.get("1").content).toContain(
          "元の回答の添付を一部読み込めませんでした",
        );
    },
  );

  test("continue job falls back to synthetic anchor when bot message is unparseable", async () => {
    const { state, env, kv, ready } = setup();
    await ready();
    kv.set("ai_registry", registry());
    state.setPref("123", "model", model().id);
    const discord = fakeDiscord();
    discord.messages.set("98", {
      id: "98",
      channel_id: "channel",
      author: { id: "app" },
      content: "旧形式のパース不能なメッセージ",
      attachments: [],
    });
    const chatRequests: any[] = [];
    spyOn(globalThis, "fetch").mockImplementation((async (url: string, options?: RequestInit) => {
      if (url.includes("/generation")) return json({ data: { total_cost: 0.001 } });
      if (url.includes("/chat/completions")) {
        const body = options?.body ? JSON.parse(String(options.body)) : null;
        chatRequests.push(body);
        return json({
          id: "g",
          model: model().id,
          choices: [{ message: { content: "アンカー回答" }, finish_reason: "stop" }],
        });
      }
      if (url.startsWith("https://discord.mock/")) return discord.handle(url, options);
      throw new Error(`unexpected request: ${url}`);
    }) as any);

    const job = new JobDO(context().ctx as any, env);
    await job.start({
      kind: "continue",
      token: "tok-anchor",
      userId: "123",
      ephemeral: true,
      prompt: "次の質問",
      channelId: "channel",
      messageId: "98",
    });
    await job.alarm();

    expect(chatRequests).toHaveLength(1);
    const msgs = chatRequests[0].messages.slice(1);
    expect(msgs).toHaveLength(3);
    expect(msgs[0].content[0].text).toBe("(以下は以前のやり取りの続きです)");
    expect(msgs[1].content[0].text).toBe("旧形式のパース不能なメッセージ");
    expect(msgs[2].content[0].text).toBe("次の質問");
  });
});
