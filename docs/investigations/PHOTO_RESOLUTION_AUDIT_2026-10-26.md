# Production photo-resolution audit - 2026-10-26

Snapshot: 2026-10-26T17:51:15.875Z (UTC). Store: kgxnau-sh.myshopify.com.

## Summary

The defect is widespread. **540 current Shopify images across 104 products are 512 pixels or smaller on their longest side.** All 540 CDN files were downloaded and their dimensions agree with Shopify's Admin API. These are master CDN files without a requested width, not intentionally small storefront thumbnail renditions.

- 103 affected products are active and published; 99 also have positive aggregate variant inventory.
- 80 products have a low-resolution lead image.
- 56 products have only low-resolution images.
- 509 image records across 97 products link to Google Photos originals above 1024 pixels and the defective bare-URL download history.
- 31 images across seven other products have unverified origins; four of these already existed in September 2025 and cannot be attributed to the March 2026 regression.
- The 540 image records refer to 383 distinct Drive filenames; duplicate gallery/variant copies inflate the image-record count relative to source files.

## Scope and method

Read-only retrieval of all 473 current Shopify products (all statuses) and 2843 image records through Admin API. Joined these to production broadcast history through the latest downloaded events, 2,810 recorded photo-transfer completions, and 2,457 transform completions. Compared original dimensions recorded by Google Photos to current Shopify dimensions; followed recorded Drive edit ancestry where available.

Downloaded and decoded **1562 files**: 540 low-resolution CDN files, seven medium-resolution CDN files, and **1015 distinct Drive source copies**. There were no failed downloads. Every measured source copy is at most 512 pixels on its longest side. These copies represent **584 distinct Google Photos IDs**; repeated transfers produced duplicate Drive files. This is a count of historical copies, not 1015 separate products or current images.

No products, images, stock, deployments, or production events were modified. Report files are local only.

## Confidence and classifications

| Classification | Image records | Interpretation |
|---|---:|---|
| Confirmed bare-download lineage | 346 | Current small CDN file has a recorded source/edit chain to a bare Google Photos download. |
| Same-photo linkage; incomplete edit chain | 163 | Current small CDN image maps to the same photo ID as a measured thumbnail download and a large original, but a manual-edit step lacks its parent URL. Strongly linked, not a fully recorded chain. |
| Small image; origin unverified | 31 | Current low resolution is confirmed, but the importer regression is not established as its cause. |
| Medium-resolution review | 7 | Longest side is 513-1023 pixels, across six products; assess gallery sharpness separately. |
| Not flagged by size | 2296 | At least 1024 pixels on the longest side; this is not a guarantee of sharpness. |

There are also **59 larger images across 14 products** whose photo IDs have thumbnail-download history but whose current edit ancestry is incomplete. They may have been repaired from larger sources; dimensions alone cannot rule out upscaling. They are listed separately for visual review and are **not included in the 540 confirmed-small count**. Product counts across categories can overlap.

## Root cause and history

Original backend implementation `0f419375` (February 23) required the Google Photos `=d` download URL. Commit `745faebe` (March 16), appearing as `321055e9` in the current branch (committed March 18), began trying the bare URL before `=d`. The first HTTP 200 ends the search, accepting Google's preview as the imported master. There is no resolution validation. The earliest bare-download completion in the retrieved records is **2026-03-16T07:59:24.338000+00:00**, and the latest is **2026-10-25T19:21:09.523000+00:00**.

Cropping and background removal preserve that lost detail; Shopify's `_s1600` filename is only a request/filename convention and does not restore resolution. A repeated sync of the existing Drive copy cannot repair it. Google documents the download parameter at https://developers.google.com/photos/picker/guides/media-items.

## Example: JAN 4542804169317

| Photo | Google Photos recorded original | Imported Drive copy | Current Shopify CDN |
|---|---|---|---|
| IMG_3120.HEIC | 2913 x 3533 | 422 x 512 | 387 x 275 |
| IMG_3121.HEIC | 2532 x 2676 | 484 x 512 | 413 x 277 |
| IMG_3119.HEIC | 3024 x 4032 | 384 x 512 | 379 x 292 |

