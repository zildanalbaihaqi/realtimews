export interface ParsedMessage {
  type:
    | "text_delta"
    | "text_done"
    | "ping"
    | "session.created"
    | "response.done"
    | "session.updated";
  id?: string;
  content?: string;
  // optional field to include full data on done
  rawData?: any;
}

export function parseOpenAIMessage(
  rawMessage: string
): ParsedMessage | undefined {
  try {
    const data = JSON.parse(rawMessage);
    console.log(JSON.stringify(data, null, 2));
    switch (data.type) {
      case "response.text.delta":
        return {
          type: "text_delta",
          id: data.item_id,
          content: data.delta ?? undefined,
        };

      case "response.output_item.done":
        return {
          type: "text_done",
          id: data.item?.id,
          content: data.item?.content?.[0]?.text ?? undefined,
        };
      case "response.done":
        return {
          type: "response.done",
          rawData: data, // simpen data lengkap di rawData
        };
              case "session.updated":
        return {
          type: "session.updated",
          rawData: data, // simpen data lengkap di rawData
        };
      case "ping":
        return { type: "ping" };

      default:
        return;
    }
  } catch (err) {
    console.error("Error parsing OpenAI message:", err);
    return;
  }
}
