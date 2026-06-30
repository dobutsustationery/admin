<script lang="ts">
  import { addDoc, collection, serverTimestamp } from "firebase/firestore";
  import { firestore } from "$lib/firebase";
  import { store } from "$lib/store";
  import { user } from "$lib/user-store";
  import ImageThumbnail from "$lib/components/ImageThumbnail.svelte";
  import {
    buildAmazonListingCreateDraftFromState,
    type AmazonListingCreateDraft,
  } from "$lib/amazon-listing-projection";
  import type {
    AmazonCatalogState,
    AmazonRawApiResponseRecord,
  } from "$lib/amazon-catalog-slice";
  import {
    AMAZON_CATALOG_PROBE_REQUEST_COLLECTION,
    AMAZON_LISTING_CREATE_REQUEST_COLLECTION,
    AMAZON_LISTING_RESTRICTIONS_REQUEST_COLLECTION,
    AMAZON_PRODUCT_TYPE_DISCOVERY_REQUEST_COLLECTION,
  } from "$lib/sync-events";

  type LocalMatch = {
    itemKey: string;
    handle: string;
    title: string;
    description: string;
    qty: number;
    shipped: number;
    onHand: number;
  };

  type LocalSearchResult = LocalMatch & {
    janCode: string;
    subtype: string;
    image: string;
    price: number;
    cost: number;
    optionValue: string;
    searchableText: string;
    hasListing: boolean;
  };

  type AmazonRow = {
    jan: string;
    localMatches: LocalMatch[];
    catalogResponse: AmazonRawApiResponseRecord | null;
    sellerResponse: AmazonRawApiResponseRecord | null;
    sellerPutResponse: AmazonRawApiResponseRecord | null;
    asin: string;
    catalogTitle: string;
    productType: string;
    sellerSku: string;
    sellerStatus: string;
    sellerIssues: number;
    amazonMessages: AmazonIssueSummary[];
    listingProblems: AmazonIssueSummary[];
    offerPrice: string;
    fulfillmentQty: string;
    sellerUpdatedAt: string;
  };

  type AmazonIssueSummary = {
    kind: string;
    key: string;
    severity: string;
    code: string;
    message: string;
  };

  type ListingWriteStatus = {
    tone: "pending" | "ok" | "warning" | "error";
    title: string;
    detail: string;
    requestId: string;
    messages: AmazonIssueSummary[];
  };

  let janInput = "4542804131499";
  let skuInput = "";
  let includeSellerListings = true;
  let isRequesting = false;
  let requestMessage = "";
  let requestError = "";
  let lastQueuedRequestId = "";
  let localSearchQuery = "";
  let createHandle = "";
  let createItemKey = "";
  let createProductType = "PRODUCT";
  let createRequirements: AmazonListingCreateDraft["requirements"] = "LISTING";
  let createCurrencyCode = "GBP";
  let createPayloadJson = "";
  let isCreateRequesting = false;
  let createMessage = "";
  let createError = "";
  let lastQueuedCreateRequestId = "";
  let productTypeItemName = "";
  let productTypeKeywords = "";
  let isProductTypeRequesting = false;
  let productTypeError = "";
  let lastQueuedProductTypeRequestId = "";
  let lastQueuedProductTypeSearchKey = "";
  let selectedProductTypeName = "";
  let restrictionAsinInput = "";
  let isRestrictionRequesting = false;
  let restrictionError = "";
  let lastQueuedRestrictionRequestId = "";
  let lastQueuedRestrictionKey = "";

  type ProductTypeCandidate = {
    name: string;
    displayName: string;
    definitionResponse: AmazonRawApiResponseRecord | null;
    schemaResponse: AmazonRawApiResponseRecord | null;
    requiredAttributes: string[];
    issueCount: number;
  };

  type ProductTypeDiscoverySummary = {
    searchKey: string;
    requestId: string;
    fetchedAtMs: number;
    candidates: ProductTypeCandidate[];
  };

  type ProductTypeDiscoveryStatus = {
    tone: "idle" | "pending" | "ok" | "error";
    title: string;
    detail: string;
    requestId: string;
  };

  type ProductTypeAttributeRow = {
    attribute: string;
    group: string;
    core: boolean;
    required: boolean;
    supplied: boolean;
  };

  type ListingRestrictionStatus = {
    tone: "idle" | "pending" | "ok" | "warning" | "error";
    title: string;
    detail: string;
    requestId: string;
    response: AmazonRawApiResponseRecord | null;
    restrictions: any[];
  };

  function firstArray<T = any>(value: unknown): T[] {
    return Array.isArray(value) ? (value as T[]) : [];
  }

  function getRawResponse(
    amazonCatalog: AmazonCatalogState | undefined,
    id: string,
  ): AmazonRawApiResponseRecord | null {
    if (!amazonCatalog || !id) return null;
    return amazonCatalog.rawResponsesById?.[id] || null;
  }

  function getCatalogItem(response: AmazonRawApiResponseRecord | null): any {
    return firstArray((response?.raw as any)?.items)[0] || null;
  }

  function getSellerItem(response: AmazonRawApiResponseRecord | null): any {
    const raw = response?.raw as any;
    if (!raw) return null;
    if (
      raw.sku ||
      raw.summaries ||
      raw.attributes ||
      raw.issues ||
      raw.offers ||
      raw.fulfillmentAvailability ||
      raw.relationships ||
      raw.productTypes
    ) {
      return raw;
    }
    return firstArray(raw?.items)[0] || null;
  }

  function getCatalogSummary(item: any): any {
    return firstArray(item?.summaries)[0] || {};
  }

  function getSellerSummary(item: any): any {
    return firstArray(item?.summaries)[0] || {};
  }

  function getProductType(catalogItem: any, sellerItem: any): string {
    const sellerType =
      firstArray<any>(sellerItem?.productTypes)[0]?.productType ||
      getSellerSummary(sellerItem)?.productType;
    const catalogType = firstArray<any>(catalogItem?.productTypes)[0]
      ?.productType;
    return String(sellerType || catalogType || "");
  }

  function formatTimestamp(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return "";
    return new Date(ms).toLocaleString();
  }

  function formatSellerUpdatedAt(value: unknown): string {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const parsed = Date.parse(raw);
    if (!Number.isFinite(parsed)) return raw;
    return new Date(parsed).toLocaleString();
  }

  function getAmazonResponseMessages(
    response: AmazonRawApiResponseRecord | null,
  ): AmazonIssueSummary[] {
    if (!response) return [];
    return firstArray<any>((response.raw as any)?.issues).map((issue) => ({
      kind: response.kind,
      key: response.key,
      severity: String(issue?.severity || "ISSUE"),
      code: String(issue?.code || ""),
      message: String(issue?.message || "Amazon returned an issue."),
    }));
  }

  function hasChildRelationships(sellerItem: any): boolean {
    return firstArray<any>(sellerItem?.relationships).some((relationship) =>
      firstArray<string>(relationship?.childSkus).some(Boolean),
    );
  }

  function getAttributeArray(sellerItem: any, name: string): any[] {
    return firstArray<any>(sellerItem?.attributes?.[name]);
  }

  function getSubmittedOfferPrice(sellerItem: any): string {
    const offer = getAttributeArray(sellerItem, "purchasable_offer")[0];
    const schedule = firstArray<any>(offer?.our_price?.[0]?.schedule)[0];
    const amount = schedule?.value_with_tax;
    const currency = offer?.currency;
    if (amount === undefined || amount === null || !currency) return "";
    return `${currency} ${amount}`;
  }

  function getSubmittedFulfillmentQty(sellerItem: any): string {
    const availability = getAttributeArray(
      sellerItem,
      "fulfillment_availability",
    )[0];
    return availability?.quantity === undefined
      ? ""
      : String(availability.quantity);
  }

  function getListingHealthProblems(sellerItem: any): AmazonIssueSummary[] {
    if (!sellerItem?.sku || hasChildRelationships(sellerItem)) return [];
    const problems: AmazonIssueSummary[] = [];
    const sku = String(sellerItem.sku || "");
    if (firstArray(sellerItem?.offers).length === 0) {
      problems.push({
        kind: "listing_health",
        key: sku,
        severity: "ERROR",
        code: "missing_offer",
        message:
          "Amazon does not report an active offer for this SKU, even though offer attributes were submitted.",
      });
    }
    if (firstArray(sellerItem?.fulfillmentAvailability).length === 0) {
      problems.push({
        kind: "listing_health",
        key: sku,
        severity: "WARNING",
        code: "missing_fulfillment_availability",
        message:
          "Amazon does not report active fulfillment availability for this SKU.",
      });
    }
    return problems;
  }

  function amazonMessageLabel(message: AmazonIssueSummary): string {
    const bits = [
      message.key,
      message.severity,
      message.code ? `#${message.code}` : "",
    ].filter(Boolean);
    return `${bits.join(" ")}: ${message.message}`;
  }

  function splitInput(value: string): string[] {
    return String(value || "")
      .split(/[,\s]+/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .filter((entry, index, all) => all.indexOf(entry) === index);
  }

  function getLocalJans(state: any): string[] {
    const idToItem = state?.inventory?.idToItem || {};
    return Object.values(idToItem)
      .map((item: any) => String(item?.janCode || "").trim())
      .filter(Boolean)
      .filter((jan, index, all) => all.indexOf(jan) === index)
      .sort((a, b) => a.localeCompare(b));
  }

  function useVisibleJans() {
    janInput = rows.map((row) => row.jan).join("\n");
    skuInput = "";
  }

  function useAllLocalJans() {
    janInput = localJans.join("\n");
    skuInput = "";
  }

  function inferMarketplaceId(): string {
    return amazonCatalog?.marketplaceId || "A1F83G8C2ARO7P";
  }

  function getListingTitle(handle: string): string {
    return String(state?.listings?.handleToListing?.[handle]?.title || "");
  }

  function getItemDescription(itemKey: string): string {
    return String(state?.inventory?.idToItem?.[itemKey]?.description || "");
  }

  function buildProductTypeKeywords(handle: string, itemKey: string): string {
    const listing = state?.listings?.handleToListing?.[handle] || {};
    const item = state?.inventory?.idToItem?.[itemKey] || {};
    const source = [
      listing.title,
      item.description,
      listing.productCategory,
      ...(Array.isArray(listing.tags) ? listing.tags : []),
      handle,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const keywords = new Set<string>();

    for (const segment of String(listing.productCategory || "").split(">")) {
      const words = segment
        .trim()
        .split(/[^a-z0-9]+/i)
        .map((word) => word.trim().toLowerCase())
        .filter((word) => word.length >= 3);
      words.forEach((word) => keywords.add(word));
    }

    if (/\b(?:binder|paper|letter|metal|wrapping)\s+clips?\b/.test(source)) {
      ["paper", "binder", "clips", "office", "stationery"].forEach((word) =>
        keywords.add(word),
      );
    }
    if (/\bstickers?\b|\bdecals?\b/.test(source)) {
      ["sticker", "decal", "craft"].forEach((word) => keywords.add(word));
    }
    if (/\bsticky\s+notes?\b|\bmemo\b/.test(source)) {
      ["sticky", "note", "paper", "office"].forEach((word) =>
        keywords.add(word),
      );
    }
    if (/\bpaper\b|\borigami\b|\bdesign\s+paper\b/.test(source)) {
      ["paper", "craft", "stationery"].forEach((word) => keywords.add(word));
    }

    return Array.from(keywords).slice(0, 20).join(" ");
  }

  function getItemHandle(state: any, itemKey: string): string {
    const item = state?.inventory?.idToItem?.[itemKey];
    const idToHandle = state?.listings?.idToHandle || {};
    const handleToListing = state?.listings?.handleToListing || {};
    const linkedHandle = String(idToHandle[itemKey] || "").trim();
    if (linkedHandle && handleToListing[linkedHandle]) return linkedHandle;
    const itemHandle = String(item?.handle || "").trim();
    if (itemHandle && handleToListing[itemHandle]) return itemHandle;
    return linkedHandle || itemHandle;
  }

  function fmtQty(n: number): string {
    if (!Number.isFinite(n)) return "-";
    const rounded = Math.round(n * 1000) / 1000;
    if (Math.abs(rounded) < 0.0005) return "0";
    return Number.isInteger(rounded)
      ? String(rounded)
      : rounded.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  }

  function fmtYen(n: number | undefined): string {
    return Number.isFinite(n)
      ? `¥${Math.round(n as number).toLocaleString()}`
      : "-";
  }

  function fmtPriceEur(n: number | undefined): string {
    return Number.isFinite(n) && (n as number) > 0
      ? `€${(n as number).toFixed(2)}`
      : "-";
  }

  function getLocalSearchResults(
    state: any,
    query: string,
  ): LocalSearchResult[] {
    const q = String(query || "")
      .trim()
      .toLowerCase();
    if (q.length < 2) return [];
    const terms = q.split(/\s+/).filter(Boolean);

    const idToItem = state?.inventory?.idToItem || {};
    const handleToListing = state?.listings?.handleToListing || {};
    return Object.entries(idToItem)
      .map(([itemKey, item]: [string, any]): LocalSearchResult => {
        const handle = getItemHandle(state, itemKey);
        const listing = handle ? handleToListing[handle] : null;
        const qty = Number(item?.qty || 0);
        const shipped = Number(item?.shipped || 0);
        const optionValue = String(
          listing?.variantOptionsByItemId?.[itemKey] || item?.subtype || "",
        );
        const janCode = String(item?.janCode || "");
        const title = String(listing?.title || "");
        const description = String(item?.description || "");
        const searchableText = [
          itemKey,
          janCode,
          item?.subtype,
          description,
          handle,
          title,
          optionValue,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        return {
          itemKey,
          handle,
          title,
          description,
          qty,
          shipped,
          onHand: qty - shipped,
          janCode,
          subtype: String(item?.subtype || ""),
          image: String(item?.image || listing?.images?.[0]?.url || ""),
          price: Number(item?.price || 0),
          cost: Number(item?.cost || 0),
          optionValue,
          searchableText,
          hasListing: Boolean(handle && handleToListing[handle]),
        };
      })
      .filter((result) =>
        terms.every((term) => result.searchableText.includes(term)),
      )
      .sort((a, b) => {
        const aExact = a.itemKey === query || a.janCode === query ? 0 : 1;
        const bExact = b.itemKey === query || b.janCode === query ? 0 : 1;
        return (
          aExact - bExact ||
          Number(b.hasListing) - Number(a.hasListing) ||
          a.itemKey.localeCompare(b.itemKey)
        );
      })
      .slice(0, 100);
  }

  function getDiscoverySearchKey(): string {
    const itemName = productTypeItemName.trim();
    if (itemName) return itemName;
    return splitInput(productTypeKeywords).join(",");
  }

  function getProductTypeSearchResponse(
    amazonCatalog: AmazonCatalogState | undefined,
    searchKey: string,
    requestId = "",
  ): AmazonRawApiResponseRecord | null {
    if (!amazonCatalog) return null;
    if (searchKey) {
      const keyedResponse = getRawResponse(
        amazonCatalog,
        amazonCatalog.productTypeSearchRawResponseIdByKey?.[searchKey],
      );
      if (keyedResponse) return keyedResponse;
    }
    if (!requestId) return null;
    const responseId = (amazonCatalog.rawResponseIds || []).find((id) => {
      const response = amazonCatalog.rawResponsesById?.[id];
      return (
        response?.requestId === requestId &&
        response?.kind === "product_type_search"
      );
    });
    return responseId ? getRawResponse(amazonCatalog, responseId) : null;
  }

  function setCreateTarget(handle: string, itemKey: string) {
    createHandle = handle;
    createItemKey = itemKey;
    productTypeItemName =
      getItemDescription(itemKey) || getListingTitle(handle);
    productTypeKeywords = buildProductTypeKeywords(handle, itemKey);
    generateCreatePayload();
  }

  function selectLocalSearchResult(result: LocalSearchResult) {
    localSearchQuery = "";
    janInput = result.janCode || result.itemKey;
    skuInput = result.itemKey;
    if (!result.hasListing) {
      createHandle = result.handle;
      createItemKey = result.itemKey;
      productTypeItemName = result.description || result.title || "";
      productTypeKeywords = "";
      createPayloadJson = "";
      createMessage = "";
      createError =
        "Selected item is not linked to a local listing, so no Amazon listing payload can be generated.";
      return;
    }
    setCreateTarget(result.handle, result.itemKey);
  }

  function getProductTypeCandidates(
    amazonCatalog: AmazonCatalogState | undefined,
    searchResponse: AmazonRawApiResponseRecord | null,
  ): ProductTypeCandidate[] {
    if (!amazonCatalog || !searchResponse) return [];
    const productTypes = firstArray<any>(
      (searchResponse?.raw as any)?.productTypes,
    );
    return productTypes
      .map((entry): ProductTypeCandidate | null => {
        const name = String(entry?.name || entry?.productType || "").trim();
        if (!name) return null;
        const definitionResponse = getRawResponse(
          amazonCatalog,
          amazonCatalog.productTypeDefinitionRawResponseIdByProductType?.[name],
        );
        const schemaResponse = getRawResponse(
          amazonCatalog,
          amazonCatalog.productTypeSchemaRawResponseIdByProductType?.[name],
        );
        const requiredAttributes = getRequiredAmazonAttributes(
          amazonCatalog,
          name,
        ).slice(0, 80);
        const issues = firstArray((definitionResponse?.raw as any)?.issues);
        return {
          name,
          displayName: String(entry?.displayName || entry?.display_name || ""),
          definitionResponse,
          schemaResponse,
          requiredAttributes,
          issueCount: issues.length,
        };
      })
      .filter((entry): entry is ProductTypeCandidate => !!entry);
  }

  function getRequiredAmazonAttributes(
    amazonCatalog: AmazonCatalogState | undefined,
    productType: string,
  ): string[] {
    return firstArray<string>(
      amazonCatalog?.productTypeRequiredAttributesByProductType?.[productType],
    )
      .map((entry) => String(entry || "").trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  }

  function getPayloadAmazonAttributes(payloadJson: string): Set<string> {
    try {
      const parsed = JSON.parse(payloadJson || "{}") as any;
      const attributes = new Set<string>(
        Object.keys(parsed?.attributes || {}).filter(Boolean),
      );
      for (const submission of firstArray<any>(parsed?.submissions)) {
        for (const attribute of Object.keys(
          submission?.payload?.attributes || {},
        )) {
          if (attribute) attributes.add(attribute);
        }
      }
      return attributes;
    } catch {
      return new Set();
    }
  }

  function getPayloadSubmissions(payloadJson: string): any[] {
    try {
      const parsed = JSON.parse(payloadJson || "{}") as any;
      return firstArray<any>(parsed?.submissions);
    } catch {
      return [];
    }
  }

  function getExemptSubmissionSkus(payloadJson: string): string[] {
    return getPayloadSubmissions(payloadJson)
      .filter((submission) =>
        firstArray<any>(
          submission?.payload?.attributes
            ?.supplier_declared_has_product_identifier_exemption,
        ).some((entry) => entry?.value === true),
      )
      .map((submission) => String(submission?.sku || "").trim())
      .filter(Boolean);
  }

  function getRestrictionKey(asin: string, conditionType = "new_new"): string {
    const cleanAsin = String(asin || "")
      .trim()
      .toUpperCase();
    const cleanCondition = String(conditionType || "new_new").trim();
    return cleanAsin ? `${cleanAsin}:${cleanCondition}` : "";
  }

  function getListingRestrictionsResponse(
    amazonCatalog: AmazonCatalogState | undefined,
    restrictionKey: string,
    requestId = "",
  ): AmazonRawApiResponseRecord | null {
    if (!amazonCatalog) return null;
    if (restrictionKey) {
      const keyedResponse = getRawResponse(
        amazonCatalog,
        amazonCatalog.listingRestrictionsRawResponseIdByKey?.[restrictionKey],
      );
      if (keyedResponse) return keyedResponse;
    }
    if (!requestId) return null;
    const responseId = (amazonCatalog.rawResponseIds || []).find((id) => {
      const response = amazonCatalog.rawResponsesById?.[id];
      return (
        response?.requestId === requestId &&
        response?.kind === "listing_restrictions"
      );
    });
    return responseId ? getRawResponse(amazonCatalog, responseId) : null;
  }

  function getRestrictionCount(response: AmazonRawApiResponseRecord | null) {
    return firstArray<any>((response?.raw as any)?.restrictions).length;
  }

  function getRestrictionRows(response: AmazonRawApiResponseRecord | null) {
    return firstArray<any>((response?.raw as any)?.restrictions);
  }

  function getListingRestrictionStatus(params: {
    amazonCatalog: AmazonCatalogState | undefined;
    restrictionKey: string;
    response: AmazonRawApiResponseRecord | null;
    lastQueuedRequestId: string;
    restrictionError: string;
  }): ListingRestrictionStatus | null {
    const {
      amazonCatalog,
      restrictionKey,
      response,
      lastQueuedRequestId,
      restrictionError,
    } = params;
    if (restrictionError) {
      return {
        tone: "error",
        title: "Restriction check could not be queued",
        detail: restrictionError,
        requestId: lastQueuedRequestId,
        response,
        restrictions: getRestrictionRows(response),
      };
    }
    if (response) {
      if (!response.ok) {
        return {
          tone: "error",
          title: "Restriction check failed",
          detail: `Amazon returned ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`,
          requestId: response.requestId,
          response,
          restrictions: getRestrictionRows(response),
        };
      }
      const restrictionCount = getRestrictionCount(response);
      return {
        tone: restrictionCount > 0 ? "warning" : "ok",
        title:
          restrictionCount > 0
            ? "Listing restrictions returned"
            : "No listing restrictions returned",
        detail:
          restrictionCount > 0
            ? `${restrictionCount} restriction${restrictionCount === 1 ? "" : "s"} returned for ${restrictionKey}.`
            : `Amazon returned no restrictions for ${restrictionKey}.`,
        requestId: response.requestId,
        response,
        restrictions: getRestrictionRows(response),
      };
    }
    if (lastQueuedRequestId) {
      const active = amazonCatalog?.activeRequestId === lastQueuedRequestId;
      const failed = amazonCatalog?.lastFailedRequestId === lastQueuedRequestId;
      const completed =
        amazonCatalog?.lastAppliedRequestId === lastQueuedRequestId;
      if (failed) {
        return {
          tone: "error",
          title: "Restriction check failed",
          detail:
            amazonCatalog?.lastListingRestrictionsError ||
            "The backend reported a failure.",
          requestId: lastQueuedRequestId,
          response,
          restrictions: getRestrictionRows(response),
        };
      }
      if (completed) {
        return {
          tone: "ok",
          title: "Restriction check complete",
          detail: `The request completed, but no replayed result is indexed for "${restrictionKey}".`,
          requestId: lastQueuedRequestId,
          response,
          restrictions: getRestrictionRows(response),
        };
      }
      return {
        tone: "pending",
        title: active
          ? "Restriction check is running"
          : "Restriction check is queued",
        detail: active
          ? "The backend has claimed this request."
          : "Waiting for the functions emulator to claim this request.",
        requestId: lastQueuedRequestId,
        response,
        restrictions: getRestrictionRows(response),
      };
    }
    return null;
  }

  function getAmazonPropertyGroupByAttribute(
    response: AmazonRawApiResponseRecord | null,
  ): Record<string, string> {
    const groups = ((response?.raw as any)?.propertyGroups || {}) as Record<
      string,
      any
    >;
    const out: Record<string, string> = {};
    for (const [groupKey, group] of Object.entries(groups)) {
      const label = String((group as any)?.title || groupKey);
      for (const property of firstArray<string>(
        (group as any)?.propertyNames,
      )) {
        if (property && !out[property]) out[property] = label;
      }
    }
    return out;
  }

  function getProductTypeAttributeRows(
    candidate: ProductTypeCandidate | null,
    supplied: Set<string>,
    amazonCatalog: AmazonCatalogState | undefined,
  ): ProductTypeAttributeRow[] {
    if (!candidate) return [];
    const required = new Set(
      getRequiredAmazonAttributes(amazonCatalog, candidate.name),
    );
    const groupByAttribute = getAmazonPropertyGroupByAttribute(
      candidate.definitionResponse,
    );
    const schemaProperties = firstArray<string>(
      amazonCatalog?.productTypePropertyNamesByProductType?.[candidate.name],
    );
    const coreAttributes = [
      "item_name",
      "brand",
      "product_description",
      "externally_assigned_product_identifier",
      "condition_type",
      "fulfillment_availability",
      "purchasable_offer",
      "item_package_weight",
      "main_product_image_locator",
    ];
    const attributes = new Set<string>([
      ...Object.keys(groupByAttribute),
      ...schemaProperties,
      ...Array.from(required),
      ...Array.from(supplied),
      ...coreAttributes,
    ]);
    return Array.from(attributes)
      .map((attribute) => ({
        attribute,
        group: groupByAttribute[attribute] || "",
        core: coreAttributes.includes(attribute),
        required: required.has(attribute),
        supplied: supplied.has(attribute),
      }))
      .sort((a, b) => {
        return (
          Number(b.required) - Number(a.required) ||
          Number(b.supplied) - Number(a.supplied) ||
          (a.group || "~").localeCompare(b.group || "~") ||
          a.attribute.localeCompare(b.attribute)
        );
      });
  }

  function getVisibleProductTypeAttributeRows(
    rows: ProductTypeAttributeRow[],
  ): ProductTypeAttributeRow[] {
    const hasRequired = rows.some((row) => row.required);
    return rows.filter((row) =>
      hasRequired ? row.required || row.supplied : row.core || row.supplied,
    );
  }

  function schemaStatus(candidate: ProductTypeCandidate | null): string {
    const raw = candidate?.definitionResponse?.raw as any;
    if (!candidate?.definitionResponse) return "No definition response loaded.";
    if (!candidate.definitionResponse.ok) return "Definition request failed.";
    if (candidate.schemaResponse?.ok) {
      return "Exact required fields were derived from Amazon's linked schema response.";
    }
    if (candidate.schemaResponse && !candidate.schemaResponse.ok) {
      return `Amazon schema link could not be fetched: ${candidate.schemaResponse.status || "unknown error"}.`;
    }
    if (raw?.schemaDocument || raw?.schema_document) {
      return "Exact Amazon JSON schema is loaded.";
    }
    if (raw?.schema?.link?.resource) {
      return "Exact required fields are behind Amazon's schema link and have not been fetched yet.";
    }
    return "No Amazon schema document was included.";
  }

  function getRecentProductTypeDiscoveries(
    amazonCatalog: AmazonCatalogState | undefined,
  ): ProductTypeDiscoverySummary[] {
    if (!amazonCatalog) return [];
    return (amazonCatalog.rawResponseIds || [])
      .map((id) => getRawResponse(amazonCatalog, id))
      .filter(
        (response): response is AmazonRawApiResponseRecord =>
          response?.kind === "product_type_search",
      )
      .map((response) => ({
        searchKey: response.key,
        requestId: response.requestId,
        fetchedAtMs: Number(response.fetchedAtMs || 0),
        candidates: getProductTypeCandidates(amazonCatalog, response),
      }))
      .sort((a, b) => b.fetchedAtMs - a.fetchedAtMs)
      .slice(0, 10);
  }

  function productTypeDefinitionSummary(
    candidate: ProductTypeCandidate,
  ): string {
    const raw = candidate.definitionResponse?.raw as any;
    if (!candidate.definitionResponse) return "Definition not fetched yet.";
    if (!candidate.definitionResponse.ok) {
      return `Definition fetch failed (${candidate.definitionResponse.status}).`;
    }
    const groups = raw?.propertyGroups
      ? Object.keys(raw.propertyGroups).length
      : 0;
    const version = raw?.productTypeVersion?.version
      ? ` Version ${raw.productTypeVersion.version}.`
      : "";
    return `Definition fetched${groups ? ` with ${groups} property group${groups === 1 ? "" : "s"}` : ""}.${version}`;
  }

  function getProductTypeDiscoveryStatus(params: {
    amazonCatalog: AmazonCatalogState | undefined;
    searchKey: string;
    searchResponse: AmazonRawApiResponseRecord | null;
    candidates: ProductTypeCandidate[];
    lastQueuedRequestId: string;
    productTypeError: string;
  }): ProductTypeDiscoveryStatus | null {
    const {
      amazonCatalog,
      searchKey,
      searchResponse,
      candidates,
      lastQueuedRequestId,
      productTypeError,
    } = params;
    if (productTypeError) {
      return {
        tone: "error",
        title: "Product type discovery could not be queued",
        detail: productTypeError,
        requestId: lastQueuedRequestId,
      };
    }
    if (searchResponse) {
      if (!searchResponse.ok) {
        return {
          tone: "error",
          title: "Product type discovery failed",
          detail: `Amazon returned ${searchResponse.status}${searchResponse.statusText ? ` ${searchResponse.statusText}` : ""}.`,
          requestId: searchResponse.requestId,
        };
      }
      return {
        tone: "ok",
        title: "Product type discovery complete",
        detail:
          candidates.length === 0
            ? `No product types returned for "${searchKey || searchResponse.key}".`
            : `Found ${candidates.length} product type${candidates.length === 1 ? "" : "s"} for "${searchKey || searchResponse.key}".`,
        requestId: searchResponse.requestId,
      };
    }
    if (lastQueuedRequestId) {
      const active = amazonCatalog?.activeRequestId === lastQueuedRequestId;
      const failed = amazonCatalog?.lastFailedRequestId === lastQueuedRequestId;
      const completed =
        amazonCatalog?.lastAppliedRequestId === lastQueuedRequestId;
      if (failed) {
        return {
          tone: "error",
          title: "Product type discovery failed",
          detail:
            amazonCatalog?.lastProductTypeDiscoveryError ||
            "The backend reported a failure.",
          requestId: lastQueuedRequestId,
        };
      }
      if (completed) {
        return {
          tone: "ok",
          title: "Product type discovery complete",
          detail: `The request completed, but no replayed result is indexed for "${searchKey}".`,
          requestId: lastQueuedRequestId,
        };
      }
      return {
        tone: "pending",
        title: active
          ? "Product type discovery is running"
          : "Product type discovery is queued",
        detail: active
          ? "The backend has claimed this request."
          : "Waiting for the functions emulator to claim this request.",
        requestId: lastQueuedRequestId,
      };
    }
    if (amazonCatalog?.lastProductTypeDiscoveryError) {
      return {
        tone: "error",
        title: "Last product type discovery failed",
        detail: amazonCatalog.lastProductTypeDiscoveryError,
        requestId: amazonCatalog.lastFailedRequestId || "",
      };
    }
    return null;
  }

  function useProductType(productType: string) {
    createProductType = productType;
    selectedProductTypeName = productType;
    generateCreatePayload();
  }

  function showProductTypeDiscovery(summary: ProductTypeDiscoverySummary) {
    productTypeItemName = summary.searchKey;
    productTypeKeywords = "";
    lastQueuedProductTypeRequestId = summary.requestId;
    lastQueuedProductTypeSearchKey = summary.searchKey;
    selectedProductTypeName = summary.candidates[0]?.name || "";
    productTypeError = "";
  }

  function generateCreatePayload() {
    createError = "";
    createMessage = "";
    const draft = buildAmazonListingCreateDraftFromState({
      state,
      handle: createHandle,
      itemKey: createItemKey,
      marketplaceId: inferMarketplaceId(),
      productType: createProductType,
      requirements: createRequirements,
      currencyCode: createCurrencyCode,
    });
    if (!draft) {
      createPayloadJson = "";
      createError = "Choose a listing handle and item key that exist locally.";
      return;
    }
    createProductType = draft.productType;
    createRequirements = draft.requirements;
    createPayloadJson = JSON.stringify(draft.payload, null, 2);
  }

  async function requestAmazonListingCreate() {
    createError = "";
    createMessage = "";
    lastQueuedCreateRequestId = "";

    if (!$user?.uid) {
      createError = "You must be signed in to create an Amazon listing.";
      return;
    }

    const draft = buildAmazonListingCreateDraftFromState({
      state,
      handle: createHandle,
      itemKey: createItemKey,
      marketplaceId: inferMarketplaceId(),
      productType: createProductType,
      requirements: createRequirements,
      currencyCode: createCurrencyCode,
    });
    if (!draft) {
      createError = "Choose a listing handle and item key that exist locally.";
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(createPayloadJson || "{}");
    } catch (error: any) {
      createError = `Payload JSON is invalid: ${error?.message || error}`;
      return;
    }

    if (!payload || typeof payload !== "object") {
      createError = "Payload JSON must be an object.";
      return;
    }

    isCreateRequesting = true;
    try {
      const docRef = await addDoc(
        collection(firestore, AMAZON_LISTING_CREATE_REQUEST_COLLECTION),
        {
          eventType: "amazon/listing_create_requested",
          creator: $user.uid,
          requestedBy: $user.uid,
          source: "amazon-listings-page",
          handle: createHandle,
          itemKey: createItemKey,
          skus: draft.submissions.map((submission) => submission.sku),
          productType: createProductType,
          requirements: createRequirements,
          payload,
          createdAtMs: Date.now(),
          createdAt: serverTimestamp(),
          timestamp: serverTimestamp(),
        },
      );
      lastQueuedCreateRequestId = docRef.id;
      createMessage = `Queued Amazon listing create for ${draft.submissions.length} SKU${draft.submissions.length === 1 ? "" : "s"}.`;
    } catch (error: any) {
      createError = error?.message || "Failed to queue Amazon listing create.";
    } finally {
      isCreateRequesting = false;
    }
  }

  async function requestAmazonProductTypeDiscovery() {
    productTypeError = "";
    lastQueuedProductTypeRequestId = "";
    lastQueuedProductTypeSearchKey = "";

    if (!$user?.uid) {
      productTypeError = "You must be signed in to discover product types.";
      return;
    }

    const itemName = productTypeItemName.trim();
    const rawKeywords = splitInput(productTypeKeywords);
    const keywords = itemName ? [] : rawKeywords;
    const searchKey = itemName || keywords.join(",");
    if (!itemName && keywords.length === 0) {
      productTypeError = "Enter an item name or keywords.";
      return;
    }

    isProductTypeRequesting = true;
    try {
      const docRef = await addDoc(
        collection(firestore, AMAZON_PRODUCT_TYPE_DISCOVERY_REQUEST_COLLECTION),
        {
          eventType: "amazon/product_type_discovery_requested",
          creator: $user.uid,
          requestedBy: $user.uid,
          source: "amazon-listings-page",
          handle: createHandle,
          itemKey: createItemKey,
          itemName,
          keywords,
          requirements: createRequirements,
          requirementsEnforced: "ENFORCED",
          maxDefinitions: 5,
          locale: "en_GB",
          searchLocale: "en_GB",
          createdAtMs: Date.now(),
          createdAt: serverTimestamp(),
          timestamp: serverTimestamp(),
        },
      );
      lastQueuedProductTypeRequestId = docRef.id;
      lastQueuedProductTypeSearchKey = searchKey;
    } catch (error: any) {
      productTypeError =
        error?.message || "Failed to queue product type discovery.";
    } finally {
      isProductTypeRequesting = false;
    }
  }

  async function requestAmazonListingRestrictions() {
    restrictionError = "";
    lastQueuedRestrictionRequestId = "";
    lastQueuedRestrictionKey = "";

    if (!$user?.uid) {
      restrictionError = "You must be signed in to check listing restrictions.";
      return;
    }

    const asin = restrictionAsinInput.trim().toUpperCase();
    const conditionType = "new_new";
    if (!asin) {
      restrictionError = "Enter an ASIN to check.";
      return;
    }

    isRestrictionRequesting = true;
    try {
      const docRef = await addDoc(
        collection(firestore, AMAZON_LISTING_RESTRICTIONS_REQUEST_COLLECTION),
        {
          eventType: "amazon/listing_restrictions_requested",
          creator: $user.uid,
          requestedBy: $user.uid,
          source: "amazon-listings-page",
          asin,
          conditionType,
          reasonLocale: "en_GB",
          createdAtMs: Date.now(),
          createdAt: serverTimestamp(),
          timestamp: serverTimestamp(),
        },
      );
      lastQueuedRestrictionRequestId = docRef.id;
      lastQueuedRestrictionKey = getRestrictionKey(asin, conditionType);
    } catch (error: any) {
      restrictionError =
        error?.message || "Failed to queue listing restrictions check.";
    } finally {
      isRestrictionRequesting = false;
    }
  }

  async function requestAmazonProbe() {
    requestError = "";
    requestMessage = "";
    lastQueuedRequestId = "";

    const jans = splitInput(janInput);
    const skus = splitInput(skuInput);
    if (!$user?.uid) {
      requestError = "You must be signed in to request an Amazon probe.";
      return;
    }
    if (jans.length === 0 && skus.length === 0) {
      requestError = "Enter at least one JAN or SKU.";
      return;
    }

    isRequesting = true;
    try {
      const docRef = await addDoc(
        collection(firestore, AMAZON_CATALOG_PROBE_REQUEST_COLLECTION),
        {
          eventType: "amazon/catalog_probe_requested",
          creator: $user.uid,
          requestedBy: $user.uid,
          source: "amazon-listings-page",
          jans,
          skus,
          includeSellerListings,
          identifiersType: "JAN",
          listingIdentifiersType: "JAN",
          createdAtMs: Date.now(),
          createdAt: serverTimestamp(),
          timestamp: serverTimestamp(),
        },
      );
      lastQueuedRequestId = docRef.id;
      requestMessage = `Queued Amazon probe for ${jans.length} JAN${jans.length === 1 ? "" : "s"}${skus.length ? ` and ${skus.length} SKU${skus.length === 1 ? "" : "s"}` : ""}.`;
    } catch (error: any) {
      requestError = error?.message || "Failed to queue Amazon probe.";
    } finally {
      isRequesting = false;
    }
  }

  function getLocalMatches(state: any, jan: string): LocalMatch[] {
    const idToItem = state?.inventory?.idToItem || {};
    const idToHandle = state?.listings?.idToHandle || {};
    const handleToListing = state?.listings?.handleToListing || {};

    return Object.entries(idToItem)
      .filter(([_, item]: [string, any]) => String(item?.janCode || "") === jan)
      .map(([itemKey, item]: [string, any]) => {
        const handle = String(idToHandle[itemKey] || "");
        const listing = handle ? handleToListing[handle] : null;
        const qty = Number(item?.qty || 0);
        const shipped = Number(item?.shipped || 0);
        return {
          itemKey,
          handle,
          title: String(listing?.title || ""),
          description: String(item?.description || ""),
          qty,
          shipped,
          onHand: qty - shipped,
        };
      })
      .sort((a, b) => a.itemKey.localeCompare(b.itemKey));
  }

  function buildRows(state: any): AmazonRow[] {
    const amazonCatalog = state?.amazonCatalog as
      | AmazonCatalogState
      | undefined;
    if (!amazonCatalog) return [];

    const jans = Array.from(
      new Set([
        ...Object.keys(amazonCatalog.catalogRawResponseIdByJan || {}),
        ...Object.keys(amazonCatalog.sellerListingsRawResponseIdByJan || {}),
        ...Object.keys(amazonCatalog.sellerListingRawResponseIdBySku || {}),
        ...Object.keys(amazonCatalog.sellerListingPutRawResponseIdBySku || {}),
      ]),
    ).sort();

    return jans.map((jan) => {
      const catalogResponse = getRawResponse(
        amazonCatalog,
        amazonCatalog.catalogRawResponseIdByJan?.[jan],
      );
      const sellerResponse = getRawResponse(
        amazonCatalog,
        amazonCatalog.sellerListingsRawResponseIdByJan?.[jan] ||
          amazonCatalog.sellerListingRawResponseIdBySku?.[jan],
      );
      const sellerPutResponse = getRawResponse(
        amazonCatalog,
        amazonCatalog.sellerListingPutRawResponseIdBySku?.[jan],
      );
      const catalogItem = getCatalogItem(catalogResponse);
      const sellerItem = getSellerItem(sellerResponse);
      const catalogSummary = getCatalogSummary(catalogItem);
      const sellerSummary = getSellerSummary(sellerItem);
      const offer = firstArray<any>(sellerItem?.offers)[0];
      const price = offer?.price;
      const availability = firstArray<any>(
        sellerItem?.fulfillmentAvailability,
      )[0];
      const issueCount = firstArray(sellerItem?.issues).length;
      const sellerStatus = firstArray(sellerSummary?.status).join(", ");
      const amazonMessages = [
        ...getAmazonResponseMessages(sellerPutResponse),
        ...getAmazonResponseMessages(sellerResponse),
      ];
      const listingProblems = getListingHealthProblems(sellerItem);

      return {
        jan,
        localMatches: getLocalMatches(state, jan),
        catalogResponse,
        sellerResponse,
        sellerPutResponse,
        asin: String(sellerSummary?.asin || catalogItem?.asin || ""),
        catalogTitle: String(
          sellerSummary?.itemName || catalogSummary?.itemName || "",
        ),
        productType: getProductType(catalogItem, sellerItem),
        sellerSku: String(sellerItem?.sku || ""),
        sellerStatus,
        sellerIssues:
          issueCount + amazonMessages.length + listingProblems.length,
        amazonMessages,
        listingProblems,
        offerPrice:
          price?.amount && (price?.currencyCode || price?.currency)
            ? `${price.currencyCode || price.currency} ${price.amount}`
            : getSubmittedOfferPrice(sellerItem)
              ? `Submitted ${getSubmittedOfferPrice(sellerItem)}`
              : "",
        fulfillmentQty:
          availability?.quantity === undefined
            ? getSubmittedFulfillmentQty(sellerItem)
              ? `Submitted ${getSubmittedFulfillmentQty(sellerItem)}`
              : ""
            : String(availability.quantity),
        sellerUpdatedAt: formatSellerUpdatedAt(sellerSummary?.lastUpdatedDate),
      };
    });
  }

  function rowClass(row: AmazonRow): string {
    if (!row.catalogResponse?.ok || !row.sellerResponse?.ok) return "error";
    if (!row.asin || !row.sellerSku) return "missing";
    if (row.sellerIssues > 0) return "issue";
    if (
      !row.sellerStatus.includes("BUYABLE") &&
      !row.sellerStatus.includes("DISCOVERABLE")
    ) {
      return "issue";
    }
    return "ok";
  }

  function getListingWriteStatus(
    amazonCatalog: AmazonCatalogState | undefined,
    requestId: string,
  ): ListingWriteStatus | null {
    if (!requestId) return null;
    const responses = (amazonCatalog?.rawResponseIds || [])
      .map((id) => getRawResponse(amazonCatalog, id))
      .filter(
        (response): response is AmazonRawApiResponseRecord =>
          !!response &&
          response.requestId === requestId &&
          (response.kind === "seller_listing_put" ||
            response.kind === "seller_listing_get_by_sku"),
      );
    const messages = responses.flatMap((response) =>
      getAmazonResponseMessages(response),
    );
    const hasErrorResponse = responses.some((response) => !response.ok);
    const hasErrorIssue = messages.some(
      (message) => message.severity.toUpperCase() === "ERROR",
    );
    const completed = amazonCatalog?.lastAppliedRequestId === requestId;
    const failed = amazonCatalog?.lastFailedRequestId === requestId;

    if (failed) {
      return {
        tone: "error",
        title: "Amazon listing create failed",
        detail:
          amazonCatalog?.lastListingWriteError ||
          "The backend reported a failure.",
        requestId,
        messages,
      };
    }
    if (hasErrorResponse || hasErrorIssue) {
      return {
        tone: "error",
        title: "Amazon listing create returned issues",
        detail: `${messages.length || responses.length} problem${messages.length === 1 || responses.length === 1 ? "" : "s"} found in Amazon's response.`,
        requestId,
        messages,
      };
    }
    if (messages.length > 0) {
      return {
        tone: "warning",
        title: "Amazon listing create completed with warnings",
        detail: `${messages.length} warning${messages.length === 1 ? "" : "s"} returned by Amazon.`,
        requestId,
        messages,
      };
    }
    if (completed) {
      return {
        tone: "ok",
        title: "Amazon listing create completed",
        detail:
          responses.length > 0
            ? `${responses.length} Amazon response${responses.length === 1 ? "" : "s"} recorded.`
            : "The request completed, but no raw response is loaded in browser state.",
        requestId,
        messages,
      };
    }
    return {
      tone: "pending",
      title:
        amazonCatalog?.activeRequestId === requestId
          ? "Amazon listing create is running"
          : "Amazon listing create is queued",
      detail:
        amazonCatalog?.activeRequestId === requestId
          ? "The backend has claimed this request."
          : "Waiting for the functions emulator to claim this request.",
      requestId,
      messages,
    };
  }

  $: state = $store;
  $: amazonCatalog = state.amazonCatalog as AmazonCatalogState;
  $: rows = buildRows(state);
  $: localJans = getLocalJans(state);
  $: localSearchResults = getLocalSearchResults(state, localSearchQuery);
  $: selectedCreateItem = createItemKey
    ? state?.inventory?.idToItem?.[createItemKey] || null
    : null;
  $: selectedCreateListing = createHandle
    ? state?.listings?.handleToListing?.[createHandle] || null
    : null;
  $: productTypeSearchKey =
    getDiscoverySearchKey() || lastQueuedProductTypeSearchKey;
  $: productTypeSearchResponse = getProductTypeSearchResponse(
    amazonCatalog,
    productTypeSearchKey,
    lastQueuedProductTypeRequestId,
  );
  $: productTypeCandidates = getProductTypeCandidates(
    amazonCatalog,
    productTypeSearchResponse,
  );
  $: selectedProductTypeCandidate =
    productTypeCandidates.find(
      (candidate) => candidate.name === selectedProductTypeName,
    ) || null;
  $: currentPayloadAmazonAttributes =
    getPayloadAmazonAttributes(createPayloadJson);
  $: exemptSubmissionSkus = getExemptSubmissionSkus(createPayloadJson);
  $: restrictionKey =
    getRestrictionKey(restrictionAsinInput) || lastQueuedRestrictionKey;
  $: listingRestrictionsResponse = getListingRestrictionsResponse(
    amazonCatalog,
    restrictionKey,
    lastQueuedRestrictionRequestId,
  );
  $: listingRestrictionStatus = getListingRestrictionStatus({
    amazonCatalog,
    restrictionKey,
    response: listingRestrictionsResponse,
    lastQueuedRequestId: lastQueuedRestrictionRequestId,
    restrictionError,
  });
  $: selectedProductTypeRows = getProductTypeAttributeRows(
    selectedProductTypeCandidate,
    currentPayloadAmazonAttributes,
    amazonCatalog,
  );
  $: visibleSelectedProductTypeRows = getVisibleProductTypeAttributeRows(
    selectedProductTypeRows,
  );
  $: selectedRequiredCount = selectedProductTypeRows.filter(
    (row) => row.required,
  ).length;
  $: selectedRequiredMissingCount = selectedProductTypeRows.filter(
    (row) => row.required && !row.supplied,
  ).length;
  $: recentProductTypeDiscoveries =
    getRecentProductTypeDiscoveries(amazonCatalog);
  $: productTypeDiscoveryStatus = getProductTypeDiscoveryStatus({
    amazonCatalog,
    searchKey:
      productTypeSearchKey || String(productTypeSearchResponse?.key || ""),
    searchResponse: productTypeSearchResponse,
    candidates: productTypeCandidates,
    lastQueuedRequestId: lastQueuedProductTypeRequestId,
    productTypeError,
  });
  $: listingWriteStatus = getListingWriteStatus(
    amazonCatalog,
    lastQueuedCreateRequestId,
  );
  $: lastCompleted = formatTimestamp(
    amazonCatalog?.lastProbeCompletedAtMs || 0,
  );
</script>

<svelte:head>
  <title>Amazon Listings</title>
</svelte:head>

<main class="page">
  <header class="page-header">
    <div>
      <h1>Amazon Listings</h1>
      <p>
        Read-only v0 view of replayed Amazon SP-API catalog and seller-listing
        observations.
      </p>
    </div>
    <div class="meta">
      <div><span>Marketplace</span>{amazonCatalog?.marketplaceId || "-"}</div>
      <div>
        <span>Raw responses</span>{amazonCatalog?.rawResponseIds?.length || 0}
      </div>
      <div><span>Last probe</span>{lastCompleted || "-"}</div>
    </div>
  </header>

  <section class="command-band">
    <div>
      <h2>Refresh Data</h2>
      <p>
        Queue a read-only Amazon SP-API probe. The backend preserves the raw API
        responses in replayable broadcast actions.
      </p>
    </div>
    <div class="probe-form">
      <label>
        <span>JANs</span>
        <textarea bind:value={janInput} rows="4" placeholder="4542804131499" />
      </label>
      <label>
        <span>Seller SKUs</span>
        <textarea bind:value={skuInput} rows="2" placeholder="Optional" />
      </label>
      <label class="check-row">
        <input type="checkbox" bind:checked={includeSellerListings} />
        <span>Include seller listing lookup</span>
      </label>
      <div class="actions">
        <button
          type="button"
          on:click={requestAmazonProbe}
          disabled={isRequesting}
        >
          {isRequesting ? "Queueing..." : "Get Amazon Info"}
        </button>
        <button type="button" class="secondary" on:click={useVisibleJans}>
          Use shown JANs
        </button>
        <button
          type="button"
          class="secondary"
          on:click={useAllLocalJans}
          title={`${localJans.length} local JANs`}
        >
          Use all local JANs
        </button>
      </div>
      {#if requestMessage}
        <div class="request-message">
          {requestMessage}
          {#if lastQueuedRequestId}
            <span>{lastQueuedRequestId}</span>
          {/if}
        </div>
      {/if}
      {#if requestError}
        <div class="request-error">{requestError}</div>
      {/if}
    </div>
  </section>

  <section class="command-band create-band">
    <div>
      <h2>Create Amazon Listing</h2>
      <p>
        Generate Listings Items submissions from one local listing, edit them if
        needed, then submit them to Amazon. Listings with multiple local options
        generate a non-buyable parent SKU plus one buyable child SKU per option.
        The backend logs the raw request and response in Sync Status.
      </p>
    </div>
    <div class="probe-form">
      <div class="local-picker">
        <label>
          <span>Find local item</span>
          <input
            bind:value={localSearchQuery}
            placeholder="Search JAN, title, description, subtype, or handle..."
          />
        </label>
        {#if localSearchResults.length > 0}
          <div class="local-search-results">
            {#each localSearchResults as result (result.itemKey)}
              <button
                type="button"
                class:unlinked={!result.hasListing}
                class="local-search-result"
                on:click={() => selectLocalSearchResult(result)}
              >
                <div class="result-thumb">
                  {#if result.image}
                    <ImageThumbnail
                      src={result.image}
                      alt={result.description || result.itemKey}
                      width="42px"
                      height="42px"
                    />
                  {/if}
                </div>
                <div class="result-main">
                  <strong>{result.itemKey}</strong>
                  <span
                    >{result.description ||
                      result.title ||
                      result.itemKey}</span
                  >
                  {#if result.handle}
                    <small>{result.janCode} · {result.handle}</small>
                  {:else}
                    <small>{result.janCode || "-"} · No local listing</small>
                  {/if}
                </div>
                <div class="result-meta">
                  <strong>Stock: {fmtQty(result.onHand)}</strong>
                  <span>Cost: {fmtYen(result.cost)}</span>
                  <span>Price: {fmtPriceEur(result.price)}</span>
                </div>
              </button>
            {/each}
          </div>
        {/if}
        {#if localSearchQuery.trim().length >= 2 && localSearchResults.length === 0}
          <div class="no-results">
            No local inventory item matches this search.
          </div>
        {/if}
      </div>

      {#if selectedCreateItem}
        <div class="selected-local-item">
          <div class="result-thumb">
            {#if selectedCreateItem.image || selectedCreateListing?.images?.[0]?.url}
              <ImageThumbnail
                src={selectedCreateItem.image ||
                  selectedCreateListing.images[0].url}
                alt={selectedCreateItem.description || createItemKey}
                width="52px"
                height="52px"
              />
            {/if}
          </div>
          <div>
            <strong>{selectedCreateItem.janCode || createItemKey}</strong>
            <span
              >{selectedCreateListing?.title ||
                selectedCreateItem.description ||
                createItemKey}</span
            >
            <small>
              <a
                href={`/itemhistory?itemKey=${encodeURIComponent(createItemKey)}`}
              >
                {createItemKey}
              </a>
              {#if createHandle}
                {" "}
                <a
                  href={`/listing-detail?handle=${encodeURIComponent(createHandle)}`}
                >
                  {createHandle}
                </a>
              {/if}
            </small>
          </div>
          <div class="selected-metrics">
            <strong>
              Stock: {fmtQty(
                Number(selectedCreateItem.qty || 0) -
                  Number(selectedCreateItem.shipped || 0),
              )}
            </strong>
            <span>Cost: {fmtYen(selectedCreateItem.cost)}</span>
            <span>Price: {fmtPriceEur(selectedCreateItem.price)}</span>
          </div>
        </div>
      {/if}

      <div class="split-row">
        <label>
          <span>Listing handle</span>
          <input
            bind:value={createHandle}
            placeholder="amifa-sakura-origami-design-paper-4542804131499"
          />
        </label>
        <label>
          <span>Item key</span>
          <input bind:value={createItemKey} placeholder="4542804131499" />
        </label>
      </div>
      <div class="split-row">
        <label>
          <span>Product type</span>
          <input bind:value={createProductType} placeholder="PRODUCT" />
        </label>
        <label>
          <span>Currency</span>
          <input bind:value={createCurrencyCode} placeholder="GBP" />
        </label>
        <label>
          <span>Requirements</span>
          <select bind:value={createRequirements}>
            <option value="LISTING">LISTING</option>
            <option value="LISTING_PRODUCT_ONLY">LISTING_PRODUCT_ONLY</option>
            <option value="LISTING_OFFER_ONLY">LISTING_OFFER_ONLY</option>
          </select>
        </label>
      </div>
      <div class="discovery-panel">
        <div class="split-row">
          <label>
            <span>Product type search item name</span>
            <input
              bind:value={productTypeItemName}
              placeholder="Amifa Kawaii Pattern Masking Sheet Stickers"
            />
          </label>
          <label>
            <span>Or keywords</span>
            <input
              bind:value={productTypeKeywords}
              placeholder="stickers stationery"
            />
          </label>
        </div>
        <div class="actions">
          <button
            type="button"
            class="secondary"
            on:click={requestAmazonProductTypeDiscovery}
            disabled={isProductTypeRequesting}
          >
            {isProductTypeRequesting ? "Queueing..." : "Discover Product Types"}
          </button>
        </div>
        {#if productTypeDiscoveryStatus}
          <div
            class:request-message={productTypeDiscoveryStatus.tone === "ok"}
            class:request-error={productTypeDiscoveryStatus.tone === "error"}
            class:request-pending={productTypeDiscoveryStatus.tone ===
              "pending"}
          >
            <strong>{productTypeDiscoveryStatus.title}</strong>
            <span>{productTypeDiscoveryStatus.detail}</span>
            {#if productTypeDiscoveryStatus.requestId}
              <span>{productTypeDiscoveryStatus.requestId}</span>
            {/if}
          </div>
        {/if}
        <div class="recent-discoveries">
          <h3>
            Recent product type discoveries
            <span>{recentProductTypeDiscoveries.length}</span>
          </h3>
          {#if recentProductTypeDiscoveries.length === 0}
            <div class="recent-empty">
              No replayed product type discoveries are loaded in this browser
              state yet. Run discovery, or refresh cached state to replay
              existing broadcast actions.
            </div>
          {:else}
            {#each recentProductTypeDiscoveries as discovery (discovery.requestId)}
              <div class="recent-discovery-row">
                <div>
                  <strong>{discovery.searchKey}</strong>
                  <span>{formatTimestamp(discovery.fetchedAtMs)}</span>
                  <small>{discovery.requestId}</small>
                </div>
                <div class="recent-candidates">
                  {#each discovery.candidates as candidate (candidate.name)}
                    <button
                      type="button"
                      class="inline-action"
                      on:click={() => {
                        showProductTypeDiscovery(discovery);
                        useProductType(candidate.name);
                      }}
                    >
                      {candidate.name}
                    </button>
                  {/each}
                </div>
                <button
                  type="button"
                  class="inline-action"
                  on:click={() => showProductTypeDiscovery(discovery)}
                >
                  Show details
                </button>
              </div>
            {/each}
          {/if}
        </div>
        {#if productTypeCandidates.length > 0}
          <div class="candidate-list">
            {#each productTypeCandidates as candidate (candidate.name)}
              <div
                class="candidate-row"
                class:selected-candidate={candidate.name ===
                  selectedProductTypeName}
              >
                <div>
                  <strong>{candidate.name}</strong>
                  {#if candidate.name === selectedProductTypeName}
                    <span class="selected-label">Showing details</span>
                  {/if}
                  {#if candidate.displayName}
                    <span>{candidate.displayName}</span>
                  {/if}
                  {#if candidate.requiredAttributes.length > 0}
                    <small>
                      Required: {candidate.requiredAttributes.join(", ")}
                    </small>
                  {:else}
                    <small>{productTypeDefinitionSummary(candidate)}</small>
                  {/if}
                  {#if candidate.definitionResponse && !candidate.definitionResponse.ok}
                    <small class="danger">
                      Definition fetch failed: {candidate.definitionResponse
                        .status}
                    </small>
                  {/if}
                </div>
                <button
                  type="button"
                  class="inline-action"
                  on:click={() => useProductType(candidate.name)}
                >
                  Use
                </button>
              </div>
            {/each}
          </div>
        {/if}
        {#if productTypeCandidates.length > 0 && !selectedProductTypeCandidate}
          <div class="recent-empty">
            No product type is selected. Click Use on a product type to generate
            the payload and review field coverage.
          </div>
        {/if}
        {#if selectedProductTypeCandidate}
          <div class="product-type-detail">
            <div class="product-type-detail-header">
              <div>
                <h3>{selectedProductTypeCandidate.name}</h3>
                {#if selectedProductTypeCandidate.displayName}
                  <span>{selectedProductTypeCandidate.displayName}</span>
                {/if}
                <small>{schemaStatus(selectedProductTypeCandidate)}</small>
                <small>
                  “Generated” means the current Amazon Listings Items payload
                  JSON below includes this attribute.
                </small>
              </div>
              <div class="coverage-summary">
                <strong>
                  {selectedRequiredCount === 0
                    ? "Required fields unknown"
                    : `${selectedRequiredCount - selectedRequiredMissingCount}/${selectedRequiredCount} required supplied`}
                </strong>
                <span>
                  {selectedRequiredMissingCount === 0 &&
                  selectedRequiredCount > 0
                    ? "No required gaps found"
                    : selectedRequiredCount > 0
                      ? `${selectedRequiredMissingCount} required missing`
                      : "Showing core fields our payload can supply"}
                </span>
              </div>
            </div>
            <div class="attribute-table-wrap">
              <table class="attribute-table">
                <thead>
                  <tr>
                    <th>Attribute</th>
                    <th>Group</th>
                    <th>Required</th>
                    <th>Generated</th>
                  </tr>
                </thead>
                <tbody>
                  {#each visibleSelectedProductTypeRows as row (row.attribute)}
                    <tr class:missing-required={row.required && !row.supplied}>
                      <td>{row.attribute}</td>
                      <td>{row.group || "-"}</td>
                      <td>{row.required ? "Yes" : row.core ? "Core" : "-"}</td>
                      <td>{row.supplied ? "Yes" : "No"}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          </div>
        {/if}
      </div>
      <div class="restrictions-panel">
        <div>
          <h3>Listing Restrictions</h3>
          <p>
            Amazon restrictions checks are ASIN-based. Use this after catalog
            discovery or a create attempt returns an ASIN.
          </p>
        </div>
        <div class="split-row restrictions-row">
          <label>
            <span>ASIN</span>
            <input bind:value={restrictionAsinInput} placeholder="B0H6WLZNZC" />
          </label>
          <div class="actions align-end">
            <button
              type="button"
              class="secondary"
              on:click={requestAmazonListingRestrictions}
              disabled={isRestrictionRequesting}
            >
              {isRestrictionRequesting ? "Queueing..." : "Check Restrictions"}
            </button>
          </div>
        </div>
        {#if listingRestrictionStatus}
          <div class={`request-status ${listingRestrictionStatus.tone}`}>
            <strong>{listingRestrictionStatus.title}</strong>
            <span>{listingRestrictionStatus.detail}</span>
            {#if listingRestrictionStatus.requestId}
              <span>{listingRestrictionStatus.requestId}</span>
            {/if}
            {#if listingRestrictionStatus.restrictions.length > 0}
              {#each listingRestrictionStatus.restrictions as restriction, index (`restriction:${index}`)}
                <small class="restriction-line">
                  {JSON.stringify(restriction)}
                </small>
              {/each}
            {/if}
          </div>
        {/if}
      </div>
      <label>
        <span>Amazon Listings Items submissions</span>
        <textarea
          bind:value={createPayloadJson}
          rows="12"
          placeholder="Generate submissions from a local listing, then review before submitting."
        />
      </label>
      {#if exemptSubmissionSkus.length > 0}
        <div class="request-status warning">
          <strong>Product identifier exemption payload</strong>
          <span>
            {exemptSubmissionSkus.length} child SKU{exemptSubmissionSkus.length ===
            1
              ? ""
              : "s"} omit EAN/JAN and set supplier_declared_has_product_identifier_exemption
            because the local listing has repeated child JANs.
          </span>
          <small>{exemptSubmissionSkus.join(", ")}</small>
        </div>
      {/if}
      <div class="actions">
        <button
          type="button"
          class="secondary"
          on:click={generateCreatePayload}
        >
          Generate Payload
        </button>
        <button
          type="button"
          on:click={requestAmazonListingCreate}
          disabled={isCreateRequesting}
        >
          {isCreateRequesting ? "Queueing..." : "Create Amazon Listing"}
        </button>
      </div>
      {#if createMessage}
        <div class="request-message">
          {createMessage}
          {#if lastQueuedCreateRequestId}
            <span>{lastQueuedCreateRequestId}</span>
          {/if}
        </div>
      {/if}
      {#if listingWriteStatus}
        <div class={`request-status ${listingWriteStatus.tone}`}>
          <strong>{listingWriteStatus.title}</strong>
          <span>{listingWriteStatus.detail}</span>
          {#if listingWriteStatus.messages.length > 0}
            <ul>
              {#each listingWriteStatus.messages as message (`${message.kind}:${message.key}:${message.code}:${message.message}`)}
                <li>{amazonMessageLabel(message)}</li>
              {/each}
            </ul>
          {/if}
        </div>
      {/if}
      {#if createError}
        <div class="request-error">{createError}</div>
      {/if}
    </div>
  </section>

  {#if amazonCatalog?.lastProbeError}
    <section class="error-banner">
      <strong>Last probe failed:</strong>
      {amazonCatalog.lastProbeError}
    </section>
  {/if}

  {#if amazonCatalog?.lastListingWriteError}
    <section class="error-banner">
      <strong>Last Amazon listing write failed:</strong>
      {amazonCatalog.lastListingWriteError}
    </section>
  {/if}

  {#if amazonCatalog?.lastProductTypeDiscoveryError}
    <section class="error-banner">
      <strong>Last Amazon product type discovery failed:</strong>
      {amazonCatalog.lastProductTypeDiscoveryError}
    </section>
  {/if}

  {#if amazonCatalog?.lastListingRestrictionsError}
    <section class="error-banner">
      <strong>Last Amazon listing restrictions check failed:</strong>
      {amazonCatalog.lastListingRestrictionsError}
    </section>
  {/if}

  {#if rows.length === 0}
    <section class="empty">No replayed Amazon observations yet.</section>
  {:else}
    <section class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>JAN</th>
            <th>Local</th>
            <th>ASIN</th>
            <th>Amazon Title</th>
            <th>Product Type</th>
            <th>Seller SKU</th>
            <th>Status</th>
            <th>Issues</th>
            <th>Offer</th>
            <th>Amazon Qty</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row (row.jan)}
            <tr class={rowClass(row)}>
              <td>
                <a href={`/itemhistory?itemKey=${encodeURIComponent(row.jan)}`}>
                  {row.jan}
                </a>
              </td>
              <td>
                {#if row.localMatches.length === 0}
                  <span class="muted">No local item</span>
                {:else}
                  {#each row.localMatches as match (match.itemKey)}
                    <div class="local-match">
                      <a
                        href={`/itemhistory?itemKey=${encodeURIComponent(match.itemKey)}`}
                      >
                        {match.itemKey}
                      </a>
                      {#if match.handle}
                        <a
                          class="handle"
                          href={`/listing-detail?handle=${encodeURIComponent(match.handle)}`}
                        >
                          {match.handle}
                        </a>
                      {/if}
                      <span class="muted">
                        Stock {match.onHand} ({match.qty} - {match.shipped})
                      </span>
                      {#if match.handle}
                        <button
                          type="button"
                          class="inline-action"
                          on:click={() =>
                            setCreateTarget(match.handle, match.itemKey)}
                        >
                          Use for create
                        </button>
                      {/if}
                    </div>
                  {/each}
                {/if}
              </td>
              <td>{row.asin || "-"}</td>
              <td>{row.catalogTitle || "-"}</td>
              <td>{row.productType || "-"}</td>
              <td>{row.sellerSku || "-"}</td>
              <td>{row.sellerStatus || "-"}</td>
              <td>
                <strong>{row.sellerIssues}</strong>
                {#if row.amazonMessages.length > 0}
                  <ul class="amazon-issue-list">
                    {#each row.amazonMessages as message (`${row.jan}:${message.kind}:${message.code}:${message.message}`)}
                      <li>{amazonMessageLabel(message)}</li>
                    {/each}
                  </ul>
                {/if}
                {#if row.listingProblems.length > 0}
                  <ul class="amazon-issue-list">
                    {#each row.listingProblems as message (`${row.jan}:${message.kind}:${message.code}:${message.message}`)}
                      <li>{amazonMessageLabel(message)}</li>
                    {/each}
                  </ul>
                {/if}
              </td>
              <td>{row.offerPrice || "-"}</td>
              <td>{row.fulfillmentQty || "-"}</td>
              <td>{row.sellerUpdatedAt || "-"}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>
  {/if}
</main>

<style>
  .page {
    padding: 24px;
    color: #1f2933;
  }

  .page-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 24px;
    margin-bottom: 20px;
  }

  h1,
  h2,
  p {
    margin: 0;
  }

  h1 {
    font-size: 28px;
    line-height: 1.2;
  }

  h2 {
    font-size: 16px;
    margin-bottom: 6px;
  }

  p {
    margin-top: 6px;
    color: #52616f;
  }

  .meta {
    display: grid;
    grid-template-columns: repeat(3, minmax(120px, 1fr));
    gap: 12px;
    min-width: 420px;
    font-weight: 700;
  }

  .meta div {
    border: 1px solid #d9e2ec;
    border-radius: 6px;
    padding: 10px 12px;
    background: #f8fafc;
  }

  .meta span {
    display: block;
    color: #627d98;
    font-size: 12px;
    font-weight: 600;
    margin-bottom: 4px;
  }

  .command-band {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    padding: 14px 16px;
    background: #f0f4f8;
    border: 1px solid #d9e2ec;
    border-radius: 6px;
    margin-bottom: 18px;
  }

  .probe-form {
    display: grid;
    gap: 10px;
    min-width: min(560px, 100%);
  }

  label {
    display: grid;
    gap: 4px;
    font-size: 12px;
    color: #52616f;
    font-weight: 700;
  }

  textarea {
    width: 100%;
    min-width: 0;
    resize: vertical;
    border: 1px solid #bcccdc;
    border-radius: 6px;
    padding: 8px 10px;
    font: inherit;
    line-height: 1.35;
    color: #1f2933;
    background: white;
  }

  input,
  select {
    width: 100%;
    min-width: 0;
    border: 1px solid #bcccdc;
    border-radius: 6px;
    padding: 8px 10px;
    font: inherit;
    line-height: 1.35;
    color: #1f2933;
    background: white;
  }

  .split-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }

  .split-row:has(label:nth-child(3)) {
    grid-template-columns: 1fr 120px 190px;
  }

  .check-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    font-weight: 600;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .discovery-panel {
    display: grid;
    gap: 10px;
    padding: 10px;
    border: 1px solid #d9e2ec;
    border-radius: 6px;
    background: #f8fafc;
  }

  .restrictions-panel {
    display: grid;
    gap: 10px;
    padding: 10px;
    border: 1px solid #d9e2ec;
    border-radius: 6px;
    background: #fff;
  }

  .restrictions-panel h3,
  .restrictions-panel p {
    margin: 0;
  }

  .restrictions-panel p {
    color: #627d98;
    font-size: 13px;
  }

  .restrictions-row {
    grid-template-columns: 1fr auto;
    align-items: end;
  }

  .align-end {
    align-self: end;
  }

  .restriction-line {
    display: block;
    overflow-wrap: anywhere;
  }

  .local-picker {
    display: grid;
    gap: 8px;
    padding: 10px;
    border: 1px solid #bcccdc;
    border-radius: 6px;
    background: white;
  }

  .local-search-results {
    display: grid;
    gap: 6px;
    max-height: 430px;
    overflow: auto;
  }

  .local-search-result,
  .selected-local-item {
    display: grid;
    grid-template-columns: 46px minmax(0, 1fr) auto;
    gap: 10px;
    align-items: center;
    width: 100%;
    padding: 8px;
    border: 1px solid #d9e2ec;
    border-radius: 6px;
    background: #f8fafc;
    color: #1f2933;
    text-align: left;
  }

  .local-search-result {
    cursor: pointer;
  }

  .local-search-result:hover {
    border-color: #1d4ed8;
    background: #eff6ff;
  }

  .local-search-result.unlinked {
    border-color: #fbd38d;
    background: #fffaf0;
  }

  .result-thumb {
    width: 46px;
    height: 46px;
    display: grid;
    place-items: center;
  }

  .result-main,
  .result-meta,
  .selected-local-item > div,
  .selected-metrics {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  .result-main span,
  .result-main small,
  .result-meta span,
  .selected-local-item span,
  .selected-local-item small,
  .selected-metrics span {
    color: #627d98;
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .result-meta,
  .selected-metrics {
    justify-items: end;
    font-size: 12px;
  }

  .selected-local-item {
    border-color: #9ae6b4;
    background: #f0fff4;
  }

  .no-results {
    padding: 8px 10px;
    border: 1px solid #d9e2ec;
    border-radius: 6px;
    color: #627d98;
    background: #f8fafc;
    font-size: 13px;
  }

  .candidate-list {
    display: grid;
    gap: 8px;
  }

  .candidate-row {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 10px;
    align-items: start;
    padding: 8px;
    border: 1px solid #d9e2ec;
    border-radius: 6px;
    background: white;
  }

  .candidate-row span,
  .candidate-row small {
    display: block;
    margin-top: 2px;
    color: #627d98;
  }

  .candidate-row .danger {
    color: #9b2c2c;
  }

  .candidate-row.selected-candidate {
    border-color: #1d4ed8;
    background: #eff6ff;
  }

  .selected-label {
    width: max-content;
    border-radius: 999px;
    padding: 2px 7px;
    background: #dbeafe;
    color: #1e3a8a;
    font-weight: 700;
  }

  .recent-discoveries {
    display: grid;
    gap: 8px;
    padding-top: 4px;
  }

  .recent-discoveries h3 {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin: 0;
    font-size: 13px;
    color: #52616f;
  }

  .recent-discoveries h3 span {
    min-width: 24px;
    border-radius: 999px;
    padding: 2px 7px;
    background: #d9e2ec;
    color: #1f2933;
    text-align: center;
    font-size: 12px;
  }

  .recent-empty {
    padding: 8px 10px;
    border: 1px dashed #bcccdc;
    border-radius: 6px;
    color: #627d98;
    background: white;
    font-size: 13px;
  }

  .recent-discovery-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(160px, auto) auto;
    gap: 10px;
    align-items: center;
    padding: 8px;
    border: 1px solid #d9e2ec;
    border-radius: 6px;
    background: white;
  }

  .recent-discovery-row span,
  .recent-discovery-row small {
    display: block;
    margin-top: 2px;
    color: #627d98;
    font-size: 12px;
  }

  .recent-candidates {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 6px;
  }

  .product-type-detail {
    display: grid;
    gap: 10px;
    padding: 10px;
    border: 1px solid #bcccdc;
    border-radius: 6px;
    background: white;
  }

  .product-type-detail-header {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 12px;
    align-items: start;
  }

  .product-type-detail-header h3 {
    margin: 0;
    font-size: 15px;
  }

  .product-type-detail-header span,
  .product-type-detail-header small,
  .coverage-summary span {
    display: block;
    margin-top: 2px;
    color: #627d98;
    font-size: 12px;
  }

  .coverage-summary {
    display: grid;
    justify-items: end;
    gap: 2px;
    font-size: 12px;
  }

  .attribute-table-wrap {
    overflow: auto;
    border: 1px solid #edf2f7;
    border-radius: 6px;
  }

  .attribute-table {
    min-width: 0;
    font-size: 12px;
  }

  .attribute-table th,
  .attribute-table td {
    padding: 6px 8px;
  }

  .attribute-table tr.missing-required {
    background: #fff5f5;
  }

  button {
    border: 1px solid #1d4ed8;
    background: #1d4ed8;
    color: white;
    border-radius: 6px;
    padding: 8px 12px;
    font: inherit;
    font-weight: 700;
    cursor: pointer;
  }

  button.secondary {
    background: white;
    color: #1d4ed8;
  }

  button.inline-action {
    width: max-content;
    border-color: #bcccdc;
    background: white;
    color: #1d4ed8;
    padding: 4px 7px;
    font-size: 12px;
  }

  button:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .request-message,
  .request-error,
  .request-pending,
  .request-status {
    border-radius: 6px;
    padding: 8px 10px;
    font-size: 13px;
  }

  .request-message strong,
  .request-message span,
  .request-error strong,
  .request-error span,
  .request-pending strong,
  .request-pending span,
  .request-status strong,
  .request-status span {
    display: block;
  }

  .request-message {
    background: #f0fff4;
    border: 1px solid #9ae6b4;
    color: #276749;
  }

  .request-message span {
    display: block;
    color: #52616f;
    font-size: 12px;
    margin-top: 2px;
  }

  .request-error {
    background: #fff5f5;
    border: 1px solid #feb2b2;
    color: #9b2c2c;
  }

  .request-pending {
    background: #eff6ff;
    border: 1px solid #bfdbfe;
    color: #1e3a8a;
  }

  .request-status.ok {
    background: #f0fff4;
    border: 1px solid #9ae6b4;
    color: #276749;
  }

  .request-status.warning {
    background: #fffaf0;
    border: 1px solid #fbd38d;
    color: #8a4b0f;
  }

  .request-status.error {
    background: #fff5f5;
    border: 1px solid #feb2b2;
    color: #9b2c2c;
  }

  .request-status.pending {
    background: #eff6ff;
    border: 1px solid #bfdbfe;
    color: #1e3a8a;
  }

  .request-status ul,
  .amazon-issue-list {
    margin: 6px 0 0;
    padding-left: 18px;
  }

  .request-status li,
  .amazon-issue-list li {
    margin: 2px 0;
    line-height: 1.35;
  }

  .error-banner,
  .empty {
    padding: 14px 16px;
    border-radius: 6px;
    margin-bottom: 18px;
  }

  .error-banner {
    background: #fff5f5;
    border: 1px solid #feb2b2;
    color: #9b2c2c;
  }

  .empty {
    background: #f8fafc;
    border: 1px solid #d9e2ec;
  }

  .table-wrap {
    overflow-x: auto;
    border: 1px solid #d9e2ec;
    border-radius: 6px;
  }

  table {
    width: 100%;
    min-width: 1300px;
    border-collapse: collapse;
    font-size: 13px;
  }

  th,
  td {
    padding: 9px 10px;
    border-bottom: 1px solid #edf2f7;
    text-align: left;
    vertical-align: top;
  }

  th {
    background: #f8fafc;
    font-size: 12px;
    color: #52616f;
    position: sticky;
    top: 0;
  }

  tr.ok {
    background: #f7fff7;
  }

  tr.issue {
    background: #fffaf0;
  }

  tr.missing,
  tr.error {
    background: #fff5f5;
  }

  a {
    color: #1d4ed8;
    text-decoration: none;
  }

  a:hover {
    text-decoration: underline;
  }

  .local-match {
    display: grid;
    gap: 2px;
    margin-bottom: 8px;
  }

  .handle,
  .muted {
    color: #627d98;
  }

  @media (max-width: 900px) {
    .page {
      padding: 16px;
    }

    .page-header,
    .command-band {
      display: block;
    }

    .meta {
      grid-template-columns: 1fr;
      min-width: 0;
      margin-top: 14px;
    }

    .probe-form {
      margin-top: 12px;
    }

    .split-row,
    .split-row:has(label:nth-child(3)) {
      grid-template-columns: 1fr;
    }

    .local-search-result,
    .selected-local-item {
      grid-template-columns: 46px minmax(0, 1fr);
    }

    .result-meta,
    .selected-metrics {
      grid-column: 2;
      justify-items: start;
    }

    .recent-discovery-row {
      grid-template-columns: 1fr;
      align-items: start;
    }

    .recent-candidates {
      justify-content: flex-start;
    }

    .product-type-detail-header {
      grid-template-columns: 1fr;
    }

    .coverage-summary {
      justify-items: start;
    }
  }
</style>
