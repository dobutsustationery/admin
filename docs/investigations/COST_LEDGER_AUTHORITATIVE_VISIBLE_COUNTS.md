# Reducer experiment: targeted cost-ledger authoritative visible counts

Backup: ../production-backup-jun-11/firestore-export.json
Implementation: targeted inventory reducer reconciliation after cost-ledger-affecting handlers
Actions replayed: 41771; errors: 0; replay 22.7s
Changed items: 35
Negative on-hand before: 9; after: 0
Resolved negatives: 9; newly negative: 0

| Item | Description | Qty before -> after | Shipped before -> after | On hand before -> after | Delta |
|---|---|---:|---:|---:|---:|
| `4542804112917` | Amifa Design & Origami Paper — Sakura Themes | 13 -> 24 | 7 -> 7 | 6 -> 17 | 11 |
| `4902778185650` | Mechanical Pencil Mitsubishi Kurotoga 0.7mm Blue | 0 -> 10 | 0 -> 0 | 0 -> 10 | 10 |
| `4589469849758` | Gacha Blind Mystery Box — Neko Cat Collectibles Set 2 | 10 -> 17 | 17 -> 17 | -7 -> 0 | 7 |
| `4542804080773Cream` | Bag Shopping Botanical | 12 -> 18 | 18 -> 18 | -6 -> 0 | 6 |
| `4991685190055Pink` | Iwako Japan Maiko Eraser | 5 -> 10 | 8 -> 8 | -3 -> 2 | 5 |
| `4991685190055White` | Iwako Japan Maiko Eraser | 5 -> 10 | 4 -> 4 | 1 -> 6 | 5 |
| `4991685201126Black` | Iwako Lucky Cat Eraser | 5 -> 10 | 6 -> 6 | -1 -> 4 | 5 |
| `4991685201126White` | Iwako Lucky Cat Eraser | 5 -> 10 | 8 -> 8 | -3 -> 2 | 5 |
| `4542804112832Cherry` | Amifa Fruit Mini Card Set | 10 -> 13 | 4 -> 4 | 6 -> 9 | 3 |
| `4542804149982Yellow` | Amifa French Chinoiserie Saddle-stich Lined A5 Notebook | 2 -> 4 | 4 -> 4 | -2 -> 0 | 2 |
| `4542804044119Blue` | Amifa Watercolour Washi Masking Tape | 11 -> 10 | 1 -> 1 | 10 -> 9 | -1 |
| `4542804044119Yellow` | Amifa Watercolour Washi Masking Tape | 12 -> 13 | 1 -> 1 | 11 -> 12 | 1 |
| `4542804080773Green` | Bag Shopping Botanical | 12 -> 13 | 11 -> 11 | 1 -> 2 | 1 |
| `4542804080957Blue` | Amifa Floral Sticker Flakes (30) | 9 -> 10 | 2 -> 2 | 7 -> 8 | 1 |
| `4542804080957Pink` | Amifa Floral Sticker Flakes (30) | 8 -> 7 | 2 -> 2 | 6 -> 5 | -1 |
| `4542804085181Beige` | Amifa Custom Note Frame Stickers (48) | 6 -> 5 | 2 -> 2 | 4 -> 3 | -1 |
| `4542804100945Blue` | Amifa Polka Dot Washi Masking Tape | 3 -> 2 | 1 -> 1 | 2 -> 1 | -1 |
| `4542804100945Green` | Amifa Polka Dot Washi Masking Tape | 6 -> 7 | 2 -> 2 | 4 -> 5 | 1 |
| `4542804105827Beige` | Amifa Art Card Set — Shabby Chic | 5 -> 6 | 2 -> 2 | 3 -> 4 | 1 |
| `4542804105827Blue` | Amifa Art Card Set — Shabby Chic | 5 -> 4 | 2 -> 2 | 3 -> 2 | -1 |
| `4542804108637Beige` | Amifa Pétale Clear Floral Stickers (30) | 6 -> 5 | 2 -> 2 | 4 -> 3 | -1 |
| `4542804108637Yellow` | Amifa Pétale Clear Floral Stickers (30) | 6 -> 7 | 2 -> 2 | 4 -> 5 | 1 |
| `4542804112832Strawberry` | Amifa Fruit Mini Card Set | 11 -> 12 | 4 -> 4 | 7 -> 8 | 1 |
| `4542804120806Blue` | Amifa Cool Sweets Sticky Notes Kawaii (70) | 21 -> 20 | 0 -> 0 | 21 -> 20 | -1 |
| `4542804120806Turquoise` | Amifa Cool Sweets Sticky Notes Kawaii (70) | 23 -> 24 | 1 -> 1 | 22 -> 23 | 1 |
| `4562136651557Grey` | Fabric Pouch 19x15.5cm Birds | 0 -> 1 | 0 -> 0 | 0 -> 1 | 1 |
| `4902505660405` | Pilot ILMILY 0.5mm Nuance Black Pen Collection | 10 -> 11 | 11 -> 11 | -1 -> 0 | 1 |
| `4902505660412` | Pilot ILMILY 0.5mm Nuance Black Pen Collection | 10 -> 11 | 11 -> 11 | -1 -> 0 | 1 |
| `4902505660450` | Pilot ILMILY 0.5mm Nuance Black Pen Collection | 10 -> 11 | 11 -> 11 | -1 -> 0 | 1 |
| `4952270242597` | Furukawa Kawaii Hedgehog Sticky Notes | 9 -> 10 | 1 -> 1 | 8 -> 9 | 1 |
| `4952270287086` | Furukawa Neko Cat Washi Paper Stationery Set Kawaii | 9 -> 10 | 2 -> 2 | 7 -> 8 | 1 |
| `4974052670381` | Shachihata Iromoyo Oil-Based Mini Ink Pad – Desk Gems | 0 -> 1 | 0 -> 0 | 0 -> 1 | 1 |
| `4974052670404` | Shachihata Iromoyo Oil-Based Mini Ink Pad – Desk Gems | 0 -> 1 | 0 -> 0 | 0 -> 1 | 1 |
| `4974052670619` | Shachihata Iromoyo Oil-Based Mini Ink Pad – Desk Gems | 0 -> 1 | 0 -> 0 | 0 -> 1 | 1 |
| `4977564720711` | Plus Deco Rush Decoration Tape 6mm x 4m | 9 -> 10 | 1 -> 1 | 8 -> 9 | 1 |
