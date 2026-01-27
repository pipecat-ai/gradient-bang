import { differenceInHours, differenceInSeconds, format, formatDistanceToNow } from "date-fns"

/**
 * Formats a timestamp as relative time (e.g., "5 minutes ago") when recent;
 * otherwise formats as a short date/time (e.g., "Oct 21, 3:45 PM").
 */
export function formatTimeAgoOrDate(value: string | Date | undefined | null): string {
  if (!value) return ""

  const date = value instanceof Date ? value : new Date(value)
  if (isNaN(date.getTime())) return ""

  if (differenceInHours(new Date(), date) < 24) {
    return formatDistanceToNow(date, { addSuffix: true })
  }

  return format(date, "MMM d, h:mm a")
}

export function formatDate(value: string | Date | undefined | null): string {
  if (!value) return ""
  const date = value instanceof Date ? value : new Date(value)
  if (isNaN(date.getTime())) return ""
  return format(date, "MMM d, h:mm a")
}

export function formatDateTime24(value: string | Date | undefined | null): string {
  if (!value) return ""
  const date = value instanceof Date ? value : new Date(value)
  if (isNaN(date.getTime())) return ""
  return format(date, "MMM d, HH:mm")
}

export function combatRoundTimeRemaining(deadline: string, currentTime: string): number {
  const deadlineDate = new Date(deadline)
  const currentTimeDate = new Date(currentTime)
  const timeDiff = differenceInSeconds(deadlineDate, currentTimeDate)
  return timeDiff > 0 ? timeDiff : 0
}

export function formatDuration(started: string | Date, ended: string | Date): string {
  const startDate = started instanceof Date ? started : new Date(started)
  const endDate = ended instanceof Date ? ended : new Date(ended)
  const seconds = differenceInSeconds(endDate, startDate)
  if (seconds < 60) return `${seconds}s`
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
}
