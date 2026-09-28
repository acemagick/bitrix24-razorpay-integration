/**
 * Build the code AWS Lambda runs: `npm run build:lambda`.
 *
 * It packs src/lambda.ts, everything it imports, and all the libraries it needs
 * (Express, zod, the AWS SDK...) into ONE file: dist-lambda/lambda.js.
 * template.yaml points the Lambda function at that folder, and `sam deploy`
 * uploads it.
 *
 * WHY ONE FILE ("bundling"): Lambda then needs no node_modules folder, the
 * upload is small, and the function starts faster.
 *
 * WHY CommonJS FORMAT ("cjs"): some of the libraries (Express,
 * serverless-express) are written in the older CommonJS style. Bundling
 * everything as CommonJS avoids the classic "Dynamic require is not supported"
 * crash that mixing the two styles can cause on Lambda.
 */

import { rm } from "node:fs/promises";
import { build } from "esbuild";

const outdir = "dist-lambda";
await rm(outdir, { recursive: true, force: true }); // never ship leftovers from an old build

const result = await build({
  entryPoints: ["src/lambda.ts"],
  outfile: `${outdir}/lambda.js`,
  bundle: true,
  platform: "node",
  target: "node24", // matches Runtime: nodejs24.x in template.yaml
  format: "cjs",
  // A source map lets error messages in CloudWatch point at the real
  // TypeScript lines (enabled by NODE_OPTIONS=--enable-source-maps in template.yaml).
  sourcemap: true,
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
});

const bytes = Object.values(result.metafile.outputs).reduce((sum, output) => sum + output.bytes, 0);
console.log(`Built ${outdir}/lambda.js (${(bytes / 1024 / 1024).toFixed(1)} MB including the source map)`);
