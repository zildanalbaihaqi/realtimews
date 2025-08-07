import WebSocket from 'ws';
import http from 'http';
import express from 'express';
import * as dotenv from 'dotenv';

dotenv.config();

const API_KEY = process.env.ELEVENLABS_API_KEY!;
const VOICE_ID = process.env.VOICE_ID!;
const TTS_TEXT = 'This is a demo of ElevenLabs realtime streaming sent to the browser in live audio.';

const app = express();
app.use(express.static('src/public'));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (client) => {
  console.log('[Browser] Connected');

  const ttsSocket = new WebSocket(`wss://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream-input?optimize_streaming_latency=2`, {
    headers: {
      'xi-api-key': API_KEY,
      'Content-Type': 'application/json',
    },
  });

  ttsSocket.on('open', () => {
    console.log('[WS] Connected to ElevenLabs');

    const config = {
      text: '',
      voice_settings: {
        stability: 0.4,
        similarity_boost: 0.8,
        style: 0.0,
        use_speaker_boost: true,
      },
      generation_config: {
        chunk_length_schedule: [50, 100, 160],
      },
      timestamp_result_format: 'start_end',
    };

    ttsSocket.send(JSON.stringify(config));

    const chunks = [
      'This is a demo of ElevenLabs realtime streaming.',
      'We are sending this audio directly to your browser.',
    ];

    chunks.forEach((chunk, i) => {
      setTimeout(() => {
        ttsSocket.send(JSON.stringify({ text: chunk }));
        console.log(`[WS] Sent chunk ${i + 1}`);
      }, i * 200);
    });

    setTimeout(() => {
      ttsSocket.send(JSON.stringify({ text: '' }));
      console.log('[WS] Sent end signal');
    }, chunks.length * 200 + 100);
  });

  ttsSocket.on('message', (data) => {
    // Forward raw audio binary to browser
    if (Buffer.isBuffer(data)) {
      client.send(data);
    } else {
      const asJSON = JSON.parse(data.toString());
      if (asJSON?.audio === null && asJSON?.isFinal) {
        console.log('[WS] Final response');
      }
    }
  });

  ttsSocket.on('close', () => {
    console.log('[WS] ElevenLabs socket closed');
  });

  ttsSocket.on('error', (err) => {
    console.error('[WS] Error:', err);
  });

  client.on('close', () => {
    console.log('[Browser] Disconnected');
    ttsSocket.close();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
