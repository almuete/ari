import { NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Server misconfigured: GEMINI_API_KEY is missing." },
        { status: 500 }
      );
    }

    const now = Date.now();
    const expireTime = new Date(now + 15 * 60 * 1000).toISOString(); // 15 minutes
    const newSessionExpireTime = new Date(now + 60 * 1000).toISOString(); // must start soon

    // Use the official SDK for token creation (v1alpha only).
    const ai = new GoogleGenAI({ apiKey, apiVersion: "v1alpha" });
    const created = await ai.authTokens.create({
      config: {
        uses: 1,
        expireTime,
        newSessionExpireTime,
      },
    });

    const token = created?.name;
    if (!token) {
      return NextResponse.json({ error: "Token creation failed." }, { status: 502 });
    }

    const resp = NextResponse.json({ token });
    resp.headers.set("Cache-Control", "no-store");
    return resp;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

