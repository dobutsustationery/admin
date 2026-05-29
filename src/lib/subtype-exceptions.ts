import type { InventoryState, Item, OrderInfo } from "./inventory";
import { makeInventoryItemKey } from "./sku";

export type SubtypeExceptionItem = {
  key: string;
  item: Item;
  qty: number;
  shipped: number;
  onHand: number;
  history: { date: string; desc: string; val: number }[];
};

export type SubtypeExceptionOrderLine = {
  orderID: string;
  date: number;
  email: string;
  product: string;
  itemKey: string;
  qty: number;
};

export type SubtypeException = {
  janCode: string;
  bare: SubtypeExceptionItem;
  subtyped: SubtypeExceptionItem[];
  orders: SubtypeExceptionOrderLine[];
  totalQty: number;
  totalShipped: number;
  totalOnHand: number;
  status:
    | "active-conflict"
    | "bare-only-active"
    | "subtypes-only-active"
    | "zero-residue";
};

export type SplitAllocation = {
  subtype: string;
  qty: number;
};

export type SplitOrderMove = {
  orderID: string;
  subtype: string;
  qty: number;
};

export type SplitPreview = {
  blocked: boolean;
  warnings: string[];
  targets: {
    subtype: string;
    key: string;
    currentQty: number;
    currentShipped: number;
    addQty: number;
    addShipped: number;
    finalQty: number;
    finalShipped: number;
    finalOnHand: number;
  }[];
  deletedBare: {
    key: string;
    qty: number;
    shipped: number;
    onHand: number;
  };
};

export type MergePreview = {
  targetKey: string;
  finalQty: number;
  finalShipped: number;
  finalOnHand: number;
  deletedKeys: string[];
  movedOrderQty: number;
};

export type ReplaceSubtypePreview = {
  blocked: boolean;
  warnings: string[];
  source?: SubtypeExceptionItem;
  target?: SubtypeExceptionItem;
  sourceArchiveSaleQty: number;
  targetUnpricedReceiptQty: number;
};

function itemRow(
  inventory: InventoryState,
  key: string,
  item: Item,
): SubtypeExceptionItem {
  const qty = Number(item.qty) || 0;
  const shipped = Number(item.shipped) || 0;
  return {
    key,
    item,
    qty,
    shipped,
    onHand: qty - shipped,
    history: [...(inventory.idToHistory[key] || [])].sort(
      (a, b) => (a.val || 0) - (b.val || 0),
    ),
  };
}

export function previewReplaceSubtype(
  inventory: InventoryState,
  sourceKey: string,
  targetKey: string,
): ReplaceSubtypePreview {
  const warnings: string[] = [];
  const sourceItem = inventory.idToItem?.[sourceKey];
  const targetItem = inventory.idToItem?.[targetKey];
  const source = sourceItem
    ? itemRow(inventory, sourceKey, sourceItem)
    : undefined;
  const target = targetItem
    ? itemRow(inventory, targetKey, targetItem)
    : undefined;

  if (!source || !target) {
    warnings.push("Choose an existing source and replacement subtype.");
  } else {
    if (sourceKey === targetKey) {
      warnings.push("Source and replacement subtype must be different.");
    }
    if (
      (source.item.janCode || "").trim() !== (target.item.janCode || "").trim()
    ) {
      warnings.push("Source and replacement subtype must share a JAN.");
    }
    if (
      Math.abs(source.qty) > 0.000001 ||
      Math.abs(source.shipped) > 0.000001
    ) {
      warnings.push(
        `Source subtype still has qty ${source.qty} and shipped ${source.shipped}; replacement is only allowed after the source row is inactive.`,
      );
    }
  }

  const sourceArchiveSaleQty = (inventory.costLedger?.[sourceKey] || [])
    .filter(
      (entry) => entry.kind === "sale" && entry.isArchive && !entry.ignored,
    )
    .reduce((sum, entry) => sum + (Number(entry.qty) || 0), 0);
  const targetUnpricedReceiptQty = (inventory.costLedger?.[targetKey] || [])
    .filter(
      (entry) =>
        entry.kind === "receipt" &&
        !entry.ignored &&
        !(entry.unitCostJpy > 0) &&
        !entry.costOrderId &&
        !String(entry.source || "").startsWith("stockOrder:"),
    )
    .reduce((sum, entry) => sum + (Number(entry.qty) || 0), 0);

  return {
    blocked: warnings.length > 0,
    warnings,
    source,
    target,
    sourceArchiveSaleQty,
    targetUnpricedReceiptQty,
  };
}

