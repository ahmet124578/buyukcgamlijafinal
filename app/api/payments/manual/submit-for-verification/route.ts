import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { hasBookingAccess } from "@/lib/auth/booking-access";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const bookingId = typeof body?.bookingId === "string" ? body.bookingId.trim() : "";

    if (!bookingId) {
      return NextResponse.json({ error: "Booking ID is required." }, { status: 400 });
    }

    if (!(await hasBookingAccess(bookingId))) {
      return NextResponse.json({ error: "Booking access could not be verified." }, { status: 403 });
    }

    const supabaseAdmin = getSupabaseAdminClient();

    const { data: booking, error: bookingError } = await supabaseAdmin
      .from("bookings")
      .select("id, payment_method, payment_status, booking_status, booking_date, total_price")
      .eq("id", bookingId)
      .maybeSingle();

    if (bookingError) {
      return NextResponse.json({ error: bookingError.message }, { status: 500 });
    }

    if (!booking) {
      return NextResponse.json({ error: "Booking not found." }, { status: 404 });
    }

    if (booking.payment_method !== "bank_transfer") {
      return NextResponse.json({ error: "Receipt verification is only available for bank transfer bookings." }, { status: 400 });
    }

    const { data: payment, error: paymentError } = await supabaseAdmin
      .from("payments")
      .select("id, receipt_url, status, review_status")
      .eq("booking_id", bookingId)
      .eq("provider", "manual")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (paymentError) {
      return NextResponse.json({ error: paymentError.message }, { status: 500 });
    }

    if (!payment || !payment.receipt_url) {
      return NextResponse.json({ error: "Please upload a valid receipt before submitting it for verification." }, { status: 400 });
    }

    const { error: updateError } = await supabaseAdmin
      .from("payments")
      .update({
        status: "under_review",
        review_status: "under_review",
        reviewed_at: new Date().toISOString(),
        review_note: "Customer submitted receipt for verification.",
        updated_at: new Date().toISOString(),
      })
      .eq("id", payment.id);

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    const { error: bookingUpdateError } = await supabaseAdmin
      .from("bookings")
      .update({
        payment_status: "under_review",
        updated_at: new Date().toISOString(),
      })
      .eq("id", bookingId);

    if (bookingUpdateError) {
      return NextResponse.json({ error: bookingUpdateError.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, message: "Receipt submitted successfully. Your payment is now under review." });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to submit receipt for verification." }, { status: 500 });
  }
}
