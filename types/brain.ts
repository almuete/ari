// types/brain.ts
export type BrainProvider = "openai" | "google";

export interface BrainRequest {
  transcript: string;
  /**
   * Optional extra context (user name, app mode, conversation state, etc.)
   */
  extraContext?: string;
  provider?: BrainProvider;
  model?: string;
}

export type BrainResponseText = string;