function orderDateMs(order: OrderInfo): number {
  const raw = order.date as any;
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === "number") return raw;
  const parsed = Date.parse(String(raw || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function statusFor(
  bare: SubtypeExceptionItem,
  subtyped: SubtypeExceptionItem[],
): SubtypeException["status"] {
  const bareActive = bare.qty !== 0 || bare.shipped !== 0;
  const subtypesActive = subtyped.some(
    (row) => row.qty !== 0 || row.shipped !== 0,
  );
  if (bareActive && subtypesActive) return "active-conflict";
  if (bareActive) return "bare-only-active";
  if (subtypesActive) return "subtypes-only-active";
  return "zero-residue";
}

export function selectSubtypeExceptions(
  inventory: InventoryState,
): SubtypeException[] {
  const groups = new Map<string, [string, Item][]>();
  for (const [key, item] of Object.entries(inventory.idToItem || {})) {
    const janCode = item.janCode || "";
    if (!janCode) continue;
    const rows = groups.get(janCode) || [];
    rows.push([key, item]);
    groups.set(janCode, rows);
  }

  const exceptions: SubtypeException[] = [];
  for (const [janCode, rows] of groups) {
    const bareKey = makeInventoryItemKey(janCode, "");
    const bareEntry = rows.find(([key]) => key === bareKey);
    const subtypeEntries = rows.filter(([key]) => key !== bareKey);
    if (!bareEntry || subtypeEntries.length === 0) continue;

    const bare = itemRow(inventory, bareEntry[0], bareEntry[1]);
    const subtyped = subtypeEntries
      .map(([key, item]) => itemRow(inventory, key, item))
      .sort((a, b) => a.key.localeCompare(b.key));
    const keys = new Set([bare.key, ...subtyped.map((row) => row.key)]);
    const orders: SubtypeExceptionOrderLine[] = [];
    for (const order of Object.values(inventory.orderIdToOrder || {})) {
      for (const line of order.items || []) {
        if (!keys.has(line.itemKey)) continue;
        orders.push({
          orderID: order.id,
          date: orderDateMs(order),
          email: order.email || "",
          product: order.product || "",
          itemKey: line.itemKey,
          qty: Number(line.qty) || 0,
        });
      }
    }

    exceptions.push({
      janCode,
      bare,
      subtyped,
      orders: orders.sort(
        (a, b) =>
          a.date - b.date ||
          a.orderID.localeCompare(b.orderID) ||
          a.itemKey.localeCompare(b.itemKey),
      ),
      totalQty: bare.qty + subtyped.reduce((sum, row) => sum + row.qty, 0),
      totalShipped:
        bare.shipped + subtyped.reduce((sum, row) => sum + row.shipped, 0),
      totalOnHand:
        bare.onHand + subtyped.reduce((sum, row) => sum + row.onHand, 0),
      status: statusFor(bare, subtyped),
    });
  }

  return exceptions.sort((a, b) => {
    const rank = {
      "active-conflict": 0,
      "bare-only-active": 1,
      "subtypes-only-active": 2,
      "zero-residue": 3,
    };
    return (
      rank[a.status] - rank[b.status] || a.janCode.localeCompare(b.janCode)
    );
  });
}

export function selectSubtypeRowsForJan(
  inventory: InventoryState,
  janCode: string,
): SubtypeExceptionItem[] {
  const normalizedJan = janCode.trim();
  if (!normalizedJan) return [];
  return Object.entries(inventory.idToItem || {})
    .filter(([, item]) => (item.janCode || "").trim() === normalizedJan)
    .map(([key, item]) => itemRow(inventory, key, item))
    .sort((a, b) => {
      const bareKey = makeInventoryItemKey(normalizedJan, "");
      const aBare = a.key === bareKey ? 0 : 1;
      const bBare = b.key === bareKey ? 0 : 1;
      return aBare - bBare || a.key.localeCompare(b.key);
    });
}

export function previewSplitBareToSubtypes(
  exception: SubtypeException,
  allocations: SplitAllocation[],
  orderMoves: SplitOrderMove[],
): SplitPreview {
  const warnings: string[] = [];
  const bySubtype = new Map<string, SplitAllocation>();
  for (const allocation of allocations) {
    const subtype = allocation.subtype.trim();
    if (!subtype) continue;
    const existing = bySubtype.get(subtype);
    bySubtype.set(subtype, {
      subtype,
      qty: (existing?.qty || 0) + (Number(allocation.qty) || 0),
    });
  }
  const normalized = [...bySubtype.values()];
  const allocationQty = normalized.reduce((sum, row) => sum + row.qty, 0);
  if (Math.abs(allocationQty - exception.bare.qty) > 0.000001) {
    warnings.push(
      `Allocated qty is ${allocationQty}; bare qty is ${exception.bare.qty}.`,
    );
  }

  const bareOrderQty = exception.orders
    .filter((line) => line.itemKey === exception.bare.key)
    .reduce((sum, line) => sum + line.qty, 0);
  const moveQty = orderMoves.reduce(
    (sum, move) => sum + (Number(move.qty) || 0),
    0,
  );
  const zeroResidueHistoricalCleanup =
    exception.bare.qty === 0 && exception.bare.shipped === 0;
  if (zeroResidueHistoricalCleanup) {
    if (Math.abs(moveQty - bareOrderQty) > 0.000001) {
      warnings.push(
        `Moved historical order qty is ${moveQty}; bare order lines total ${bareOrderQty}.`,
      );
    }
  } else {
    if (Math.abs(moveQty - exception.bare.shipped) > 0.000001) {
      warnings.push(
        `Moved order qty is ${moveQty}; bare shipped qty is ${exception.bare.shipped}.`,
      );
    }
    if (bareOrderQty !== exception.bare.shipped) {
      warnings.push(
        `Bare order lines total ${bareOrderQty}, but bare shipped counter is ${exception.bare.shipped}.`,
      );
    }
  }

  const shippedBySubtype = new Map<string, number>();
  for (const move of orderMoves) {
    const subtype = move.subtype.trim();
    const shippedQty = zeroResidueHistoricalCleanup ? 0 : Number(move.qty) || 0;
    shippedBySubtype.set(
      subtype,
      (shippedBySubtype.get(subtype) || 0) + shippedQty,
    );
  }

  const currentBySubtype = new Map(
    exception.subtyped.map((row) => [row.item.subtype || "", row]),
  );
  const targets = normalized.map((allocation) => {
    const current = currentBySubtype.get(allocation.subtype);
    const currentQty = current?.qty || 0;
    const currentShipped = current?.shipped || 0;
    const addShipped = shippedBySubtype.get(allocation.subtype) || 0;
    return {
      subtype: allocation.subtype,
      key: makeInventoryItemKey(exception.janCode, allocation.subtype),
      currentQty,
      currentShipped,
      addQty: allocation.qty,
      addShipped,
      finalQty: currentQty + allocation.qty,
      finalShipped: currentShipped + addShipped,
      finalOnHand: currentQty + allocation.qty - currentShipped - addShipped,
    };
  });

  return {
    blocked: warnings.length > 0,
    warnings,
    targets,
    deletedBare: {
      key: exception.bare.key,
      qty: exception.bare.qty,
      shipped: exception.bare.shipped,
      onHand: exception.bare.onHand,
    },
  };
}

export function previewMergeSubtypesToBare(
  exception: SubtypeException,
): MergePreview {
  const movedQty = exception.subtyped.reduce((sum, row) => sum + row.qty, 0);
  const movedShipped = exception.subtyped.reduce(
    (sum, row) => sum + row.shipped,
    0,
  );
  return {
    targetKey: exception.bare.key,
    finalQty: exception.bare.qty + movedQty,
    finalShipped: exception.bare.shipped + movedShipped,
    finalOnHand:
      exception.bare.qty + movedQty - exception.bare.shipped - movedShipped,
    deletedKeys: exception.subtyped.map((row) => row.key),
    movedOrderQty: exception.orders
      .filter((line) => line.itemKey !== exception.bare.key)
      .reduce((sum, line) => sum + line.qty, 0),
  };
}
