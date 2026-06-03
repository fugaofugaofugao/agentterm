import { WsMessage } from "./types";

export function encodeMessage(msg: WsMessage): string {
  return JSON.stringify(msg);
}

export function decodeMessage(raw: string): WsMessage | null {
  try {
    return JSON.parse(raw) as WsMessage;
  } catch {
    return null;
  }
}
