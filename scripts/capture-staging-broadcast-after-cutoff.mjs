/**
 * Capture (back up) every staging broadcast doc whose timestamp is AFTER the
 * production-backup cutoff, so they can be deleted to reset staging to the
 * backup state. Writes a file in the shape delete-staging-broadcast-from-backup
 * expects: { cutoff, collections.broadcast.documents:[{id,data}] }.
 *
 * Usage:
 *   node scripts/capture-staging-broadcast-after-cutoff.mjs [out.json]
 */
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

// Cutoff = max timestamp in ../production-backup-jun-11 (the backup's last doc:
// shopify_order_reconciled:13392027353470:2026-06-11T17:04:05+03:00).
const CUTOFF_SECONDS = 1781186781;
const CUTOFF_NANOS = 164000000;
const cutoff = new Timestamp(CUTOFF_SECONDS, CUTOFF_NANOS);
const outPath = process.argv[2] || "staging-after-cutoff-backup.json";

const keyPath = resolve(process.cwd(), "service-account-staging.json");
if (!existsSync(keyPath)) {
  console.error(`Service account key not found: ${keyPath}`);
  process.exit(1);
}
const db = getFirestore(
  initializeApp(
    { credential: cert(JSON.parse(readFileSync(keyPath, "utf8"))) },
    "capture-staging-broadcast",
  ),
);

const total = (await db.collection("broadcast").count().get()).data().count;
const snap = await db
  .collection("broadcast")
  .where("timestamp", ">", cutoff)
  .get();

const documents = [];
snap.forEach((doc) => documents.push({ id: doc.id, data: doc.data() }));

const out = {
  capturedAt: new Date().toISOString(),
  cutoff: { _seconds: CUTOFF_SECONDS, _nanoseconds: CUTOFF_NANOS },
  collections: { broadcast: { documents } },
};
writeFileSync(outPath, JSON.stringify(out, null, 2));

console.log(`Cutoff: ${cutoff.toDate().toISOString()}`);
console.log(`Staging broadcast total: ${total}`);
console.log(`After-cutoff docs captured: ${documents.length}`);
console.log(`Expected staging total after delete: ${total - documents.length}`);
console.log(`Wrote ${outPath}`);
process.exit(0);
