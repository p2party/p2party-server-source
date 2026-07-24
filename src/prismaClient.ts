import type { PrismaClient as ImportedPrismaClient } from "@prisma/client";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname } from "path";
global.__filename = fileURLToPath(import.meta.url);
global.__dirname = dirname(__filename);

const require = createRequire(import.meta.url ?? __filename);

const { PrismaClient: RequiredPrismaClient } = require("@prisma/client");

const _PrismaClient: typeof ImportedPrismaClient = RequiredPrismaClient;

export class PrismaClient extends _PrismaClient {}

export type ProcessPrismaClient = Omit<PrismaClient, "$disconnect">;

/** The single Prisma connection manager used for the lifetime of the server. */
export const prisma: ProcessPrismaClient = new PrismaClient();
