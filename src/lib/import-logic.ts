/**
 * Import Logic for Order Processing
 * Handles parsing of CSV/Spreadsheet data and matching against inventory.
 */

import type { Item, InventoryState } from "./inventory";

export interface ParsedItem {
  janCode: string;
  qty: number;
  row: number; // For reference/error reporting
}

export interface ImportPlan {
  matches: PlanMatch[];
  newItems: PlanNewItem[];
  conflicts: PlanConflict[];
  summary: {
    totalRows: number;
    validRows: number;
    totalQty: number;
  };
}

export interface PlanMatch {
  janCode: string;
  item: Item;
  addQty: number;
}

export interface PlanNewItem {
  janCode: string;
  qty: number;
}

export interface PlanConflict {
  janCode: string;
  currentSubtypes: Item[];
  totalQty: number;
}

/**
 * Parse raw CSV text into structured data
 * Assumes a simple format: "JAN CODE, QTY" or similar
 * Heuristics:
 * - Look for column with JAN-like format (13 digits, starting with 45/49)
 * - Look for column with numeric value
 */
export function parseImportData(csvText: string): ParsedItem[] {
  const lines = csvText.split(/\r?\n/);
  const result: ParsedItem[] = [];

  // Simple heuristic: find JAN column index and Qty column index
  // For V1, we'll try to detect headers, or just Scan every row for a JAN.
  
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    
    // Split by comma (ignoring quotes is better, but simple split for now)
    const columns = line.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
    
    // Find candidate JAN
    // JANs are usually 13 digits, sometimes 8.
    // A heuristic: First column that looks like a JAN.
    const janIndex = columns.findIndex(c => /^\d{8,13}$/.test(c));
    
    if (janIndex !== -1) {
       const janCode = columns[janIndex];
       
       // Look for quantity. Usually after JAN.
       // Heuristic: First numeric column after JAN, or just the next column.
       let qty = 1; // Default
       
       // Try to find an explicit quantity column
       // For now, let's assume if there's a number in the *next* column, it's qty.
       // Or if there is a header "Qty" or "Quantity".
       // Let's rely on row-by-row scanning.
       
       // Search for number in other columns
       const qtyCandidate = columns.find((c, i) => i !== janIndex && /^\d+$/.test(c));
       if (qtyCandidate) {
          qty = parseInt(qtyCandidate, 10);
       }
       
       // Exclude probable headers (e.g. if JAN found is part of a header row that has 13 digits? Unlikely)
       // But checking if "49..."
       
       result.push({ janCode, qty, row: index + 1 });
    }
  });

  return result;
}

/**
 * Analyze parsed data against current inventory to generate an Import Plan
 */
export function analyzeImport(parsedItems: ParsedItem[], inventory: InventoryState): ImportPlan {
  const matches: PlanMatch[] = [];
  const newItems: PlanNewItem[] = [];
  const conflicts: PlanConflict[] = []; // Subtype conflicts
  
  // Aggregate parsed items by JAN (in case multiple rows for same JAN)
  const aggregated: Record<string, number> = {};
  parsedItems.forEach(p => {
    aggregated[p.janCode] = (aggregated[p.janCode] || 0) + p.qty;
  });
  
  // Walk through unique JANs
  Object.keys(aggregated).forEach(janCode => {
     const qty = aggregated[janCode];
     
     // Search in inventory
     // idToItem keys are sometimes just JAN, sometimes JAN+Subtype
     
     // 1. Exact match on JAN (if it used as ID directly) OR
     // 2. Find all items starting with JAN
     
     const foundItems: Item[] = [];
     Object.values(inventory.idToItem).forEach(item => {
        if (item.janCode === janCode) {
           foundItems.push(item);
        }
     });
     
     if (foundItems.length === 0) {
        // NEW ITEM
        newItems.push({ janCode, qty });
     } else if (foundItems.length === 1) {
        // EXACT MATCH (Single SKU)
        // Check if it has a subtype? Even if it has a subtype, if it's the ONLY one, matches.
        // Wait, if it has a subtype, usually it key is JAN+Subtype. 
        // If we only have 1 item with that JAN, we can assume it's that SKU.
        matches.push({ janCode, item: foundItems[0], addQty: qty });
     } else {
        // MULTIPLE MATCHES (Subtypes exist)
        // CONFLICT
        conflicts.push({
           janCode,
           currentSubtypes: foundItems,
           totalQty: qty
        });
     }
  });
  
  return {
    matches,
    newItems,
    conflicts,
    summary: {
      totalRows: parsedItems.length,
      validRows: Object.keys(aggregated).length,
      totalQty: parsedItems.reduce((acc, p) => acc + p.qty, 0)
    }
  };
}
