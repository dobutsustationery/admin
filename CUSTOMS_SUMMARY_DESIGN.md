# Customs summary design

Status: implementation for staging, 2026-09-13. Source inspection remains as recorded below. The durability requirements in section 10 supersede the earlier local-draft architecture. Source workbooks are never edited by this feature.

Implemented staging scope: separate Customs Summary route; native Google Sheets selection through the existing account's Drive list or URL; explicit tab selection; durable reports and raw source imports; reducer-side parsing/reconciliation and HS suggestions (including previously accepted report classifications); explicit single/batch/manual classification; report-local origin/weight corrections; whole-shipment or per-carton measured gross allocation; confirmed non-additive carton package counts; both previews; new-workbook export with recovery and reducer-side read-back verification.

The initial supplier profile requires matching order/shipment quantities and unambiguous rows. Partial shipments, duplicate order identities, continuation cartons and invoice-total discrepancies remain visible blockers to resolve in the source spreadsheets and reread. There is no AI service, automatic inventory write-back, draft export, arbitrary package declaration policy, or Google Picker dependency in this staging implementation. Drive listing/URL selection uses the existing granted read access; users with only drive.file will see/access the files already granted to this app. These limitations are explicit, not inferred data.

## Outcome and scope

Add a **Customs Summary** page at `/customs-summary`. The user selects a supplier order Google spreadsheet and its shipping/packing Google spreadsheet. The inventory system reads both through the Google Sheets API, reconciles their product rows, supplies available inventory HS classifications, and generates the two tables currently found on **Ognyan Summary**:

1. Commodity totals grouped by HS code and country of origin, with English/Bulgarian descriptions, pieces, packages, net/gross weight, and invoice value.
2. The cartons containing each HS-code/country combination.

Show the tables in the application and offer **Create Google summary**, producing a new workbook with an `Ognyan Summary` tab. The reference workbook is the specification and a test fixture, not a third file the user must select each time. The two selected source files remain unchanged. Creating a summary must not receive stock, change quantities/costs, or trigger Shopify/Amazon synchronization.

**Two files alone cannot fill every final column.** They contain quantities, prices, origins, unit weights, and carton membership, but no product-to-HS mapping or measured shipment gross weight. The feature becomes automatic for classified inventory once the user supplies shipment gross weight and resolves the package convention. Missing information must be visible in a draft rather than represented as zero.

## 1. Evidence from the three files

All filenames below are relative to `sheets/`.

| Role | Exact filename | Relevant tabs |
| --- | --- | --- |
| Order input | Automation（260821 Final Confirmed by Ellie）Kanegen Order【SPNSS Ltd. Elpis Nikolaou様】Order 20260818.xlsx | Product List; HS Codes |
| Shipping input | Automation【Elpis Nikolaou 様】 Shipping Invoice for the Order Placed on August 21 .xlsx | 出荷明細書; 箱番順 |
| Reference output | Kanegen Working on this for automation - Google Sheets Version.xlsx | Original Order from Kanegen; Carton Info; Normalised Data with HS Code; HS Code > Carton; Ognyan Summary; HS Codes |

Inspection used the XLSX XML, including stored cell values and formulas. Google Sheets QUERY/spill formulas are exported partly as `__xludf.DUMMYFUNCTION` wrappers; their stored results are useful evidence, not portable formulas to execute.

### Current input shipment: exact reconciliation

Both inputs identify invoice **S067690**, issue date **20260821**, and supplier registration **T7-0300-0100-1987**. Use these fields to confirm the pairing. File titles and other unlabelled dates are weaker evidence.

The order has **69 product rows, rows 11–79**, with 69 distinct JANs. Both shipping tabs also contain those 69 JANs with identical quantities and carton assignments. They differ only in ordering. There are no unmatched JANs or per-JAN quantity differences in this fixture.

| Carton | Product rows | Shipped pieces | Goods value JPY | Net kg |
| --- | ---: | ---: | ---: | ---: |
| 1 | 31 | 371 | 108,520 | 8.720 |
| 2 | 19 | 230 | 55,580 | 13.370 |
| 3 | 19 | 310 | 74,130 | 7.360 |
| **Total** | **69** | **911** | **238,230** | **29.450** |

All 69 order rows state Japan as origin. The order's row 89 independently totals **D89 = 911**, **H89 = 238230**, **M89 = 29450 grams**, and **O89 = 95 order units**. Those 95 are supplier pack units, not evidence of 95 shipping cartons.

The shipping footer at D86/E86 contains a received-order-amount label and **126**. It is not the goods total, pieces total, carton count, or a labelled gross weight; do not use it for any of these.

The two inputs do not support a trustworthy numeric HS-group table until classification is supplied. This inspection did not read production inventory to measure classification coverage.

### Reference workbook: intended calculations and defects

Its contents describe a different shipment: **71 product rows, 959 pieces, JPY 301,013, 40.314 kg net**, cartons 1–4. These are reference-fixture expectations, never expected totals for the August inputs.

The principal formula chain is:

```text
Original Order from Kanegen
  + Carton Info, joined by JAN through VLOOKUP
  -> Normalised Data with HS Code
       + manually chosen HS category
       + HS Codes descriptions
       + line net/gross calculations
  -> Ognyan Summary, grouped commodity totals

Normalized HS + origin + carton
  -> HS Code > Carton, UNIQUE and TEXTJOIN
  -> Ognyan Summary, carton membership table
```

Specific cells establish the intended mapping:

