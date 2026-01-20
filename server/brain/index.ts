import "server-only";
import OpenAI from "openai";
import { buildBrainMessages } from "./prompts";

let openai: OpenAI | null = null;

function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY environment variable");
  }
  openai ??= new OpenAI({ apiKey });
  return openai;
}

export interface BrainInput {
  transcript: string;
  /**
   * Optional extra context (user name, app mode, conversation state, etc.)
   */
  extraContext?: string;
}

export async function brain(input: BrainInput) {
  const transcript = input.transcript?.trim();
  if (!transcript) {
    throw new Error("Transcript is required");
  }

  const messages = buildBrainMessages({
    transcript,
    extraContext: input.extraContext,
  });

  const client = getOpenAIClient();

  const resp = await client.responses.create({
    model: "gpt-4.1",
    input: messages,
  });

  const output = resp.output_text?.trim();

  if (!output) {
    throw new Error("Brain returned empty response");
  }

  return output;
}
