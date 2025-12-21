import type { Item } from "$lib/inventory";
import Papa from "papaparse";

export interface ShopifyProduct {
  Handle: string;
  Title: string;
  "Body (HTML)": string;
  Vendor: string;
  "Product Category": string;
  Published: string;
  "Option1 Name": string;
  "Option1 Value": string;
  "Variant SKU": string;
  "Variant Grams": number;
  "Variant Inventory Tracker": string;
  "Variant Inventory Qty": number;
  "Variant Inventory Policy": string;
  "Variant Fulfillment Service": string;
  "Variant Price": number;
  "Variant Requires Shipping": string;
  "Variant Taxable": string;
  "Variant Barcode": string;
  "Image Src": string;
  "Image Position": number;
  "Image Alt Text": string;
  "Variant Image": string;
  "Variant Weight Unit": string;
  Status: string;
}

export function generateShopifyCSV(products: ShopifyProduct[]): string {
  return Papa.unparse(products);
}

// Helper to map our Item to a base partial ShopifyProduct
export function mapItemToProduct(item: Item, imagePos: number): ShopifyProduct {
  // Use persisted fields or defaults
  // Handle: Required. If missing from item, caller must ensure it exists or we default? 
  // Ideally, valid items for export have handles.
  const handle = item.handle || "MISSING-HANDLE";
  const title = item.description || "Untitled";
  const body = item.bodyHtml || "";
  
  return {
    Handle: handle,
    Title: title,
    "Body (HTML)": body,
    Vendor: "SPNSS Ltd.",
    "Product Category": item.productCategory || "", 
    Published: "true",
    "Option1 Name": "Subtype",
    "Option1 Value": item.subtype || "Default",
    "Variant SKU": item.janCode + (item.subtype ? "-" + item.subtype : ""),
    "Variant Grams": item.weight || 0,
    "Variant Inventory Tracker": "shopify",
    "Variant Inventory Qty": item.qty,
    "Variant Inventory Policy": "deny",
    "Variant Fulfillment Service": "manual",
    "Variant Price": item.price || 0,
    "Variant Requires Shipping": "true",
    "Variant Taxable": "true",
    "Variant Barcode": item.janCode,
    "Image Src": item.image || "",
    "Image Position": imagePos,
    "Image Alt Text": item.description, // Default to desc
    "Variant Image": item.image || "", // Default to same image
    "Variant Weight Unit": "g",
    Status: "active"
  };
}
