import GeminiLiveMic from "@/components/live/GeminiLiveMic";
import SpeechToText from "@/components/speech/SpeechToText";
import { TbRobot } from "react-icons/tb";

export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center h-screen">
      <div className="flex items-center justify-center text-4xl font-bold">
        <h1>ARI</h1>
        <TbRobot />
      </div>
      {/*<SpeechToText />*/}
      <GeminiLiveMic />
    </div>
  );
}
