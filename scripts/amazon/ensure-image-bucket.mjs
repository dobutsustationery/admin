// Provision the dedicated public cache of Amazon delivery images. It must never
// hold originals or private documents. Run with an explicitly selected project:
// direnv exec . node scripts/amazon/ensure-image-bucket.mjs PROJECT storage-admin-credential.json [worker-service-account]
import { readFile } from "node:fs/promises";
import { initializeApp, cert } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";
const [projectId, credentialPath, writerEmail] = process.argv.slice(2);
if (!projectId || !credentialPath)
  throw Error("Supply PROJECT and credential.json.");
try {
  const credential = JSON.parse(await readFile(credentialPath, "utf8"));
  if (credential.project_id !== projectId)
    throw Error("Credential project does not match the selected project.");
  initializeApp({ projectId, credential: cert(credential) });
  const bucket = getStorage().bucket(`${projectId}-amazon-images`);
  if (!(await bucket.exists())[0])
    await bucket.create({
      location: "US-CENTRAL1",
      storageClass: "STANDARD",
      iamConfiguration: { uniformBucketLevelAccess: { enabled: true } },
    });
  const [policy] = await bucket.iam.getPolicy({ requestedPolicyVersion: 3 });
  policy.bindings ||= [];
  const desired = [
    { role: "roles/storage.objectViewer", member: "allUsers" },
    ...(writerEmail
      ? [
          {
            role: "roles/storage.objectAdmin",
            member: `serviceAccount:${writerEmail}`,
          },
        ]
      : []),
  ];
  let changed = false;
  for (const { role, member } of desired)
    if (
      !policy.bindings.some(
        (b) => b.role === role && b.members?.includes(member),
      )
    ) {
      policy.bindings.push({ role, members: [member] });
      changed = true;
    }
  if (changed) await bucket.iam.setPolicy(policy);
  console.log(`Amazon delivery image bucket ready: ${bucket.name}`);
} catch (error) {
  console.error(
    `Image bucket setup failed: ${error.code || ""} ${String(error.message).split("\n")[0]}`,
  );
  process.exitCode = 1;
}
