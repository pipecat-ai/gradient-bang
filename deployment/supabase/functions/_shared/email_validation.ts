/**
 * Signup email validation: shape check + disposable-domain blocklist.
 *
 * Baked-in list comes from the community-maintained `disposable-email-domains`
 * package (~9,700 domains). Extend at runtime via the `BLOCKED_EMAIL_DOMAINS`
 * env var (comma-separated) to react to new spam waves without a redeploy.
 *
 * Throws `EmailValidationError` on failure; returns the normalized email
 * (trimmed + lowercased) on success.
 */

import disposableDomains from "disposable-email-domains" with { type: "json" };

export type EmailValidationCode = "email_format" | "email_blocked";

export class EmailValidationError extends Error {
  status = 400;
  code: EmailValidationCode;

  constructor(code: EmailValidationCode, message: string) {
    super(message);
    this.name = "EmailValidationError";
    this.code = code;
  }
}

function loadBlockedDomains(): Set<string> {
  const set = new Set<string>(
    (disposableDomains as string[]).map((d) => d.toLowerCase()),
  );
  const extra = Deno.env.get("BLOCKED_EMAIL_DOMAINS") ?? "";
  for (const raw of extra.split(",")) {
    const domain = raw.trim().toLowerCase();
    if (domain) set.add(domain);
  }
  return set;
}

const BLOCKED_DOMAINS = loadBlockedDomains();

export function validateSignupEmail(raw: string): string {
  const email = (raw ?? "").trim().toLowerCase();

  const atIndex = email.lastIndexOf("@");
  if (atIndex < 1 || atIndex === email.length - 1 || email.indexOf("@") !== atIndex) {
    throw new EmailValidationError(
      "email_format",
      "Please enter a valid email address.",
    );
  }

  const domain = email.slice(atIndex + 1);
  if (BLOCKED_DOMAINS.has(domain)) {
    throw new EmailValidationError(
      "email_blocked",
      "This email provider isn't supported. Please use a different address.",
    );
  }

  return email;
}
