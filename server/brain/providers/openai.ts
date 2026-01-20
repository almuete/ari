import "server-only";
import OpenAI from "openai";

let openai: OpenAI | null = null;

function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY environment variable");
  openai ??= new OpenAI({ apiKey });
  return openai;
}

type BrainMessage = { role: "system" | "user" | "assistant"; content: string };

export interface OpenAIBrainOptions {
  messages: BrainMessage[];
  model?: string;
}

export async function generateOpenAIBrainReply(
  options: OpenAIBrainOptions
): Promise<string> {
  const client = getOpenAIClient();

  const resp = await client.responses.create({
    model: options.model ?? "gpt-4.1",
    input: options.messages,
  });

  const output = resp.output_text?.trim();
  if (!output) throw new Error("Brain returned empty response");
  return output;
}

