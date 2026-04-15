/**
 * Shared display-name validation for user-chosen names (characters, ships, corporations).
 *
 * Enforces a per-kind format (length + charset) and screens for profanity/slurs
 * via the `obscenity` library, which normalizes leetspeak and obfuscation.
 *
 * Throws `NameValidationError` on failure; returns the trimmed name on success.
 */

import {
  RegExpMatcher,
  englishDataset,
  englishRecommendedTransformers,
} from "obscenity";

export type NameKind = "character" | "ship" | "corporation";

export type NameValidationCode = "name_format" | "name_blocked";

export class NameValidationError extends Error {
  status = 400;
  code: NameValidationCode;

  constructor(code: NameValidationCode, message: string) {
    super(message);
    this.name = "NameValidationError";
    this.code = code;
  }
}

interface KindRules {
  minLength: number;
  maxLength: number;
  charset: RegExp;
  charsetDescription: string;
  label: string;
}

const RULES: Record<NameKind, KindRules> = {
  character: {
    minLength: 3,
    maxLength: 20,
    charset: /^[A-Za-z0-9_ ]+$/,
    charsetDescription: "letters, numbers, underscores, and spaces",
    label: "Character name",
  },
  ship: {
    minLength: 3,
    maxLength: 30,
    charset: /^[A-Za-z0-9_ '\-]+$/,
    charsetDescription:
      "letters, numbers, spaces, underscores, hyphens, and apostrophes",
    label: "Ship name",
  },
  corporation: {
    minLength: 3,
    maxLength: 50,
    charset: /^[A-Za-z0-9_ '\-]+$/,
    charsetDescription:
      "letters, numbers, spaces, underscores, hyphens, and apostrophes",
    label: "Corporation name",
  },
};

const profanityMatcher = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
});

export function validateDisplayName(raw: string, kind: NameKind): string {
  const rules = RULES[kind];
  const trimmed = (raw ?? "").trim();

  if (
    trimmed.length < rules.minLength ||
    trimmed.length > rules.maxLength
  ) {
    throw new NameValidationError(
      "name_format",
      `${rules.label} must be ${rules.minLength}-${rules.maxLength} characters (${rules.charsetDescription}).`,
    );
  }

  if (!rules.charset.test(trimmed)) {
    throw new NameValidationError(
      "name_format",
      `${rules.label} may only contain ${rules.charsetDescription}.`,
    );
  }

  if (profanityMatcher.hasMatch(trimmed)) {
    throw new NameValidationError(
      "name_blocked",
      "That name isn't allowed. Please choose another.",
    );
  }

  return trimmed;
}
