/* eslint-disable */
  /**
   * Generated `api` utility.
   *
   * THIS CODE IS AUTOMATICALLY GENERATED.
   *
   * To regenerate, run `npx convex dev`.
   * @module
   */
  
import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";
import { anyApi } from "convex/server";
import type * as admin from "../admin.js";
import type * as automation from "../automation.js";
import type * as constants from "../constants.js";
import type * as crons from "../crons.js";
import type * as http from "../http.js";
import type * as lib_audit from "../lib/audit.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_outbox from "../lib/outbox.js";
import type * as lib_rateLimit from "../lib/rateLimit.js";
import type * as lib_sha256 from "../lib/sha256.js";
import type * as lib_signing from "../lib/signing.js";
import type * as lib_validate from "../lib/validate.js";
import type * as loans from "../loans.js";
import type * as maintenance from "../maintenance.js";
import type * as outbox from "../outbox.js";
import type * as tools from "../tools.js";
import type * as users from "../users.js";

const fullApi: ApiFromModules<{
  "admin": typeof admin,
"automation": typeof automation,
"constants": typeof constants,
"crons": typeof crons,
"http": typeof http,
"lib/audit": typeof lib_audit,
"lib/auth": typeof lib_auth,
"lib/outbox": typeof lib_outbox,
"lib/rateLimit": typeof lib_rateLimit,
"lib/sha256": typeof lib_sha256,
"lib/signing": typeof lib_signing,
"lib/validate": typeof lib_validate,
"loans": typeof loans,
"maintenance": typeof maintenance,
"outbox": typeof outbox,
"tools": typeof tools,
"users": typeof users,
}> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export const api: FilterApi<typeof fullApi, FunctionReference<any, "public">> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export const internal: FilterApi<typeof fullApi, FunctionReference<any, "internal">> = anyApi as any;
