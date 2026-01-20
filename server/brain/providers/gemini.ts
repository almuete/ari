import "server-only";
import { GoogleGenAI } from "@google/genai";
import { BRAIN_OUTPUT_STYLE_PROMPT, BRAIN_SYSTEM_PROMPT } from "../prompts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function buildSystemInstruction(args: { extraContext?: string }) {
  const extra = args.extraContext?.trim()
    ? `\n\nContext:\n${args.extraContext.trim()}`
    : "";
  return `${BRAIN_SYSTEM_PROMPT}\n\n${BRAIN_OUTPUT_STYLE_PROMPT}${extra}`.trim();
}

function extractTextParts(value: unknown): string {
  if (!isRecord(value)) return "";
  const parts = value.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((p) => (isRecord(p) && typeof p.text === "string" ? p.text : ""))
    .join("")
    .trim();
}

function extractResponseText(value: unknown): string {
  if (!isRecord(value)) return "";

  // SDK convenience accessor (common in @google/genai)
  if (typeof value.text === "string" && value.text.trim()) {
    return value.text.trim();
  }

  // Fallback to candidate parsing (mirrors REST response shape)
  const candidates = value.candidates;
  const candidate = Array.isArray(candidates) ? candidates[0] : null;
  const content = isRecord(candidate) ? candidate.content : null;
  const text = extractTextParts(content);
  return text;
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

  const model = options.model ?? "gemini-3-flash-preview";
  const ai = new GoogleGenAI({ apiKey });

  let response: unknown;
  try {
    response = await ai.models.generateContent({
      model,
      contents: options.transcript.trim(),
      config: {
        systemInstruction: buildSystemInstruction({ extraContext: options.extraContext }),
      },
    });
  } catch (err) {
    const message =
      err instanceof Error && err.message
        ? err.message
        : "Gemini request failed (unknown error)";
    throw new Error(message);
  }

  const text = extractResponseText(response);

  if (!text) throw new Error("Brain returned empty response");
  return text;
}

