import { rootReducer } from "../src/lib/root-reducer";
import { set_paste, set_event_date, commit_import } from "../src/lib/live-event-import-slice";
import { bulk_import_items } from "../src/lib/inventory";

const logger = () => {};

const paste = [
  "janCode,subtype,description,Sold",
  "4510085335639,Yellow,Notebook,6",
].join("\n");

let state = rootReducer(undefined, { type: "@@INIT" }, logger);

state = rootReducer(
  state,
  {
    ...bulk_import_items({
      items: [
        {
          type: "new",
          id: "4510085335639Yellow",
          item: {
            janCode: "4510085335639",
            subtype: "Yellow",
            qty: 10,
            shipped: 0,
          } as any,
        },
      ],
    }),
    id: "seed",
    _timestamp: 1000,
  },
  logger,
);

state = rootReducer(
  state,
  { ...set_paste({ rawPaste: paste }), id: "paste", _timestamp: 1000 },
  logger,
);

state = rootReducer(
  state,
  { ...set_event_date({ eventDate: "2024-05-01" }), id: "date", _timestamp: 2000 },
  logger,
);

state = rootReducer(
  state,
  { ...commit_import(), id: "commit", _timestamp: 3000 },
  logger,
);

console.log(
  Object.values(state.inventory.orderIdToOrder).map(o => ({
    id: o.id,
    date: o.date instanceof Date ? o.date.toISOString() : o.date,
    eventDate: o.eventDate instanceof Date ? o.eventDate.toISOString() : o.eventDate,
  }))
);
