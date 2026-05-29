import { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, apiSuccess } from "@/lib/api-response";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { readJsonBody } from "@/lib/parse-json-body";
import { verifyStellarPayment } from "@/lib/stellar";

const fundSchema = z.object({
  amount: z.number().positive("Amount must be greater than 0"),
  method: z.enum(["card", "bank", "crypto"]).default("card"),
  note: z.string().optional(),
  /**
   * simulated=true  (default) — mutate local ledger only.
   * simulated=false           — reserved for future on-chain Stellar payment handling.
   */
  simulated: z.boolean().default(true),
  txHash: z.string().optional(),
  stellarAddress: z.string().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser(request);
    if (!currentUser) return apiError("Unauthorized", 401);

    const raw = await readJsonBody(request);
    if (!raw.ok) return raw.response;
    const parsed = fundSchema.safeParse(raw.data);
    if (!parsed.success) {
      return apiError(parsed.error.errors[0].message, 400);
    }

    const { amount, method, note, simulated } = parsed.data;

    if (!simulated) {
      const { txHash, stellarAddress } = parsed.data;

      if (!txHash)
        return apiError("txHash is required for on-chain funding", 400);
      if (!stellarAddress)
        return apiError("stellarAddress is required for on-chain funding", 400);

      let verified: { amount: number; asset: string };
      try {
        verified = await verifyStellarPayment(txHash, stellarAddress, amount);
      } catch (err) {
        return apiError(
          err instanceof Error
            ? err.message
            : "Stellar payment verification failed",
          400,
        );
      }

      const [transaction, updatedUser] = await prisma.$transaction([
        prisma.walletTransaction.create({
          data: {
            userId: currentUser.id,
            type: "fund",
            amount: verified.amount,
            currency: verified.asset,
            status: "completed",
            method,
            note: note ?? null,
            txHash,
            stellarAddress,
          },
        }),
        prisma.user.update({
          where: { id: currentUser.id },
          data: { walletBalance: { increment: verified.amount } },
          select: { walletBalance: true, updatedAt: true },
        }),
      ]);

      return apiSuccess(
        {
          balance: updatedUser.walletBalance,
          transaction,
          lastSync: updatedUser.updatedAt.toISOString(),
          simulated: false,
          txHash,
        },
        "Wallet funded successfully",
        201,
      );
    }

    const [transaction, updatedUser] = await prisma.$transaction([
      prisma.walletTransaction.create({
        data: {
          userId: currentUser.id,
          type: "fund",
          amount,
          currency: "USD",
          status: "completed",
          method,
          note: note ?? null,
        },
      }),
      prisma.user.update({
        where: { id: currentUser.id },
        data: { walletBalance: { increment: amount } },
        select: { walletBalance: true, updatedAt: true },
      }),
    ]);

    return apiSuccess(
      {
        balance: updatedUser.walletBalance,
        transaction,
        lastSync: updatedUser.updatedAt.toISOString(),
        simulated,
      },
      "Wallet funded successfully",
      201,
    );
  } catch {
    return apiError("Failed to fund wallet", 500);
  }
}
