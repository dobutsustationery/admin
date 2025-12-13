import { describe, it, expect } from "vitest";
import { getDateRange, shiftDateRange } from "../src/lib/audit-helpers";
import {
  startOfDay,
  endOfDay,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  addDays,
  addWeeks,
  addMonths,
} from "date-fns";

describe("audit-helpers", () => {
  const refDate = new Date("2024-03-15T12:00:00Z"); // A Friday

  describe("getDateRange", () => {
    it("should return correct range for day view", () => {
      const range = getDateRange("day", refDate);
      expect(range.start).toEqual(startOfDay(refDate));
      expect(range.end).toEqual(endOfDay(refDate));
    });

    it("should return correct range for week view", () => {
      const range = getDateRange("week", refDate);
      expect(range.start).toEqual(startOfWeek(refDate));
      expect(range.end).toEqual(endOfWeek(refDate));
    });

    it("should return correct range for month view", () => {
      const range = getDateRange("month", refDate);
      expect(range.start).toEqual(startOfMonth(refDate));
      expect(range.end).toEqual(endOfMonth(refDate));
    });
  });

  describe("shiftDateRange", () => {
    it("should shift day forward", () => {
      const newDate = shiftDateRange("day", refDate, "forward");
      expect(newDate).toEqual(addDays(refDate, 1));
    });

    it("should shift day back", () => {
      const newDate = shiftDateRange("day", refDate, "back");
      expect(newDate).toEqual(addDays(refDate, -1));
    });

    it("should shift week forward", () => {
      const newDate = shiftDateRange("week", refDate, "forward");
      expect(newDate).toEqual(addWeeks(refDate, 1));
    });

    it("should shift month back", () => {
      const newDate = shiftDateRange("month", refDate, "back");
      expect(newDate).toEqual(addMonths(refDate, -1));
    });
  });
});

import {
  getAuditActionDescription,
  formatField,
} from "../src/lib/audit-helpers";

describe("formatField", () => {
  it("should format janCode", () => {
    expect(formatField("janCode")).toBe("JAN Code");
  });
  it("should format hsCode", () => {
    expect(formatField("hsCode")).toBe("HS Code");
  });
  it("should format qty", () => {
    expect(formatField("qty")).toBe("Quantity");
  });
  it("should format creationDate", () => {
    expect(formatField("creationDate")).toBe("Creation Date");
  });
  it("should capitalize other fields", () => {
    expect(formatField("description")).toBe("Description");
    expect(formatField("subtype")).toBe("Subtype");
  });
});

describe("getAuditActionDescription", () => {
  it("should handle create_name", () => {
    const action = {
      type: "create_name",
      payload: { id: "123", name: "foo" },
    };
    expect(getAuditActionDescription(action)).toBe(
      'Created name "foo" for ID "123"',
    );
  });

  it("should handle remove_name", () => {
    const action = {
      type: "remove_name",
      payload: { id: "123", name: "foo" },
    };
    expect(getAuditActionDescription(action)).toBe(
      'Removed name "foo" from ID "123"',
    );
  });

  it("should handle update_field", () => {
    const action = {
      type: "update_field",
      payload: { id: "123", field: "janCode", from: "old", to: "new" },
    };
    expect(getAuditActionDescription(action)).toBe(
      'Updated JAN Code from "old" to "new" for item 123',
    );
  });

  it("should handle update_field with other field", () => {
    const action = {
      type: "update_field",
      payload: { id: "123", field: "description", from: "desc1", to: "desc2" },
    };
    expect(getAuditActionDescription(action)).toBe(
      'Updated Description from "desc1" to "desc2" for item 123',
    );
  });

  it("should fallback to type if no payload", () => {
    expect(getAuditActionDescription({ type: "some_action" })).toBe(
      "some_action",
    );
  });
});
