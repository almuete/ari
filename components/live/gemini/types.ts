export type LogItem = { t: number; level: "info" | "warn" | "error"; msg: string };

export type MapLatLng = { lat: number; lng: number };

export type GeminiFunctionCall = {
  id?: string;
  name?: string;
  args?: unknown;
};

