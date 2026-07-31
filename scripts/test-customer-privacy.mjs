/**
 * Customer privacy (SEC-5.1) — a shop reads only its OWN customers.
 *
 * customers_select was `using (true)` — any shop login could read every
 * customer's name/phone/address across all branches (the whole CRM) with one
 * direct PostgREST call. A shop legitimately needs only the customers it has
 * actually served (which it sees through the scoped receivables / shop_warranties
 * views). This scopes the employee arm to "a customer with a sale at my shop".
 *
 * Verifies:
 *   • shop B's customer is INVISIBLE to shop A
 *   • shop B still sees its own customer (receivables/warranties keep working)
 *   • a customer with no sale at a shop is invisible to that shop
 *   • the owner still sees every customer
 *
 * Provisions two throwaway shops. Run: node scripts/test-customer-privacy.mjs
 */
import {
  owner, RUN, check, section, summary,
  provisionShop, seedPart, seedEngineModel, seedCustomer,
  receive, deliverAndConfirm, trackCustomer, trackEngine, cleanup,
} from "./_harness.mjs";

const A = await provisionShop("PrivacyA");
const B = await provisionShop("PrivacyB");

section("Setup: shop B sells an engine to a customer (ties customer → shop B)");
const model = await seedEngineModel({ brand: "ZZ-TEST", model: "Priv", hp: 15 });
const SERIAL = `ZZ-PRIV-${RUN}`;
await receive({
  parts: [],
  engines: [{
    serial_number: SERIAL, engine_model_id: model.id, condition: "brand_new",
    cost_centavos: 1_000_000, price_centavos: 2_000_000, warranty_months: null,
  }],
});
const { data: engine } = await owner.from("engines").select("id").eq("serial_number", SERIAL).single();
trackEngine(engine.id);
await deliverAndConfirm(B, { engine_ids: [engine.id] });

const custName = `ZZ-TEST Private Buyer ${RUN}`;
// partial payment → the sale lands in the receivables view (utang), so the
// regression check below exercises the customers-join under the new policy.
const { data: saleId, error: sErr } = await B.client.rpc("fn_record_sale", {
  p_customer_id: null, p_customer: { name: custName, phone: "0917-555-0000" },
  p_part_lines: [], p_engine_lines: [{ engine_id: engine.id, agreed_price_centavos: 2_000_000 }],
  p_payment_type: "partial", p_amount_paid_centavos: 500_000,
});
check("shop B recorded an engine sale with a customer", !sErr && !!saleId, sErr?.message);
const { data: saleRow } = await owner.from("sales").select("customer_id").eq("id", saleId).single();
const bCustomerId = saleRow.customer_id;
trackCustomer(bCustomerId);

// a second customer with NO sale anywhere — pure enumeration bait
const orphan = await seedCustomer({ label: "Orphan" });

section("SEC-5.1: shop A must not see shop B's customer, nor enumerate all");
{
  const { data } = await A.client.from("customers").select("id, name, phone").eq("id", bCustomerId);
  check("shop A cannot read shop B's customer", (data?.length ?? 0) === 0,
    `shop A saw ${data?.length ?? 0} row(s): ${data?.[0]?.name ?? ""}`);
}
{
  const { data } = await A.client.from("customers").select("id").eq("id", orphan.id);
  check("shop A cannot read a sale-less customer", (data?.length ?? 0) === 0, `saw ${data?.length ?? 0}`);
}
{
  // the blunt enumeration: can shop A pull the whole table?
  const { data } = await A.client.from("customers").select("id").in("id", [bCustomerId, orphan.id]);
  check("shop A cannot enumerate other shops' customers", (data?.length ?? 0) === 0, `saw ${data?.length ?? 0}`);
}

section("Regression: shop B sees its own customer; owner sees all");
{
  const { data } = await B.client.from("customers").select("id, name").eq("id", bCustomerId);
  check("shop B DOES see its own customer (views keep working)", (data?.length ?? 0) === 1,
    `shop B saw ${data?.length ?? 0}`);
}
{
  // and shop B reads it through the scoped view too
  const { data } = await B.client.from("shop_receivables").select("customer_name").eq("sale_id", saleId);
  check("shop B's receivables view still shows the customer name",
    (data?.[0]?.customer_name ?? "") === custName, `got "${data?.[0]?.customer_name ?? ""}"`);
}
{
  const { data } = await owner.from("customers").select("id").in("id", [bCustomerId, orphan.id]);
  check("owner still sees every customer", (data?.length ?? 0) === 2, `owner saw ${data?.length ?? 0}`);
}

await cleanup();
summary();
