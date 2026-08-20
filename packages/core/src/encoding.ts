import { base64urlnopad } from "@scure/base";

export const b64url = {
  encode: (bytes: Uint8Array): string => base64urlnopad.encode(bytes),
  decode: (s: string): Uint8Array => base64urlnopad.decode(s),
};

const encoder = new TextEncoder();
export const utf8 = (s: string): Uint8Array => encoder.encode(s);
