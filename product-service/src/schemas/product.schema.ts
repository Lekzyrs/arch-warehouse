import { z } from "zod";
import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
} from "@asteasolutions/zod-to-openapi";

// расширяем zod openapi-метаданными один раз на уровне модуля
extendZodWithOpenApi(z);

export const CreateProductDtoSchema = z
  .object({
    sku: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    unit: z.string().min(1),
    category: z.string().min(1),
  })
  .openapi("CreateProductDto");

export const UpdateProductDtoSchema = CreateProductDtoSchema.partial().openapi(
  "UpdateProductDto",
);

export const ProductSchema = z
  .object({
    id: z.string(),
    sku: z.string(),
    name: z.string(),
    description: z.string().nullable().optional(),
    unit: z.string(),
    category: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("Product");

export type CreateProductDto = z.infer<typeof CreateProductDtoSchema>;
export type UpdateProductDto = z.infer<typeof UpdateProductDtoSchema>;
export type Product = z.infer<typeof ProductSchema>;

// общий реестр для openapi.ts. регистрировать пути там, тут только схемы
export const registry = new OpenAPIRegistry();
registry.register("CreateProductDto", CreateProductDtoSchema);
registry.register("UpdateProductDto", UpdateProductDtoSchema);
registry.register("Product", ProductSchema);
