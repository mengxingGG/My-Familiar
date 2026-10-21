export interface GithubAuthStatus {
  revision: string;
  clientId: string;
  connected: boolean;
  phase: 'signedOut' | 'saving' | 'authorizing' | 'connected' | 'refreshing' | 'error';
  detail: string;
  configurationError?: boolean;
  scopes: string[];
  user?: { id: number; login: string };
  authorization?: { url: string; userCode: string; expiresAt: number };
}
declare module '../kernel/index.ts' {
  interface Services {
    'github.deviceAuth': {
      status(): GithubAuthStatus;
      configure(value: { revision: string; clientId: string }): Promise<void>;
      begin(revision: string): Promise<void>;
      open(revision: string): Promise<void>;
      cancel(revision: string): void;
      forget(revision: string): Promise<void>;
      credential(): string;
      available(credential: string): boolean;
      token(credential: string, signal: AbortSignal): Promise<string>;
    };
  }
}
