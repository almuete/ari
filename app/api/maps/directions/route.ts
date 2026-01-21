import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type LatLng = { lat: number; lng: number };

type DirectionsReq = {
  origin?: string | LatLng | null;
  destination?: string | LatLng | null;
  mode?: string;
};

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function normalizeLatLng(value: unknown): LatLng | null {
  if (!value || typeof value !== "object") return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lat = (value as any).lat;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lng = (value as any).lng;
  if (!isFiniteNumber(lat) || !isFiniteNumber(lng)) return null;
  return { lat, lng };
}

function normalizeEndpoint(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  const ll = normalizeLatLng(value);
  if (ll) return `${ll.lat},${ll.lng}`;
  return null;
}

function normalizeMode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const mode = value.trim().toLowerCase();
  if (!mode) return undefined;
  const allowed = new Set(["driving", "walking", "bicycling", "transit"]);
  return allowed.has(mode) ? mode : undefined;
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

    const body = (await req.json().catch(() => ({}))) as DirectionsReq;
    const origin = normalizeEndpoint(body.origin);
    const destination = normalizeEndpoint(body.destination);
    const mode = normalizeMode(body.mode);

    if (!origin) {
      return NextResponse.json({ error: "origin is required" }, { status: 400 });
    }
    if (!destination) {
      return NextResponse.json({ error: "destination is required" }, { status: 400 });
    }

    const url = new URL("https://maps.googleapis.com/maps/api/directions/json");
    url.searchParams.set("origin", origin);
    url.searchParams.set("destination", destination);
    if (mode) url.searchParams.set("mode", mode);
    url.searchParams.set("key", apiKey);

    const res = await fetch(url.toString(), { method: "GET" });
    const data = (await res.json().catch(() => ({}))) as {
      status?: string;
      error_message?: string;
      routes?: Array<{
        summary?: string;
        overview_polyline?: { points?: string };
        legs?: Array<{
          distance?: { text?: string; value?: number };
          duration?: { text?: string; value?: number };
          start_address?: string;
          end_address?: string;
          steps?: Array<{
            html_instructions?: string;
            distance?: { text?: string; value?: number };
            duration?: { text?: string; value?: number };
          }>;
        }>;
      }>;
    };

    if (!res.ok) {
      return NextResponse.json(
        { error: `Maps directions failed (${res.status})` },
        { status: 502 }
      );
    }

    const status = data.status || "UNKNOWN";
    if (status !== "OK") {
      return NextResponse.json(
        { error: data.error_message || `Maps directions status: ${status}` },
        { status: 502 }
      );
    }

    const route = data.routes?.[0];
    const leg = route?.legs?.[0];

    const result = {
      status,
      summary: route?.summary ?? "",
      polyline: route?.overview_polyline?.points ?? "",
      startAddress: leg?.start_address ?? "",
      endAddress: leg?.end_address ?? "",
      distance: leg?.distance ?? null,
      duration: leg?.duration ?? null,
      steps:
        leg?.steps?.slice(0, 20).map((s) => ({
          instructionHtml: s.html_instructions ?? "",
          distance: s.distance ?? null,
          duration: s.duration ?? null,
        })) ?? [],
    };

    const resp = NextResponse.json(result);
    resp.headers.set("Cache-Control", "no-store");
    return resp;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

