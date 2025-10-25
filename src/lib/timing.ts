const t0 = new Date().getTime();

let last = t0;

export function logTime(message: string) {
  const now = new Date().getTime();
  const delta = now - last;
  last = now;
  console.log(`@${now - t0} Δ${delta} ${message}`);
}

export function logBeginningOfTime() {
  logTime(`Beginning of time @ ${new Date().toString()}`);
}
