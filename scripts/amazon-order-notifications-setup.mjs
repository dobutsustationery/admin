// Register an existing, SP-API-enabled SQS queue. Run through direnv with AWS credentials/profile.
// Queue provisioning and its SendMessage policy are documented in docs/ops/amazon-orders.md.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../functions/package.json", import.meta.url),
);
const { SQSClient, GetQueueAttributesCommand } = require("@aws-sdk/client-sqs");
const env = Object.fromEntries(
  (await readFile(".env.amazon", "utf8")).split(/\r?\n/).flatMap((line) => {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/);
    return m ? [[m[1], m[2].trim().replace(/^(['"])(.*)\1$/, "$2")]] : [];
  }),
);
const value = (name) => process.env[name] || env[name] || "";
const queueUrl = value("AMAZON_ORDERS_SQS_QUEUE_URL");
if (!queueUrl)
  throw Error("Set AMAZON_ORDERS_SQS_QUEUE_URL in .env.amazon first");
const sqs = new SQSClient({
  region: value("AMAZON_ORDERS_SQS_REGION") || "eu-west-1",
  ...(value("AMAZON_ORDERS_SQS_ACCESS_KEY_ID")
    ? {
        credentials: {
          accessKeyId: value("AMAZON_ORDERS_SQS_ACCESS_KEY_ID"),
          secretAccessKey: value("AMAZON_ORDERS_SQS_SECRET_ACCESS_KEY"),
        },
      }
    : {}),
});
const attrs = await sqs.send(
  new GetQueueAttributesCommand({
    QueueUrl: queueUrl,
    AttributeNames: ["QueueArn"],
  }),
);
const arn = attrs.Attributes.QueueArn;
const token = async (grantless) => {
  const r = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: grantless ? "client_credentials" : "refresh_token",
      client_id: value("AMAZON_LWA_CLIENT_ID"),
      client_secret: value("AMAZON_LWA_CLIENT_SECRET"),
      ...(grantless
        ? { scope: "sellingpartnerapi::notifications" }
        : { refresh_token: value("AMAZON_LWA_REFRESH_TOKEN") }),
    }),
  });
  if (!r.ok) throw Error("LWA token request failed HTTP " + r.status);
  return (await r.json()).access_token;
};
const call = async (path, accessToken, body) => {
  const r = await fetch(
    "https://sellingpartnerapi-eu.amazon.com/notifications/v1" + path,
    {
      method: body ? "POST" : "GET",
      headers: {
        "x-amz-access-token": accessToken,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
  const data = await r.json();
  if (r.status === 404) return null;
  if (!r.ok)
    throw Error(
      `Notifications API HTTP ${r.status}: ${JSON.stringify(data.errors)}`,
    );
  return data.payload;
};
const grantless = await token(true);
const destinations = await call("/destinations", grantless);
let destination = (destinations || []).find(
  (d) => d.resource?.sqs?.arn === arn,
);
if (!destination)
  destination = await call("/destinations", grantless, {
    name: "dobutsu-amazon-orders",
    resourceSpecification: { sqs: { arn } },
  });
const sellerToken = await token(false);
const existing = await call("/subscriptions/ORDER_CHANGE", sellerToken);
if (existing && existing.destinationId !== destination.destinationId)
  throw Error(
    "An ORDER_CHANGE subscription already targets another destination; left unchanged",
  );
const subscription =
  existing ||
  (await call("/subscriptions/ORDER_CHANGE", sellerToken, {
    payloadVersion: "1.0",
    destinationId: destination.destinationId,
    processingDirective: {
      eventFilter: {
        eventFilterType: "ORDER_CHANGE",
        orderChangeTypes: ["OrderStatusChange", "BuyerRequestedChange"],
      },
    },
  }));
console.log(
  JSON.stringify({
    destinationId: destination.destinationId,
    subscriptionId: subscription.subscriptionId,
    queueArn: arn,
  }),
);
