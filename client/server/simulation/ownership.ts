/// <reference path="../types/express.d.ts" />
import type { Request, Response } from "express";
import { getPrismaClient } from "../../../src/shared/agents/memory/database/prismaClient.js";

export async function isSimulationOwnedByEmail(
  sessionId: string,
  email: string | undefined
): Promise<boolean> {
  if (!email) return false;

  const prisma = getPrismaClient();
  const session = await prisma.session.findFirst({
    where: { sessionId, emailId: email },
    select: { sessionId: true },
  });

  return Boolean(session);
}

export async function requireSimulationOwnership(
  req: Request,
  res: Response
): Promise<boolean> {
  const email = req.user?.email;
  if (!email) {
    res.status(401).json({ error: "Authentication required" });
    return false;
  }

  const isOwner = await isSimulationOwnedByEmail(req.params.id, email);
  if (!isOwner) {
    res.status(403).json({ error: "Forbidden" });
    return false;
  }

  return true;
}
