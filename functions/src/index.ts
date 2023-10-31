import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
//import { CollectionReference, DocumentData } from "firebase-admin/firestore";

// TODO: hit real API
const base = "https://api-m.sandbox.paypal.com";
const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = process.env;

admin.initializeApp();

/*
async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
*/

// post utility function
/*
async function post(url: string, data: any): Promise<any> {
  for (let retries = 0; retries < 5; ++retries) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        redirect: "follow",
        referrerPolicy: "no-referrer",
        body: new URLSearchParams(data).toString(),
      });
      return response.json();
    } catch (err) {
      console.log(`Caught ${JSON.stringify(err)} attempt ${retries}`);
      await sleep(200);
      if (retries < 5) continue;
      throw err;
    }
  }
}
*/

/**
 * Generate an OAuth 2.0 access token for authenticating with
 * PayPal REST APIs.
 *
 * @see https://developer.paypal.com/api/rest/authentication/
 */
const generateAccessToken = async () => {
  try {
    if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
      throw new Error("MISSING_API_CREDENTIALS");
    }
    const auth = Buffer.from(
      PAYPAL_CLIENT_ID + ":" + PAYPAL_CLIENT_SECRET
    ).toString("base64");
    const response = await fetch(`${base}/v1/oauth2/token`, {
      method: "POST",
      body: "grant_type=client_credentials",
      headers: {
        Authorization: `Basic ${auth}`,
      },
    });

    const data = await response.json();
    return data.access_token;
  } catch (error) {
    console.error("Failed to generate Access Token:", error);
  }
};

async function handleResponse(response: Response) {
  try {
    const jsonResponse = await response.json();
    return {
      jsonResponse,
      httpStatusCode: response.status,
    };
  } catch (err) {
    const errorMessage = await response.text();
    throw new Error(errorMessage);
  }
}

/**
 * Create an order to start the transaction.
 *
 * @see https://developer.paypal.com/docs/api/orders/v2/#orders_create
 */
const paypalOrder = async (cart: any) => {
  // use the cart information passed from the front-end to calculate the purchase unit details
  console.log("shopping cart specifies: ", cart, cart[0], cart[0].cost);

  const accessToken = await generateAccessToken();
  const url = `${base}/v2/checkout/orders`;
  const products = [
    {
	  name: "Advent Calendar",
      productCode: "advent-2023",
      basePrice: 75,
      discount: 0,
      quantity: 1,
      subtotal: 75,
      shipping: 27,
      grandTotal: 102,
    },
    {
	  name: "Journaling Pack",
      productCode: "single-journaling",
      basePrice: 27,
      discount: 0,
      quantity: 1,
      subtotal: 27,
      shipping: 9,
      grandTotal: 36,
    },
    {
	  name: "Stationery Pack",
      productCode: "single-stationery",
      basePrice: 28,
      discount: 0,
      quantity: 1,
      subtotal: 28,
      shipping: 9,
      grandTotal: 37,
    },
    {
	  name: "Journaling Pack",
      productCode: "subscribe-journaling",
      basePrice: 27,
      discount: 0.1,
      quantity: 3,
      subtotal: 72.9,
      shipping: 27,
      grandTotal: 99.9,
    },
    {
	  name: "Stationery Pack",
      productCode: "subscribe-stationery",
      basePrice: 28,
      discount: 0.1,
      quantity: 3,
      subtotal: 75.6,
      shipping: 27,
      grandTotal: 102.6,
    },
  ];
  const selectedItem = products.filter((x) => {
    return x.productCode === cart[0].product;
  });
  console.log("Selected Item?: ", JSON.stringify(selectedItem));
  const item = selectedItem[0];
  const financial = (x: number) => Math.round(x*100)/100;
  const discount = financial(item.discount*item.basePrice*item.quantity);
  console.log(`Discount ${discount}`)
  const payload = {
    intent: "CAPTURE",
    purchase_units: [
      {
        amount: {
          currency_code: "EUR",
          value: financial(item.grandTotal),
          breakdown: {
            item_total: {
              currency_code: "EUR",
              value: financial(item.basePrice*item.quantity),
            },
			discount: {
              currency_code: "EUR",
              value: discount,
			},
			shipping: {
              currency_code: "EUR",
              value: item.shipping,
			}
          },
        },
        items: [
          {
            name: item.name,
            unit_amount: {
              currency_code: "EUR",
              value: item.basePrice,
            },
            quantity: item.quantity,
          },
        ],
      },
    ],
  };
  console.log(JSON.stringify(payload));

  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      // Uncomment one of these to force an error for negative testing (in sandbox mode only). Documentation:
      // https://developer.paypal.com/tools/sandbox/negative-testing/request-headers/
      // "PayPal-Mock-Response": '{"mock_application_codes": "MISSING_REQUIRED_PARAMETER"}'
      // "PayPal-Mock-Response": '{"mock_application_codes": "PERMISSION_DENIED"}'
      // "PayPal-Mock-Response": '{"mock_application_codes": "INTERNAL_SERVER_ERROR"}'
    },
    method: "POST",
    body: JSON.stringify(payload),
  });

  return handleResponse(response);
};

exports.createOrder = functions.https.onRequest(async (req, res) => {
  try {
    // use the cart information passed from the front-end
    // to calculate the order amount detals
    const { cart } = req.body;
    const { jsonResponse, httpStatusCode } = await paypalOrder(cart);
    res.status(httpStatusCode).json(jsonResponse);
  } catch (error) {
    console.error("Failed to create order:", error);
    res.status(500).json({ error: "Failed to create order." });
  }
});

const captureOrder = async (orderID: string) => {
  const accessToken = await generateAccessToken();
  const url = `${base}/v2/checkout/orders/${orderID}/capture`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      // Uncomment one of these to force an error for negative testing (in sandbox mode only). Documentation:
      // https://developer.paypal.com/tools/sandbox/negative-testing/request-headers/
      // "PayPal-Mock-Response": '{"mock_application_codes": "INSTRUMENT_DECLINED"}'
      // "PayPal-Mock-Response": '{"mock_application_codes": "TRANSACTION_REFUSED"}'
      // "PayPal-Mock-Response": '{"mock_application_codes": "INTERNAL_SERVER_ERROR"}'
    },
  });

  return handleResponse(response);
};

exports.capture = functions.https.onRequest(async (req, res) => {
  try {
    console.log(JSON.stringify(req.body));
    const { orderID } = req.body;
    const { jsonResponse, httpStatusCode } = await captureOrder(orderID);
    res.status(httpStatusCode).json(jsonResponse);
  } catch (error) {
    console.error("Failed to create order:", error);
    res.status(500).json({ error: "Failed to capture order." });
  }
});
