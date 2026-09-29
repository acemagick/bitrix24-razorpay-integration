/**
 * Print the Bitrix24 deal pipelines with their IDs and stages:
 *
 *   npm run list-pipelines
 *
 * WHY this exists: the recurring renewal links only work for deals in the
 * "Recurring" pipeline, and the service recognises that pipeline by its ID
 * (RECURRING_CATEGORY_ID), which Bitrix doesn't show in its interface.
 * ("Category" is Bitrix's API name for a pipeline.)
 *
 * Only needs BITRIX_WEBHOOK_URL, like `npm run list-fields`. Read-only.
 */

import { BitrixClient, BitrixApiError, BitrixError } from "../src/bitrix.ts";
import { loadDotEnv } from "../src/config.ts";

loadDotEnv();
const webhookUrl = process.env.BITRIX_WEBHOOK_URL;
if (!webhookUrl) {
  console.error("BITRIX_WEBHOOK_URL is not set. Copy .env.example to .env and fill it in first.");
  process.exit(1); // safe here: no network requests have started yet
}

const bitrix = new BitrixClient(webhookUrl);

interface Category {
  id: number | string;
  name: string;
  isDefault?: string;
}
interface Stage {
  STATUS_ID: string;
  NAME: string;
  SORT: string | number;
}

try {
  // entityTypeId 2 = deals. The result includes the default pipeline (ID 0).
  // Bitrix returns at most 50 per call, so follow `next` until there's no more.
  const categories: Category[] = [];
  let start: number | undefined = 0;
  do {
    const page: { result: { categories: Category[] }; next: number | undefined } = await bitrix.callPage(
      "crm.category.list",
      { entityTypeId: 2, start },
    );
    categories.push(...page.result.categories);
    start = page.next;
  } while (start !== undefined);

  for (const category of categories) {
    const id = String(category.id);
    // Stages of the default pipeline are listed under "DEAL_STAGE", the others
    // under "DEAL_STAGE_<pipeline id>".
    const stages = await bitrix.call<Stage[]>("crm.status.list", {
      filter: { ENTITY_ID: id === "0" ? "DEAL_STAGE" : `DEAL_STAGE_${id}` },
      order: { SORT: "ASC" },
    });
    console.log(`\nPipeline ID ${id}: "${category.name}"${category.isDefault === "Y" ? " (default)" : ""}`);
    console.log(`  Stages: ${stages.map((s) => `${s.NAME} (${s.STATUS_ID})`).join(" -> ")}`);
  }

  console.log("\nPut the Recurring pipeline's ID into RECURRING_CATEGORY_ID in .env.");
} catch (err) {
  console.error(`Failed: ${(err as Error).message}`);
  if (err instanceof BitrixApiError) {
    console.error("Hint: check the webhook URL is complete, and that the inbound webhook has the CRM (crm) permission.");
  } else if (err instanceof BitrixError) {
    console.error("Hint: check the portal address in BITRIX_WEBHOOK_URL and your internet connection.");
  }
  process.exitCode = 1; // not process.exit(): see scripts/checkSetup.ts
}
