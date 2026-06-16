// SPDX-License-Identifier: MIT
// @sffmc/shared — see ../../LICENSE

import { describe, it, expect } from "bun:test";
import { hasMetadataError } from "./has-metadata-error.ts";

describe("hasMetadataError", () => {
  it("returns false for null meta", () => {
    expect(hasMetadataError(null)).toBe(false);
  });

  it("returns false for undefined meta", () => {
    expect(hasMetadataError(undefined)).toBe(false);
  });

  it("returns false for empty object meta", () => {
    expect(hasMetadataError({})).toBe(false);
  });

  it("returns false when error is undefined", () => {
    expect(hasMetadataError({ error: undefined })).toBe(false);
  });

  it("returns false when error is null", () => {
    expect(hasMetadataError({ error: null })).toBe(false);
  });

  it("returns false when error is false", () => {
    expect(hasMetadataError({ error: false })).toBe(false);
  });

  it("returns true when error is a string", () => {
    expect(hasMetadataError({ error: "some string" })).toBe(true);
  });

  it("returns true when error is 0 (treated as set by original logic)", () => {
    expect(hasMetadataError({ error: 0 })).toBe(true);
  });

  it("returns true when error is an empty string", () => {
    expect(hasMetadataError({ error: "" })).toBe(true);
  });

  it("returns true when error is an object with code", () => {
    expect(hasMetadataError({ error: { code: 500 } })).toBe(true);
  });

  it("returns true when error is an Error instance", () => {
    expect(hasMetadataError({ error: new Error("x") })).toBe(true);
  });

  it("returns true when error is boolean true", () => {
    expect(hasMetadataError({ error: true })).toBe(true);
  });
});
