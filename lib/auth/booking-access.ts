import { createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import type { NextResponse } from "next/server";

export const BOOKING_ACCESS_COOKIE = "chamlija_booking_access";

function getBookingAccessSecret() {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) {
    throw new Error("Missing booking access configuration.");
  }
  return secret;
}

function createSignature(bookingId: string) {
  return createHmac("sha256", getBookingAccessSecret()).update(bookingId).digest("hex");
}

export async function setBookingAccessCookie(response: NextResponse, bookingId: string) {
  const existing = (await cookies()).get(BOOKING_ACCESS_COOKIE)?.value ?? "";
  const values = existing.split("|").filter(Boolean);
  const nextValues = [`${bookingId}.${createSignature(bookingId)}`, ...values.filter((value) => !value.startsWith(`${bookingId}.`))].slice(0, 5);

  response.cookies.set(BOOKING_ACCESS_COOKIE, nextValues.join("|"), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 8,
  });
}

export async function hasBookingAccess(bookingId: string) {
  const value = (await cookies()).get(BOOKING_ACCESS_COOKIE)?.value ?? "";
  return value.split("|").some((entry) => {
    const separator = entry.lastIndexOf(".");
    if (separator <= 0) return false;

    const storedBookingId = entry.slice(0, separator);
    const storedSignature = entry.slice(separator + 1);
    if (storedBookingId !== bookingId || !/^[a-f0-9]{64}$/.test(storedSignature)) return false;

    const expectedSignature = createSignature(bookingId);
    return timingSafeEqual(Buffer.from(storedSignature, "hex"), Buffer.from(expectedSignature, "hex"));
  });
}
