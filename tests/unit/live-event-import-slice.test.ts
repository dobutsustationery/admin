import { describe, expect, it } from "vitest";
import {
  commit_import,
  computeLiveEventImportCommit,
  parseLiveEventPaste,
  set_paste,
  set_event_date,
} from "../../src/lib/live-event-import-slice";
import { bulk_import_items } from "../../src/lib/inventory";
import { rootReducer } from "../../src/lib/root-reducer";
import { makeInventoryItemKey } from "../../src/lib/sku";

const timestamp = { seconds: 1_700_000_000, nanoseconds: 0 };

describe("live event import", () => {
  it("parses TSV rows and infers the event name from taking/returned columns", () => {
    const paste = [
      [
        "janCode",
        "subtype",
        "description",
        "image",
        "hsCode",
        "qty",
        "pieces",
        "shipped",
        "Inventory Count per system",
        "Actual inventory count in office",
        "Taking to Christmas Market",
        "Returned from Christmas Market",
        "Sold",
      ].join("\t"),
      [
        "4510085333840",
        "Default",
        "Senshu Kawaii Panda Wall Stickers",
        "https://example.test/panda.jpg",
        "48211010",
        "20",
        "1",
        "0",
        "20",
        "20",
        "10",
        "8",
        "2",
      ].join("\t"),
    ].join("\n");

    const parsed = parseLiveEventPaste(paste);

    expect(parsed.delimiter).toBe("tsv");
    expect(parsed.eventName).toBe("Christmas Market");
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].approved).toBe(true);
    expect(parsed.rows[0].parsed?.janCode).toBe("4510085333840");
    expect(parsed.rows[0].parsed?.subtype).toBe("Default");
    expect(parsed.rows[0].parsed?.sold).toBe(2);
  });

  it("derives sold from taken minus returned when Sold is absent", () => {
    const paste = [
      "janCode,subtype,description,Taking to Pop Up,Returned from Pop Up",
      "4510085335639,Yellow,Notebook,8,2",
    ].join("\n");

    const parsed = parseLiveEventPaste(paste);

    expect(parsed.eventName).toBe("Pop Up");
    expect(parsed.rows[0].parsed?.sold).toBe(6);
  });

  it("computes commit lines from approved parsed rows and exact inventory keys", () => {
    const key = makeInventoryItemKey("4510085335639", "Yellow");
    const parsed = parseLiveEventPaste(
      [
        "janCode,subtype,description,Sold",
        "4510085335639,Yellow,Notebook,6",
      ].join("\n"),
    );

    const result = computeLiveEventImportCommit(
      {
        rawPaste: "",
        delimiter: "csv",
        eventName: "market",
        step: "review",
        rows: parsed.rows,
      },
      {
        [key]: {
          janCode: "4510085335639",
          subtype: "Yellow",
          qty: 10,
          shipped: 0,
        },
      },
    );

    expect(result.lines).toEqual([{ index: 0, itemKey: key, qty: 6 }]);
    expect(result.indices).toEqual([0]);
  });

  it("matches exact inventory keys while preserving subtype spaces", () => {
    const key = makeInventoryItemKey("4952270291472", "Deco Seals");
    const parsed = parseLiveEventPaste(
      [
        "janCode,subtype,description,Sold",
        "4952270291472,Deco Seals,Sticker sheet,2",
      ].join("\n"),
    );

    expect(key).toBe("4952270291472Deco Seals");

    const result = computeLiveEventImportCommit(
      {
        rawPaste: "",
        delimiter: "csv",
        eventName: "market",
        step: "review",
        rows: parsed.rows,
      },
      {
        [key]: {
          janCode: "4952270291472",
          subtype: "Deco Seals",
          qty: 10,
          shipped: 0,
        },
      },
    );

    expect(result.lines).toEqual([{ index: 0, itemKey: key, qty: 2 }]);
    expect(result.indices).toEqual([0]);
  });

  it("matches inventory items with same subtype even if their key is just the JAN code", () => {
    // Inventory item has a key that is just the JAN code, but its subtype field is "Deco Seals".
    const inventoryKey = "4952270291472";
    const parsed = parseLiveEventPaste(
      [
        "janCode,subtype,description,Sold",
        "4952270291472,Deco Seals,Sticker sheet,2",
      ].join("\n"),
    );

    const result = computeLiveEventImportCommit(
      {
        rawPaste: "",
        delimiter: "csv",
        eventName: "market",
        step: "review",
        rows: parsed.rows,
      },
      {
        [inventoryKey]: {
          janCode: "4952270291472",
          subtype: "Deco Seals",
          qty: 10,
          shipped: 0,
        },
      },
    );

    expect(result.lines).toEqual([{ index: 0, itemKey: inventoryKey, qty: 2 }]);
    expect(result.indices).toEqual([0]);
  });

  it("does not fall back to a different subtype for the same JAN", () => {
    const greenKey = makeInventoryItemKey("4510085335639", "Green");
    const parsed = parseLiveEventPaste(
      [
        "janCode,subtype,description,Sold",
        "4510085335639,Yellow,Notebook,6",
      ].join("\n"),
    );

    const result = computeLiveEventImportCommit(
      {
        rawPaste: "",
        delimiter: "csv",
        eventName: "market",
        step: "review",
        rows: parsed.rows,
      },
      {
        [greenKey]: {
          janCode: "4510085335639",
          subtype: "Green",
          qty: 10,
          shipped: 0,
        },
      },
    );

    expect(result.lines).toEqual([]);
    expect(result.indices).toEqual([]);
  });

  it("does not infer a non-default subtype when the paste has no subtype", () => {
    const yellowKey = makeInventoryItemKey("4510085335639", "Yellow");
    const parsed = parseLiveEventPaste(
      ["janCode,description,Sold", "4510085335639,Notebook,6"].join("\n"),
    );

    const result = computeLiveEventImportCommit(
      {
        rawPaste: "",
        delimiter: "csv",
        eventName: "market",
        step: "review",
        rows: parsed.rows,
      },
      {
        [yellowKey]: {
          janCode: "4510085335639",
          subtype: "Yellow",
          qty: 10,
          shipped: 0,
        },
      },
    );

    expect(result.lines).toEqual([]);
    expect(result.indices).toEqual([]);
  });

  it("commits approved sales through package_item synthesis", () => {
    const key = makeInventoryItemKey("4510085335639", "Yellow");
    const paste = [
      "janCode,subtype,description,Taking to Christmas Market,Returned from Christmas Market,Sold",
      "4510085335639,Yellow,Notebook,8,2,6",
    ].join("\n");
    const logger = () => {};

    let state = rootReducer(undefined, { type: "@@INIT" }, logger);
    state = rootReducer(
      state,
      {
        ...bulk_import_items({
          items: [
            {
              type: "new",
              id: key,
              item: {
                janCode: "4510085335639",
                subtype: "Yellow",
                description: "Notebook",
                hsCode: "",
                image: "",
                qty: 10,
                pieces: 1,
                shipped: 0,
                creationDate: "Test",
                timestamp: 0,
              },
            },
          ],
        }),
        id: "seed",
        timestamp,
      },
      logger,
    );

    state = rootReducer(
      state,
      { ...set_paste({ rawPaste: paste }), id: "paste", timestamp },
      logger,
    );
    state = rootReducer(
      state,
      { ...set_event_date({ eventDate: "2023-12-25" }), id: "date", timestamp },
      logger,
    );
    state = rootReducer(
      state,
      { ...commit_import(), id: "commit-1", timestamp },
      logger,
    );

    expect(state.inventory.idToItem[key].shipped).toBe(6);
    expect(state.liveEventImport.rows[0].processed).toBe(true);
    expect(
      state.inventory.orderIdToOrder["live-event:christmas-market:commit-1"]
        .items,
    ).toEqual([{ itemKey: key, qty: 6 }]);
    expect(
      state.inventory.orderIdToOrder["live-event:christmas-market:commit-1"]
        .eventDate,
    ).toEqual(new Date("2023-12-25T00:00:00"));
  });
});
