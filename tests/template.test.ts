/**
 * template.yaml (the AWS deployment) must match the code. These checks catch the
 * mistakes that would otherwise only show up after a deploy, e.g. a setting the
 * code needs but the template never passes, or a table key with the wrong name.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isMap, parseDocument, type Scalar, type YAMLMap } from "yaml";

import { loadConfig } from "../src/config.ts";
import * as lambda from "../src/lambda.ts";

// CloudFormation's short forms (!Ref Table, !Sub "...", !GetAtt X.Y) are custom
// YAML tags. Read them as { Ref: "Table" } etc., which is what they mean.
const cloudFormationTags = ["Ref", "Sub", "GetAtt"].map((name) => ({
  tag: `!${name}`,
  resolve: (value: string) => ({ [name]: value }),
}));

const doc = parseDocument(readFileSync("template.yaml", "utf8"), { customTags: cloudFormationTags });
const template = doc.toJS() as Record<string, any>;
const fn = template.Resources.PaymentLinksFunction.Properties;
const table = template.Resources.Table.Properties;
const envVars: Record<string, unknown> = fn.Environment.Variables;

describe("template.yaml", () => {
  it("is valid YAML", () => {
    expect(doc.errors).toEqual([]);
    expect(isMap(doc.contents)).toBe(true);
  });

  it("passes every setting the code requires to the function", () => {
    // Ask the config loader itself which variables are required: an empty
    // environment makes it list every missing required one.
    let message = "";
    try {
      loadConfig({});
    } catch (err) {
      message = (err as Error).message;
    }
    const required = [...message.matchAll(/^ {2}- (\w+):/gm)].map((m) => m[1]!);
    expect(required.length).toBeGreaterThan(0);
    for (const name of required) expect(envVars, `${name} is missing from template.yaml`).toHaveProperty(name);
  });

  it("gives the function the DynamoDB table, as Lambda requires", () => {
    expect(envVars.DYNAMODB_TABLE).toEqual({ Ref: "Table" });
    expect(fn.Policies).toContainEqual({ DynamoDBCrudPolicy: { TableName: { Ref: "Table" } } });
  });

  it("creates the table with the key and expiry field the code uses", () => {
    // src/dynamoStorage.ts writes rows keyed by `pk` and sets `expiresAt`.
    expect(table.KeySchema).toEqual([{ AttributeName: "pk", KeyType: "HASH" }]);
    expect(table.AttributeDefinitions).toEqual([{ AttributeName: "pk", AttributeType: "S" }]);
    expect(table.TimeToLiveSpecification).toEqual({ AttributeName: "expiresAt", Enabled: true });
  });

  it("points Lambda at the built file's handler, on the Node version it was built for", () => {
    expect(fn.CodeUri).toBe("dist-lambda/");
    expect(fn.Handler).toBe("lambda.handler"); // dist-lambda/lambda.js, export `handler`
    expect(typeof lambda.handler).toBe("function");
    expect(fn.Runtime).toBe("nodejs24.x"); // scripts/buildLambda.mjs targets node24
    expect(readFileSync("scripts/buildLambda.mjs", "utf8")).toContain('target: "node24"');
  });

  it("has a public URL, protected by the service itself", () => {
    expect(fn.FunctionUrlConfig).toEqual({ AuthType: "NONE" });
    // Hence the token is required in AWS, not optional as on your computer.
    const token = template.Parameters.InboundApiToken;
    expect(token.NoEcho).toBe(true);
    expect(token.MinLength).toBeGreaterThanOrEqual(16);
    expect(token.Default).toBeUndefined();
  });

  it("hides every secret setting (NoEcho)", () => {
    for (const name of ["BitrixWebhookUrl", "RazorpayKeySecret", "RazorpayWebhookSecret", "InboundApiToken"]) {
      expect(template.Parameters[name].NoEcho, name).toBe(true);
    }
  });

  it("keeps the table if the stack is deleted (it may hold unresolved links)", () => {
    const resources = doc.get("Resources") as YAMLMap;
    const tableNode = resources.get("Table") as YAMLMap;
    expect((tableNode.get("DeletionPolicy", true) as Scalar).value).toBe("Retain");
  });
});
