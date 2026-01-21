import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type LatLng = { lat: number; lng: number };

type PlacesReq = {
  query?: string;
  location?: LatLng | null;
  radiusMeters?: number;
  maxResults?: number;
};

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function normalizeLocation(value: unknown): LatLng | null {
  if (!value || typeof value !== "object") return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lat = (value as any).lat;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lng = (value as any).lng;
  if (!isFiniteNumber(lat) || !isFiniteNumber(lng)) return null;
  return { lat, lng };
}

export async function POST(req: Request) {
  try {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Server misconfigured: GOOGLE_MAPS_API_KEY is missing." },
        { status: 500 }
      );
    }

    const body = (await req.json().catch(() => ({}))) as PlacesReq;
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (!query) {
      return NextResponse.json({ error: "query is required" }, { status: 400 });
    }

    const location = normalizeLocation(body.location);
    const radiusMeters =
      isFiniteNumber(body.radiusMeters) && body.radiusMeters > 0
        ? Math.floor(body.radiusMeters)
        : undefined;
    const maxResults =
      isFiniteNumber(body.maxResults) && body.maxResults > 0
        ? Math.min(20, Math.floor(body.maxResults))
        : 5;

    const url = new URL("https://maps.googleapis.com/maps/api/place/textsearch/json");
    url.searchParams.set("query", query);
    if (location && radiusMeters) {
      url.searchParams.set("location", `${location.lat},${location.lng}`);
      url.searchParams.set("radius", String(radiusMeters));
    }
    url.searchParams.set("key", apiKey);

    const res = await fetch(url.toString(), { method: "GET" });
    const data = (await res.json().catch(() => ({}))) as {
      status?: string;
      error_message?: string;
      results?: Array<{
        name?: string;
        formatted_address?: string;
        place_id?: string;
        rating?: number;
        user_ratings_total?: number;
        geometry?: { location?: { lat?: number; lng?: number } };
        types?: string[];
      }>;
    };

    if (!res.ok) {
      return NextResponse.json(
        { error: `Maps places search failed (${res.status})` },
        { status: 502 }
      );
    }

    const status = data.status || "UNKNOWN";
    if (status !== "OK" && status !== "ZERO_RESULTS") {
      return NextResponse.json(
        { error: data.error_message || `Maps places status: ${status}` },
        { status: 502 }
      );
    }

    const places = (data.results ?? [])
      .slice(0, maxResults)
      .map((r) => ({
        name: r.name ?? "",
        address: r.formatted_address ?? "",
        placeId: r.place_id ?? "",
        location: r.geometry?.location ?? null,
        rating: r.rating ?? null,
        userRatingsTotal: r.user_ratings_total ?? null,
        types: Array.isArray(r.types) ? r.types : [],
      }))
      .filter((p) => !!p.name);

    const resp = NextResponse.json({ status, places });
    resp.headers.set("Cache-Control", "no-store");
    return resp;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

