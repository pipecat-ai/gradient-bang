export const DEFAULT_MAINTENANCE_MESSAGE =
  "Gradient Bang is down for maintenance. Please try again shortly.";
export const DEFAULT_ONLINE_STATUS_MESSAGE =
  "Gradient Bang login services are available.";

export type PublicServerStatus = "online" | "maintenance";

export interface PublicServerStatusSnapshot {
  status: PublicServerStatus;
  can_login: boolean;
  message: string;
}

export function isMaintenanceMode(raw = Deno.env.get("MAINTENANCE_MODE")): boolean {
  const normalized = (raw ?? "").trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
}

export function getMaintenanceMessage(
  raw = Deno.env.get("MAINTENANCE_MESSAGE"),
): string {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : DEFAULT_MAINTENANCE_MESSAGE;
}

export function getPublicServerStatusSnapshot(): PublicServerStatusSnapshot {
  if (isMaintenanceMode()) {
    return {
      status: "maintenance",
      can_login: false,
      message: getMaintenanceMessage(),
    };
  }

  return {
    status: "online",
    can_login: true,
    message: DEFAULT_ONLINE_STATUS_MESSAGE,
  };
}
