window.buttonNumber = window.buttonNumber || 0;
window.buy = () => {
  buttonNumber++;
  
  window.paypal
    .Buttons({
      style: {
        layout: 'horizontal',
        tagline: false,
      },
      async createOrder() {
        const choices = document.getElementsByTagName('input');
        const selectedProduct = Object.keys(choices).filter(k => choices[k].checked);
        const product = choices[selectedProduct[0]].value;

        try {
          const response = await fetch("/api/orders", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              cart: [
                {
                  product,
                },
              ],
            }),
          });

          const orderData = await response.json();

          if (orderData.id) {
            return orderData.id;
          } else {
            const errorDetail = orderData?.details?.[0];
            const errorMessage = errorDetail
              ? `${errorDetail.issue} ${errorDetail.description} (${orderData.debug_id})`
              : JSON.stringify(orderData);

            throw new Error(errorMessage);
          }
        } catch (error) {
          console.error(error);
          resultMessage(
            `Could not initiate PayPal Checkout...<br><br>${error}`
          );
        }
      },
      async onApprove(data, actions) {
        try {
          const response = await fetch(`/api/capture`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(data),
          });

          const orderData = await response.json();
          // Three cases to handle:
          //   (1) Recoverable INSTRUMENT_DECLINED -> call actions.restart()
          //   (2) Other non-recoverable errors -> Show a failure message
          //   (3) Successful transaction -> Show confirmation or thank you message

          const errorDetail = orderData?.details?.[0];

          if (errorDetail?.issue === "INSTRUMENT_DECLINED") {
            // (1) Recoverable INSTRUMENT_DECLINED -> call actions.restart()
            // recoverable state, per https://developer.paypal.com/docs/checkout/standard/customize/handle-funding-failures/
            return actions.restart();
          } else if (errorDetail) {
            // (2) Other non-recoverable errors -> Show a failure message
            throw new Error(
              `${errorDetail.description} (${orderData.debug_id})`
            );
          } else if (!orderData.purchase_units) {
            throw new Error(JSON.stringify(orderData));
          } else {
            // (3) Successful transaction -> Show confirmation or thank you message
            // Or go to another URL:  actions.redirect('thank_you.html');
            const transaction =
              orderData?.purchase_units?.[0]?.payments?.captures?.[0] ||
              orderData?.purchase_units?.[0]?.payments?.authorizations?.[0];
            resultMessage(
              `Thank you for your purchase!`
            );
            console.log(
              "Capture result",
              orderData,
              JSON.stringify(orderData, null, 2)
            );
          }
        } catch (error) {
          console.error(error);
          resultMessage(
            `Sorry, your transaction could not be processed...<br><br>${error}`
          );
        }
      },
    })
    .render(`#paypal-button-container-${buttonNumber}`);
};
// Example function to show a result to the user. Your site's UI library can be used instead.
function resultMessage(message) {
  const container = document.querySelector(`#result-message-${buttonNumber}`);
  container.innerHTML = message;
}
