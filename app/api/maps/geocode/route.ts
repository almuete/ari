import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type GeocodeReq = {
  address?: string;
};

export async function POST(req: Request) {
  try {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Server misconfigured: GOOGLE_MAPS_API_KEY is missing." },
        { status: 500 }
      );
    }

    const body = (await req.json().catch(() => ({}))) as GeocodeReq;
    const address = typeof body.address === "string" ? body.address.trim() : "";
    if (!address) {
      return NextResponse.json({ error: "address is required" }, { status: 400 });
    }

    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("address", address);
    url.searchParams.set("key", apiKey);

    const res = await fetch(url.toString(), { method: "GET" });
    const data = (await res.json().catch(() => ({}))) as {
      status?: string;
      error_message?: string;
      results?: Array<{
        formatted_address?: string;
        place_id?: string;
        geometry?: { location?: { lat?: number; lng?: number } };
      }>;
    };

    if (!res.ok) {
      return NextResponse.json(
        { error: `Maps geocode failed (${res.status})` },
        { status: 502 }
      );
    }

    const status = data.status || "UNKNOWN";
    if (status !== "OK") {
      return NextResponse.json(
        { error: data.error_message || `Maps geocode status: ${status}` },
        { status: 502 }
      );
    }

    const results = (data.results ?? [])
      .map((r) => ({
        formattedAddress: r.formatted_address ?? "",
        placeId: r.place_id ?? "",
        location: r.geometry?.location ?? null,
      }))
      .filter((r) => !!r.formattedAddress && !!r.location);

    const resp = NextResponse.json({ results, status });
    resp.headers.set("Cache-Control", "no-store");
    return resp;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

