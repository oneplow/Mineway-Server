// app/api/internal/report-usage/route.js
// เรียกโดย VPS Tunnel Server ทุก 30 วินาที และตอน session ปิด

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(req) {
  // ─── ตรวจ internal secret ───────────────────────────────────────────
  const secret = req.headers.get("x-internal-secret");
  if (!secret || secret !== process.env.INTERNAL_SECRET) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const { keyId, rxBytes, txBytes } = body || {};

  if (!keyId || rxBytes === undefined || txBytes === undefined) {
    return NextResponse.json({ ok: false, reason: "missing_fields" }, { status: 400 });
  }

  // ─── เพิ่ม bytes เข้า DB แบบ atomic (increment) ────────────────────
  await prisma.apiKey.update({
    where: { id: keyId },
    data:  {
      rxBytes:    { increment: BigInt(rxBytes) },
      txBytes:    { increment: BigInt(txBytes) },
      lastUsedAt: new Date(),
    },
  });

  return NextResponse.json({ ok: true });
}
