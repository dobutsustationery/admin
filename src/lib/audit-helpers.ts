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

export function formatField(field: string): string {
  if (!field) return "Unknown Field";
  switch (field) {
    case "janCode":
      return "JAN Code";
    case "hsCode":
      return "HS Code";
    case "qty":
      return "Quantity";
    case "creationDate":
      return "Creation Date";
    default:
      return field.charAt(0).toUpperCase() + field.slice(1);
  }
}

export function getAuditActionDescription(action: any): string {
  const p = action.payload;
  if (!p) return action.type;

  switch (action.type) {
    case "create_name":
      return `Created name "${p.name}" for ID "${p.id}"`;
    case "remove_name":
      return `Removed name "${p.name}" from ID "${p.id}"`;
    case "update_item":
      // Safe access in case item is partial or missing
      return `Updated item ${p.item?.janCode ?? p.id}`;
    case "update_field":
      return `Updated ${formatField(p.field)} from "${p.from}" to "${p.to}" for item ${p.id}`;
    case "new_order":
      return `Created new order ${p.orderID} for ${p.email}`;
    case "package_item":
      return `Packaged ${p.qty} of ${p.itemKey} for order ${p.orderID}`;
    case "quantify_item":
      return `Updated quantity to ${p.qty} for ${p.itemKey} in order ${p.orderID}`;
    case "retype_item":
      return `Retyped ${p.itemKey} to ${p.janCode} (${p.subtype})`;
    case "rename_subtype":
      return `Renamed subtype for ${p.itemKey} to ${p.subtype}`;
    case "delete_empty_order":
      return `Deleted empty order ${p.orderID}`;
    case "archive_inventory":
      return `Archived inventory as "${p.archiveName}"`;
    case "hide_archive":
      return `Hidden archive "${p.archiveName}"`;
    case "make_sales":
      return `Recorded sales event for "${p.archiveName}"`;
    case "inventory_synced":
      return "Inventory synced";
    default:
      return `${action.type}`;
  }
}
