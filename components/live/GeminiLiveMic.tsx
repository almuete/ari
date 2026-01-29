"use client";

import VoiceWave from "@/components/speech/VoiceWave";
import { BiRefresh } from "react-icons/bi";
import { useGeminiLiveSession } from "@/components/live/gemini/useGeminiLiveSession";

export default function GeminiLiveMic() {
  const { connected, streaming, logs, clearLogs, startMic, stopMic } =
    useGeminiLiveSession({ autoConnect: true });

  return (
    <div>
      <div className="relative ">
        <div className="flex flex-col items-center gap-2">
          <button
            onClick={streaming ? () => void stopMic() : () => void startMic()}
            className="cursor-pointer"
            aria-label={streaming ? "Stop microphone" : "Start microphone"}
          >
            <VoiceWave
              active={true}
              color={streaming ? "#FF9500" : "green"}
              glow
              sensitivity={8}
              size={320}
              className="rounded-full"
            />
          </button>

          <span className="text-sm text-gray-500">
            {connected ? (streaming ? "Streaming" : "") : ""}
          </span>
        </div>

        <div className="relative w-sm">
          <div className="border border-gray-200 rounded-md p-2">
            {logs.length === 0 ? (
              <div>—</div>
            ) : (
              <ul className="overflow-y-auto max-h-[200px]">
                {logs.map((l) => (
                  <li key={l.t + l.msg} className="text-sm text-gray-500 text-left">
                    <span>
                      {new Date(l.t).toLocaleTimeString()}
                    </span>{" "}
                    <span>{l.msg}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="text-right absolute -top-4 -right-4 ">
            <button
              onClick={clearLogs}
              className="cursor-pointer text-right bg-white rounded-full p-2 border border-gray-200"
            >
              <BiRefresh className="text-2xl" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