All three images of the 2027 Kawaii Animal Desk Calendar are affected. The first two have incomplete manual-edit parent history; the third has a fully recorded lineage. All three original import copies were measured.

## When current small image records were created on Shopify

These are Shopify image-record creation months, not necessarily the dates of the original defective downloads.

| Month | Small image records |
|---|---:|
| 2025-09 | 4 |
| 2026-03 | 33 |
| 2026-05 | 2 |
| 2026-06 | 17 |
| 2026-07 | 51 |
| 2026-09 | 34 |
| 2026-10 | 399 |

## Unverified-origin products

These products have 31 confirmed-small image records between them, but no established link to the importer regression:

- Amifa Custom Note Frame Stickers (48)
- Amifa Decorative Paper Set — Typography Themes
- Amifa Moon and Sky Wall Stickers (Large)
- Amifa Transparent Moon & Star Wall Stickers (94)
- Amifa Zodiac Mini Letter Set
- Nippon Japan Notebook (17.9 x 12.6 mm)
- Seal Do Washi Masking Tape Neko Cats Kawaii (15mm) — four 500 x 500 images created in September 2025, predating the regression.

## Repair order

1. Fix and verify original-resolution downloading and dimension checks before any reprocessing. Preserve source metadata and reject unexplained reductions.
2. Repair the 76 live, stocked products with low-resolution lead images first; then their other affected gallery images. Counts and identities are in the priority-sorted product CSV.
3. Retrieve fresh full-resolution Google Photos sources. Regenerate the selected edits/crops from those sources, preserving product/variant associations and image order. Do not merely enlarge the existing thumbnail.
4. Bypass or invalidate the existing cached derivations when repairing: the current worker can reuse an existing Drive result by its derivation key. A normal retry is not sufficient proof of repair.
5. Replace Shopify media only after validating the repaired source and CDN dimensions and visually checking detail. Restore suitable large masters; the current sync requests up to 1600 pixels on the longest side.
6. Review the seven products with unverified origins, medium images, and the larger images with thumbnail history separately. Avoid assuming every small legacy image was caused by this regression.

This is a proposed repair sequence only; no repair was performed.

## Product list

Complete affected-product list, sorted by repair priority. “Stock” is aggregate variant inventory, not a guarantee of storefront purchasability. Lead/all refer to the <=512-pixel threshold. The CSV includes full JAN/SKU lists and product IDs.

