import WebSocket from 'ws';
import http from 'http';
import express from 'express';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import path from 'path';

dotenv.config();

const API_KEY = process.env.ELEVENLABS_API_KEY!;
const VOICE_ID = process.env.VOICE_ID!;
const PORT = process.env.PORT || 3020;
const model = 'eleven_flash_v2_5';

const app = express();
app.use(express.static('src/public'));
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('[Browser] WebSocket client connected');

  ws.on('message', async (message) => {
    try {
      const { text } = JSON.parse(message.toString());
      if (typeof text !== 'string' || !text.trim()) {
        console.warn('[Server] Invalid or empty text received');
        return;
      }

      // Cleanup previous stream if exists
      if ((ws as any).elevenLabsWS) {
        (ws as any).elevenLabsWS.terminate();
        console.log('[Server] Previous ElevenLabs connection terminated');
      }
      if ((ws as any).writeStream) {
        (ws as any).writeStream.end();
        console.log('[Server] Previous writeStream closed');
      }

      const timestamp = Date.now();
      const outputDir = './output';
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

      const tempPath = path.join(outputDir, `audio_${timestamp}.part`);
      const finalPath = path.join(outputDir, `audio_${timestamp}.mp3`);
      const metaPath = path.join(outputDir, `audio_${timestamp}.json`);

      const writeStream = fs.createWriteStream(tempPath, { flags: 'a' });
      const elevenLabsWS = new WebSocket(
        `wss://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream-input?model_id=${model}`,
        {
          headers: { 'xi-api-key': API_KEY },
        }
      );

      // Store references on this client
      (ws as any).elevenLabsWS = elevenLabsWS;
      (ws as any).writeStream = writeStream;
      (ws as any).tempPath = tempPath;

      elevenLabsWS.on('open', () => {
        console.log('[ElevenLabs] Connection opened');

        elevenLabsWS.send(JSON.stringify({
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

        elevenLabsWS.send(JSON.stringify({ text, flush: true }));
        elevenLabsWS.send(JSON.stringify({ text: '' }));
      });

      elevenLabsWS.on('message', (event) => {
        const data = JSON.parse(event.toString());
        if (data.audio) {
          const audioBuffer = Buffer.from(data.audio, 'base64');
          writeStream.write(audioBuffer);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(data.audio);
          }
          console.log(`[Stream] Sent chunk (${audioBuffer.length} bytes)`);
        }
      });

      elevenLabsWS.on('close', () => {
        writeStream.end(() => {
          try {
            const stats = fs.statSync(tempPath);
            const isPartial = stats.size < 10000;

            if (isPartial) {
              fs.renameSync(tempPath, finalPath); // Tetap simpan
              console.log('[File] Partial audio saved:', finalPath);
            } else {
              fs.renameSync(tempPath, finalPath);
              console.log('[File] Complete audio saved:', finalPath);
            }

            // Write metadata for auditing
            const metadata = {
              text,
              file: finalPath,
              timestamp: new Date().toISOString(),
              status: isPartial ? 'partial' : 'complete',
              size_bytes: stats.size,
            };
            fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
            console.log('[Audit] Metadata saved:', metaPath);
          } catch (err) {
            console.error('[File] Finalization error:', err);
          }
        });
      });

      elevenLabsWS.on('error', (err) => {
        console.error('[ElevenLabs] WebSocket error:', err);
        writeStream.end();
      });

    } catch (err) {
      console.error('[Server] Message handling error:', err);
    }
  });

  ws.on('close', () => {
    console.log('[Browser] WebSocket client disconnected');
    if ((ws as any).elevenLabsWS) (ws as any).elevenLabsWS.terminate();
    if ((ws as any).writeStream) (ws as any).writeStream.end();
    if ((ws as any).tempPath && fs.existsSync((ws as any).tempPath)) {
      fs.unlinkSync((ws as any).tempPath);
      console.log('[Cleanup] Temp file deleted on disconnect');
    }
  });
});

server.listen(PORT, () => {
  console.log(`[Server] Listening at http://localhost:${PORT}`);
});
