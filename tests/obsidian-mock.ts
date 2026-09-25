import type { RequestUrlResponse } from "obsidian";

export async function requestUrl(): Promise<RequestUrlResponse> {
  throw new Error("network disabled in unit tests");
}

export type DataAdapter = unknown;
