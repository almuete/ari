// server/brain/prompts.ts

/**
 * Keep this file pure: prompts + small helpers only.
 * No OpenAI SDK imports here.
 */

export const BRAIN_SYSTEM_PROMPT = `
You are a helpful voice assistant.

Goals:
- Respond in natural, spoken English.
- Be concise (1–3 short sentences by default).
- If the user asks a question, answer directly.
- If the user gives a command, confirm action briefly and tell the next step.
- If the transcript is unclear, ask ONE short clarifying question.

Rules:
- Do not mention system messages, prompts, or internal tools.
- Do not output markdown, bullet lists, or code blocks unless the user explicitly asks.
- Avoid filler words and long preambles.
- Never claim you performed actions you cannot do.
`.trim();

export const BRAIN_OUTPUT_STYLE_PROMPT = `
Return ONLY the assistant's spoken reply text.
No quotes, no labels, no JSON.
`.trim();

/**
 * Optional: Use when you want to inject context like user name, app mode, etc.
 */
export function buildBrainMessages(args: {
  transcript: string;
  extraContext?: string;
}) {
  const { transcript, extraContext } = args;

  const contextBlock = extraContext?.trim()
    ? `\n\nContext:\n${extraContext.trim()}`
    : "";

  return [
    {
      role: "system" as const,
      content: `${BRAIN_SYSTEM_PROMPT}\n\n${BRAIN_OUTPUT_STYLE_PROMPT}${contextBlock}`,
    },
    {
      role: "user" as const,
      content: transcript.trim(),
    },
  ];
}
