export type Cell = string | number | boolean | null;
export interface CustomsSource {
  id: string;
  name: string;
  tab: string;
  sheetId: number;
  rows: Cell[][];
  modifiedTime?: string;
}
export interface CustomsInput {
  order: CustomsSource;
  shipping: CustomsSource;
  dictionary?: CustomsSource;
}
export interface CustomsDecision {
  code?: string;
  en?: string;
  bg?: string;
  origin?: string;
  grams?: string;
}
export interface CustomsSettings {
  grossKg: string;
  grossSource: string;
  packagePolicy: "" | "cartons";
  cartonGross: Record<string, string>;
  grossMethod: "shipment" | "carton";
}
export interface CustomsProduct {
  jan: string;
  description: string;
  manufacturer: string;
  material: string;
  origin: string;
  grams: number;
  qty: number;
  price: number;
  row: number;
  code: string;
  en: string;
  bg: string;
  basis: string;
  suggestions: { code: string; reason: string; en?: string; bg?: string }[];
}
export interface CustomsAllocation {
  jan: string;
  orderRow: number;
  shippingRow: number;
  carton: string;
  qty: number;
  yen: number;
  netKg: number;
}
export interface CustomsGroup {
  key: string;
  code: string;
  en: string;
  bg: string;
  origin: string;
  pieces: number;
  yen: number;
  netKg: number;
  grossKg: number | null;
  cartons: string[];
}
export interface CustomsProjection {
  invoice: string;
  products: CustomsProduct[];
  allocations: CustomsAllocation[];
  groups: CustomsGroup[];
  cartons: { id: string; pieces: number; yen: number; netKg: number }[];
  issues: string[];
  excluded: string[];
  totals: {
    pieces: number;
    yen: number;
    netKg: number;
    grossKg: number | null;
  };
  ready: boolean;
  // Materialized export cells are derived here, never put in events.
  tables: Record<string, Cell[][]>;
}
export interface CustomsReport {
  id: string;
  name: string;
  creator: string;
  timestamp: number;
  chunks: Record<string, Record<number, string>>;
  input?: CustomsInput;
  inventoryFacts: Record<
    string,
    { janCode: string; hsCode: string; description: string }
  >;
  previousClassifications: {
    jan: string;
    description: string;
    material: string;
    code: string;
    en: string;
    bg: string;
    reportName: string;
  }[];
  decisions: Record<string, CustomsDecision>;
  settings: CustomsSettings;
  settingsConfirmed: boolean;
  revision: number;
  projection: CustomsProjection;
  exports: Record<
    string,
    { revision: number; response?: string; verified?: boolean }
  >;
}
export interface CustomsState {
  reports: Record<string, CustomsReport>;
  appliedEventIds: string[];
}
