import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type WebSearchReq = {
  query?: string;
  maxResults?: number;
};

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export async function POST(req: Request) {
  try {
    const apiKey = process.env.SERPER_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        {
          error:
            "Server misconfigured: SERPER_API_KEY is missing. Set it to enable web_search.",
        },
        { status: 500 }
      );
    }

    const body = (await req.json().catch(() => ({}))) as WebSearchReq;
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (!query) {
      return NextResponse.json({ error: "query is required" }, { status: 400 });
    }

    const maxResults =
      isFiniteNumber(body.maxResults) && body.maxResults > 0
        ? Math.min(10, Math.floor(body.maxResults))
        : 5;

    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": apiKey,
      },
      body: JSON.stringify({ q: query, num: maxResults }),
    });

    const data = (await res.json().catch(() => ({}))) as {
      organic?: Array<{
        title?: string;
        link?: string;
        snippet?: string;
        position?: number;
        date?: string;
        source?: string;
      }>;
      knowledgeGraph?: unknown;
      answerBox?: unknown;
      error?: string;
    };

    if (!res.ok) {
      return NextResponse.json(
        { error: data?.error || `Web search failed (${res.status})` },
        { status: 502 }
      );
    }

    const results = (data.organic ?? [])
      .slice(0, maxResults)
      .map((r) => ({
        title: r.title ?? "",
        url: r.link ?? "",
        snippet: r.snippet ?? "",
        position: r.position ?? null,
        date: r.date ?? null,
        source: r.source ?? null,
      }))
      .filter((r) => !!r.title && !!r.url);

    const resp = NextResponse.json({
      query,
      results,
      // Keeping these for richer responses when available.
      answerBox: data.answerBox ?? null,
      knowledgeGraph: data.knowledgeGraph ?? null,
    });
    resp.headers.set("Cache-Control", "no-store");
    return resp;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

