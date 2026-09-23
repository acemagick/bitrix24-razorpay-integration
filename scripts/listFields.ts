/**
 * Print the custom (UF_CRM_...) fields on Bitrix24 deals, so you can find the
 * API names to put in BITRIX_PAYMENT_LINK_FIELD and BITRIX_PAYMENT_ID_FIELD.
 *
 *   npm run list-fields            custom fields only
 *   npm run list-fields -- --all   every deal field, including standard ones
 *
 * WHY this exists: Bitrix shows your field's label ("Payment link") in the UI,
 * but the API needs its generated name (UF_CRM_1727000000), which the UI hides.
 *
 * Only needs BITRIX_WEBHOOK_URL. You need these field names *before* you can
 * fill in the rest of .env, so this deliberately doesn't load the full config.
 */

import { BitrixClient, BitrixApiError, BitrixError } from "../src/bitrix.ts";
import { loadDotEnv } from "../src/config.ts";

loadDotEnv();
const webhookUrl = process.env.BITRIX_WEBHOOK_URL;
if (!webhookUrl) {
  console.error("BITRIX_WEBHOOK_URL is not set. Copy .env.example to .env and fill it in first.");
  process.exit(1); // safe here: no network requests have started yet
}

const showAll = process.argv.includes("--all");
const bitrix = new BitrixClient(webhookUrl);

try {
  const fields = await bitrix.listDealFields();
  const rows = Object.entries(fields)
    .filter(([name]) => showAll || name.startsWith("UF_CRM_"))
    .map(([name, def]) => ({
      "API name": name,
      type: String(def.type ?? ""),
      // Custom fields keep their human label in listLabel/formLabel; standard fields use title.
      label: String(def.listLabel || def.formLabel || def.editFormLabel || def.title || ""),
    }));

  if (rows.length === 0) {
    console.log("No custom deal fields found.");
    console.log("Create two fields of type String in CRM -> Deals -> (any deal) -> the gear icon on the form -> Add field,");
    console.log("then run this again.");
  } else {
    console.table(rows);
    console.log("Copy the API names of your two fields into BITRIX_PAYMENT_LINK_FIELD and BITRIX_PAYMENT_ID_FIELD in .env.");
  }
} catch (err) {
  console.error(`Failed: ${(err as Error).message}`);
  if (err instanceof BitrixApiError) {
    console.error("Hint: check the webhook URL is complete, and that the inbound webhook has the CRM (crm) permission.");
  } else if (err instanceof BitrixError) {
    console.error("Hint: check the portal address in BITRIX_WEBHOOK_URL and your internet connection.");
  }
  process.exitCode = 1; // not process.exit(): see scripts/checkSetup.ts
}
