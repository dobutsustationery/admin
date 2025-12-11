import {
  startOfDay,
  endOfDay,
  subDays,
  subWeeks,
  subMonths,
  addDays,
  addWeeks,
  addMonths,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
} from "date-fns";

export type DateRangeView = "day" | "week" | "month";

export interface DateRange {
  start: Date;
  end: Date;
}

export function getDateRange(
  view: DateRangeView,
  referenceDate: Date = new Date(),
): DateRange {
  switch (view) {
    case "day":
      return {
        start: startOfDay(referenceDate),
        end: endOfDay(referenceDate),
      };
    case "week":
      return {
        start: startOfWeek(referenceDate),
        end: endOfWeek(referenceDate),
      };
    case "month":
      return {
        start: startOfMonth(referenceDate),
        end: endOfMonth(referenceDate),
      };
  }
}

export function shiftDateRange(
  view: DateRangeView,
  currentDate: Date,
  direction: "forward" | "back",
): Date {
  const amount = direction === "forward" ? 1 : -1;
  switch (view) {
    case "day":
      return addDays(currentDate, amount);
    case "week":
      return addWeeks(currentDate, amount);
    case "month":
      return addMonths(currentDate, amount);
  }
}
