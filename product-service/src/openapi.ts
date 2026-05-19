import { z } from "zod";
import { OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import {
  CreateProductDtoSchema,
  ProductSchema,
  UpdateProductDtoSchema,
  registry,
} from "./schemas/product.schema";

// id-параметр пути регистрируем как именованный для повторного использования
const idParam = registry.registerParameter(
  "ProductId",
  z.string().openapi({
    param: { name: "id", in: "path" },
    example: "00000000-0000-0000-0000-000000000000",
  }),
);

// POST /products
registry.registerPath({
  method: "post",
  path: "/products",
  request: {
    body: {
      content: { "application/json": { schema: CreateProductDtoSchema } },
    },
  },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: ProductSchema } },
    },
    400: { description: "Validation failed" },
  },
});

// GET /products
registry.registerPath({
  method: "get",
  path: "/products",
  responses: {
    200: {
      description: "List of products",
      content: { "application/json": { schema: z.array(ProductSchema) } },
    },
  },
});

// GET /products/{id}
registry.registerPath({
  method: "get",
  path: "/products/{id}",
  request: { params: z.object({ id: idParam }) },
  responses: {
    200: {
      description: "Product",
      content: { "application/json": { schema: ProductSchema } },
    },
    404: { description: "Not found" },
  },
});

// PUT /products/{id}
registry.registerPath({
  method: "put",
  path: "/products/{id}",
  request: {
    params: z.object({ id: idParam }),
    body: {
      content: { "application/json": { schema: UpdateProductDtoSchema } },
    },
  },
  responses: {
    200: {
      description: "Updated product",
      content: { "application/json": { schema: ProductSchema } },
    },
    400: { description: "Validation failed" },
    404: { description: "Not found" },
  },
});

// DELETE /products/{id}
registry.registerPath({
  method: "delete",
  path: "/products/{id}",
  request: { params: z.object({ id: idParam }) },
  responses: {
    204: { description: "Deleted" },
    404: { description: "Not found" },
  },
});

const generator = new OpenApiGeneratorV3(registry.definitions);
export const openapiSpec = generator.generateDocument({
  openapi: "3.0.0",
  info: { title: "Product Service API", version: "1.0.0" },
  servers: [{ url: "http://localhost:8080" }],
});