- `Normalised Data with HS Code!A1` queries `Original Order from Kanegen!A10:X1000`, selecting **C,J,E,B,N,D,H,Q,L** where D > 0: JAN, origin, product, manufacturer, supplier units, pieces, goods value, carton, unit grams.
- Normalized **J** is a manually selected category label. **R** looks it up against `HS Codes!D:F` to get the code; **S/T** look up short English/Bulgarian descriptions by code.
- **U = I × F / 1000** computes line net kg.
- **Y = IF(H="-", previous Y, H)** carries forward carton values. That spreadsheet convention must become an explicit parser option, not unrestricted fill-down.
- `Ognyan Summary!A4` groups **R,S,T,B**, summing **F**, literal **0**, **U**, **V**, and **G**. Thus “Number of Pieces” really means PCS, while “Number of Packages” is entirely unimplemented.
- The second table begins at **A35:E35**. `HS Code > Carton` deduplicates normalized **W:X:Y = HS:origin:carton**, then joins carton IDs with commas. Some output values are pasted rather than dynamically linked.

Defects to exclude from the new implementation:

1. The normalized query admits the source totals row because its quantity is positive. Normalized row 73 has **959 pieces and 301013 value with no JAN**. It becomes a spurious blank classification row at `Ognyan Summary!A5:I5`, duplicating shipment totals if included.
2. Gross formulas are inconsistent: **V2:V4 use net / 94.29 × 106.6**, while **V5 onward use net / 40.314 × 46.3**. The summary's H2 is separately hardcoded to **106.6**. Actual displayed group gross values sum to approximately **46.2870905975**, matching neither declared number. There is no established reliable historical gross total to copy.
3. Packages are zero in every group, not derived from either supplier units or cartons.
4. Carton lists retain encounter order, e.g. **1, 4, 3**; use stable natural sorting.
5. The reference `Packing List` has failing dimension/weight lookups. Unlabelled values in `HS Code > Carton!M:M` also do not establish a reliable gross-weight source.
6. The “BGN Cost” label in J1 has no populated conversion calculation. Currency conversion is not required to reproduce the functioning tables.

## 2. User workflow

1. Open **Customs Summary** from navigation near Order Import. Connect the existing Google account if necessary.
2. Select **Order spreadsheet** and **Shipping spreadsheet** separately using Google Picker, with file title and selected tab displayed. Native Google Sheets are the MVP input type. Show a clear instruction to save an Excel file as Google Sheets if an XLSX is selected; do not silently convert or alter it.
3. Detect `Product List` and `出荷明細書`. Use `箱番順` only as an alternative, never concatenate both. If names differ, identify tabs by required headers and offer an explicit tab/mapping selection when ambiguous.
4. Read and reconcile. Show invoice identity, source links, accepted/excluded/error row counts, pieces, value, net kg, and carton totals.
5. Resolve an **Information needed** table: missing/ambiguous HS codes, missing translations, origin/weight conflicts, unmatched products, quantity/price discrepancies, and missing carton information. Show the originating cells next to each issue. Allow bulk category assignment with a preview of affected rows.
6. Enter measured total shipment gross kg, or measured gross kg for every carton. Record where the measurements came from. Select the agreed package convention described below.
7. Preview both summary tables; selecting a group expands its contributing products and cartons. Changes to classifications or measurements recalculate immediately from the same input snapshot.
8. Create a new Google workbook. Once read-back validation succeeds, show its link. A separate **Export draft** action may create a visibly marked draft with unresolved cells blank and an Issues tab. It must never appear complete.

Report-specific corrections are durable user-decision events and stay in the report. An optional later “Save classification to inventory” action should use existing audited item-update actions and explicitly show the affected items; report generation itself must not dispatch inventory mutations.

Recommended MVP output is a fresh workbook. Updating an arbitrary existing workbook or the historical template is outside MVP; this avoids overwriting hand edits. Regeneration creates a new version, while retrying a failed export resumes the same app-created workbook.

## 3. Input schema and normalization

### Order: Product List

Header is row 10 in this fixture. Detect headers after normalizing whitespace, newlines, case, and full-width characters; retain original text and positions for audit. Match header meanings before using the supplier profile's column defaults.

| Field | Fixture column | Meaning / rule |
| --- | --- | --- |
| Source line number | A | Diagnostic; not the join key |
| Manufacturer | B | Audit and classification review |
| JAN | C | Product join key, preserved as text |
| Ordered pieces | D | Order Q'ty PCS; integer count |
| Product description | E | Display/audit |
| Retail price | F | Do not use as invoice value |
| Wholesale unit JPY | G | Cost per piece |
| Extended line JPY | H | Compare with D × G |
| Origin | J | Supplier country of origin |
| Material | K | Classification review context |
| Unit grams | L | Weight per piece |
| Extended grams | M | Compare with D × L |
| Pieces per supplier unit | N | Minimum Order Quantity in this input |
| Ordered supplier units | O | Check D / N where meaningful |
| Remarks | P | Preserve corrections and exceptions |

The old reference swaps the roles of **N/O**: N is ordered supplier units and O is items per inner box. Header-based mapping is essential.

Metadata for this input: invoice **H3**, labelled issue date **H2**, registration **H1**. Parse explicit eight-digit YYYYMMDD separately from genuine Sheets date serials, using the spreadsheet locale/time zone for the latter. Prefer labelled metadata; discrepancies require review.

### Shipping: 出荷明細書, alternatively 箱番順

| Field | Fixture column | Meaning / rule |
| --- | --- | --- |
| Source line number | A | Diagnostic |
| JAN | B | Join to order |
| Product description | C | Japanese description for cross-checking |
| Shipped pieces | D | Authoritative quantity for this shipment |
| Carton | E | Physical carton membership |
| Remarks | F | Preserve |

Invoice is **E4**, issue date **E3**, registration **E2**. No wholesale cost or measured gross column is present.

### Parsing rules

