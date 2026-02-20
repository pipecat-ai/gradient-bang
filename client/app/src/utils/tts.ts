/**
 * Remove <...> and [...] tags from text, then collapse whitespace.
 */
export function stripTags(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}
