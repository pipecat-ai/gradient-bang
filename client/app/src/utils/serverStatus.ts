export type PublicServerStatus = "online" | "maintenance";
export type LoginScreenServerState =
  | "checking"
  | "online"
  | "maintenance"
  | "offline";

export interface ParsedPublicServerStatus {
  state: Extract<LoginScreenServerState, "online" | "maintenance">;
  message: string;
}

export interface LoginScreenServerBadge {
  state: LoginScreenServerState;
  label: string;
  detail: string;
}

const DEFAULT_SERVER_URL = "http://localhost:54321/functions/v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function buildServerFunctionUrl(functionName: string, baseUrl?: string | null): string {
  const normalizedBase =
    (baseUrl?.trim() || DEFAULT_SERVER_URL).replace(/\/+$/, "");
  const normalizedFunction = functionName.replace(/^\/+/, "");
  return `${normalizedBase}/${normalizedFunction}`;
}

export function parsePublicServerStatus(value: unknown): ParsedPublicServerStatus | null {
  if (!isRecord(value) || value.success !== true) {
    return null;
  }

  if (value.status !== "online" && value.status !== "maintenance") {
    return null;
  }

  return {
    state: value.status,
    message: typeof value.message === "string" ? value.message : "",
  };
}

export function getLoginScreenServerBadge(
  state: LoginScreenServerState,
  message?: string | null,
): LoginScreenServerBadge {
  const detail = message?.trim() ?? "";

  switch (state) {
    case "online":
      return {
        state,
        label: "Server Online",
        detail,
      };
    case "maintenance":
      return {
        state,
        label: "Maintenance",
        detail || "Login is temporarily unavailable.",
      };
    case "offline":
      return {
        state,
        label: "Server Unreachable",
        detail || "Unable to reach the public status endpoint.",
      };
    case "checking":
      return {
        state,
        label: "Checking Server",
        detail: "Checking the public status endpoint.",
      };
  }
}
