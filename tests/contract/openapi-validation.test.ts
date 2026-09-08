import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import SwaggerParser from "@apidevtools/swagger-parser";
import type { AnySchema } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

const contractPath = fileURLToPath(
  new URL(
    "../../specs/001-mineru-public-publishing/contracts/openapi.yaml",
    import.meta.url,
  ),
);
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const operationMethods = new Set([
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "trace",
]);

type ObjectValue = Record<string, unknown>;

function objectValue(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} is not an object`);
  }
  return value as ObjectValue;
}

let contractPromise: Promise<ObjectValue> | undefined;

function contract(): Promise<ObjectValue> {
  contractPromise ??= SwaggerParser.validate(contractPath).then((document) =>
    objectValue(document, "OpenAPI document"),
  );
  return contractPromise;
}

function routeModulePath(contractRoute: string): readonly string[] {
  const route = contractRoute
    .replaceAll(/\{([^}]+)\}/gu, "[$1]")
    .replace(/^\//u, "");
  return [`src/pages/${route}.ts`, `src/pages/${route}/index.ts`];
}

async function findRouteModule(contractRoute: string): Promise<string> {
  for (const candidate of routeModulePath(contractRoute)) {
    try {
      await access(`${projectRoot}${candidate}`);
      return candidate;
    } catch {
      // Try the directory-index representation next.
    }
  }
  throw new Error(`No Astro route module for ${contractRoute}`);
}

describe("generated OpenAPI validation", () => {
  it("validates and dereferences the complete OpenAPI 3.1 document", async () => {
    const document = await contract();
    expect(document.openapi).toBe("3.1.0");

    const schemas = objectValue(
      objectValue(document.components, "components").schemas,
      "components.schemas",
    );
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    for (const [name, schema] of Object.entries(schemas)) {
      expect(() => ajv.compile(schema as AnySchema)).not.toThrow();
      expect(name).toMatch(/^[A-Z][A-Za-z0-9]+$/u);
    }
  });

  it("maps unique operations to existing Astro routes", async () => {
    const document = await contract();
    const paths = objectValue(document.paths, "paths");
    const operationIds = new Set<string>();

    for (const [contractRoute, pathItemValue] of Object.entries(paths)) {
      const pathItem = objectValue(pathItemValue, contractRoute);
      await findRouteModule(contractRoute);
      for (const [method, operationValue] of Object.entries(pathItem)) {
        if (!operationMethods.has(method)) continue;
        const operation = objectValue(
          operationValue,
          `${method.toUpperCase()} ${contractRoute}`,
        );
        const operationId = operation.operationId;
        expect(operationId).toEqual(expect.any(String));
        expect(operationIds.has(String(operationId))).toBe(false);
        operationIds.add(String(operationId));
      }
    }

    expect(operationIds.size).toBeGreaterThan(0);
  });

  it("declares cache behavior for every response and required security headers for binaries", async () => {
    const document = await contract();
    const paths = objectValue(document.paths, "paths");
    const missingCacheHeaders: string[] = [];

    for (const [contractRoute, pathItemValue] of Object.entries(paths)) {
      const pathItem = objectValue(pathItemValue, contractRoute);
      for (const [method, operationValue] of Object.entries(pathItem)) {
        if (!operationMethods.has(method)) continue;
        const operation = objectValue(
          operationValue,
          `${method.toUpperCase()} ${contractRoute}`,
        );
        const responses = objectValue(
          operation.responses,
          `${method.toUpperCase()} ${contractRoute} responses`,
        );
        for (const [status, responseValue] of Object.entries(responses)) {
          const response = objectValue(
            responseValue,
            `${method.toUpperCase()} ${contractRoute} ${status}`,
          );
          const headers =
            response.headers &&
            typeof response.headers === "object" &&
            !Array.isArray(response.headers)
              ? (response.headers as ObjectValue)
              : {};
          if (!("Cache-Control" in headers)) {
            missingCacheHeaders.push(
              `${method.toUpperCase()} ${contractRoute} ${status}`,
            );
          }
        }
      }
    }
    expect(missingCacheHeaders).toEqual([]);

    for (const contractRoute of [
      "/books/{bookKey}/assets/{versionId}/{resourceId}",
      "/books/{bookKey}/originals/{fileId}",
      "/api/manage/books/{bookId}/preview/{buildId}/assets/{resourceId}",
    ]) {
      const operation = objectValue(
        objectValue(paths[contractRoute], contractRoute).get,
        `GET ${contractRoute}`,
      );
      const responses = objectValue(operation.responses, "responses");
      for (const [status, responseValue] of Object.entries(responses)) {
        const headers = objectValue(
          objectValue(responseValue, `${contractRoute} ${status}`).headers,
          `${contractRoute} ${status} headers`,
        );
        expect(headers).toHaveProperty("X-Content-Type-Options");
      }
    }
  });
});
