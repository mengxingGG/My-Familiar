import type { CareSettings } from "../contracts/companion.ts";
export type MobileCareSettings = CareSettings;
export interface MobileCareState {
  settings: MobileCareSettings;
  revision: string;
  busy: boolean;
  lastMessage?: string;
  lastError?: string;
  location?: { accuracy: number; time: number; mock: boolean };
  locationPermission: boolean;
  locationEnabled: boolean;
}
export interface MobileCareCommands {
  "care.get": { params: undefined; result: MobileCareState };
  "care.save": {
    params: { settings: MobileCareSettings; revision: string };
    result: MobileCareState;
  };
  "care.preview": { params: undefined; result: MobileCareState };
  "care.stop": { params: undefined; result: MobileCareState };
  "care.locate": {
    params: { operationId: string; revision: string };
    result: MobileCareState;
  };
  "care.locate.cancel": { params: { operationId: string }; result: void };
}
