/**
 * Convert-to-delivery classifier (pure) — classifyRequestLines splits a shop's
 * delivery-request lines into what master can fulfill (available, capped) vs
 * what it can't (no stock), for parts and engines. Imports the TS helper
 * directly (Node strips types) — no DB, no fixtures.
 *
 * Run: node scripts/test-convert-request.mjs
 */
import { classifyRequestLines } from "../lib/request-fulfillment.ts";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

const partLine = (id, qty, name, sku = null) => ({
  part_id: id, engine_model_id: null, qty_requested: qty,
  part_name: name, part_sku: sku, model_name: null,
});
const engLine = (modelId, qty, name) => ({
  part_id: null, engine_model_id: modelId, qty_requested: qty,
  part_name: null, part_sku: null, model_name: name,
});

console.log("Parts: available / partial-capped / no-stock");
{
  const lines = [
    partLine("p-full", 3, "Impeller", "IMP-1"),   // 10 on hand → available, qty 3
    partLine("p-part", 5, "Cylinder", "CYL-9"),   // 2 on hand  → available, capped to 2
    partLine("p-none", 4, "Carburetor", "CAR-2"), // 0 on hand  → no stock
  ];
  const master = [{ part_id: "p-full", master_qty: 10 }, { part_id: "p-part", master_qty: 2 }];
  const c = classifyRequestLines(lines, master, []);

  const full = c.availableParts.find((p) => p.part_id === "p-full");
  const part = c.availableParts.find((p) => p.part_id === "p-part");
  check("fully-available part: qty = requested (3)", full?.qty === "3" && full?.requested === 3);
  check("partial part is AVAILABLE, qty capped to on-hand (2)", part?.qty === "2");
  check("partial part carries requested (5) + available (2) for the caption",
    part?.requested === 5 && part?.available === 2);
  check("zero-stock part is NO STOCK (not deliverable)",
    c.availableParts.every((p) => p.part_id !== "p-none") &&
    c.noStockParts.length === 1 && c.noStockParts[0].part_id === "p-none");
  check("no-stock part keeps its name + sku + requested",
    c.noStockParts[0].name === "Carburetor" && c.noStockParts[0].sku === "CAR-2" &&
    c.noStockParts[0].qty_requested === 4);
}

console.log("\nEngines: matched / partial / none, serials never reused");
{
  const lines = [
    engLine("m-A", 2, "Yamaha 40"),   // 3 serials → 2 matched, none short
    engLine("m-B", 2, "Honda 9.9"),   // 1 serial  → 1 matched, 1 short
    engLine("m-C", 1, "Suzuki 15"),   // 0 serials → no stock
  ];
  const inMaster = [
    { id: "s1", engine_model_id: "m-A" }, { id: "s2", engine_model_id: "m-A" },
    { id: "s3", engine_model_id: "m-A" }, { id: "s4", engine_model_id: "m-B" },
  ];
  const c = classifyRequestLines(lines, [], inMaster);

  check("model with enough serials: 2 auto-picked", c.engineIds.filter((id) => ["s1", "s2", "s3"].includes(id)).length === 2);
  check("no short caption when fully matched", !c.shortEngines.some((e) => e.name === "Yamaha 40"));
  check("partial model: 1 serial matched", c.engineIds.includes("s4"));
  check("partial model gets a short caption (1 of 2)",
    c.shortEngines.some((e) => e.name === "Honda 9.9" && e.matched === 1 && e.requested === 2));
  check("zero-serial model is NO STOCK",
    c.noStockEngines.some((e) => e.name === "Suzuki 15" && e.qty_requested === 1));
  check("total matched serials = 3 (2 + 1), never reused", c.engineIds.length === 3);
}

console.log("\nSerials are not reused across two lines of the SAME model");
{
  const lines = [engLine("m-A", 2, "Yamaha 40"), engLine("m-A", 2, "Yamaha 40")];
  const inMaster = [
    { id: "s1", engine_model_id: "m-A" }, { id: "s2", engine_model_id: "m-A" },
    { id: "s3", engine_model_id: "m-A" },
  ];
  const c = classifyRequestLines(lines, [], inMaster);
  check("3 serials spread across the two lines, no double-pick",
    c.engineIds.length === 3 && new Set(c.engineIds).size === 3);
  check("second line is short (only 1 left after the first took 2)",
    c.shortEngines.some((e) => e.matched === 1));
}

console.log("\nEverything out of stock → nothing available");
{
  const c = classifyRequestLines(
    [partLine("p", 2, "Widget"), engLine("m", 1, "Engine X")],
    [], []
  );
  check("no available parts or engines", c.availableParts.length === 0 && c.engineIds.length === 0);
  check("both surface as no-stock", c.noStockParts.length === 1 && c.noStockEngines.length === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
