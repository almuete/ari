import type { GeminiFunctionCall, MapLatLng } from "./types";

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function toLatLng(value: unknown): MapLatLng | null {
  if (!value || typeof value !== "object") return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lat = (value as any).lat;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lng = (value as any).lng;
  if (!isFiniteNumber(lat) || !isFiniteNumber(lng)) return null;
  return { lat, lng };
}

export function readFirstString(
  root: unknown,
  paths: string[][]
): string | null {
  for (const path of paths) {
    let cur: unknown = root;
    for (const key of path) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cur = (cur as any)?.[key];
    }
    if (typeof cur === "string" && cur.trim().length) return cur;
  }
  return null;
}

export function extractFunctionCalls(msg: unknown): GeminiFunctionCall[] | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toolCall = (msg as any).toolCall ?? (msg as any).tool_call;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const functionCalls = (toolCall as any)?.functionCalls ?? (toolCall as any)?.function_calls;
  return Array.isArray(functionCalls) ? (functionCalls as GeminiFunctionCall[]) : null;
}

