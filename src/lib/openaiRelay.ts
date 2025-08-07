// src/lib/openaiRelay.ts
import WebSocket from "ws";
import { v4 as uuidv4 } from "uuid";

export function sendOpenAIMessage(
  openaiSocket: WebSocket,
  text: string,
  previousItemId: string | null = null
): void {
  if (openaiSocket.readyState !== WebSocket.OPEN) {
    console.error("OpenAI socket is not open.");
    return;
  }

  const eventId = `e_${uuidv4().replace(/-/g, "").slice(0, 30)}`;
  const messageId = `m_${uuidv4().replace(/-/g, "").slice(0, 30)}`;

  const payload = {
    event_id: eventId,
    type: "conversation.item.create",
    previous_item_id: previousItemId,
    item: {
      id: messageId,
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  };

  const resp = {
    event_id: eventId,
    type: "response.create",
    response: { modalities: ["text"] },
  };

  openaiSocket.send(JSON.stringify(payload));
  openaiSocket.send(JSON.stringify(resp));

  //console.log("[Server -> OpenAI]", payload);
}

export function updateOpenAISession(openaiSocket: WebSocket, instructions: string): void {
  if (openaiSocket.readyState !== WebSocket.OPEN) {
    console.error("OpenAI socket is not open for session update.");
    return;
  }

  const eventId = `e_${uuidv4().replace(/-/g, "").slice(0, 30)}`;

  const payload = {
    event_id: eventId,
    type: "session.update",
    session: {
      instructions,
      modalities: ['text']
    },
  };

  openaiSocket.send(JSON.stringify(payload));
  console.log("[Server -> OpenAI] session.update", payload);
}
