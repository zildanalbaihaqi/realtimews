import WebSocket, { WebSocket as WS } from "ws";
import { sendOpenAIMessage, updateOpenAISession } from "@/lib/openaiRelay";
import { parseOpenAIMessage } from "@/lib/messageParser";
import { OPENAI_URL } from "@/config/openai";
import * as dotenv from "dotenv";
import * as fs from "fs";
import path from "path";

dotenv.config();

export default function handleConnection(clientSocket: WS): void {
  console.log("[Client] Connected");

  const openaiSocket = new WebSocket(OPENAI_URL, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  let sessionInitialized = false;
  let ttsSocket: WebSocket | null = null;
  let writeStream: fs.WriteStream | null = null;
  let tempPath: string | null = null;

  const cleanupTTS = () => {
    if (ttsSocket && ttsSocket.readyState === WebSocket.OPEN) ttsSocket.terminate();
    if (writeStream) writeStream.end();
    if (tempPath && fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
      console.log("[Cleanup] Deleted partial audio");
    }
    ttsSocket = null;
    writeStream = null;
    tempPath = null;
  };

  const connectToTTS = (text: string) => {
    cleanupTTS();

    const VOICE_ID = process.env.VOICE_ID!;
    const model = 'eleven_multilingual_v2';
    const timestamp = Date.now();
    const outputDir = './output';
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

    tempPath = path.join(outputDir, `audio_${timestamp}.part`);
    const finalPath = path.join(outputDir, `audio_${timestamp}.mp3`);
    const metaPath = path.join(outputDir, `audio_${timestamp}.json`);

    writeStream = fs.createWriteStream(tempPath, { flags: 'a' });

    ttsSocket = new WebSocket(`wss://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream-input?model_id=${model}`, {
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY! },
    });

    ttsSocket.on("open", () => {
      console.log("[TTS] Connected");
      ttsSocket!.send(JSON.stringify({
        text: ' ',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.8,
          use_speaker_boost: false,
        },
        generation_config: {
          chunk_length_schedule: [120, 160, 250, 290],
        },
      }));
      ttsSocket!.send(JSON.stringify({ text, flush: true }));
      ttsSocket!.send(JSON.stringify({ text: '' }));
    });

    ttsSocket.on("message", (event) => {
      const data = JSON.parse(event.toString());
      if (data.audio && clientSocket.readyState === WS.OPEN) {
        const audioBuffer = Buffer.from(data.audio, 'base64');
        writeStream!.write(audioBuffer);
        clientSocket.send(JSON.stringify({ type: "audio", audio: data.audio }));
      }
    });

    ttsSocket.on("close", () => {
      if (!tempPath || !writeStream) return;

      writeStream.end(() => {
        try {
          const stats = fs.statSync(tempPath);
          const isPartial = stats.size < 10000;

          fs.renameSync(tempPath, finalPath);
          const metadata = {
            text,
            file: finalPath,
            timestamp: new Date().toISOString(),
            status: isPartial ? "partial" : "complete",
            size_bytes: stats.size,
          };
          fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
          console.log(`[TTS] Saved audio: ${finalPath}`);
        } catch (err) {
          console.error("[TTS] File finalization error:", err);
        }
      });
    });

    ttsSocket.on("error", (err) => {
      console.error("[TTS] Error:", err);
    });
  };

  // When OpenAI is ready
  openaiSocket.on("open", () => {
    console.log("[OpenAI] Connected");

    clientSocket.on("message", (msg: WS.RawData) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.type === "start_chat" && data.user && !sessionInitialized) {
          const { name, email } = data.user;

          const instructions = `
You are a helpful AI assistant in a customer support chat.
The user's name is ${name || "Guest"} and their email is ${email || "unknown@example.com"}.
Greet the user by name and assist them in a friendly, concise, and helpful manner.
If needed, you may reference their email for account-related questions.
          `.trim();

          updateOpenAISession(openaiSocket, instructions);
          sendOpenAIMessage(openaiSocket, "hi");
          sessionInitialized = true;

        } else if (typeof data.text === "string" && data.text.trim()) {
          sendOpenAIMessage(openaiSocket, data.text.trim());
        } else {
          console.warn("[Client] Invalid message format");
        }
      } catch (err) {
        console.error("[Client] Failed to parse:", err);
      }
    });

    openaiSocket.on("message", (msg: WS.RawData) => {
      const parsed = parseOpenAIMessage(msg.toString());
      if (parsed && parsed.text && clientSocket.readyState === WS.OPEN) {
        clientSocket.send(JSON.stringify({ type: "text", text: parsed.text }));
        connectToTTS(parsed.text); // Convert OpenAI response to audio
      }
    });
  });

  // Cleanup on disconnect
  const cleanup = () => {
    if (openaiSocket.readyState === WebSocket.OPEN) openaiSocket.close();
    if (clientSocket.readyState === WebSocket.OPEN) clientSocket.close();
    cleanupTTS();
    console.log("[Session] Closed");
  };

  clientSocket.on("close", cleanup);
  openaiSocket.on("close", cleanup);
}
