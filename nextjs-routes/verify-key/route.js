// app/api/internal/verify-key/route.js
// เรียกโดย VPS Tunnel Server เท่านั้น — ไม่ใช่ public endpoint

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(req) {
  // ─── ตรวจ internal secret ───────────────────────────────────────────
  const secret = req.headers.get("x-internal-secret");
  if (!secret || secret !== process.env.INTERNAL_SECRET) {
    return NextResponse.json({ valid: false }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body?.key_hash) {
    return NextResponse.json({ valid: false, reason: "missing_key_hash" }, { status: 400 });
  }

  // ─── ค้นหา key จาก hash ────────────────────────────────────────────
  const apiKey = await prisma.apiKey.findUnique({
    where:   { keyHash: body.key_hash },
    include: {
      user: {
        include: { plan: true },
      },
    },
  });

  if (!apiKey) {
    return NextResponse.json({ valid: false, reason: "not_found" });
  }

  if (apiKey.status !== "active") {
    return NextResponse.json({ valid: false, reason: "key_" + apiKey.status });
  }

  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
    return NextResponse.json({ valid: false, reason: "expired" });
  }

  const plan = apiKey.user?.plan;

  // ─── ตรวจ bandwidth quota ───────────────────────────────────────────
  if (plan) {
    const limitBytes = BigInt(plan.bandwidthGB) * 1_000_000_000n;
    const usedBytes  = apiKey.rxBytes + apiKey.txBytes;
    if (usedBytes >= limitBytes) {
      return NextResponse.json({ valid: false, reason: "quota_exceeded" });
    }

    return NextResponse.json({
      valid:              true,
      keyId:              apiKey.id,
      userId:             apiKey.userId,
      plan:               plan.name,
      maxPlayers:         plan.maxPlayers,
      bandwidthRemaining: Number(limitBytes - usedBytes),
    });
  }

  // ไม่มี plan = Free tier
  return NextResponse.json({
    valid:      true,
    keyId:      apiKey.id,
    userId:     apiKey.userId,
    plan:       "free",
    maxPlayers: 5,
    bandwidthRemaining: null,
  });
}
