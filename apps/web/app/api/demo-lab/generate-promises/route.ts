import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@rp/database';
import { requireMerchantContext } from '../../../../lib/merchant-context';

const CHANNELS = ['phone', 'email', 'sms', 'whatsapp'];

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({} as any));
  const count = Math.min(100, Math.max(5, Number(body?.count) || 20));
  const seed = Number(body?.seed) > 0 ? Math.floor(Number(body?.seed)) : 20260826;

  const { merchantId } = await requireMerchantContext();
  const rng = mulberry32(seed);
  const created = [];

  for (let i = 0; i < count; i++) {
    const amount = Math.floor(rng() * 490000) + 10000;
    const promisedDate = new Date();
    const daysOffset = Math.floor(rng() * 30) - 15;
    promisedDate.setDate(promisedDate.getDate() + daysOffset);
    const channel = CHANNELS[Math.floor(rng() * CHANNELS.length)];

    let status: string;
    if (daysOffset > 5) status = 'pending';
    else if (daysOffset > 0) status = rng() < 0.6 ? 'pending' : 'kept';
    else status = rng() < 0.4 ? 'kept' : rng() < 0.7 ? 'broken' : 'extended';

    const promise = await prisma.promiseToPay.create({
      data: {
        merchantId,
        customerEmail: `customer${i}@example.com`,
        promisedAmount: amount,
        currency: 'INR',
        promisedDate,
        channel,
        status,
        escalationLevel: status === 'broken' ? 1 : status === 'extended' ? 2 : 0,
        keptAt: status === 'kept' ? new Date() : null,
        brokenAt: status === 'broken' ? new Date() : null,
        agentNotes: `Demo promise via ${channel}`,
      },
    });
    created.push({ id: promise.id, amount, status, channel, dueDate: promisedDate.toISOString().slice(0, 10) });
  }

  return NextResponse.json({
    ok: true,
    created: created.length,
    promises: created,
    note: `Generated ${created.length} promises.`,
  });
}
