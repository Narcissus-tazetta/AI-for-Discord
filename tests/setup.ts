import { afterEach, mock } from "bun:test";

// Durable Object classes extend this runtime-only base class; tests construct them directly
// with an in-memory storage double instead.
mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      public ctx: any,
      public env: any,
    ) {}
  },
}));

// Wrangler imports these as compiled WASM and binary data. Bun imports both as paths.
const wasm = await Bun.file(
  new URL(import.meta.resolve("@resvg/resvg-wasm/index_bg.wasm")),
).arrayBuffer();
const font = await Bun.file(
  new URL("../src/discord/fonts/discord-table-sans.otf", import.meta.url),
).arrayBuffer();
mock.module("@resvg/resvg-wasm/index_bg.wasm", () => ({ default: new WebAssembly.Module(wasm) }));
mock.module("../src/discord/fonts/discord-table-sans.otf", () => ({ default: font }));

afterEach(() => mock.restore());
