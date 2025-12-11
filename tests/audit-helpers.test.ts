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
