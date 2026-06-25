import { POST as Withdraw } from '@/app/api/wallet/withdraw/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockRequest, parseResponse } from '../helpers/api';
import { prisma } from '@/lib/prisma';

const mockConvertUSDtoXLM = vi.hoisted(() => vi.fn());

vi.mock('@/lib/stellar', () => ({
  submitStellarWithdrawal: vi.fn(),
  convertUSDtoXLM: mockConvertUSDtoXLM,
  convertXLMtoUSD: vi.fn(),
  getUSDtoXLMRate: vi.fn().mockResolvedValue(0.12),
}));

describe('Wallet Withdrawal with Currency Conversion', () => {
  let user: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockConvertUSDtoXLM.mockResolvedValue(833.33); // $100 USD -> ~833 XLM at $0.12/XLM

    prisma.$transaction = vi.fn(async (callback: any) => callback(prisma as any));

    user = {
      id: 'user_1',
      email: 'user@example.com',
      walletAddress: 'GUSER1WALLET',
      walletBalance: 500,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  });

  describe('Simulated withdrawal with conversion', () => {
    it('should create withdrawal with USD to XLM conversion info', async () => {
      prisma.user.findUnique = vi.fn().mockResolvedValue(user);
      prisma.walletTransaction.create = vi.fn().mockResolvedValue({
        id: 'tx_1',
        userId: user.id,
        type: 'withdraw',
        amount: 100,
        convertedAmount: 833.33,
        currency: 'USD',
        convertedCurrency: 'XLM',
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      prisma.user.update = vi.fn().mockResolvedValue({
        walletBalance: 400,
        updatedAt: new Date(),
      });

      vi.spyOn(await import('@/lib/auth'), 'getCurrentUser').mockResolvedValue(user);

      const request = createMockRequest('http://localhost:3000/api/wallet/withdraw', {
        method: 'POST',
        body: {
          amount: 100,
          method: 'bank',
          simulated: true,
        },
      });

      const response = await Withdraw(request);
      const { status, data } = await parseResponse(response);

      expect(status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.balance).toBe(400);
      expect(data.data.simulated).toBe(true);
      
      // Verify conversion info is included
      expect(data.data.conversionInfo).toBeDefined();
      expect(data.data.conversionInfo.originalAmount).toBe(100);
      expect(data.data.conversionInfo.originalCurrency).toBe('USD');
      expect(data.data.conversionInfo.convertedAmount).toBe(833.33);
      expect(data.data.conversionInfo.convertedCurrency).toBe('XLM');
    });

    it('should decrement balance by original USD amount', async () => {
      const mockTx = {
        id: 'tx_1',
        userId: user.id,
        type: 'withdraw',
        amount: 50,
        convertedAmount: 416.67,
        currency: 'USD',
        convertedCurrency: 'XLM',
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      prisma.user.findUnique = vi.fn().mockResolvedValue(user);
      prisma.walletTransaction.create = vi.fn().mockResolvedValue(mockTx);
      prisma.user.update = vi.fn().mockResolvedValue({
        walletBalance: 450, // 500 - 50
        updatedAt: new Date(),
      });

      vi.spyOn(await import('@/lib/auth'), 'getCurrentUser').mockResolvedValue(user);

      const request = createMockRequest('http://localhost:3000/api/wallet/withdraw', {
        method: 'POST',
        body: {
          amount: 50,
          method: 'bank',
          simulated: true,
        },
      });

      const response = await Withdraw(request);
      const { status, data } = await parseResponse(response);

      expect(status).toBe(200);
      // User balance should be decremented by original USD amount (50)
      expect(data.data.balance).toBe(450);
    });

    it('should handle conversion failure gracefully', async () => {
      mockConvertUSDtoXLM.mockRejectedValue(new Error('Exchange rate unavailable'));

      prisma.user.findUnique = vi.fn().mockResolvedValue(user);

      vi.spyOn(await import('@/lib/auth'), 'getCurrentUser').mockResolvedValue(user);

      const request = createMockRequest('http://localhost:3000/api/wallet/withdraw', {
        method: 'POST',
        body: {
          amount: 100,
          method: 'bank',
          simulated: false, // This will attempt conversion
          destinationAddress: 'GDEST123',
        },
      });

      const response = await Withdraw(request);
      const { status, data } = await parseResponse(response);

      // On-chain withdrawal should fail if conversion fails
      expect(status).toBe(502);
      expect(data.success).toBe(false);
    });

    it('should reject insufficient balance', async () => {
      prisma.user.findUnique = vi.fn().mockResolvedValue(user);

      vi.spyOn(await import('@/lib/auth'), 'getCurrentUser').mockResolvedValue(user);

      const request = createMockRequest('http://localhost:3000/api/wallet/withdraw', {
        method: 'POST',
        body: {
          amount: 1000, // More than balance of 500
          method: 'bank',
          simulated: true,
        },
      });

      const response = await Withdraw(request);
      const { status, data } = await parseResponse(response);

      expect(status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toContain('Insufficient');
    });
  });

  describe('On-chain withdrawal with conversion', () => {
    it('should convert USD to XLM before Stellar submission', async () => {
      const mockSubmitStellar = vi.hoisted(() => vi.fn().mockResolvedValue('hash123'));
      
      vi.doMock('@/lib/stellar', () => ({
        submitStellarWithdrawal: mockSubmitStellar,
        convertUSDtoXLM: mockConvertUSDtoXLM,
      }));

      prisma.user.findUnique = vi.fn()
        .mockResolvedValueOnce(user)
        .mockResolvedValueOnce(user);

      prisma.walletTransaction.create = vi.fn().mockResolvedValue({
        id: 'tx_1',
        userId: user.id,
        type: 'withdraw',
        amount: 100,
        convertedAmount: 833.33,
        currency: 'USD',
        convertedCurrency: 'XLM',
        status: 'completed',
        txHash: 'hash123',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      prisma.walletTransaction.update = vi.fn().mockResolvedValue({
        id: 'tx_1',
        status: 'completed',
        txHash: 'hash123',
      });

      prisma.user.update = vi.fn().mockResolvedValue({
        walletBalance: 400,
        updatedAt: new Date(),
      });

      vi.spyOn(await import('@/lib/auth'), 'getCurrentUser').mockResolvedValue(user);

      const request = createMockRequest('http://localhost:3000/api/wallet/withdraw', {
        method: 'POST',
        body: {
          amount: 100,
          method: 'bank',
          simulated: false,
          destinationAddress: 'GDEST123',
          asset: 'XLM',
        },
      });

      const response = await Withdraw(request);
      const { status, data } = await parseResponse(response);

      expect(status).toBe(200);
      expect(data.success).toBe(true);
      
      // Verify conversion happened
      expect(mockConvertUSDtoXLM).toHaveBeenCalledWith(100);
      
      // Verify Stellar received converted amount
      expect(mockSubmitStellar).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 833.33,
          asset: 'XLM',
        }),
      );
    });

    it('should store transaction hash for on-chain withdrawals', async () => {
      prisma.user.findUnique = vi.fn()
        .mockResolvedValueOnce(user)
        .mockResolvedValueOnce(user);

      const mockTx = {
        id: 'tx_1',
        userId: user.id,
        type: 'withdraw',
        amount: 100,
        convertedAmount: 833.33,
        currency: 'USD',
        convertedCurrency: 'XLM',
        status: 'completed',
        txHash: 'hash123',
        stellarAddress: 'GDEST123',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      prisma.walletTransaction.create = vi.fn().mockResolvedValue(mockTx);
      prisma.walletTransaction.update = vi.fn().mockResolvedValue(mockTx);
      prisma.user.update = vi.fn().mockResolvedValue({
        walletBalance: 400,
        updatedAt: new Date(),
      });

      vi.spyOn(await import('@/lib/auth'), 'getCurrentUser').mockResolvedValue(user);

      const request = createMockRequest('http://localhost:3000/api/wallet/withdraw', {
        method: 'POST',
        body: {
          amount: 100,
          method: 'bank',
          simulated: false,
          destinationAddress: 'GDEST123',
          asset: 'XLM',
        },
      });

      const response = await Withdraw(request);
      const { status, data } = await parseResponse(response);

      expect(status).toBe(200);
      expect(data.data.txHash).toBe('hash123');
    });
  });
});
