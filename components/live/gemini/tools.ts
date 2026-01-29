import { postJson } from "./net";
import { isFiniteNumber, toLatLng } from "./message";

export async function runGeminiTool(name: string, args: unknown) {
  if (name === "maps_geocode") {
    const address =
      typeof (args as { address?: unknown } | undefined)?.address === "string"
        ? (args as { address: string }).address
        : "";
    return await postJson("/api/maps/geocode", { address });
  }

  if (name === "maps_search_places") {
    const a = args as
      | {
          query?: unknown;
          location_lat?: unknown;
          location_lng?: unknown;
          radius_meters?: unknown;
          max_results?: unknown;
          // Back-compat if model sends camelCase anyway
          radiusMeters?: unknown;
          maxResults?: unknown;
        }
      | undefined;
    const query = typeof a?.query === "string" ? a.query : "";
    const locationLat = isFiniteNumber(a?.location_lat) ? a.location_lat : null;
    const locationLng = isFiniteNumber(a?.location_lng) ? a.location_lng : null;
    const location =
      locationLat !== null && locationLng !== null
        ? { lat: locationLat, lng: locationLng }
        : null;
    const radiusMeters = isFiniteNumber(a?.radius_meters)
      ? a?.radius_meters
      : isFiniteNumber(a?.radiusMeters)
        ? a?.radiusMeters
        : undefined;
    const maxResults = isFiniteNumber(a?.max_results)
      ? a?.max_results
      : isFiniteNumber(a?.maxResults)
        ? a?.maxResults
        : undefined;
    return await postJson("/api/maps/places", {
      query,
      location,
      radiusMeters,
      maxResults,
    });
  }

  if (name === "maps_directions") {
    const a = args as
      | {
          origin_address?: unknown;
          origin_lat?: unknown;
          origin_lng?: unknown;
          destination_address?: unknown;
          destination_lat?: unknown;
          destination_lng?: unknown;
          // Back-compat if model sends these anyway
          origin?: unknown;
          destination?: unknown;
          mode?: unknown;
        }
      | undefined;

    const origin =
      typeof a?.origin_address === "string" && a.origin_address.trim()
        ? a.origin_address.trim()
        : isFiniteNumber(a?.origin_lat) && isFiniteNumber(a?.origin_lng)
          ? { lat: a.origin_lat, lng: a.origin_lng }
          : typeof a?.origin === "string"
            ? a.origin
            : toLatLng(a?.origin);

    const destination =
      typeof a?.destination_address === "string" && a.destination_address.trim()
        ? a.destination_address.trim()
        : isFiniteNumber(a?.destination_lat) && isFiniteNumber(a?.destination_lng)
          ? { lat: a.destination_lat, lng: a.destination_lng }
          : typeof a?.destination === "string"
            ? a.destination
            : toLatLng(a?.destination);
    const mode = typeof a?.mode === "string" ? a.mode : undefined;

    return await postJson("/api/maps/directions", { origin, destination, mode });
  }

  if (name === "web_search") {
    const a = args as
      | {
          query?: unknown;
          max_results?: unknown;
          // Back-compat if model sends camelCase anyway
          maxResults?: unknown;
        }
      | undefined;
    const query = typeof a?.query === "string" ? a.query : "";
    const maxResults = isFiniteNumber(a?.max_results)
      ? a?.max_results
      : isFiniteNumber(a?.maxResults)
        ? a?.maxResults
        : undefined;
    return await postJson("/api/web/search", { query, maxResults });
  }

  throw new Error(`Unknown tool: ${name}`);
}

