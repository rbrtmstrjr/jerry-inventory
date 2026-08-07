import { dbAuth } from "./qa-lib.mjs";
const q = await dbAuth("owner");
const NAME = process.argv[2];
const p = (await q(`parts?name=eq.${encodeURIComponent(NAME)}&select=id`))[0];
const lines = await q(`sale_lines?part_id=eq.${p.id}&select=id,sale_id,qty,description&order=created_at.desc`);
console.log(`${lines.length} sale lines for ${NAME}`);
for (const l of lines) {
  const s = (await q(`sales?id=eq.${l.sale_id}&select=id,status,shop_id,batch_id,total_centavos,deleted_at`))[0];
  console.log(`  qty=${l.qty}  sale=${l.sale_id.slice(0, 8)}  status=${s?.status}  batch=${s?.batch_id ? s.batch_id.slice(0, 8) : "none"}  deleted=${s?.deleted_at ?? "no"}`);
}
const lv = await q(`stock_levels?part_id=eq.${p.id}&select=qty,shop_id`);
console.log("stock:", JSON.stringify(lv));
