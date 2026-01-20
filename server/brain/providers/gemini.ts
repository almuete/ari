import "server-only";
import { BRAIN_OUTPUT_STYLE_PROMPT, BRAIN_SYSTEM_PROMPT } from "../prompts";

function buildSystemInstruction(args: { extraContext?: string }) {
  const extra = args.extraContext?.trim()
    ? `\n\nContext:\n${args.extraContext.trim()}`
    : "";
  return `${BRAIN_SYSTEM_PROMPT}\n\n${BRAIN_OUTPUT_STYLE_PROMPT}${extra}`.trim();
}

function extractTextParts(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const anyVal = value as any;
  const parts = anyVal.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
    .join("")
    .trim();
}

export interface GeminiBrainOptions {
  transcript: string;
  extraContext?: string;
  model?: string;
}

export async function generateGeminiBrainReply(
  options: GeminiBrainOptions
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY environment variable");

  const model = options.model ?? "gemini-1.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const body = {
    systemInstruction: {
      parts: [{ text: buildSystemInstruction({ extraContext: options.extraContext }) }],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: options.transcript.trim() }],
      },
    ],
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = (await resp.json().catch(() => null)) as any;

  if (!resp.ok) {
    const message =
      typeof data?.error?.message === "string"
        ? data.error.message
        : `Gemini request failed (${resp.status})`;
    throw new Error(message);
  }

  const candidate = Array.isArray(data?.candidates) ? data.candidates[0] : null;
  const text = extractTextParts(candidate?.content);

  if (!text) throw new Error("Brain returned empty response");
  return text;
}

