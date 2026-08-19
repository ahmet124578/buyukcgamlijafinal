import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { createIkhokhaCheckout, getBookingPaymentSummary, getIkhokhaConfig, toCents } from "@/lib/payments/ikhokha";
import { hasBookingAccess } from "@/lib/auth/booking-access";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const bookingId = typeof body?.bookingId === "string" ? body.bookingId.trim() : "";

    if (!bookingId) {
      return NextResponse.json({ error: "A bookingId is required to start payment." }, { status: 400 });
    }

    if (!(await hasBookingAccess(bookingId))) {
      return NextResponse.json({ error: "Booking access could not be verified." }, { status: 403 });
    }

    const supabaseAdmin = getSupabaseAdminClient();
    const { data: booking, error: bookingError } = await supabaseAdmin
      .from("bookings")
      .select("id, total_price, booking_status, payment_status")
      .eq("id", bookingId)
      .maybeSingle();

    if (bookingError || !booking) {
      return NextResponse.json({ error: "The booking could not be found." }, { status: 404 });
    }

    const summary = await getBookingPaymentSummary(bookingId);
    if (!summary) {
      return NextResponse.json({ error: "Unable to load booking payment details." }, { status: 404 });
    }

    const trustedAmount = Number(summary?.total_price ?? booking.total_price ?? 0);
    const trustedAmountInCents = toCents(trustedAmount);

    if (!Number.isFinite(trustedAmount) || trustedAmount <= 0) {
      return NextResponse.json({ error: "This booking does not have a payable amount." }, { status: 400 });
    }

    if (booking.payment_status === "paid" || booking.booking_status === "confirmed") {
      return NextResponse.json({ error: "This booking has already been paid for." }, { status: 409 });
    }

    const { data: existingPayment } = await supabaseAdmin
      .from("payments")
      .select("id, status, provider_payment_id, amount, provider_reference")
      .eq("booking_id", bookingId)
      .eq("provider", "ikhokha")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingPayment && existingPayment.status === "pending") {
      return NextResponse.json({
        success: true,
        bookingId,
        paymentId: existingPayment.provider_payment_id ?? existingPayment.id ?? null,
        totalPrice: trustedAmount,
        checkoutUrl: null,
        redirectUrl: null,
        providerConfigured: false,
        paymentStatus: "pending",
        message: "A payment record already exists for this booking and is awaiting provider confirmation.",
      });
    }

    const externalTransactionId = `booking-${bookingId}-${randomUUID()}`;
    const { data: paymentRecord, error: paymentError } = await supabaseAdmin
      .from("payments")
      .upsert(
        [
          {
            booking_id: bookingId,
            provider: "ikhokha",
            provider_payment_id: null,
            provider_reference: externalTransactionId,
            amount: trustedAmountInCents,
            currency: "ZAR",
            status: "pending",
            refund_amount: 0,
          },
        ],
        { onConflict: "booking_id,provider,provider_payment_id" },
      )
      .select("id, provider_payment_id, provider_reference, status")
      .single();

    if (paymentError) {
      return NextResponse.json({ error: paymentError.message }, { status: 500 });
    }

    const { returnUrl } = getIkhokhaConfig();
    const callbackUrl = `${returnUrl}/api/payments/ikhokha/webhook`;
    const successUrl = `${returnUrl}/book/payment/success?bookingId=${encodeURIComponent(bookingId)}`;
    const failureUrl = `${returnUrl}/book/payment/failure?bookingId=${encodeURIComponent(bookingId)}`;
    const cancelUrl = `${returnUrl}/book/payment/cancel?bookingId=${encodeURIComponent(bookingId)}`;

    try {
      const checkout = await createIkhokhaCheckout(summary, callbackUrl, successUrl, failureUrl, cancelUrl);

      if (!checkout.providerConfigured || !checkout.checkoutUrl) {
        return NextResponse.json(
          {
            success: false,
            bookingId,
            paymentId: paymentRecord?.id ?? null,
            checkoutUrl: null,
            redirectUrl: null,
            providerConfigured: false,
            paymentStatus: "pending",
            message: checkout.providerMessage || "iKhokha checkout was not created.",
          },
          { status: 503 },
        );
      }

      const { error: updateError } = await supabaseAdmin
        .from("payments")
        .update({
          provider_payment_id: checkout.paymentId,
          provider_reference: checkout.externalTransactionId ?? externalTransactionId,
          amount: trustedAmountInCents,
          updated_at: new Date().toISOString(),
        })
        .eq("id", paymentRecord?.id);

      if (updateError) {
        return NextResponse.json({ error: updateError.message }, { status: 500 });
      }

      return NextResponse.json({
        success: true,
        bookingId,
        paymentId: checkout.paymentId ?? paymentRecord?.id ?? null,
        totalPrice: trustedAmount,
        externalTransactionId: checkout.externalTransactionId ?? externalTransactionId,
        checkoutUrl: checkout.checkoutUrl,
        redirectUrl: checkout.redirectUrl ?? checkout.checkoutUrl,
        providerConfigured: true,
        paymentStatus: "pending",
        message: checkout.providerMessage || "Payment link created successfully.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to create the payment session.";
      return NextResponse.json({ error: message, success: false, paymentId: paymentRecord?.id ?? null }, { status: 503 });
    }
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unable to create the payment session.",
      },
      { status: 500 },
    );
  }
}