- Process all populated relevant rows, including hidden/filtered rows; the current view is not shipment scope. Fetch to the tab's grid boundary in bounded chunks, rather than stopping at the first blank or using the template's 1000/1491 cutoff.
- Accept a product row only when it has a valid JAN and a positive integer quantity. Classify empty rows and positively identified totals/headers separately. A partly populated apparent product with invalid JAN or quantity is an error, not silently dropped. Zero-quantity product rows are excluded and listed; negative/fractional quantities require resolution.
- JANs are identifiers. Trim whitespace and normalize digits; retain leading zeros. Convert numeric/scientific-notation cells to exact plain integer strings only when safely representable. If formatting preserves leading zeros, recover them from that cell representation; if information has already been lost, request correction. Do not pad unknown digits or join on product names.
- Store HS codes as text. The supplier profile expects eight digits, preserving leading zeros; do not assert that every inventory code is eight digits or silently truncate other classifications. Unexpected lengths require review.
- Canonicalize numeric cartons such as **1.0 → "1"**; retain meaningful alphanumeric labels. Treat “1,2” or “1–3” as ambiguous allocation unless separate per-carton quantities are supplied. Do not assign the whole row quantity to every named carton.
- Fill down a carton only for actual merged cells, or an explicitly enabled supplier convention for “-”/blank continuation rows inside the same product block. Never carry through headings/totals or accept a leading orphan continuation.
- Read calculated values, retain formulas for provenance, and surface Sheets cell errors. Do not evaluate Excel formulas or parse locale-formatted currency as the primary numeric input.
- Use decimal arithmetic for money and weight. Do not reuse permissive numeric parsing that strips arbitrary characters or rounds unit prices before reconciliation.

### Matching and shipment quantities

Join shipping JANs to order JANs. Preserve **one normalized allocation per order-line/shipping-row/carton combination**.

For each ordered JAN, reconcile ordered quantity against the sum of its shipping rows. Splitting one JAN across cartons is supported; copying the full ordered line value onto each shipping row is prohibited.

Duplicate order JANs may be combined only when cost, origin, weight, classification, and other relevant attributes agree, while preserving all source row references. Otherwise require an explicit match/quantity allocation. Identical duplicate shipping rows are flagged for review; do not silently deduplicate them because they might be real allocations.

Unshipped order lines are reported separately. Partially shipped orders require a confirmed shipment scope and valuation. Shipping-only products block a completed report until their cost/origin/weight/classification are supplied from an identified source. Over-shipment and invoice-identity mismatches require resolution. The current fixture has none of these discrepancies.

Inventory matching must account for subtypes: multiple inventory items can share a JAN. An HS value can be reused automatically if all matching active candidates agree on a nonempty code. Disagreement or incomplete candidates require selection/review; never pick the first match or the item's current stock quantity.

## 4. HS classification and bilingual descriptions

The order's `HS Codes` tab contains **24 dictionary entries**: A code, B full English, C full Bulgarian, D short English. It contains **no per-product assignment and no short Bulgarian column**.

The reference has **29 dictionary entries**, with short Bulgarian in E and a redundant code in F. The app's `src/lib/hscodes.ts` already has 29 English descriptions corresponding to that reference dictionary, but no Bulgarian descriptions. The dictionaries differ: for example, **59061000** is present in the new order dictionary and absent from the existing app dictionary.

Implement a versioned dictionary with:

```ts
type CustomsDescription = {
  code: string;
  shortEn: string;
  shortBg?: string;
  fullEn?: string;
  fullBg?: string;
  source: string;
  version: string;
};
```

Seed short Bulgarian descriptions from the reference's HS Codes tab during implementation, preserving existing English exports for their current consumers. Import the selected order's dictionary as report-local supplemental data; show conflicting descriptions for review rather than overwriting shared definitions.

Resolve product HS code in this order: explicit report correction or accepted suggestion; mapped explicit source HS column if present in a future supplier file; unambiguous inventory code; suggestion awaiting review; unresolved. Show disagreements between sources. Product title/material may generate candidates through the review workflow in section 9; a guess never becomes an accepted classification without user action. Existing item values also require visibility because inventory entry screens can supply defaults.

Resolve descriptions from the approved report dictionary: short English/Bulgarian preferred; full English/Bulgarian is an acceptable visible fallback, with a preview because it produces taller rows. Missing Bulgarian must not fall back silently to English. Resolve before completed export. A new code with complete approved descriptions may be used without a deployment.

For example, the reference maps **48201030** to **Notebooks & Memo Pads / тетрадки и бележници**, and **82130000** to **Scissors / Ножици**. These are historical template labels, not an assertion that a code is legally correct for a newly imported item.

Supplier origin and weight take precedence for this shipment, with inventory differences shown as review items. Inventory fills absent fields only through a visible resolution. Save the chosen field value and its provenance in the report snapshot.

## 5. Computations

Let allocation i have shipped pieces qᵢ, unit invoice price pᵢ JPY, unit weight wᵢ grams, HS hᵢ, normalized origin oᵢ, and carton cᵢ.

### Line value and net weight

```text
lineNetKgᵢ = qᵢ × wᵢ / 1000
lineGoodsJpyᵢ = qᵢ × pᵢ
group key = (HS code, normalized country of origin)
```

For a fully shipped order line, reconcile the calculated value with supplier extended amount H. When H differs from D × G, require an explicit valuation resolution (e.g. confirmed discounted extended value), keeping both original values. If an authoritative line amount V is chosen, allocate V × qᵢ / Q across that line's shipped pieces. For partial shipments, Q is the ordered quantity only when the user confirms proportional valuation; otherwise obtain the actual shipment invoice amount.

