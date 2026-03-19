import { randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import { getPrismaClient } from "./prismaClient.js";

export async function seedDatabase(): Promise<void> {
  await seedDefaultAdmin();
}

/**
 * Seed default admin user
 * Creates test@test.com with password "test" for development/demo purposes
 */
async function seedDefaultAdmin(): Promise<void> {
  const prisma = getPrismaClient();

  const existingAdmin = await prisma.user.findUnique({
    where: { email: "test@test.com" },
    select: { id: true },
  });

  if (existingAdmin) {
    return;
  }

  console.log("Creating default admin user (test@test.com)...");

  const userId = randomUUID();
  const passwordHash = bcrypt.hashSync("test", 10);

  await prisma.user.create({
    data: {
      id: userId,
      email: "test@test.com",
      username: "admin",
      passwordHash,
      isEmailVerified: true,
      isActive: true,
      role: "ADMIN",
    },
  });

  console.log("Default admin user created successfully!");
}
