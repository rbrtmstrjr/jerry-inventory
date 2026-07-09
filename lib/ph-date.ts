/** Business "today" in the shops' timezone (Asia/Manila), as YYYY-MM-DD. */
export function ph_today(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
