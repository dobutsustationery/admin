/**
 * Delete broadcast actions from staging Firestore by id, using a backup file
 * produced beforehand as the authoritative list of what to remove.
 *
 * Safety:
 *  - Dry-run by default; pass --confirm to actually delete.
 *  - Only deletes document ids that appear in the backup file.
 *  - Before deleting each id, re-reads the live doc and refuses to delete
 *    anything whose timestamp is at or before the backup's recorded cutoff
 *    (so a stray id can never wipe a pre-cutoff action).
 *
 * Usage:
 *   node scripts/delete-staging-broadcast-from-backup.mjs <backup.json> [--confirm]
 */
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const backupPath = process.argv[2];
const confirm = process.argv.includes("--confirm");

if (!backupPath) {
  console.error(
    "Usage: node scripts/delete-staging-broadcast-from-backup.mjs <backup.json> [--confirm]",
  );
  process.exit(1);
}
if (!existsSync(backupPath)) {
  console.error(`Backup file not found: ${backupPath}`);
  process.exit(1);
}

const backup = JSON.parse(readFileSync(backupPath, "utf8"));
const docs = backup?.collections?.broadcast?.documents || [];
const ids = docs.map((d) => d.id);
if (ids.length === 0) {
  console.error("Backup contains no broadcast documents; nothing to delete.");
  process.exit(1);
}
const cutoff = backup?.cutoff
  ? new Timestamp(backup.cutoff._seconds, backup.cutoff._nanoseconds)
  : null;

const keyPath = resolve(process.cwd(), "service-account-staging.json");
if (!existsSync(keyPath)) {
  console.error(`Service account key not found: ${keyPath}`);
  process.exit(1);
}
const db = getFirestore(
  initializeApp(
    { credential: cert(JSON.parse(readFileSync(keyPath, "utf8"))) },
    "delete-staging-broadcast",
  ),
);

console.log(`Backup: ${backupPath}`);
console.log(`Documents in backup: ${ids.length}`);
console.log(
  `Cutoff: ${cutoff ? cutoff.toDate().toISOString() : "(none — timestamp guard disabled)"}`,
);
console.log(`Mode: ${confirm ? "DELETE" : "DRY RUN (pass --confirm to delete)"}`);
console.log("");

const toDelete = [];
let missing = 0;
let beforeCutoff = 0;

for (const id of ids) {
  const ref = db.collection("broadcast").doc(id);
  const snap = await ref.get();
  if (!snap.exists) {
    missing++;
    continue;
  }
  const ts = snap.get("timestamp");
  if (cutoff && ts instanceof Timestamp && ts.toMillis() <= cutoff.toMillis()) {
    console.error(
      `REFUSING ${id}: timestamp ${ts.toDate().toISOString()} is at/before cutoff`,
    );
    beforeCutoff++;
    continue;
  }
  toDelete.push(ref);
}

console.log(`Resolved: ${toDelete.length} to delete, ${missing} already absent`);
if (beforeCutoff > 0) {
  console.error(
    `ABORT: ${beforeCutoff} doc(s) are at/before the cutoff. Refusing to proceed.`,
  );
  process.exit(2);
}

if (!confirm) {
  console.log("\nDry run only. Re-run with --confirm to delete.");
  process.exit(0);
}

// One commit per 400 (well under the 500 batch limit).
let deleted = 0;
for (let i = 0; i < toDelete.length; i += 400) {
  const batch = db.batch();
  const slice = toDelete.slice(i, i + 400);
  slice.forEach((ref) => batch.delete(ref));
  await batch.commit();
  deleted += slice.length;
  console.log(`Deleted ${deleted}/${toDelete.length}`);
}

const remaining = await db.collection("broadcast").count().get();
console.log(`\nDone. Deleted ${deleted} doc(s).`);
console.log(`staging broadcast total now: ${remaining.data().count}`);
process.exit(0);
