import { describe, expect, it } from "vitest";
import {
  classifySyncRequestStatusFromEventTypes,
  inferSyncRequestDomainFromEvents,
} from "../../src/lib/shopify-sync-model";

describe("sync status classification", () => {
  it("classifies google auth failed as failed", () => {
    const status = classifySyncRequestStatusFromEventTypes([
      "google/auth_requested",
      "google/auth_started",
      "google/auth_failed",
    ]);
    expect(status).toBe("failed");
  });

  it("classifies google auth completed as success", () => {
    const status = classifySyncRequestStatusFromEventTypes([
      "google/auth_requested",
      "google/auth_started",
      "google/auth_completed",
    ]);
    expect(status).toBe("success");
  });

  it("infers google domain from google event types", () => {
    const domain = inferSyncRequestDomainFromEvents([
      { eventType: "google/auth_requested" },
    ]);
    expect(domain).toBe("google");
  });

  it("classifies listings audit completed as success", () => {
    const status = classifySyncRequestStatusFromEventTypes([
      "shopify/listings_audit_requested",
      "shopify/listings_audit_completed",
    ]);
    expect(status).toBe("success");
  });

  it("classifies listings audit failed as failed", () => {
    const status = classifySyncRequestStatusFromEventTypes([
      "shopify/listings_audit_requested",
      "shopify/listings_audit_failed",
    ]);
    expect(status).toBe("failed");
  });

  it("classifies amazon catalog probes through lifecycle states", () => {
    expect(
      classifySyncRequestStatusFromEventTypes([
        "amazon/catalog_probe_requested",
      ]),
    ).toBe("queued");
    expect(
      classifySyncRequestStatusFromEventTypes([
        "amazon/catalog_probe_requested",
        "amazon/catalog_probe_started",
      ]),
    ).toBe("processing");
    expect(
      classifySyncRequestStatusFromEventTypes([
        "amazon/catalog_probe_requested",
        "amazon/catalog_probe_started",
        "amazon/catalog_probe_api_call",
        "amazon/catalog_probe_completed",
      ]),
    ).toBe("success");
    expect(
      classifySyncRequestStatusFromEventTypes([
        "amazon/catalog_probe_requested",
        "amazon/catalog_probe_failed",
      ]),
    ).toBe("failed");
  });

  it("classifies amazon listing creates through lifecycle states", () => {
    expect(
      classifySyncRequestStatusFromEventTypes([
        "amazon/listing_create_requested",
      ]),
    ).toBe("queued");
    expect(
      classifySyncRequestStatusFromEventTypes([
        "amazon/listing_create_requested",
        "amazon/listing_create_started",
      ]),
    ).toBe("processing");
    expect(
      classifySyncRequestStatusFromEventTypes([
        "amazon/listing_create_requested",
        "amazon/listing_create_started",
        "amazon/listing_create_api_call",
        "amazon/listing_create_completed",
      ]),
    ).toBe("success");
    expect(
      classifySyncRequestStatusFromEventTypes([
        "amazon/listing_create_requested",
        "amazon/listing_create_failed",
      ]),
    ).toBe("failed");
  });

  it("classifies amazon product type discovery through lifecycle states", () => {
    expect(
      classifySyncRequestStatusFromEventTypes([
        "amazon/product_type_discovery_requested",
      ]),
    ).toBe("queued");
    expect(
      classifySyncRequestStatusFromEventTypes([
        "amazon/product_type_discovery_requested",
        "amazon/product_type_discovery_started",
      ]),
    ).toBe("processing");
    expect(
      classifySyncRequestStatusFromEventTypes([
        "amazon/product_type_discovery_requested",
        "amazon/product_type_discovery_started",
        "amazon/product_type_discovery_api_call",
        "amazon/product_type_discovery_completed",
      ]),
    ).toBe("success");
    expect(
      classifySyncRequestStatusFromEventTypes([
        "amazon/product_type_discovery_requested",
        "amazon/product_type_discovery_failed",
      ]),
    ).toBe("failed");
  });

  it("classifies amazon listing restriction checks through lifecycle states", () => {
    expect(
      classifySyncRequestStatusFromEventTypes([
        "amazon/listing_restrictions_requested",
      ]),
    ).toBe("queued");
    expect(
      classifySyncRequestStatusFromEventTypes([
        "amazon/listing_restrictions_requested",
        "amazon/listing_restrictions_started",
      ]),
    ).toBe("processing");
    expect(
      classifySyncRequestStatusFromEventTypes([
        "amazon/listing_restrictions_requested",
        "amazon/listing_restrictions_started",
        "amazon/listing_restrictions_api_call",
        "amazon/listing_restrictions_completed",
      ]),
    ).toBe("success");
    expect(
      classifySyncRequestStatusFromEventTypes([
        "amazon/listing_restrictions_requested",
        "amazon/listing_restrictions_failed",
      ]),
    ).toBe("failed");
  });

  it("infers amazon domain from amazon event types", () => {
    const domain = inferSyncRequestDomainFromEvents([
      { eventType: "amazon/catalog_probe_requested" },
    ]);
    expect(domain).toBe("amazon");
  });
});
