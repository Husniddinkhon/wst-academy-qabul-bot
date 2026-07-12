declare module 'dotenv' {
  const dotenv: { config: () => void };
  export default dotenv;
}

declare module 'node:crypto' {
  export function randomUUID(): string;
}

declare module 'node:fs/promises' {
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  export function readFile(path: string, encoding: 'utf8'): Promise<string>;
  export function rename(oldPath: string, newPath: string): Promise<void>;
  export function writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
}

declare module 'node:path' {
  const path: { dirname: (filePath: string) => string };
  export default path;
}

declare module 'telegraf' {
  export class Telegraf<C = any> {
    telegram: { setMyDescription(description: string): Promise<void>; setMyShortDescription(shortDescription: string): Promise<void>; setMyCommands(commands: Array<{ command: string; description: string }>, extra?: { scope: { type: 'default' } | { type: 'chat'; chat_id: number } }): Promise<void>; sendMessage(chatId: number | string, text: string): Promise<{ message_id: number }>; sendPhoto(chatId: number | string, photo: string, extra?: { caption?: string }): Promise<{ message_id: number }> };
    constructor(token: string);
    use(middleware: unknown): void;
    start(handler: (ctx: C) => unknown): void;
    hears(trigger: string, handler: (ctx: C) => unknown): void;
    on(updateType: string, handler: (ctx: C) => unknown): void;
    command(command: string, handler: (ctx: C) => unknown): void;
    catch(handler: (error: unknown, ctx: { update: { update_id: number } }) => unknown): void;
    launch(options?: { dropPendingUpdates?: boolean }): Promise<void>;
    stop(reason?: string): void;
  }

  export namespace Scenes {
    export interface WizardSessionData {
      cursor?: number;
    }

    export interface WizardContext<D extends WizardSessionData = WizardSessionData> {
      from?: { id: number; username?: string; first_name?: string; last_name?: string };
      message?: { text?: string; caption?: string; photo?: Array<{ file_id: string; width: number; height: number }>; contact?: { phone_number: string } };
      telegram: Telegraf['telegram'];
      reply(text: string, extra?: unknown): Promise<unknown>;
      replyWithDocument(document: unknown): Promise<unknown>;
      scene: { session: D; current?: { id?: string }; enter(sceneId: string): Promise<unknown>; leave(): Promise<unknown> };
      wizard: { next(): unknown };
    }

    export class WizardScene<C = any> {
      constructor(sceneId: string, ...steps: Array<(ctx: C) => unknown>);
    }

    export class Stage<C = any> {
      constructor(scenes: Array<WizardScene<C>>);
      middleware(): unknown;
    }
  }

  export interface Context {}

  export const Markup: {
    keyboard(buttons: unknown[][]): { resize(): unknown };
    button: { contactRequest(text: string): unknown };
  };

  export const Input: {
    fromBuffer(buffer: unknown, filename: string): unknown;
  };

  export function session(): unknown;
}

declare namespace NodeJS {
  interface ErrnoException extends Error {
    code?: string;
  }

  type Signals = 'SIGINT' | 'SIGTERM' | string;
}

declare const process: {
  env: Record<string, string | undefined>;
  pid: number;
  exit(code?: number): never;
  once(event: string, listener: (signal: NodeJS.Signals) => void | Promise<void>): void;
};

declare const console: {
  log(...data: unknown[]): void;
  error(...data: unknown[]): void;
};

declare const Buffer: {
  from(data: string, encoding?: string): unknown;
};

declare function fetch(input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
