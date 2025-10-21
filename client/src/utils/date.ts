import { differenceInHours, format, formatDistanceToNow } from "date-fns";

/**
 * Formats a timestamp as relative time (e.g., "5 minutes ago") when recent;
 * otherwise formats as a short date/time (e.g., "Oct 21, 3:45 PM").
 */
export function formatTimeAgoOrDate(
  value: string | Date | undefined | null
): string {
  if (!value) return "";

  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) return "";

  if (differenceInHours(new Date(), date) < 24) {
    return formatDistanceToNow(date, { addSuffix: true });
  }

  return format(date, "MMM d, h:mm a");
}
