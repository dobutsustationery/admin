import {
  collection,
  doc,
  serverTimestamp,
  writeBatch,
  type Firestore,
} from "firebase/firestore";
export async function findAmazonOfferMatches(
  db: Firestore,
  creator: string,
  jans: string[],
) {
  const keys = [...new Set(jans)].filter((jan) => /^\d{13}$/.test(jan));
  if (!keys.length) throw Error("No valid JAN codes to search.");
  if (keys.length > 8000) throw Error("Select fewer products for this search.");
  const batch = writeBatch(db);
  const requestIds: string[] = [];
  for (let i = 0; i < keys.length; i += 20) {
    const ref = doc(collection(db, "request_amazon_catalog_probe"));
    requestIds.push(ref.id);
    batch.set(ref, {
      creator,
      eventType: "amazon/catalog_probe_requested",
      jans: keys.slice(i, i + 20),
      includeSellerListings: false,
      source: "amazon-offer-preparation",
      createdAt: serverTimestamp(),
    });
  }
  await batch.commit();
  return { count: keys.length, requestIds };
}
