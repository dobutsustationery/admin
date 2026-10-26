import {
  preparationScope,
  preparationDraftScope,
  type PreparationState,
} from "./amazon-preparation";

// Reuse only saved pricing; unrelated legacy draft decisions remain unapplied.
export function offerReviewPricing(
  prep: PreparationState,
  seller: string,
  owner: string,
) {
  const active = prep.policies[preparationScope(seller)]?.gbpPerEur;
  const saved = prep.drafts[preparationDraftScope(seller, owner)]?.gbpPerEur;
  const value = Number(active) > 0 ? active : Number(saved) > 0 ? saved : "";
  return {
    factor: value,
    prep: value
      ? {
          ...prep,
          policies: {
            ...prep.policies,
            [preparationScope(seller)]: { gbpPerEur: value },
          },
        }
      : prep,
  };
}

export function localOfferImage(
  row: { key: string; jan: string; family: string; sharedJan: boolean },
  inventory: any,
  listings: any,
  photos: any,
) {
  const item = inventory?.idToItem?.[row.key];
  if (item?.image) return { url: item.image, label: "Our variant photo" };
  const photo = (key: string) =>
    (photos?.janCodeToPhotos?.[key] || [])
      .map((p: any) => photos?.registry?.[p.id] || p)
      .find((p: any) => p.baseUrl)?.baseUrl;
  const variantPhoto =
    row.key !== row.jan || !row.sharedJan ? photo(row.key) : "";
  if (variantPhoto) return { url: variantPhoto, label: "Our variant photo" };
  const barcodePhoto = photo(row.jan);
  if (barcodePhoto)
    return {
      url: barcodePhoto,
      label: row.sharedJan
        ? "Our shared-barcode photo - check variant"
        : "Our product photo",
    };
  const gallery = [...(listings?.handleToListing?.[row.family]?.images || [])]
    .sort((a, b) => a.position - b.position)
    .find((i) => i.url);
  return gallery
    ? { url: gallery.url, label: "Our product gallery - check variant" }
    : { url: "", label: "Our photo unavailable" };
}
