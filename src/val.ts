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
const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 menit

type Word = {
  text: string;
  confidence: number;
  start: number;
  end: number;
  word_is_final: boolean;
};

export default function handleConnection(clientSocket: WS): void {
  const sessionId = uuidv4().slice(0, 8);
  console.log(`[${sessionId}] [Client] Connected`);

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

  const assemblySocket = new WebSocket(
    `wss://streaming.assemblyai.com/v3/ws?${querystring.stringify({
      sample_rate: 16000,
      format_turns: true,
    })}`,
    {
      headers: {
        Authorization: ASSEMBLYAI_KEY,
      },
    }
  );

  let currentTTS: WebSocket | null = null;
  let activeTurnId: string | null = null;
  let sessionInitialized = false;
  let idleTimer: NodeJS.Timeout;

  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      console.log(`[${sessionId}] ⏱ Session timeout.`);
      cleanup();
    }, SESSION_TIMEOUT_MS);
  };

  openaiSocket.on("open", () => {
    console.log(`[${sessionId}] [OpenAI] Connected`);
    resetIdleTimer();

    clientSocket.on("message", async (msg: WebSocket.RawData) => {
      try {
        resetIdleTimer();

        if (typeof msg === "string" || isProbablyJson(msg)) {
          let data;
          try {
            data = JSON.parse(msg.toString());
          } catch (err) {
            console.warn(
              `[${sessionId}]  Ignored invalid JSON:`,
              msg.toString()
            );
            return;
          }

          if (!sessionInitialized) {
            //const { name, email } = data.user;
            sessionInitialized = true;

            const instructions = `You are Dr. Ava. from Valiant Clinic.
            `.trim();

            updateOpenAISession(openaiSocket, instructions);
            sendOpenAIMessage(openaiSocket, "hi");
          } else if (typeof data.text === "string" && data.text.trim()) {
            activeTurnId = uuidv4();

            if (currentTTS && currentTTS.readyState === WS.OPEN) {
              currentTTS.close();
              clientSocket.send(
                JSON.stringify({ type: "stop_audio", turnId: activeTurnId })
              );
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
        console.error(
          `[${sessionId}] [Server] Failed to handle client message:`,
          err
        );
      }
    });

    openaiSocket.on("message", async (msg: WebSocket.RawData) => {
      const parsed = parseOpenAIMessage(msg.toString());
      if (!parsed) return;
      if (parsed.type === "session.created") {
        const instructions = `You are Dr. Ava. from Valiant Clinic.`;
      }

      if (!parsed || clientSocket.readyState !== WS.OPEN) return;

      if (parsed.type === "text_delta" && parsed.content) {
        clientSocket.send(
          JSON.stringify({
            type: "partial_response",
            text: parsed.content,
            turnId: activeTurnId,
          })
        );
      }

      if (parsed.type === "text_done" && parsed.content) {
        const turnId = activeTurnId;
        const fullText = parsed.content.trim();
        console.log(
          `[${sessionId}] [OpenAI] Final response ${turnId}:`,
          fullText
        );

        clientSocket.send(
          JSON.stringify({
            type: "final_response",
            text: fullText,
            turnId,
          })
        );

        const ttsWs = new WebSocket(
          `wss://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream-input?model_id=${MODEL_ID}`,
          { headers: { "xi-api-key": ELEVENLABS_API_KEY } }
        );

        currentTTS = ttsWs;
        let audioSent = false;

        ttsWs.on("open", async () => {
          console.log(`[${sessionId}] [TTS] Started ${turnId}`);

          ttsWs.send(
            JSON.stringify({
              text: " ",
              voice_settings: {
                stability: 0.5,
                similarity_boost: 0.8,
                use_speaker_boost: false,
              },
              generation_config: {
                chunk_length_schedule: [120, 160, 250, 290],
              },
            })
          );

          ttsWs.send(
            JSON.stringify({
              text: fullText,
              flush: true,
            })
          );
          ttsWs.send(JSON.stringify({ text: "" }));
        });

        ttsWs.on("message", (event) => {
          try {
            const data = JSON.parse(event.toString());

            if (data.audio && ttsWs === currentTTS) {
              if (!audioSent) audioSent = true;

              //const durationMs = estimateMp3Duration(data.audio); // <--- Tambahin ini

              clientSocket.send(
                JSON.stringify({
                  type: "tts_audio",
                  audio: data.audio,
                  turnId,
                  //durationMs, // <--- Tambahin ini
                })
              );

              console.log(
                `[${sessionId}] [TTS] Sent audio chunk ${turnId}: ${data.audio.length} bytes`
              );
            }

          } catch (err) {
            console.error(`[${sessionId}] [TTS] Message parse error:`, err);
          }
        });

        ttsWs.on("close", () => {
          console.log(`[${sessionId}] [TTS] Closed ${turnId}`);
          if (currentTTS === ttsWs) currentTTS = null;
        });

        ttsWs.on("error", (err) => {
          console.error(`[${sessionId}] [TTS] WS error:`, err.message);
        });
      }

      if (parsed.type === "ping") {
        clientSocket.send(JSON.stringify({ type: "ping" }));
      }
    });
  });

  assemblySocket.on("open", () => {
    console.log(`[${sessionId}] [AssemblyAI] Connected`);
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
        const validWords = (data.words as Word[]).filter(
          (w) => w.confidence >= minWordConfidence
        );

        if (!transcript || transcript.length < 2 || validWords.length === 0)
          return;

        const turnId = uuidv4();
        activeTurnId = turnId;

        console.log(
          `[${sessionId}] [AssemblyAI] Transcript (${turnId}):`,
          transcript
        );

        if (currentTTS && currentTTS.readyState === WS.OPEN) {
          currentTTS.close();
          clientSocket.send(JSON.stringify({ type: "stop_audio", turnId }));
        }

        sendOpenAIMessage(openaiSocket, transcript);
        clientSocket.send(
          JSON.stringify({ type: "transcript", text: transcript, turnId })
        );
      }
    } catch (err) {
      console.error(`[${sessionId}] [AssemblyAI] Parse error:`, err);
    }
  });

  assemblySocket.on("close", (code, reason) => {
    console.log(
      `[${sessionId}] [AssemblyAI] Closed: ${code}, reason: ${reason}`
    );
    cleanup();
  });

  assemblySocket.on("error", (err) => {
    console.error(`[${sessionId}] [AssemblyAI WS Error]:`, err.message);
    cleanup();
  });

  clientSocket.on("close", cleanup);
  openaiSocket.on("close", cleanup);

  function cleanup() {
    clearTimeout(idleTimer);
    if (openaiSocket.readyState === WS.OPEN) openaiSocket.close();
    if (assemblySocket.readyState === WS.OPEN) assemblySocket.close();
    if (clientSocket.readyState === WS.OPEN) clientSocket.close();
    if (currentTTS && currentTTS.readyState === WS.OPEN) currentTTS.close();
    console.log(`[${sessionId}] [Session] Closed`);
  }
}

function isProbablyJson(msg: WebSocket.RawData): boolean {
  try {
    JSON.parse(msg.toString("utf8"));
    return true;
  } catch {
    return false;
  }
}
function splitText(text: string): string[] {
  return text
    .split(/(?<=[.?!])\s+/) // split tiap kalimat
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function estimateMp3Duration(audioBase64: string, kbps = 48): number {
  const byteLength = (audioBase64.length * 3) / 4; // base64 → byte
  const bytesPerSec = (kbps * 1000) / 8;
  const durationMs = (byteLength / bytesPerSec) * 1000;
  return Math.round(durationMs);
}