Goods value excludes separately stated freight, insurance, tax, and handling. Preserve such charges and their reconciliation separately if future inputs contain them; do not infer a customs-value formula or distribute unidentified footer numbers. The current input's goods total is exactly JPY 238230.

Net calculations similarly reconcile M against D × L. Do not label supplier weights as measured shipment weights: record that they are supplied per-piece weights. If their net/gross meaning is disputed, resolve it rather than adjusting to make totals fit.

Worked current-input row: JAN **4952270242559**, order row 11, shipping carton **2**, quantity **20**, unit wholesale **212 JPY**, unit weight **15 g**:

```text
value = 20 × 212 = 4240 JPY
net = 20 × 15 / 1000 = 0.300 kg
```

It contributes those amounts once to its eventual HS/Japan group and to carton 2.

### Table 1: commodity summary

Group by canonical HS and country, not translated description text. Resolve one description pair per group. Sort HS ascending, then canonical country.

| Column | Output heading | Computation |
| --- | --- | --- |
| A | HS CODE | Group HS, text |
| B | Description of commodity in English | Resolved English dictionary value |
| C | Description of commodity in Bulgarian | Resolved Bulgarian dictionary value |
| D | Origin Country | Canonical country rendered in English |
| E | Number of Pieces | Sum qᵢ in group |
| F | Number of Packages | Explicit package policy below |
| G | Net weight (kg) | Sum lineNetKgᵢ |
| H | Gross weight (kg) | Sum allocated gross under selected method |
| I | Value as per invoice currency (YEN) | Sum lineGoodsJpyᵢ |

The two scissors rows in the reference demonstrate why origin is part of the key: China and Japan remain separate even with identical HS/description.

### Gross weight allocation

A measured shipment total cannot be derived from unit product weights. Require positive measured gross kg and its source. Missing gross remains null in draft.

Default when only total gross G is available:

```text
N = sum(all line net kg)
grossᵢ = lineNetKgᵢ × G / N
```

This is proportional allocation of measured shipment gross, matching the reference's apparent intent while eliminating hardcoded denominators. State the method in the output. Require N > 0 and G ≥ N; discrepancies need correction, not a silently accepted negative packaging weight.

If gross measurements G꜀ exist for **every carton**, prefer:

```text
N꜀ = sum(net kg allocated to carton c)
grossᵢ = lineNetKgᵢ × G꜀ / N꜀
shipment gross = sum(G꜀)
```

Require each G꜀ ≥ N꜀ and reconcile any independently entered shipment gross. Do not blend a few measured cartons with an unstated estimate for the others; choose complete per-carton measurements or shipment-wide allocation explicitly. Empty cartons/pallets need a documented packaging allocation if their weight is included in gross.

Illustrative only: if the August shipment were measured at **33.000 kg**, carton 2's 13.370 net would receive **13.370 / 29.450 × 33.000** gross under the shipment method. **33.000 is not in either input and must never be prefilled.**

### Packages: unresolved business convention

Three distinct counts must not be confused:

- **911 pieces**: units of merchandise.
- **95 supplier order units**: wholesale packs from order O.
- **3 physical cartons**: unique shipping carton IDs.

The reference's package column is zero everywhere, so its intended business meaning cannot be inferred. Default to blank and require the user to choose a documented policy before marking the report complete:

| Policy | Group F | Shipment package total |
| --- | --- | --- |
| Cartons containing this commodity | Count distinct cᵢ in group | Count unique cartons across shipment |
| Explicit declaration counts | User-entered nonnegative integer per group, with explanation for shared cartons | Separately supplied/confirmed shipment count |

With the first policy, group package counts are **non-additive**: a mixed carton occurs in several groups. Annotate this clearly and show unique shipment cartons separately; never sum F as total physical packages. Do not map supplier units to F without a separate agreed specification.

Confirm the convention with the intended recipient before adopting a persistent default. Draft generation and all other calculations can proceed meanwhile.

### Table 2: carton membership

For each identical HS/origin group, collect distinct carton IDs; natural-sort them and join with **", "**. Output A HS, B English, C Bulgarian, D Origin Country, E Contained in Carton Number. Use the same group order as table 1. Shared cartons legitimately appear on multiple rows.

For reference **48201030/Japan**, the normalized list must be **1, 3, 4**; for **48211010/Japan**, **1, 4**. Membership must come from shipping allocations, not product-level VLOOKUP first matches.

### Precision and totals

Keep decimal values at source precision through multiplication and aggregation. Export counts as integers, JPY totals at whole yen for this profile, and weights at **0.001 kg**. Values genuinely requiring sub-yen precision must be resolved or assigned an explicit rounding policy, not silently rounded at import.

For a proportional allocation, reconcile rounded displayed amounts with their authoritative rounded total using largest remainders: floor each nonnegative share to the output increment; distribute remaining increments to the largest fractional remainders, breaking ties by stable group/order/carton key. Record adjustments. Use this for split line yen and displayed net/gross group weights as necessary; preserve unrounded calculations in audit data.

Assert that group pieces/value/net sum to normalized shipment totals, allocated gross sums to measured gross, and every carton membership corresponds to at least one contributing allocation. No blank HS/origin groups may appear in a completed report.

BGN conversion is outside MVP. If later added, require explicit target currency, rate, rate date/source, and rounding; do not reuse the old BGN heading or inventory exchange-rate constants as an implied requirement.

## 6. Google integration

Reuse `src/lib/google-auth-unified.ts` for PKCE, tokens, refresh, and reauthorization, plus compatible metadata helpers in `src/lib/google-drive.ts`. The integration design document describes broader Sheets functionality, but the inspected Drive module currently provides file/image/CSV operations rather than this report pipeline.

