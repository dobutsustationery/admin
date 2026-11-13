// Read-only lookups can retry throttling without publishing duplicate offers.
async function lookupWithRetry(
  perform,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  let response;
  for (let attempt = 0; attempt < 4; attempt++) {
    response = await perform();
    if (response.status !== 429 && response.status < 500) return response;
    if (attempt < 3) await pause(2000 * 2 ** attempt);
  }
  return response; // Preserve the actual failed response for the UI/event log.
}
module.exports = { lookupWithRetry };
