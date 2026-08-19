import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { hasBookingAccess } from "@/lib/auth/booking-access";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { bookingId, paymentMethod } = body as { bookingId?: string; paymentMethod?: string };

    if (!bookingId || !paymentMethod) {
      return NextResponse.json({ error: "Booking ID and payment method are required" }, { status: 400 });
    }

    if (!(await hasBookingAccess(bookingId))) {
      return NextResponse.json({ error: "Booking access could not be verified." }, { status: 403 });
    }

    if (!["bank_transfer", "cash_at_gate"].includes(paymentMethod)) {
      return NextResponse.json({ error: "Invalid payment method" }, { status: 400 });
    }

    const supabaseAdmin = getSupabaseAdminClient();

    const isBankTransfer = paymentMethod === "bank_transfer";

    const { data: bookingData, error: updateError } = await supabaseAdmin
      .from("bookings")
      .update({
        payment_method: paymentMethod,
        payment_status: isBankTransfer ? "pending_payment" : "pending",
        booking_status: isBankTransfer ? "pending" : "pending",
      })
      .eq("id", bookingId)
      .select("id, total_price");

    if (updateError) {
      console.error("Booking update error:", updateError);
      return NextResponse.json({ error: `Failed to update booking: ${updateError.message}` }, { status: 500 });
    }

    if (!bookingData || bookingData.length === 0) {
      return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    }

    const booking = bookingData[0];
    const totalPrice = Number(booking.total_price) || 0;

    const { data: existingPayment, error: checkError } = await supabaseAdmin
      .from("payments")
      .select("id")
      .eq("booking_id", bookingId)
      .eq("provider", "manual")
      .maybeSingle();

    if (checkError && checkError.code !== "PGRST116") {
      // PGRST116 means no rows found, which is fine
      console.error("Payment check error:", checkError);
      return NextResponse.json({ error: `Failed to check payment record: ${checkError.message}` }, { status: 500 });
    }

    if (existingPayment) {
      const { error: paymentUpdateError } = await supabaseAdmin
        .from("payments")
        .update({
          amount: totalPrice,
          currency: "ZAR",
          status: isBankTransfer ? "pending_payment" : "pending",
          review_status: isBankTransfer ? "pending" : null,
          review_note: isBankTransfer ? "Awaiting transfer receipt upload and manual verification." : null,
          refund_amount: 0,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existingPayment.id);

      if (paymentUpdateError) {
        console.error("Payment update error:", paymentUpdateError);
        return NextResponse.json({ error: `Failed to update payment record: ${paymentUpdateError.message}` }, { status: 500 });
      }
    } else {
      const { error: paymentInsertError } = await supabaseAdmin.from("payments").insert({
        booking_id: bookingId,
        provider: "manual",
        provider_payment_id: null,
        provider_reference: null,
        amount: totalPrice,
        currency: "ZAR",
        status: isBankTransfer ? "pending_payment" : "pending",
        review_status: isBankTransfer ? "pending" : null,
        review_note: isBankTransfer ? "Awaiting transfer receipt upload and manual verification." : null,
        refund_amount: 0,
      });

      if (paymentInsertError) {
        console.error("Payment insert error:", paymentInsertError);
        return NextResponse.json({ error: `Failed to create payment record: ${paymentInsertError.message}` }, { status: 500 });
      }
    }

    return NextResponse.json({
      success: true,
      message: "Payment method saved successfully",
      data: {
        bookingId,
        paymentMethod,
        totalPrice,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    console.error("Payment confirmation error:", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
