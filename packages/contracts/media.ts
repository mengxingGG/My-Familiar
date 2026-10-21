import type { PromptMessage } from "./llm.ts";

export interface Attachment {
  id: string;
  name: string;
  kind: "image" | "text";
  mimeType: string;
  bytes: number;
  time: number;
  source: "file" | "clipboard" | "screen" | "mcp";
}
export interface PromptImage {
  mimeType: string;
  data: string;
}
export interface ChatInput {
  text: string;
  attachments?: string[];
  screen?: boolean;
  origin?: "text" | "voice";
}
export interface MediaSettings {
  screenEnabled: boolean;
  autoScreen: boolean;
  displayId: string;
}
export interface ToolResult {
  type: "familiar.multimodal";
  text: string;
  attachments: Attachment[];
}
declare module "../kernel/index.ts" {
  interface Services {
    "media.assets": {
      add(
        name: string,
        mimeType: string,
        data: Uint8Array,
        source?: Attachment["source"],
      ): Promise<Attachment>;
      get(ids: string[]): Promise<Attachment[]>;
      /** 读取完整文本供本地导入；按用途限制大小，不截断文件。 */
      text(id: string, maxBytes: number): Promise<string>;
      resolve(messages: PromptMessage[]): Promise<PromptMessage[]>;
      preview(
        id: string,
      ): Promise<{ attachment: Attachment; dataUrl?: string; text?: string }>;
    };
    "platform.media": {
      choose(): Promise<Attachment[]>;
      paste(): Promise<Attachment>;
      capture(displayId: string): Promise<Attachment>;
      displays(): { id: string; name: string }[];
    };
    "media.input": {
      get(): MediaSettings;
      set(value: MediaSettings): Promise<MediaSettings>;
      prepare(
        input: string | ChatInput,
      ): Promise<{
        text: string;
        attachments: Attachment[];
        origin: "text" | "voice";
      }>;
    };
  }
}
