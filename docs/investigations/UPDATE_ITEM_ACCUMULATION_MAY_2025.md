# May 2025 scanner qty accumulation report

Generated from a fresh emulator export:
`/tmp/admin2-update-item-count-20260521-141743/firestore-export.json`

Method: replayed the export through the existing `rootReducer`, read
`state.inventory.idToItem[id].qty` immediately before each May 3-5
`update_item`, then dispatched that same action through the reducer. For the
items that accumulated from a non-zero qty, replay then traced later
`update_field` qty actions on the same item key.

## Summary

The May 3-5 scanner window contains 349 top-level `update_item` actions.

| outcome                                                    | actions | unique item keys |
| ---------------------------------------------------------- | ------: | ---------------: |
| Existing qty was non-zero and the scan accumulated it      |      15 |               14 |
| Existing qty was zero and the scan behaved like `0 -> qty` |     334 |              328 |
| Other                                                      |       0 |                0 |

Of the 14 item keys affected by non-zero accumulation:

| outcome                                       | item keys |
| --------------------------------------------- | --------: |
| Later explicitly set to the last scanned qty  |        10 |
| No later qty edit found                       |         2 |
| Later edited, but not to the last scanned qty |         2 |

## Follow-up table

Timestamps are UTC. "Elapsed" is measured from the final accumulating scan for
that item key to the relevant later qty edit.

| item key              | item                                   | final accumulating scan  | accumulation   | later qty edit           | edited qty | elapsed        | outcome                                                                   |
| --------------------- | -------------------------------------- | ------------------------ | -------------- | ------------------------ | ---------: | -------------- | ------------------------------------------------------------------------- |
| `4542804085182Beige`  | Frame Sticker Custom Note              | 2025-05-03T14:04:56.076Z | `6 + 6 = 12`   | none                     |            | none           | No later qty edit found                                                   |
| `4542804085182Pink`   | Frame Sticker Custom Note              | 2025-05-03T14:05:09.523Z | `5 + 5 = 10`   | none                     |            | none           | No later qty edit found                                                   |
| `4542804090796Pink`   | Stickers Wrapping Hexagon              | 2025-05-04T04:54:02.447Z | `19 + 12 = 31` | 2025-05-07T16:57:55.529Z |         12 | 3d 12h 3m 53s  | Explicitly reset to last scanned qty                                      |
| `4542804089561Pink`   | Stickers Wrapping Round                | 2025-05-04T05:07:22.864Z | `12 + 10 = 22` | 2025-05-07T17:04:56.399Z |         10 | 3d 11h 57m 34s | Explicitly reset to last scanned qty after an intermediate bad edit to 52 |
| `4542804089561Blue`   | Stickers Wrapping Round                | 2025-05-04T05:08:25.044Z | `10 + 10 = 20` | 2025-05-07T17:04:51.337Z |         10 | 3d 11h 56m 26s | Explicitly reset to last scanned qty                                      |
| `4542804110159Blue`   | Stickers Wrapping Seal                 | 2025-05-04T05:21:22.376Z | `6 + 11 = 17`  | 2025-05-07T17:11:08.582Z |         11 | 3d 11h 49m 46s | Explicitly reset to last scanned qty                                      |
| `4542804113372Black`  | Design Paper Art Cards City Scapes     | 2025-05-04T05:35:13.574Z | `4 + 4 = 8`    | 2025-05-07T17:18:28.059Z |          4 | 3d 11h 43m 14s | Explicitly reset to last scanned qty                                      |
| `4542804113372Brown`  | Design Paper Art Cards City Scapes     | 2025-05-04T05:35:42.302Z | `2 + 2 = 4`    | 2025-05-08T19:59:23.049Z |          2 | 4d 14h 23m 41s | Explicitly reset to last scanned qty                                      |
| `4542804104400Black`  | Art card set                           | 2025-05-04T07:41:39.329Z | `5 + 5 = 10`   | 2025-06-02T17:16:07.813Z |          5 | 29d 9h 34m 28s | Explicitly reset to last scanned qty                                      |
| `4542804119800Flower` | Bag Zip Lock Masterpiece Square        | 2025-05-04T09:24:55.204Z | `19 + 19 = 38` | 2025-05-04T09:25:56.661Z |         19 | 1m 1s          | Explicitly reset to last scanned qty                                      |
| `4542804119800Fruit`  | Bag Zip Lock Masterpiece Square        | 2025-05-04T09:27:37.528Z | `18 + 19 = 37` | 2025-05-07T16:51:25.909Z |         19 | 3d 7h 23m 48s  | Explicitly reset to last scanned qty                                      |
| `4542804115291`       | Sheet bag pink party                   | 2025-05-04T09:48:57.957Z | `10 + 20 = 30` | 2025-05-08T18:43:38.433Z |         24 | 4d 8h 54m 40s  | Edited later, but not to last scanned qty                                 |
| `4542804110043Blue`   | Bag Non-woven Drawstring Twinkle Bloom | 2025-05-04T09:58:16.868Z | `6 + 7 = 13`   | 2025-05-08T20:57:05.141Z |          7 | 4d 10h 58m 48s | Explicitly reset to last scanned qty                                      |
| `4902505523915`       | Gel Pen Juice Up 0.4mm Pastel 6CT      | 2025-05-04T15:12:59.183Z | `4 + 9 = 13`   | 2025-05-04T15:13:35.929Z |          4 | 37s            | Edited later, but reset to old qty rather than last scanned qty           |

## Notes

- `4542804090796Pink` had two accumulating scans: first `12 + 7 = 19`, then
  `19 + 12 = 31`. The follow-up edit set qty from 31 back to 12.
- `4542804089561Pink` had three later qty edits: `22 -> 52`, then `52 -> 10`,
  then `10 -> 12`.
- `4542804119800Flower` and `4902505523915` were corrected almost immediately,
  which is strong evidence that the operator saw the visible qty jump and used
  the inventory screen to undo it.
- The two `4542804085182...` keys had no later qty correction in the replayed
  export and should be checked manually.
