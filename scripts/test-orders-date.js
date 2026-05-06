import { store } from "../src/lib/store.js";
import { rootReducer } from "../src/lib/root-reducer.js";
import { set_paste, set_event_date, commit_import } from "../src/lib/live-event-import-slice.js";

const state = store.getState();
console.log(Object.keys(state.inventory.orderIdToOrder).filter(k => k.includes("live-event")));