The existing default OAuth scope union includes **drive.file** and **drive.readonly**, with environment overrides. Check actual granted token scopes. For this feature, prefer Picker-selected files plus **drive.file**, which supports working with selected/app-created Sheets. Do not request blanket Drive write access merely to create reports. Existing broader read access can support URL selection, but a pasted URL alone does not grant access under drive.file. Prompt the user to select that file through Picker if needed. Google documents file-scoped access and supported Sheets scopes in its [Sheets authorization guide](https://developers.google.com/workspace/sheets/api/scopes).

Configure Google Picker using the same Cloud project/app ID and OAuth account, with a Google Sheets MIME filter and a referrer-restricted API key. Enable Sheets, Drive, and Picker APIs for each environment as necessary. Keep Firebase login and Google file-access identity visible as distinct accounts. Follow the [Picker integration guide](https://developers.google.com/workspace/drive/api/guides/picker).

### Read sequence

1. Get Drive metadata for each selected file: ID, name, MIME type, modifiedTime/version where available. Reject the same workbook selected for both roles in the MVP supplier flow.
2. Read Sheets metadata: spreadsheet title, locale/time zone, tabs with numeric sheet IDs and grid bounds. Detect tabs and headers.
3. Fetch relevant ranges in batches **per spreadsheet**, with `majorDimension=ROWS`, `valueRenderOption=UNFORMATTED_VALUE`, and explicit date rendering. Example ranges for these inputs: `'Product List'!A1:P931`, `'HS Codes'!A1:F25`, and `'出荷明細書'!A1:F1000`. Actual endpoints use detected bounds, not these fixture constants.
4. Capture cell provenance/formulas/errors via bounded `spreadsheets.get` grid-data requests selecting `userEnteredValue`, `effectiveValue`, and `formattedValue`; alternatively use that grid representation directly as the parser input to avoid redundant reads.
5. Recheck source metadata after reading. If either changes, discard the mixed snapshot and reread. Cross-workbook reads are not atomic; also hash the values actually used and revalidate relevant ranges before export. If changed, show differences and regenerate the preview.
6. Retain spreadsheet ID, sheet ID/title, row/cell addresses, read time, source metadata, input hash, and inventory enrichment snapshot with the result.

Quote/escape tab names in A1 ranges and URL-encode parameters; do not interpolate arbitrary URLs into network destinations. Sheets returns ragged arrays and omits trailing empty cells; normalize missing positions rather than shifting columns. The official [batchGet reference](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/batchGet) specifies value rendering and ranges; [spreadsheets.get](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/get) supports selective grid data and field masks.

### Write sequence and output shape

Create **Customs Summary — S067690 — 2026-08-21** with four tabs:

- **Ognyan Summary**: the two recipient-facing tables, shipment identity/totals, and weight/package method notes.
- **Normalised Data**: each allocation with source references, JAN, product, quantities, unit/extended amounts, weights, HS/descriptions, origin, carton, and enrichment provenance.
- **Cartons**: carton totals and entered measured gross weights.
- **Sources and Checks**: source links/versions/hashes, parser and dictionary versions, report corrections, excluded rows, reconciliations, unresolved issues/draft status, and report generation ID.

Keep the nine-column order of the first reference table. Recommended deterministic layout: metadata rows 1–4; table 1 header row 6; data row 7 onward; totals immediately after data; notes next; second header at `max(35, firstTableTotalRow + 5)`. This retains row 35 for small reports and prevents overlap for more than the historical 11 groups. Wrap descriptions, set sensible widths, and format numeric cells; do not reproduce query-generated “sum” headers or the duplicate totals group.

Use `POST /v4/spreadsheets` with the tab definitions and retain its returned ID. Google documents this in [spreadsheets.create](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/create). Write deterministic cell arrays with `POST /v4/spreadsheets/{id}/values:batchUpdate`, `valueInputOption: "RAW"`, and typed numeric values. JAN/HS/carton identifiers and descriptions are strings. RAW avoids interpreting supplier text as formulas or dates; see [ValueInputOption](https://developers.google.com/workspace/sheets/api/reference/rest/v4/ValueInputOption) and [values.batchUpdate](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/batchUpdate).

Apply formatting with [spreadsheets.batchUpdate](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/batchUpdate). Read back the output table ranges and reconcile them before marking export complete. Export calculated values, not cross-file IMPORTRANGE/QUERY chains; the app owns the computation and the report remains reproducible without live spreadsheet formulas.

No public-sharing permission changes: the existing image-upload path has a `setFilePermissions` helper inappropriate for commercial shipment documents. A user can share the new report through Google Sheets afterward.

### Failures and repeat clicks

Use a report/run ID and deterministic input/configuration hash. Disable concurrent export clicks. Persist the created spreadsheet ID immediately in a small account-scoped export journal; retry writes against that ID. Mark workbook status incomplete until verified. If create times out without returning an ID, do not blindly create again: inspect candidate app-created files for the run marker (included in initial title), or ask the user to resolve the uncertain result. Add run metadata once the ID is known.

401: refresh once, then reconnect. 403/404: report file/account/scope access problem with the source title. 429/5xx: bounded exponential backoff with jitter, respecting retry guidance. Repeated source changes require another preview. Batch requests rather than per-row API calls; Google documents quotas and backoff in [Sheets usage limits](https://developers.google.com/workspace/sheets/api/limits).

## 7. Application architecture and data boundaries

The app uses SvelteKit routes, a hydrated Redux inventory, Firebase authentication, and an existing Google token broker. Implement this as a browser-driven workflow using the signed-in user's Google access token; keep client secrets and refresh-token handling in the existing broker. No scheduled backend job is needed for MVP.

Proposed files:

| File | Responsibility |
| --- | --- |
| `src/routes/customs-summary/+page.svelte` | Selection, reconciliation, correction, preview, export flow |
| `src/lib/components/Navigation.svelte` | Customs Summary entry |
| `src/lib/google-sheets.ts` | Typed metadata/grid reads, create/write/read-back, retry handling |
| `src/lib/google-sheet-picker.ts` | Picker loading and file selection |
| `src/lib/customs-summary-model.ts` | Source snapshot, allocations, dictionary, issues, report types |
| `src/lib/customs-summary-parse.ts` | Supplier profile/header detection, row typing and exact normalization |
| `src/lib/customs-summary-reconcile.ts` | Order/shipping joins and inventory enrichment |
| `src/lib/customs-summary-compute.ts` | Pure grouping, allocations, rounding, invariant checks |
| `src/lib/customs-summary-export.ts` | Stable workbook arrays/layout and export journal |
| `src/lib/hscodes.ts` or compatible companion module | Versioned bilingual description registry |

Reuse `inventory.ts` fields `janCode`, `subtype`, `hsCode`, `countryOfOrigin`, `weight` (grams), and canonicalization concepts from `sku.ts`. Inspect `stock-order-cost-tsv.ts` for reconciliation/UI patterns, but do not reuse its unit-price rounding or dispatch the mutations in `order-import-slice.ts`.

Suggested report data:

```text
ReportSnapshot {
  schemaVersion, parserVersion, generatedAt, createdBy,
  sources[], sourceValueHashes, invoiceIdentity,
  inventoryEnrichmentSnapshot[], dictionarySnapshot[],
  orderLines[], shippingRows[], allocations[],
  corrections[{field, sourceRefs, before, after, reason}],
  grossMethod, measuredGrossTotal?, cartonMeasurements[],
  packagePolicy, packageOverrides?,
  commodityGroups[], cartonGroups[], totals,
  checks[], status: draft | ready | exporting | exported,
  exportRunId?, outputSpreadsheetId?
}
```

Compute functions take immutable snapshots and return results; no fetches, clock calls, inventory writes, or Google writes inside them. The browser obtains the current inventory only after hydration and snapshots the fields used, so later inventory edits do not silently change an existing preview.

Persist incoming source data and user decisions through the existing broadcast event log under the customs/ namespace, independently of stock-import actions. Reports resume from replay on another browser or after cache removal. Redux/IndexedDB projections are disposable caches, not the source of truth. See section 10 for the implemented event contract. Never put credentials into these events.

## 8. Verification and delivery

### Fixture acceptance

Use the supplied XLSX files as immutable fixtures, with a deterministic extraction step producing API-shaped grids and preserving original rows/formulas. Compare parsed inputs against the exact carton table in section 1. Assert 69 unique JANs, 911 shipped pieces, 238230 JPY, 29.450 kg, three cartons, 95 supplier units, all Japan, and equivalence of the two shipping tabs when selected individually.

The current-input fixture must initially report missing product HS assignments if no inventory enrichment is supplied, and missing measured gross/package policy. It must not invent complete HS totals. Tests can supply an explicit synthetic inventory map/measurements, labelled as test inputs.

For the historical reference, exclude the blank-JAN totals row and validate these established commodity totals:

| HS | Origin | Pieces | Net kg | JPY |
| --- | --- | ---: | ---: | ---: |
| 39261000 | Japan | 40 | 0.620 | 7,560 |
| 48171000 | Japan | 10 | 0.100 | 1,650 |
| 48201030 | Japan | 140 | 19.700 | 44,490 |
| 48211010 | Japan | 210 | 1.500 | 44,070 |
| 49090000 | Japan | 260 | 6.224 | 64,800 |
| 82130000 | China | 80 | 2.000 | 34,360 |
| 82130000 | Japan | 20 | 0.400 | 7,700 |
| 96081010 | Japan | 80 | 4.370 | 35,380 |
| 96082000 | Japan | 40 | 2.970 | 19,570 |
| 96084000 | Japan | 50 | 0.650 | 13,230 |
| 96110000 | China | 29 | 1.780 | 28,203 |
| **Total** | | **959** | **40.314** | **301,013** |

Test corrected gross allocation using an explicitly supplied synthetic measurement, not the inconsistent cached gross values. Validate both same-HS/different-origin groups and carton lists.

### Essential edge cases

- Footer totals cannot become product rows; malformed apparent products cannot disappear.
- Shifted headers, reordered columns, Japanese tabs, embedded header newlines, ragged cells, scientific notation and leading-zero identifiers.
- Duplicate JANs, subtype disagreement, corrected JAN remarks, partial shipment, over-shipment, unknown shipped product, and split quantities across cartons.
- One order line split across two cartons preserves its total value and net weight exactly; first-match VLOOKUP behavior must fail this test.
- Missing code, short/full Bulgarian fallback, conflicting dictionary entries, and source-only code 59061000.
- Missing/zero/invalid weight, gross below net, incomplete carton measurements, and proportional rounding residuals.
- Shared cartons produce non-additive package counts and deduplicated sorted membership.
- Source changed during read/export, unavailable token/scopes, failed export after create, repeat clicks, literal formula-looking descriptions, and Unicode round-trip.
- More than 25 groups and more than 1491 source rows work without overlap or truncation.
- Rendering, corrections, export, and retry produce no inventory quantity/cost updates or marketplace sync requests.

Use existing Vitest/unit and Playwright conventions. Mock Sheets responses for normal CI; add one controlled Google fixture integration test for selection/read/create/read-back when credentials are available. Production supplier files must not be test write targets.

### Delivery order

1. Extract immutable fixtures; implement parser, joins, dictionary enrichment, pure calculations and reconciliation tests.
2. Build the page with file selection and read-only Google import; make the August fixture totals reproducible in preview.
3. Add missing-information resolution, gross/package policies, bilingual descriptions and both tables.
4. Add new-workbook export, audit tabs, recovery/idempotency handling and read-back checks.
5. Validate the package convention, gross allocation method and description wording with the report recipient; record chosen defaults. Demonstrate the supplied shipment end to end in staging before production rollout.

The remaining business inputs are concrete: measured shipment/carton gross, HS classification for products lacking a trustworthy inventory value, and the meaning of “Number of Packages.” They do not prevent implementing the import, reconciliation, net/value calculations, and carton membership now.

## 9. Relationship to Order Import and reviewed HS suggestions

### Keep separate workflows; share the reusable parts

The existing `/order-import` route reads CSV files from the configured Drive folder. It downloads a selected CSV, parses rows, compares them with inventory by JAN, and previews MATCH, NEW, CONFLICT, and resolved rows. Review handles incoming/existing HS, weight, and origin differences, plus subtype allocations. Applying batches broadcasts `orderImport/import_batch`; the root reducer builds inventory updates through `bulk_import_items`. Even import-session selection and raw-row analysis currently use broadcast actions.

Its `findHSCode` helper discovers a code already present in an HS-labelled column. It does **not** infer a classification from a product description.

| Concern | Existing Order Import | Customs Summary |
| --- | --- | --- |
| Purpose | Apply supplier data to inventory | Prepare shipment paperwork |
| Inputs | One CSV, compared with current inventory | Order Sheet plus shipping Sheet, enriched from inventory |
| Main reconciliation | New/existing products, field conflicts, subtype allocation | Ordered versus shipped pieces, invoice value, weights, cartons |
| Completion action | Apply inventory updates | Create a new report workbook |
| Repeat operation | Must respect already-processed import rows | Regenerate a report without receiving/importing stock again |
| State | Broadcast import session/actions | Durable customs input/decision events; reducer-derived report |

Keep `/customs-summary` separately accessible and place it alongside Order Import in navigation. Share pure column normalization, JAN matching, field-conflict presentation, the bilingual dictionary, and the HS suggestion/review component. Extract those utilities without coupling report state to the existing import session, batch action, or stock updates. Do not require an order to have been imported before preparing its customs summary.

A later **Prepare customs summary** shortcut from Order Import can pass source identity and accepted classifications into a new report draft. The user still selects the packing spreadsheet, and the report still checks authoritative supplier prices, quantities, and row provenance. An imported CSV is not automatically a substitute for the original Google order Sheet. Likewise, link missing inventory classifications back to a separately confirmed save action without re-running the stock import.

Do not expand the first customs implementation into a rewrite of Order Import. Build the shared HS-review service/component for customs first, then expose it in the existing import preview as a follow-up. The distinction is between shared analysis and separate completion actions.

### Suggest missing codes, with explicit acceptance

For every line without an established usable HS code, generate a small ranked candidate set using available product description, material, manufacturer, supplier category, and previously accepted classifications. Aggregate split-carton allocations for the same product into one classification decision; propagate the decision back to all its allocations.

Recommended candidate-generation order:

1. A previously user-approved classification for the same supplier product identity/JAN, where the product attributes still agree. Surface this as a prior decision with its date/source.
2. Closely matching products already classified in inventory, using product family, description and material together. Include the matched examples and their codes. Brand alone or a common JAN prefix is insufficient.
3. Explicit, versioned category/material rules mapping to the available dictionary. Ambiguous materials or competing product categories produce alternatives rather than a forced choice.
4. Optional AI-assisted ranking against the supplied candidate dictionary for descriptions the rules cannot resolve. Use a structured response containing candidate codes, reasons and missing facts. Validate returned codes against the dictionary; treat the response as a proposal. Do not let a generated confidence percentage decide acceptance. This optional service must not be required for the deterministic workflow to function.

Use evidence labels such as **Previous accepted match**, **Similar classified products**, or **Description/material match**, rather than claiming statistical confidence without calibration. A new code outside the dictionary can be entered manually with its descriptions and provenance; generated unsupported codes must not enter the final report.

The review screen has three queues/counts: **Suggestions to review**, **Manual classification needed**, and **Resolved**. Each product card/row shows JAN, description, material, manufacturer, origin, source-row links, available image, suggested code and English/Bulgarian descriptions, the reason/examples, and alternative candidates. Offer **Accept suggestion**, **Choose another code**, and **Enter code manually**. Users can change a resolved decision later.

Require manual classification when there is no defensible candidate, the suggestion is rejected without a replacement, or the available evidence cannot distinguish alternatives. Ask for the missing material/product detail when that would help, but do not force the user to accept a guess to continue. A code plus required descriptions must be resolved for every included product before completed export. An unresolved product cannot be silently omitted.

Allow batch acceptance only for an explicitly selected, visible set of products with a displayed proposed code and affected count. No preaccepted guesses, automatic acceptance based on confidence, or hidden “accept all” behavior. For hundreds of products, group similar unresolved products and allow deliberate multi-selection while retaining individual overrides.

Store each decision with product/source identity, proposed candidates, evidence, rule/model version where applicable, selected code, acceptance/manual-override status, user and time. Suggested and accepted codes must be separate fields. If source product attributes change, invalidate the suggestion/acceptance for review; if only shipment quantity changes, preserve classification and recalculate quantities/weights/value. Never overwrite a nonempty inventory classification merely because a guess disagrees with it.

Accepted suggestions are report-local by default. Offer a separate **Save accepted classifications to inventory** operation with a review of matched item keys, old/new codes and subtype ambiguity. Save only user-accepted values using existing audited update actions; new/unmatched inventory items remain report-local until explicitly handled by the inventory workflow. This makes future shipments easier without attaching stock changes to report export.

Add a pure `customs-hs-suggestions.ts` service and a reusable HS review component to the proposed architecture. If AI is introduced, keep service credentials behind an authenticated backend endpoint, send only the product fields necessary to rank classifications, and validate its response before it reaches the review state.

### Preview is a required stage before export

The user sees both tables in the inventory application **before any output workbook is created**. Use the same computed report model and rounded cell values for preview and export, so the workbook agrees with what the user reviewed.

The preview shows invoice identity, pieces/value/net/gross totals, unique carton count, the selected package policy, bilingual group rows, and the carton-membership table. Expand a row to see contributing products, allocations, source cells and classification decisions. Edits to a code, origin, measurement or package policy recalculate the tables immediately.

Allow preview while classification is incomplete: show unresolved products in a distinct **Unclassified — action required** area, and include their amounts in shipment reconciliation so the totals cannot hide them. Pending guesses may be shown in a clearly labelled provisional view, but cannot be treated as accepted final groups. If gross is missing, display “Required” rather than zero. Display remaining issue counts alongside the export button.

Enable **Export to new Google workbook** only after every included product has a resolved code/descriptions and all required reconciliation, gross and package decisions are complete. An explicit **Export draft** remains available if desired, with DRAFT status and unresolved data clearly preserved. After an input change requiring a new snapshot, refresh the preview and require the user to initiate export again.

Acceptance tests must cover rejected guesses requiring manual entry, batch acceptance affecting only selected products, source-change invalidation, no automatic inventory updates, pending guesses excluded from completed output, and exact preview/export agreement for both tables and totals.

## 10. Durable events and reducer-owned calculations

The user explicitly requires the same replayable architecture as the existing inventory flows. The browser must never publish calculated product rows, matches, HS suggestions, summaries, rounding allocations, or totals as authoritative events. Importing raw cell values is allowed; parsing and all business computations run in the reducer.

| Event | Persisted facts / intent | Reducer behavior |
| --- | --- | --- |
| customs/created | User's report ID and name; standard event creator/timestamp | Creates a resumable report |
| customs/sourceChunk | Read ID, chunk index, exact JSON text of incoming Sheets cells/metadata | Accumulates transport chunks; no partial report calculation |
| customs/sourceReceived | Read ID and expected chunk count | Joins raw chunks, parses rows, captures inventory fields from state at that point in replay, reconciles, suggests codes and calculates tables |
| customs/decision | Selected JANs and the code/descriptions/origin/unit grams explicitly accepted or entered | Applies the user's decision and recalculates |
| customs/settings | User-entered gross measurements/source and package convention | Recalculates weight allocation and readiness |
| customs/exportStarted | User-initiated export run ID | Associates the run with the current reducer-derived report revision |
| customs/exportResponse | Raw Google create/recovery response | Records the external workbook identity for recovery |
| customs/exportReadback | Raw Google read-back response | Compares returned cells with reducer-produced tables; derives verification status |

Raw Sheets/API JSON is transported in strings so nested spreadsheet arrays are compatible with Firestore. Source chunks are bounded below the broadcast size limit. An incomplete chunk set cannot replace a report. Source re-reads are explicit and conservative: changed source facts invalidate previous classifications; entered shipment measurements remain available for review. No network access, random IDs, current-clock calls, or asynchronous work occurs in the reducer.

`root-reducer.ts` invokes `reduceCustoms` with the inventory state resulting from preceding events. Inventory fields used for enrichment are captured in reducer state, not copied into client-generated event payloads. Replaying the event log recreates the historical enrichment context. Suggestions remain separate from resolved HS codes; accepting a suggestion is an operator decision event.

`computeCustoms` is a pure reducer helper. It owns parsing, validation, joins, category suggestions, invoice/net arithmetic, allocation rounding, group/carton membership, readiness, and all workbook cell arrays. The route renders this projection and sends its export arrays to Google; it does not recalculate totals. Raw Google responses are external receipts, not substitute business facts: replay always rebuilds the summary from original source/decision events, and verifies export receipts against that result.

The existing broadcast log provides durability and ordering. Saved report sessions appear on the route and resume without re-reading Google. Standard event creator/timestamp provide the audit history of each decision. Report creation, classification and export never dispatch inventory receipt/batch mutations. Every acknowledged UI operation waits until its exact broadcast event has reached the reducer.

Schema version 21 forces stale browser snapshots to replay. Future calculation fixes must also invalidate cached projections with the existing schema-version mechanism. A replay may correctly show a historical exported workbook as no longer verified if the corrected calculations differ; regeneration creates a new workbook and never silently rewrites an old one.

Tests exercise original fixture reconciliation, split-carton conservation, unresolved/manual/batch choices, gross validation, source-change invalidation, chunk assembly, deterministic full replay, unchanged stock/sync slices, exact preview/export cell equality, and stale export revisions. The source fixture contains supplier inputs only; synthetic test classifications and gross measurements are identified in test code.

## Appendix: inspected fixture identity

SHA-256 of the files used for this design:

| Role | SHA-256 |
| --- | --- |
| Order input | `55e9d32585b832df93873e230532d4f3f91815c27e02ceff52e6522006f3351e` |
| Shipping input | `c1c1cc9c185bbbab6099a7bb5a4f58ccc96013ecbf191d36b21753e4d5d727ab` |
| Reference workbook | `5b8fe544733d75cec36819d9a4a93039d81ad89efb967257617917b740e9dfb3` |

Repository paths cited here refer to the inspected old checkout at `/Volumes/Macintosh HD/Users/anicolao/projects/antigravity/admin2`.
