import WebSocket, { RawData } from "ws";
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

  if (!OPENAI_URL || !OPENAI_KEY || !ELEVENLABS_API_KEY || !VOICE_ID) {
    throw new Error("Missing required env variables.");
  }

  const openaiSocket = new WebSocket(OPENAI_URL, {
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

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
    clientSocket.send(JSON.stringify({ type: "openai_ready" }));
    clientSocket.on("message", async (msg: RawData) => {
      try {
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
/*
      if (parsed.type === "text_delta" && parsed.content) {
        clientSocket.send(JSON.stringify({
          type: "partial_response",
          text: parsed.content,
          turnId: activeTurnId,
        }));
      }
*/
      if (parsed.type === "text_done" && parsed.content) {
        const turnId = activeTurnId || uuidv4();
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
       if (parsed.type === "response.done") {
        console.log(JSON.stringify(parsed ,null, 2));
        const out = parsed.rawData;
        clientSocket.send(JSON.stringify(out));
      }
        if (parsed.type === "session.updated") {
        //console.log(JSON.stringify(parsed ,null, 2));
        const out = parsed.rawData;
        clientSocket.send(JSON.stringify(out));
      }         
    });
  });

  function handleClientJsonMessage(data: any) {
    if (data.type === "transcript") {
      const transcript = data.transcript?.trim();
      if (!transcript) return;

      const turnId = uuidv4();
      activeTurnId = turnId;

      if (currentTTS && currentTTS.readyState === WebSocket.OPEN) {
        stopTTS(turnId);
      }

      console.log("📩 [Frontend] Transcript received:", transcript);
      sendOpenAIMessage(openaiSocket, transcript);
      clientSocket.send(JSON.stringify({ type: "transcript", text: transcript, turnId }));
    }

    if (data.type === 'session.update' || data.type === 'conversation.item.create' ||
        data.type === 'response.create'
    ){
        openaiSocket.send(JSON.stringify(data));
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
    if (clientSocket.readyState === WebSocket.OPEN) clientSocket.close();
    if (currentTTS && currentTTS.readyState === WebSocket.OPEN) currentTTS.close();

    currentTTS = null;
    currentTTSTurnId = null;
    console.log("[Session] Closed");
  };

  clientSocket.on("close", cleanup);
  openaiSocket.on("close", cleanup);
}
