import type { DiscordAttachment } from "../shared/types";
import type { DiscordUpload } from "./api";

export const ANSWER_SOURCE_FILENAME = "answer-source.md";
const MAX_SOURCE_BYTES = 256 * 1024;

export function answerSource(header: string, body: string): DiscordUpload | null {
  const data = new Blob([header, body], { type: "text/markdown; charset=utf-8" });
  return data.size <= MAX_SOURCE_BYTES
    ? { filename: ANSWER_SOURCE_FILENAME, description: "回答の元テキスト（表を含む）", data }
    : null;
}

export async function readAnswerSource(attachment: DiscordAttachment): Promise<string | null> {
  if (!(attachment.size > 0 && attachment.size <= MAX_SOURCE_BYTES)) return null;
  const url = URL.parse(attachment.url);
  if (
    url?.origin !== "https://cdn.discordapp.com" ||
    url.username ||
    url.password ||
    !url.pathname.startsWith("/attachments/")
  )
    return null;

  try {
    const response = await fetch(url.toString(), {
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || Number(response.headers.get("content-length")) > MAX_SOURCE_BYTES) {
      await response.body?.cancel();
      console.log(`history: attachment unavailable (status ${response.status})`);
      return null;
    }
    if (!response.body) return null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
    let size = 0;
    let text = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return text + decoder.decode();
        size += value.length;
        if (size > MAX_SOURCE_BYTES) {
          console.log("history: attachment exceeded the source size limit");
          return null;
        }
        text += decoder.decode(value, { stream: true });
      }
    } finally {
      try {
        await reader.cancel();
      } finally {
        reader.releaseLock();
      }
    }
  } catch (error) {
    console.log(
      `history: could not read answer attachment (${error instanceof Error ? error.name : "unknown"})`,
    );
    return null;
  }
}
