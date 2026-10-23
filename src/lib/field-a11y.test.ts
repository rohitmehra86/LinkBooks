import { describe, expect, it } from "vitest";
import { fieldA11y } from "./field-a11y";

describe("fieldA11y", () => {
  it("returns only the id when there is nothing to describe", () => {
    expect(fieldA11y("name")).toEqual({ id: "name" });
  });
  it("marks invalid and links the error before the helper text", () => {
    expect(fieldA11y("name", { error: "Required", helper: true })).toEqual({
      id: "name",
      "aria-invalid": true,
      "aria-describedby": "name-error name-help",
    });
  });
  it("marks required", () => {
    expect(fieldA11y("name", { required: true })["aria-required"]).toBe(true);
  });
});