| Priority | Product | Small / total | Lead small | All small | Stock |
|---|---|---:|---|---|---:|
| 1 | [Amifa Fruit Gummy Sealing Stickers (24)](https://dobutsustationery.com/products/amifa-fruit-gummy-sealing-stickers-24-4542804125580) | 16 / 16 | Yes | Yes | 24 |
| 1 | [Amifa Kawaii Sleepy Animal Sticker Flakes (100)](https://dobutsustationery.com/products/amifa-kawaii-sleepy-animal-sticker-flakes-100-4542804155358) | 16 / 16 | Yes | Yes | 24 |
| 1 | [Amifa Retro Animal Shop Flake Stickers (27)](https://dobutsustationery.com/products/amifa-retro-animal-shop-flake-stickers-27-4542804155327) | 16 / 16 | Yes | Yes | 24 |
| 1 | [Uni Propus Window Double-ended Highlighter](https://dobutsustationery.com/products/uni-propus-window-highlighter) | 13 / 15 | Yes | No | 71 |
| 1 | [Amifa Floral Sealing Stickers (21)](https://dobutsustationery.com/products/amifa-floral-sealing-stickers-21-4542804125610) | 12 / 12 | Yes | Yes | 24 |
| 1 | [Amifa Kawaii Yummy Flake Stickers (15)](https://dobutsustationery.com/products/amifa-kawaii-yummy-flake-stickers-15-4542804141153) | 12 / 12 | Yes | Yes | 24 |
| 1 | [Amifa Sleepy Kawaii Animal Sticker Flakes (24)](https://dobutsustationery.com/products/amifa-sleepy-kawaii-animal-sticker-flakes-24-4542804166958) | 12 / 12 | Yes | Yes | 24 |
| 1 | [Kyowa Kawaii Lucky Neko Cat A6 Memo Pad (50)](https://dobutsustationery.com/products/kyowa-kawaii-lucky-neko-cat-a6-memo-pad-4969757176290) | 12 / 13 | Yes | No | 3 |
| 1 | [Amifa A5 Ruled Spiral Notebook with Band](https://dobutsustationery.com/products/amifa-a5-ruled-spiral-notebook-with-band-4542804135282) | 11 / 12 | Yes | No | 12 |
| 1 | [Kyowa Kawaii Lucky Neko Cat Envelopes (8)](https://dobutsustationery.com/products/kyowa-kawaii-lucky-neko-envelopes-8-4969757176269) | 10 / 10 | Yes | Yes | 46 |
| 1 | [Kyowa Sakurameguri Iyo Washi Envelopes (8)](https://dobutsustationery.com/products/kyowa-sakurameguri-iko-washi-envelopes-4969757172476) | 10 / 10 | Yes | Yes | 24 |
| 1 | [Kyowa Fresh Fruit Mini Cards (15)](https://dobutsustationery.com/products/kyowa-fresh-fruit-mini-cards-15-4969757173480) | 9 / 10 | Yes | No | 22 |
| 1 | [Kyowa Kawaii Lucky Neko Cat Iyo Washi Letter Paper (15)](https://dobutsustationery.com/products/kyowa-kawaii-lucky-neko-cat-iyo-washi-letter-paper-4969757176252) | 9 / 10 | Yes | No | 45 |
| 1 | [Kyowa Kawaii Lucky Neko Cat Mini Cards (15)](https://dobutsustationery.com/products/kyowa-kawaii-lucky-neko-cat-mini-cards-15-4969757176306) | 9 / 10 | Yes | No | 33 |
| 1 | [Nippon Japan Notebook (17.9 x 12.6 mm)](https://dobutsustationery.com/products/nippon-notebook-17-9-x-12-6-mm) | 9 / 9 | Yes | Yes | 11 |
| 1 | [Amifa A6 Mogu Mogu Spiral Dot Grid Notebook](https://dobutsustationery.com/products/amifa-a6-mogu-mogu-spiral-dot-grid-notebook-4542804166095) | 8 / 8 | Yes | Yes | 20 |
| 1 | [Amifa Chic Seasonal Girl Sticker Flakes (24)](https://dobutsustationery.com/products/amifa-chic-seasonal-girl-sticker-flakes-24-4542804169423) | 8 / 8 | Yes | Yes | 20 |
| 1 | [Amifa Fairy Tale Mini Sheet Stickers](https://dobutsustationery.com/products/amifa-fairy-tale-mini-sheet-stickers-4542804168471) | 8 / 8 | Yes | Yes | 12 |
| 1 | [Amifa French Romantic Sticker Flakes (30)](https://dobutsustationery.com/products/amifa-french-romantic-sticker-flakes-30-4542804133912) | 8 / 8 | Yes | Yes | 24 |
| 1 | [Amifa Kawaii Knitting Animal Flake Stickers](https://dobutsustationery.com/products/amifa-kawaii-knitting-animal-flake-stickers-4542804169447) | 8 / 8 | Yes | Yes | 20 |
| 1 | [Amifa Kawaii Lounging Animal Stickers (32)](https://dobutsustationery.com/products/amifa-kawaii-lounging-animal-stickers-32-4542804166941) | 8 / 8 | Yes | Yes | 24 |
| 1 | [Amifa Kawaii Marmut/Chinchilla Holographic Flake Stickers (24)](https://dobutsustationery.com/products/amifa-kawaii-marmut-chinchilla-holographic-flake-stickers-24-4542804170351) | 8 / 8 | Yes | Yes | 10 |
| 1 | [Amifa Masterpiece Double Spiral A5 Notebook](https://dobutsustationery.com/products/amifa-masterpiece-double-spiral-a5-notebook-4542804119084) | 8 / 8 | Yes | Yes | 24 |
| 1 | [Amifa Panda & Cat Magnetic Bookmarks (6)](https://dobutsustationery.com/products/amifa-panda-cat-magnetic-bookmarks-6-4542804162318) | 8 / 8 | Yes | Yes | 20 |
| 1 | [Amifa Slice of Life Sticker Flakes (24)](https://dobutsustationery.com/products/amifa-slice-of-life-sticker-flakes-24-4542804157529) | 8 / 8 | Yes | Yes | 20 |
| 1 | [Kyowa Kawaii Lucky Neko Cat Envelopes Mini Envelopes (8)](https://dobutsustationery.com/products/kyowa-japanese-lucky-cat-envelopes-mini-envelopes-8-4969757176313) | 8 / 10 | Yes | No | 36 |
| 1 | [Pilot ILMILY 0.5mm Nuance Black LILRF Refill](https://dobutsustationery.com/products/pilot-ilmily-nuance-black-05mm-lilrf-refills) | 8 / 8 | Yes | Yes | 99 |
| 1 | [Uni Hahatoco 2B Pencils (8)](https://dobutsustationery.com/products/mitsubishi-hahatoco-2b-pencils-12) | 8 / 8 | Yes | Yes | 20 |
| 1 | [Amifa Chinoiserie Floral Sticky Notes (40)](https://dobutsustationery.com/products/amifa-chinoiserie-floral-sticky-notes-40-4542804126785) | 7 / 7 | Yes | Yes | 24 |
| 1 | [Amifa Peeking Pals Clear Stamp Set](https://dobutsustationery.com/products/amifa-peeking-pals-clear-stamp-set-4542804166729) | 7 / 7 | Yes | Yes | 24 |
| 1 | [Amifa Transparent Moon & Star Wall Stickers (94)](https://dobutsustationery.com/products/amifa-moon-and-star-wall-stickers-4542804115635) | 7 / 7 | Yes | Yes | 35 |
| 1 | [Kyowa Kawaii Puppy Dog Love & Fur](https://dobutsustationery.com/products/kyowa-kawaii-puppy-dog-love-fur-4969757173350) | 7 / 12 | Yes | No | 43 |
| 1 | [Amifa Flying Squirrel Clear A4 3-Pocket Clear Document Folder](https://dobutsustationery.com/products/amifa-flying-squirrel-clear-a4-3-pocket-document-folder-4542804143126) | 6 / 6 | Yes | Yes | 9 |
| 1 | [Amifa Masterpiece Collection A4 Collage Paper (8/15)](https://dobutsustationery.com/products/amifa-masterpiece-collection-a4-collage-paper-8-15-4542804123555) | 6 / 6 | Yes | Yes | 34 |
| 1 | [Furukawa Kawaii Neko Cat Sticky Notes (40)](https://dobutsustationery.com/products/furukawa-kawaii-neko-cat-sticky-notes) | 6 / 6 | Yes | Yes | 4 |
| 1 | [King Jim Acrylic Animal Ice Cube Stamps (6)](https://dobutsustationery.com/products/king-jim-acrylic-animal-stamp-set) | 6 / 6 | Yes | Yes | 19 |
| 1 | [Pilot Juice Up Classic Glossy 0.4mm Gel Pen](https://dobutsustationery.com/products/pilot-juice-up-classic-glossy-0-4-individual) | 6 / 6 | Yes | Yes | 23 |
| 1 | [Amifa Masterpiece Collection Clear 3-Pocket A4 Folder](https://dobutsustationery.com/products/amifa-masterpiece-collection-clear-3-pocket-a4-folder-4542804119831) | 5 / 5 | Yes | Yes | 22 |
| 1 | [Amifa Retro Tulip Clear 3-Pocket A4 Document File](https://dobutsustationery.com/products/amifa-retro-tulip-clear-a4-file-4542804118100) | 5 / 5 | Yes | Yes | 22 |
| 1 | [PLUS Twiggy Capless Pocket Scissors](https://dobutsustationery.com/products/plus-twiggy-capless-pocket-scissors) | 5 / 6 | Yes | No | 30 |
| 1 | [Uni Jetstream Ballpoint Pen](https://dobutsustationery.com/products/uni-jetstream-ballpoint-pen) | 5 / 5 | Yes | Yes | 17 |
| 1 | [Amifa Square Holographic Sticker Sheets(6)](https://dobutsustationery.com/products/amifa-square-holographic-sticker-sheets-6-4542804169690) | 4 / 4 | Yes | Yes | 20 |
| 1 | [Amifa Water-Based Double Tip Pen Gradient Colors](https://dobutsustationery.com/products/amifa-water-based-double-tip-pen-gradient-colors-4542804147421) | 4 / 5 | Yes | No | 11 |
| 1 | [Kyowa Fluffy Momonga Flying Squirrel Mini Sticky Notes (75)](https://dobutsustationery.com/products/kyowa-fluffy-momonga-flying-squirrel-mini-sticky-notes-75-4969757172124) | 4 / 5 | Yes | No | 33 |
| 1 | [Pilot Juice Up Classic Glossy 0.5mm 6-Color Set](https://dobutsustationery.com/products/pilot-juice-up-classic-glossy-0-5mm-6-color-set-4902505632297) | 4 / 4 | Yes | Yes | 10 |
| 1 | [Pilot Juice+ Synergy Tip Gel Pen Set (8 colours)](https://dobutsustationery.com/products/pilot-juice-synergy-tip-gel-pen-set-8-colours-4902505693380) | 4 / 4 | Yes | Yes | 10 |
| 1 | [Seal Do Washi Masking Tape Neko Cats Kawaii (15mm)](https://dobutsustationery.com/products/seal-do-washi-tape-neko-cats-kawaii-4582608265532) | 4 / 4 | Yes | Yes | 17 |
| 1 | [Uni-ball One Smooth Gel Pen](https://dobutsustationery.com/products/uniball-one-smooth-ballpoint-pen) | 4 / 4 | Yes | Yes | 12 |
| 1 | [Uniball Zento Premium Metal 0.5mm Ballpoint Pen + 2 refills](https://dobutsustationery.com/products/uniball-zento-premium-metal-0-5mm) | 4 / 4 | Yes | Yes | 20 |
| 1 | [Uniball Zento Standard 0.5mm Ballpoint Pen + 1 refill](https://dobutsustationery.com/products/uniball-zento-standard) | 4 / 4 | Yes | Yes | 20 |
| 1 | [2027 Kawaii Animal Desk Calendar](https://dobutsustationery.com/products/amifa-2027-kawaii-animal-desk-calendar-4542804169317) | 3 / 3 | Yes | Yes | 20 |
| 1 | [Amifa Autumn Glow Transparent Origami/Design Paper](https://dobutsustationery.com/products/amifa-autumn-glow-transparent-origami-design-paper-4542804155006) | 3 / 3 | Yes | Yes | 10 |
| 1 | [Amifa Decorative Paper Set — Typography Themes](https://dobutsustationery.com/products/amifa-decorative-paper-typography-4542804115932) | 3 / 6 | Yes | No | 38 |
| 1 | [Amifa Fluffy Shima-Enaga A4 Clipboard](https://dobutsustationery.com/products/amifa-fluffy-shima-enaga-a4-clipboard-4542804140941) | 3 / 5 | Yes | No | 19 |
| 1 | [Amifa Moon and Sky Wall Stickers (Large)](https://dobutsustationery.com/products/amifa-moon-and-sky-wall-stickers) | 3 / 6 | Yes | No | 7 |
| 1 | [Amifa Strawberry Bear Puffy Flakes (15)](https://dobutsustationery.com/products/amifa-strawberry-bear-puffy-flakes-15-4542804156775) | 3 / 3 | Yes | Yes | 10 |
| 1 | [Furukawa Mini Washi Paper Letter Set](https://dobutsustationery.com/products/furukawa-mini-washi-paper-letter-set) | 3 / 15 | Yes | No | 8 |
| 1 | [Kawaii Baby Animal Stickers (45)](https://dobutsustationery.com/products/kawaii-baby-animal-stickers-45-4542804167085) | 3 / 15 | Yes | No | 24 |
| 1 | [Lucky Cat Mini Envelopes](https://dobutsustationery.com/products/lucky-cat-mini-envelopes-4952270198948) | 3 / 3 | Yes | Yes | 6 |
| 1 | [MD Midori A5 Daily Dot Grid Journal 368 Pages 15313006](https://dobutsustationery.com/products/md-a5-daily-dot-grid-journal-15313006-4902805153133) | 3 / 3 | Yes | Yes | 7 |
| 1 | [Tomoe River A5 Dot Grid Notebook](https://dobutsustationery.com/products/tomoe-river-a5-dot-grid-notebook-4909171852516) | 3 / 3 | Yes | Yes | 20 |
| 1 | [Uniball One 0.5mm Rose Gold Clip Ballpoint Pen](https://dobutsustationery.com/products/uniball-one-smooth-gel-rose-gold) | 3 / 3 | Yes | Yes | 20 |
| 1 | [Zebra Sarasa Nano Vintage 0.38mm Gel Pens](https://dobutsustationery.com/products/zebra-sarasa-nano-vintage-0-38mm-gel-pens-4901681482580) | 3 / 3 | Yes | Yes | 10 |
| 1 | [Amifa Fuwafuwa Kawaii Marmot/Chinchilla Sheet Stickers (33)](https://dobutsustationery.com/products/amifa-fuwafuwa-kawaii-marmot-chinchilla-stickers-33-4542804170368) | 2 / 6 | Yes | No | 10 |
| 1 | [Amifa Kawaii Felt Monster Stickers (15)](https://dobutsustationery.com/products/amifa-felt-kawaii-monster-stickers-15-4542804169621) | 2 / 2 | Yes | Yes | 20 |
| 1 | [Furukawa Working Neko Cat Sticky Notes (30)](https://dobutsustationery.com/products/furukawa-working-neko-cat-sticky-notes-30-4952270242559) | 2 / 2 | Yes | Yes | 19 |
| 1 | [King Jim Acrylic Maltese Dog Ice Cube Stamp](https://dobutsustationery.com/products/king-jim-acrylic-maltese-dog-ice-cube-stamp-4971660061617) | 2 / 2 | Yes | Yes | 9 |
| 1 | [Kyowa White Iyo Washi Letter Set](https://dobutsustationery.com/products/kyowa-white-iyo-washi-letter-set-4969757174418) | 2 / 2 | Yes | Yes | 36 |
| 1 | [MD Midori Notebook A5 Blank: For Your Ideas 176 Pages 15293006](https://dobutsustationery.com/products/md-notebook-a5-blank-for-your-ideas-4902805152938) | 2 / 2 | Yes | Yes | 9 |
| 1 | [PLUS Twiggy Pocket Scissors](https://dobutsustationery.com/products/plus-twiggy-pocket-scissors) | 2 / 7 | Yes | No | 41 |
| 1 | [UNI Posca New Colours Marker Set (6)](https://dobutsustationery.com/products/uni-posca-new-colours-marker-set-6-4902778654071) | 2 / 3 | Yes | No | 10 |
| 1 | [Uni Kuru Toga 0.3mm Auto-Sharpening Mechanical Pencil](https://dobutsustationery.com/products/unit-kuru-toga-0-3mm-auto-sharpening-mechanical-pencil-4902778028216) | 2 / 2 | Yes | Yes | 19 |
| 1 | [Uni-ball One 0.5mm Metallic Pens (3)](https://dobutsustationery.com/products/uni-ball-one-0-5mm-metallic-pens-3-4902778319642) | 2 / 2 | Yes | Yes | 8 |
| 1 | [Zebra Sarasa R 0.4 Ballpoint Pen](https://dobutsustationery.com/products/zebra-sarasa-r-04mm-ballpoint-pen) | 2 / 16 | Yes | No | 62 |
| 1 | [Furukawa Mino Washi Dog Washi Letter Set](https://dobutsustationery.com/products/furukawa-mino-washi-dog-washi-letter-set-4952270258031) | 1 / 2 | Yes | No | 1 |
| 1 | [Uni-ball One Limited Edition Fika 0.38 Ballpoint Pen Set (8)](https://dobutsustationery.com/products/uni-ball-one-limited-eidtion-fika-pen-set-8-fika-color-8-color-gel-pen-set-4902778319697) | 1 / 2 | Yes | No | 10 |
| 2 | [Kyowa Kawaii Puppy Dog Love & Fur Mini Cards (30)](https://dobutsustationery.com/products/kyowa-kawaii-puppy-dog-love-fur-mini-cards-30-4969757171820) | 8 / 10 | No | No | 41 |
| 2 | [Senshu Motif Line Roller Markers (2)](https://dobutsustationery.com/products/senshu-motif-line-roller-markers-2) | 7 / 12 | No | No | 60 |
| 2 | [2027 Shima Enaga Good Fortune  Calendar (A4)](https://dobutsustationery.com/products/2027-shima-enaga-good-fortune-calendar-a4-4542804169263) | 5 / 7 | No | No | 20 |
| 2 | [Journalling Starter Kit](https://dobutsustationery.com/products/journalling-starter-kit) | 5 / 63 | No | No | 100 |
| 2 | [Amifa Chic Seasonal Girl Sheet Stickers (15)](https://dobutsustationery.com/products/amifa-seasonal-girl-stickers-15-4542804169416) | 4 / 6 | No | No | 20 |
| 2 | [Uni Double-ended Propus Window Highlighter Set — 5 Colours](https://dobutsustationery.com/products/uni-propus-window-highlighter-set) | 4 / 10 | No | No | 27 |
| 2 | [Amifa Kawaii Cat & Dog Planner Stickers (150)](https://dobutsustationery.com/products/amifa-kawaii-planner-stickers-150-4542804154290) | 3 / 8 | No | No | 28 |
| 2 | [Amifa Shimmer Metallic Markers 3-Pack](https://dobutsustationery.com/products/amifa-shimmer-metallic-markers-3-pack-4542804163131) | 3 / 7 | No | No | 36 |
| 2 | [Amifa Shinkansen Clear A4 Document File](https://dobutsustationery.com/products/amifa-shinkansen-clear-a4-file-4542804144598) | 3 / 5 | No | No | 20 |
| 2 | [Amifa Zodiac Mini Letter Set](https://dobutsustationery.com/products/amifa-zodiac-mini-card-set-4542804130904) | 3 / 6 | No | No | 41 |
| 2 | [Kawaii Animals B5 Kanji Drill Book](https://dobutsustationery.com/products/kanji-drill-book-b5) | 3 / 10 | No | No | 40 |
| 2 | [Kyowa Kawaii Lucky Neko Cat Cash Gift Envelopes (3)](https://dobutsustationery.com/products/kyowa-kawaii-lucky-neko-cat-envelopes-3-4969757176320) | 3 / 16 | No | No | 48 |
| 2 | [Zebra Clickart Marker Set — 12 Colours](https://dobutsustationery.com/products/zebra-clickart-12-color-marker-set) | 3 / 11 | No | No | 36 |
| 2 | [Amifa Custom Note Frame Stickers (48)](https://dobutsustationery.com/products/amifa-custom-note-frame-stickers-4542804085181) | 2 / 5 | No | No | 8 |
| 2 | [Amifa Toile de Jouy Sticky Notes (80)](https://dobutsustationery.com/products/amifa-toile-de-jouy-sticky-notes-4542804114294) | 2 / 4 | No | No | 9 |
| 2 | [Campus A5 Weekly Study Planner](https://dobutsustationery.com/products/campus-a5-weekly-study-planner-4901480349510) | 2 / 5 | No | No | 7 |
| 2 | [Japanese Neko Cat Stationery Mystery Pack](https://dobutsustationery.com/products/japanese-neko-cat-stationery-mystery-pack) | 2 / 14 | No | No | 24 |
| 2 | [Uni Kuru Toga 0.5mm Auto-Sharpening Mechanical Pencil](https://dobutsustationery.com/products/uni-kuru-toga-0-5mm-mechanical-pencil) | 2 / 11 | No | No | 46 |
| 2 | [Amifa Kawaii Animal Planner Break Stickers (47)](https://dobutsustationery.com/products/amifa-kawaii-animal-planner-break-stickers-47-4542804168068) | 1 / 6 | No | No | 20 |
| 2 | [Amifa Kawaii Oshikatsu Schedule Stickers (55)](https://dobutsustationery.com/products/amifa-kawaii-oshikatsu-schedule-stickers-55-4542804168075) | 1 / 6 | No | No | 20 |
| 2 | [Amifa Kawaii Puffy Animal Stickers](https://dobutsustationery.com/products/amifa-kawaii-puffy-animal-stickers-4542804154962) | 1 / 8 | No | No | 24 |
| 2 | [Furukawa Dog Fine Washi Paper Letter Set](https://dobutsustationery.com/products/furukawa-dog-fine-washi-paper-letter-set-4952270302482) | 1 / 2 | No | No | 8 |
| 2 | [Puffy Mofutto Monster Stickers](https://dobutsustationery.com/products/puffy-mofutto-monster-stickers-4542804170016) | 1 / 2 | No | No | 20 |
| 3 | [Amifa Birds & Blooms Paper Napkins](https://dobutsustationery.com/products/amifa-birds-blooms-paper-napkins-4542804127652) | 5 / 5 | Yes | Yes | 0 |
| 3 | [Amifa Advent Bear Stickers (24)](https://dobutsustationery.com/products/amifa-advent-bear-stickers-24-4542804125320) | 3 / 5 | No | No | 12 |
| 3 | [Dobutsu Sakura Precious Memories Message Board](https://dobutsustationery.com/products/dobutsu-sakura-precious-memories-message-board-4542804112894) | 3 / 5 | Yes | No | 0 |
| 3 | [Furukawa Mino Washi Neko Cat Letter Set](https://dobutsustationery.com/products/furukawa-mino-washi-neko-cat-letter-set-4952270258055) | 2 / 2 | Yes | Yes | 0 |
| 3 | [Uni Jetstream 0.7mm Ballpoint Pen](https://dobutsustationery.com/products/uni-jetstream-0-7mm-ballpoint-pen-4902778134955) | 1 / 2 | Yes | No | 0 |

## Evidence files

All files are in [photo-resolution-audit-2026-10-26](photo-resolution-audit-2026-10-26/).

- [Affected products](photo-resolution-audit-2026-10-26/affected-products.csv): 104 products, repair priority, publication/stock context, lead image and gallery impact.
- [Low-resolution images](photo-resolution-audit-2026-10-26/low-resolution-images.csv): all 540 image records, live CDN URLs, dimensions, source IDs, evidence classification, event IDs, and available lineage.
- [All Shopify images](photo-resolution-audit-2026-10-26/all-shopify-images.csv): complete 2,843-image inventory; blank measured dimensions mean not downloaded in this audit.
- [Medium-resolution review](photo-resolution-audit-2026-10-26/medium-resolution-review.csv): seven images.
- [Larger images with thumbnail history](photo-resolution-audit-2026-10-26/large-images-with-thumbnail-history.csv): separate watchlist, not confirmed visually degraded.
- [Thumbnail source copies](photo-resolution-audit-2026-10-26/thumbnail-source-copies.csv): measured historical source files and whether their photo IDs link to current Shopify images.
- [Machine-readable summary](photo-resolution-audit-2026-10-26/summary.json).

## Limitations

Original Google Photos dimensions are recorded metadata, not newly downloaded original files. Direct ancestry is incomplete for some manual edits. We did not visually inspect all 2,843 images or prove that every image above 1024 pixels is sharp. This audit covers product media in the current Shopify catalogue, not theme assets, deleted Shopify products, every historical image version, or newly arriving changes after the snapshot. Historical source-file findings do not mean all 584 photo IDs are still selected or published.
