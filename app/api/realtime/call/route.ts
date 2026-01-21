import "server-only";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type RealtimeCallRequest = {
  sdp: string;
  model?: string;
  voice?: string;
  instructions?: string;
};

export async function POST(req: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Missing OPENAI_API_KEY environment variable" },
        { status: 500 }
      );
    }

    const body = (await req.json()) as Partial<RealtimeCallRequest>;
    // Normalize SDP to CRLF (some parsers are picky) and ensure it ends with newline.
    const sdp = body.sdp
      ?.replace(/\r?\n/g, "\r\n")
      .trim()
      .concat("\r\n");
    if (!sdp) {
      return NextResponse.json({ error: "sdp is required" }, { status: 400 });
    }
    if (!sdp.startsWith("v=")) {
      return NextResponse.json({ error: "Invalid SDP offer" }, { status: 400 });
    }

    // NOTE: Some Realtime deployments reject `session.type` (unknown_parameter).
    // Keep the session payload to widely-supported keys only.
    const session: Record<string, unknown> = {
      model: body.model ?? "gpt-realtime",
      voice: body.voice ?? "alloy",
    };
    if (body.instructions) session.instructions = body.instructions;

    // Docs: https://platform.openai.com/docs/api-reference/realtime/create-call
    const form = new FormData();
    // IMPORTANT: OpenAI expects `sdp` as a simple form field (string),
    // not a file/blob part.
    form.set("sdp", sdp);
    form.set("session", JSON.stringify(session));

    const upstream = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        // Some orgs/accounts still require this opt-in header for Realtime.
        "OpenAI-Beta": "realtime=v1",
      },
      body: form,
    });

    const answerSdp = await upstream.text();
    if (!upstream.ok) {
      return NextResponse.json(
        { error: answerSdp || "Realtime call creation failed" },
        { status: upstream.status }
      );
    }

    const location = upstream.headers.get("location") ?? undefined;
    const callId = location?.split("/").pop();

    return NextResponse.json({ sdpAnswer: answerSdp, callId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

