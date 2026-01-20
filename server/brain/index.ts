import "server-only";
import { buildBrainMessages } from "./prompts";
import type { BrainProvider } from "@/types/brain";
import { generateOpenAIBrainReply } from "./providers/openai";
import { generateGeminiBrainReply } from "./providers/gemini";
import { console } from "inspector";

function normalizeProvider(value: string | undefined): BrainProvider {
  return value === "openai" || value === "gemini" ? value : "openai";
}

export interface BrainInput {
  transcript: string;
  /**
   * Optional extra context (user name, app mode, conversation state, etc.)
   */
  extraContext?: string;
}

export interface BrainOptions {
  provider?: BrainProvider;
  /**
   * Provider-specific model override (ex: "gpt-4.1", "gemini-1.5-flash")
   */
  model?: string;
}

const DEFAULTS = {
  provider: normalizeProvider(process.env.BRAIN_PROVIDER),
} as const;

export async function brain(input: BrainInput, options: BrainOptions = {}) {

  const transcript = input.transcript?.trim();
  if (!transcript) {
    throw new Error("Transcript is required");
  }

  const messages = buildBrainMessages({
    transcript,
    extraContext: input.extraContext,
  });

  const provider = options.provider ?? DEFAULTS.provider;

  switch (provider) {
    case "openai":
      return generateOpenAIBrainReply({
        messages,
        model: options.model,
      });

    case "gemini":
      return generateGeminiBrainReply({
        transcript,
        extraContext: input.extraContext,
        model: options.model,
      });

    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unsupported brain provider: ${_exhaustive}`);
    }
  }
}
