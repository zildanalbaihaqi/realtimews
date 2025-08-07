import WebSocket from "ws";
import type { RawData } from "ws";
import { sendOpenAIMessage, updateOpenAISession } from "./lib/openaiRelay";
import { parseOpenAIMessage } from "./lib/messageParser";
import { v4 as uuidv4 } from "uuid";
import * as dotenv from "dotenv";
dotenv.config();

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY!;
const VOICE_ID = process.env.VOICE_ID!;
const MODEL_ID = "eleven_flash_v2_5";

export default function handleConnection(clientSocket: WebSocket): void {
  console.log("[Client] Connected");

  const OPENAI_URL = process.env.OPENAI_URL!;
  const OPENAI_KEY = process.env.OPENAI_API_KEY!;
  const DEEPGRAM_KEY = process.env.DEEPGRAM_API_KEY!;

  if (!OPENAI_URL || !OPENAI_KEY || !DEEPGRAM_KEY) {
    throw new Error("Missing env variables");
  }

  const openaiSocket = new WebSocket(OPENAI_URL, {
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  const deepgramSocket = new WebSocket(
    "wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&channels=1&punctuate=true&smart_format=true&interim_results=true&language=en&model=nova-2&endpointing=1",
    {
      headers: {
        Authorization: `Token ${DEEPGRAM_KEY}`,
      },
    }
  );

  let currentTTS: WebSocket | null = null;
  let currentTTSTurnId: string | null = null;
  let activeTurnId: string | null = null;
  let lastTTSId: string | null = null;
  let lastBargedTurnId: string | null = null;
  const sessionInitialized = { current: false };

  function stopTTS(turnId: string) {
    if (currentTTS && currentTTS.readyState === WebSocket.OPEN) {
      console.log(`[TTS] Stop requested (turn ${turnId})`);
      currentTTS.close();
      clientSocket.send(JSON.stringify({ type: "stop_audio", turnId }));
    }
    currentTTS = null;
    currentTTSTurnId = null;
  }

  function startTTS(text: string, turnId: string) {
    const ttsWs = new WebSocket(
      `wss://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream-input?model_id=${MODEL_ID}&output_format=pcm_16000&sync_alignment=true`,
      {
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
        },
      }
    );

    currentTTS = ttsWs;
    currentTTSTurnId = turnId;
    lastTTSId = turnId;

    ttsWs.on("open", () => {
      console.log(`[TTS] Started (${turnId})`);

      ttsWs.send(JSON.stringify({
        text: " ",
        voice_settings: {
          stability: 0.3,
          similarity_boost: 0.3,
          use_speaker_boost: false,
        },
        generation_config: {
          chunk_length_schedule: [80, 120, 150],
        },
      }));

      ttsWs.send(JSON.stringify({ text, flush: true }));
      ttsWs.send(JSON.stringify({ text: "" }));
    });

    ttsWs.on("message", (event) => {
      try {
        const data = JSON.parse(event.toString());
        if (
          data.audio &&
          ttsWs === currentTTS &&
          currentTTSTurnId === turnId
        ) {
          clientSocket.send(JSON.stringify({
            type: "tts_audio",
            audio: data.audio,
            turnId,
          }));
        }
      } catch (err) {
        console.error("[TTS] Message parse error:", err);
      }
    });

    ttsWs.on("close", () => {
      console.log(`[TTS] Closed (${turnId})`);
      if (currentTTS === ttsWs) {
        currentTTS = null;
        currentTTSTurnId = null;
      }
    });

    ttsWs.on("error", (err) => {
      console.error("[TTS] WS error:", err.message);
    });
  }

  openaiSocket.on("open", () => {
    console.log("[OpenAI] Connected");

clientSocket.on("message", async (msg: RawData) => {
  try {
    // Handle binary audio (buffer)
    console.log(msg);


    // Handle text messages
    const str = (typeof msg === "string" ? msg : msg.toString()).trim();
    if (str.startsWith("{") || str.startsWith("[")) {
      const data = JSON.parse(str);
      handleClientJsonMessage(data);
    } else {
      console.warn("[Server] Ignored non-JSON text:", str.slice(0, 50));
    }
  } catch (err) {
    console.error("[Server] Failed to handle client message:", err);
  }
});



    openaiSocket.on("message", async (msg: RawData) => {
      const parsed = parseOpenAIMessage(msg.toString());
      if (!parsed || clientSocket.readyState !== WebSocket.OPEN) return;

      if (parsed.type === "text_delta" && parsed.content) {
        clientSocket.send(JSON.stringify({
          type: "partial_response",
          text: parsed.content,
          turnId: activeTurnId,
        }));
      }

      if (parsed.type === "text_done" && parsed.content) {
        const turnId = activeTurnId!;
        clientSocket.send(JSON.stringify({
          type: "final_response",
          text: parsed.content,
          turnId,
        }));

        lastBargedTurnId = null;
        startTTS(parsed.content, turnId);
      }

      if (parsed.type === "ping") {
        clientSocket.send(JSON.stringify({ type: "ping" }));
      }
    });
  });

  deepgramSocket.on("open", () => {
    console.log("[Deepgram] Audio stream opened");
  });

  deepgramSocket.on("message", (msg: RawData) => {
    try {
      const response = JSON.parse(msg.toString());
      console.log('dg: ',JSON.stringify(response, null, 2));
      const transcript = response.channel?.alternatives?.[0]?.transcript;
      const isFinal = response.is_final;

      if (!transcript || !transcript.trim()) return;

      const ts = (response.start + response.duration).toFixed(2);
      console.log(`🕒 DG ${isFinal ? "FINAL" : "PARTIAL"} @ +${ts}s:`, transcript);

      // 💥 Barge-in trigger
      if (lastTTSId && lastBargedTurnId !== lastTTSId) {
               //clientSocket.send(JSON.stringify({ type: "stop_audio", turnId: lastTTSId }));
        //stopTTS(lastTTSId);
        
        lastBargedTurnId = lastTTSId;

        console.log("🔇 Barge-in: TTS interrupted by speech.");
      }

      if (isFinal) {
        const turnId = uuidv4();
        activeTurnId = turnId;
        sendOpenAIMessage(openaiSocket, transcript);
        clientSocket.send(JSON.stringify({ type: "transcript", text: transcript, turnId }));
      }
    } catch (err) {
      console.error("[Deepgram] JSON parse error:", err);
    }
  });

  function handleClientJsonMessage(data: any) {
      if (data.type === 'transcript') {
        console.log("📩 Received transcript:", data.transcript);
        // bisa logika apapun di sini (simpan DB, AI parsing, dsb)
      }

    if (data.type === "start_chat" && data.user && !sessionInitialized.current) {
      sessionInitialized.current = true;
      const instructions = `
You are a helpful AI assistant in a customer support chat.
The user's name is ${data.user.name || "Guest"} and their email is ${data.user.email || "unknown@example.com"}.
Greet the user and assist them in a concise and helpful manner.
      `.trim();
      updateOpenAISession(openaiSocket, instructions);
      sendOpenAIMessage(openaiSocket, "hi");
    } else if (typeof data.text === "string" && data.text.trim()) {
      const turnId = uuidv4();
      activeTurnId = turnId;

      if (currentTTS && currentTTS.readyState === WebSocket.OPEN) {
        stopTTS(turnId);
      }

      sendOpenAIMessage(openaiSocket, data.text.trim());
    }
  }

  const cleanup = () => {
    if (openaiSocket.readyState === WebSocket.OPEN) openaiSocket.close();
    if (deepgramSocket.readyState === WebSocket.OPEN) {
      deepgramSocket.send(JSON.stringify({ type: "CloseStream" }));
      deepgramSocket.close();
    }
    if (clientSocket.readyState === WebSocket.OPEN) clientSocket.close();
    if (currentTTS && currentTTS.readyState === WebSocket.OPEN) currentTTS.close();

    currentTTS = null;
    currentTTSTurnId = null;
    console.log("[Session] Closed");
  };

  clientSocket.on("close", cleanup);
  openaiSocket.on("close", cleanup);
  deepgramSocket.on("close", cleanup);
}

function isProbablyJson(msg: RawData): boolean {
  try {
    const str = msg.toString("utf8");
    return str.trim().startsWith("{") || str.trim().startsWith("[");
  } catch {
    return false;
  }
}
