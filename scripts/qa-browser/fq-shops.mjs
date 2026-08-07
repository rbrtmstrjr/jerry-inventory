import { dbAuth } from "./qa-lib.mjs";
const q = await dbAuth("owner");
const shops = await q("shops?deleted_at=is.null&select=id,name&order=name");
const profs = await q("profiles?role=eq.employee&select=id,full_name,shop_id,active");
console.log("SHOPS:");
for (const s of shops) {
  const who = profs.filter((p) => p.shop_id === s.id).map((p) => `${p.full_name}${p.active ? "" : " (inactive)"}`);
  console.log(`  ${s.name}  (${s.id})  <- ${who.join(", ") || "no login"}`);
}
const part = process.argv[2];
if (part) {
  const p = await q(`parts?name=eq.${encodeURIComponent(part)}&select=id`);
  if (p[0]) {
    console.log(`\nSTOCK for ${part}:`);
    const lv = await q(`stock_levels?part_id=eq.${p[0].id}&select=qty,shop_id`);
    for (const l of lv) console.log(`  ${l.shop_id ?? "master"}: ${l.qty}`);
    const dl = await q(`delivery_lines?part_id=eq.${p[0].id}&select=id,delivery_id,qty,qty_received,qty_outstanding&order=id.desc`);
    console.log("DELIVERY LINES:", JSON.stringify(dl, null, 1));
    for (const d of dl) {
      const h = await q(`deliveries?id=eq.${d.delivery_id}&select=id,shop_id,status`);
      console.log(`  delivery ${d.delivery_id} -> shop ${h[0]?.shop_id} status=${h[0]?.status}`);
    }
  }
}
