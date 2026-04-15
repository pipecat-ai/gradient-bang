/**
 * Pure unit tests for the shared display-name validator.
 * No Supabase / server required.
 */

import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.197.0/testing/asserts.ts";

import {
  NameValidationError,
  validateDisplayName,
} from "../_shared/name_validation.ts";

Deno.test("validateDisplayName: accepts valid character names", () => {
  assertEquals(validateDisplayName("Bob", "character"), "Bob");
  assertEquals(validateDisplayName("Pilot_42", "character"), "Pilot_42");
  assertEquals(validateDisplayName("  Rogue One  ", "character"), "Rogue One");
});

Deno.test("validateDisplayName: rejects too-short names with name_format", () => {
  const err = assertThrows(
    () => validateDisplayName("ab", "character"),
    NameValidationError,
  );
  assertEquals(err.code, "name_format");
  assertEquals(err.status, 400);
});

Deno.test("validateDisplayName: rejects too-long names with name_format", () => {
  const err = assertThrows(
    () => validateDisplayName("a".repeat(21), "character"),
    NameValidationError,
  );
  assertEquals(err.code, "name_format");
});

Deno.test("validateDisplayName: rejects disallowed charset for character", () => {
  // Hyphens & apostrophes aren't allowed in character names (only ship/corp)
  const err = assertThrows(
    () => validateDisplayName("Jack's", "character"),
    NameValidationError,
  );
  assertEquals(err.code, "name_format");
});

Deno.test("validateDisplayName: ship allows apostrophes and hyphens", () => {
  assertEquals(
    validateDisplayName("Jack's Freighter", "ship"),
    "Jack's Freighter",
  );
  assertEquals(validateDisplayName("Star-Runner", "ship"), "Star-Runner");
});

Deno.test("validateDisplayName: rejects obvious profanity with name_blocked", () => {
  const err = assertThrows(
    () => validateDisplayName("fuck", "character"),
    NameValidationError,
  );
  assertEquals(err.code, "name_blocked");
});

Deno.test("validateDisplayName: rejects leetspeak profanity", () => {
  // Format regex already strips most substitutions, but the obscenity
  // dataset covers common variants that pass the charset.
  const err = assertThrows(
    () => validateDisplayName("fuck42", "character"),
    NameValidationError,
  );
  assertEquals(err.code, "name_blocked");
});

Deno.test("validateDisplayName: corporation uses 3-50 length bounds", () => {
  assertEquals(
    validateDisplayName("A".repeat(50), "corporation"),
    "A".repeat(50),
  );
  assertThrows(
    () => validateDisplayName("A".repeat(51), "corporation"),
    NameValidationError,
  );
});
