import { owner, provisionShop, seedPart, receive, deliverAndConfirm, check, section, summary, cleanup } from "./_harness.mjs";
const A = await provisionShop("Badges");
section("fn_shop_badge_counts returns the three counts in one call");
const { data, error } = await A.client.rpc("fn_shop_badge_counts");
check("rpc exists + returns object", !error && data && typeof data === "object", error?.message);
check("has deliveries/low_stock/receivables keys",
  data && ["deliveries","low_stock","receivables"].every((k) => k in data), JSON.stringify(data));
check("employee-scoped shop_name present", !!data?.shop_name, JSON.stringify(data));
await cleanup();
summary();
