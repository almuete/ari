// Ephemeral tokens are supported in v1alpha + constrained endpoint.
export const WS_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";

export const MODEL = "models/gemini-2.5-flash-native-audio-preview-12-2025";

// Per docs: input 16-bit PCM, 16kHz mono; output audio typically 24kHz.
export const SEND_SAMPLE_RATE = 16000;
export const RECEIVE_SAMPLE_RATE = 24000;

// Send ~20ms frames (16000 * 0.02 = 320 samples)
export const FRAME_SAMPLES = 320;

// Live API does not support stop_sequences in generation_config for the
// constrained bidi endpoint. We emulate it client-side.
export const STOP_SEQUENCES = [
  "bye",
  "bye bye",
  "goodbye",
  "good bye",
  "see you later",
  "see you soon",
  "see you tomorrow",
  "see you next time",
  "see you next week",
  "see you next month",
  "see you next year",
  "see you next decade",
  "see you next century",
  "see you next millennium",
] as const;

// Phrases that should INTERRUPT the current model response, but keep the session open.
// Ref: Live API docs: any `clientContent` message interrupts current model generation.
export const INTERRUPT_SEQUENCES = ["stop it", "stop talking", "stop speaking"] as const;

function escapeRegexLiteral(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createStopSequenceRegex() {
  return new RegExp(`\\b(?:${STOP_SEQUENCES.map(escapeRegexLiteral).join("|")})\\b`, "i");
}

export function createInterruptSequenceRegex() {
  return new RegExp(`\\b(?:${INTERRUPT_SEQUENCES.map(escapeRegexLiteral).join("|")})\\b`, "i");
}

export const MAPS_FUNCTION_DECLARATIONS = [
  {
    name: "maps_geocode",
    description: "Convert a human address into latitude/longitude (geocoding).",
    parameters: {
      type: "object",
      properties: {
        address: { type: "string", description: "The address to geocode." },
      },
      required: ["address"],
    },
  },
  {
    name: "maps_search_places",
    description:
      "Search places using a text query, optionally biased near a given location.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: 'Search query, e.g. "coffee near Makati".',
        },
        location_lat: {
          type: "number",
          description:
            "Optional latitude for location bias (requires location_lng too).",
        },
        location_lng: {
          type: "number",
          description:
            "Optional longitude for location bias (requires location_lat too).",
        },
        radius_meters: {
          type: "number",
          description:
            "Optional radius in meters for location-bias searches (e.g. 2000).",
        },
        max_results: {
          type: "number",
          description: "Optional max number of results to return (default 5).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "maps_directions",
    description:
      "Get route directions between an origin and destination (driving/walking/etc).",
    parameters: {
      type: "object",
      properties: {
        origin_address: {
          type: "string",
          description:
            "Origin address string. Provide this OR origin_lat+origin_lng.",
        },
        origin_lat: {
          type: "number",
          description:
            "Origin latitude. Provide this AND origin_lng (or use origin_address).",
        },
        origin_lng: {
          type: "number",
          description:
            "Origin longitude. Provide this AND origin_lat (or use origin_address).",
        },
        destination_address: {
          type: "string",
          description:
            "Destination address string. Provide this OR destination_lat+destination_lng.",
        },
        destination_lat: {
          type: "number",
          description:
            "Destination latitude. Provide this AND destination_lng (or use destination_address).",
        },
        destination_lng: {
          type: "number",
          description:
            "Destination longitude. Provide this AND destination_lat (or use destination_address).",
        },
        mode: {
          type: "string",
          description:
            'Travel mode: "driving" | "walking" | "bicycling" | "transit".',
        },
      },
      required: [],
    },
  },
] as const;

export const WEB_FUNCTION_DECLARATIONS = [
  {
    name: "web_search",
    description:
      "Search the public web for up-to-date information and return relevant results with titles, URLs, and snippets.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        max_results: {
          type: "number",
          description: "Optional max number of results to return (default 5).",
        },
      },
      required: ["query"],
    },
  },
] as const;

export const DEFAULT_SYSTEM_INSTRUCTION_TEXT = [
  "You are a helpful and friendly AI assistant.",
  "You have access to Google Maps tools for geocoding, places search, and directions.",
  "When you need real-world location info, call the appropriate maps_* tool instead of guessing.",
  "You also have access to a web_search tool for up-to-date information. Use it when you need current facts.",
  "When using web_search results, cite sources by including the URL in your answer.",
  "If the user’s location is ambiguous, ask a brief follow-up question.",
].join("\n");

// When server sends `goAway.timeLeft`, reconnect slightly before it disconnects.
// Ref: https://ai.google.dev/api/live#GoAway
export const GO_AWAY_AUTO_RECONNECT_DEFAULT = true;
export const GO_AWAY_RECONNECT_BEFORE_MS_DEFAULT = 2500;

// Many sessions won’t receive `goAway` (depends on endpoint/close reason).
// This provides an estimated countdown so the UI can still show time left.
// Docs mention Live sessions are typically limited to ~10 minutes.
export const SESSION_MAX_DURATION_MS_DEFAULT = 10 * 60 * 1000;

