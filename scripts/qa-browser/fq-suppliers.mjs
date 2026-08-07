import { dbAuth } from "./qa-lib.mjs";
const q = await dbAuth("owner");
const s = await q("suppliers?deleted_at=is.null&select=id,name,credit_limit&order=name");
let pay = [];
try { pay = await q("supplier_payables?select=supplier_id,outstanding_centavos"); } catch {}
const byId = {};
for (const p of pay) byId[p.supplier_id] = (byId[p.supplier_id] ?? 0) + Number(p.outstanding_centavos ?? 0);
console.log(`${s.length} suppliers\n`);
for (const x of s) {
  const out = byId[x.id] ?? 0;
  const lim = Number(x.credit_limit ?? 0);
  const room = lim === 0 ? "no limit" : `${((lim - out) / 100).toFixed(2)} room`;
  console.log(`${lim === 0 || out < lim * 0.5 ? "GOOD " : "TIGHT"}  ${x.name}  limit=${(lim / 100).toFixed(2)} out=${(out / 100).toFixed(2)}  ${room}`);
}
