import WebSocket, { WebSocket as WS } from "ws";
import { sendOpenAIMessage, updateOpenAISession } from "./lib/openaiRelay";
import { parseOpenAIMessage } from "./lib/messageParser";
import { v4 as uuidv4 } from "uuid";
import * as dotenv from "dotenv";
import querystring from "querystring";

dotenv.config();

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY!;
const VOICE_ID = process.env.VOICE_ID!;
const MODEL_ID = "eleven_flash_v2_5";
type Word = {
  text: string;
  confidence: number;
  start: number;
  end: number;
  word_is_final: boolean;
};
export default function handleConnection(clientSocket: WS): void {
  console.log("[Client] Connected");

  const OPENAI_URL = process.env.OPENAI_URL!;
  const OPENAI_KEY = process.env.OPENAI_API_KEY!;
  const ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_KEY!;

  if (!OPENAI_URL || !OPENAI_KEY || !ASSEMBLYAI_KEY) {
    throw new Error("Missing env variables");
  }

  const openaiSocket = new WebSocket(OPENAI_URL, {
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  // AssemblyAI v3 Streaming Setup
  const CONNECTION_PARAMS = {
    sample_rate: 16000,
    format_turns: true,
  };
  const API_ENDPOINT = `wss://streaming.assemblyai.com/v3/ws?${querystring.stringify(CONNECTION_PARAMS)}`;

  const assemblySocket = new WebSocket(API_ENDPOINT, {
    headers: {
      Authorization: ASSEMBLYAI_KEY,
    },
  });

  let currentTTS: WebSocket | null = null;
  let activeTurnId: string | null = null;

  openaiSocket.on("open", () => {
    console.log("[OpenAI] Connected");
    let sessionInitialized = false;

    clientSocket.on("message", async (msg: WebSocket.RawData) => {
      try {
        if (typeof msg === "string" || isProbablyJson(msg)) {
          const data = JSON.parse(msg.toString());

          if (data.type === "start_chat" && data.user && !sessionInitialized) {
            const { name, email } = data.user;
            sessionInitialized = true;

            const instructions = `
You are a helpful AI assistant in a customer support chat.
The user's name is ${name || "Guest"} and their email is ${email || "unknown@example.com"}.
Greet the user and assist them in a concise and helpful manner.
            `.trim();

            updateOpenAISession(openaiSocket, instructions);
            sendOpenAIMessage(openaiSocket, "hi");
          } else if (typeof data.text === "string" && data.text.trim()) {
            activeTurnId = uuidv4();

            if (currentTTS && currentTTS.readyState === WS.OPEN) {
              currentTTS.close();
              clientSocket.send(JSON.stringify({ type: "stop_audio", turnId: activeTurnId }));
            }

            sendOpenAIMessage(openaiSocket, data.text.trim());
          }

          return;
        }

        // Binary = audio stream
        if (Buffer.isBuffer(msg) && assemblySocket.readyState === WS.OPEN) {
          assemblySocket.send(msg);
        }
      } catch (err) {
        console.error("[Server] Failed to handle client message:", err);
      }
    });

    openaiSocket.on("message", async (msg: WebSocket.RawData) => {
      const parsed = parseOpenAIMessage(msg.toString());
      if (!parsed || clientSocket.readyState !== WS.OPEN) return;

      if (parsed.type === "text_delta" && parsed.content) {
        clientSocket.send(JSON.stringify({
          type: "partial_response",
          text: parsed.content,
          turnId: activeTurnId,
        }));
      }

      if (parsed.type === "text_done" && parsed.content) {
        const turnId = activeTurnId;
        console.log("[OpenAI] Final response", turnId, parsed.content);

        clientSocket.send(JSON.stringify({
          type: "final_response",
          text: parsed.content,
          turnId,
        }));

    const ttsWs = new WebSocket(
      `wss://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream-input?model_id=${MODEL_ID}&output_format=pcm_16000&sync_alignment=true`,
      {
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
        },
      }
    );

        currentTTS = ttsWs;
        let audioSent = false;

        ttsWs.on("open", () => {
          console.log("[TTS] Started", turnId);

          ttsWs.send(JSON.stringify({
            text: " ",
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.8,
              use_speaker_boost: false,
            },
            generation_config: {
              chunk_length_schedule: [120, 160, 250, 290],
            },
          }));

setTimeout(() => {
  ttsWs.send(JSON.stringify({ text: parsed.content, flush: true }));
  ttsWs.send(JSON.stringify({ text: "" }));
}, 60); // kasih delay kecil (50-100ms)
        });

        ttsWs.on("message", (event) => {
          try {
            const data = JSON.parse(event.toString());
            if (data.audio && ttsWs === currentTTS) {
              if (!audioSent) audioSent = true;

              clientSocket.send(JSON.stringify({
                type: "tts_audio",
                audio: data.audio,
                turnId,
              }));

              console.log("[TTS] Sent audio chunk", turnId, data.audio.length);
            }
          } catch (err) {
            console.error("[TTS] Message parse error:", err);
          }
        });

        ttsWs.on("close", () => {
          console.log("[TTS] Closed", turnId);
          if (currentTTS === ttsWs) currentTTS = null;
        });

        ttsWs.on("error", (err) => {
          console.error("[TTS] WS error:", err.message);
        });
      }

      if (parsed.type === "ping") {
        clientSocket.send(JSON.stringify({ type: "ping" }));
      }
    });
  });

  assemblySocket.on("open", () => {
    console.log("[AssemblyAI] Connected");
  });

 assemblySocket.on("message", (msg) => {
  try {
    const data = JSON.parse(msg.toString());

    if (
      data.type === "Turn" &&
      data.transcript &&
      data.turn_is_formatted === true &&
      data.end_of_turn === true
    ) {
   const transcript = data.transcript.trim();
  const minWordConfidence = 0.75;

  // Skip kalau semua kata confidence-nya jelek atau terlalu pendek
  const validWords = (data.words as Word[]).filter((w) => w.confidence >= minWordConfidence);
  if (!transcript || transcript.length < 2 || validWords.length === 0) return;


      const turnId = uuidv4();
      activeTurnId = turnId;

      console.log(`[AssemblyAI] Transcript (${turnId}):`, transcript);

      if (currentTTS && currentTTS.readyState === WS.OPEN) {
        currentTTS.close();
        clientSocket.send(JSON.stringify({ type: "stop_audio", turnId }));
      }

      sendOpenAIMessage(openaiSocket, transcript);
      clientSocket.send(JSON.stringify({ type: "transcript", text: transcript, turnId }));
    }
  } catch (err) {
    console.error("[AssemblyAI] Parse error:", err);
  }
});

  assemblySocket.on("close", (code, reason) => {
    console.log(`[AssemblyAI] Closed: ${code}, reason: ${reason}`);
    cleanup();
  });

  assemblySocket.on("error", (err) => {
    console.error("[AssemblyAI WS Error]:", err.message);
    cleanup();
  });

  const cleanup = () => {
    if (openaiSocket.readyState === WS.OPEN) openaiSocket.close();
    if (assemblySocket.readyState === WS.OPEN) assemblySocket.close();
    if (clientSocket.readyState === WS.OPEN) clientSocket.close();
    if (currentTTS && currentTTS.readyState === WS.OPEN) currentTTS.close();
    console.log("[Session] Closed");
  };

  clientSocket.on("close", cleanup);
  openaiSocket.on("close", cleanup);
}

function isProbablyJson(msg: WebSocket.RawData): boolean {
  try {
    const str = msg.toString("utf8");
    return str.trim().startsWith("{") || str.trim().startsWith("[");
  } catch {
    return false;
  }
}
