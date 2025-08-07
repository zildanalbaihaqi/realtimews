// src/lib/sceneRelay.ts
import WebSocket from "ws";

export function sendConversationResponse(
  ws: WebSocket,
  sentence: string,
  turnId: string,
  personaId: string,
  isFinal = true,
  userInput = '',
  context: Record<string, any> = {}
): Promise<void> {
  return new Promise(resolve => {
    const response = {
      category: "scene",
      kind: "request",
      name: "conversationResponse",
      transaction: turnId,
      body: {
        personaId,
        input: { text: userInput },
        output: { text: sentence },
        variables: {
          Turn_Id: turnId,
          isFinalSentence: isFinal,
          allow_interrupt: true,
          ignore_speech: false,
          ...context,
        },
        provider: {
          kind: "custom",
          meta: { conversation_id: turnId },
        },
      },
    };

    ws.send(JSON.stringify(response));
    console.log(`Sent response: ${sentence}`);
    resolve();
  });
}
