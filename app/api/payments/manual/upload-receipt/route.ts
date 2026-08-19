import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { ensurePaymentReceiptBucket, getPrivateReceiptUrl } from "@/lib/payments/manual";
import { hasBookingAccess } from "@/lib/auth/booking-access";

const MAX_RECEIPT_SIZE = 4 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const bookingId = String(formData.get("bookingId") ?? "").trim();
    const file = formData.get("receipt");

    if (!bookingId) {
      return NextResponse.json({ error: "Booking ID is required" }, { status: 400 });
    }

    if (!(await hasBookingAccess(bookingId))) {
      return NextResponse.json({ error: "Booking access could not be verified." }, { status: 403 });
    }

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "A receipt file is required" }, { status: 400 });
    }

    if (file.size <= 0) {
      return NextResponse.json({ error: "The uploaded file is empty" }, { status: 400 });
    }

    if (file.size > MAX_RECEIPT_SIZE) {
      return NextResponse.json({ error: "Receipt must be smaller than 4MB" }, { status: 400 });
    }

    const allowedTypes = ["image/jpeg", "image/jpg", "image/png", "image/webp", "application/pdf"];
    if (!allowedTypes.includes(file.type)) {
      return NextResponse.json({ error: "Unsupported file type. Please upload a JPG, PNG, WEBP, or PDF." }, { status: 400 });
    }

    const supabaseAdmin = getSupabaseAdminClient();
    await ensurePaymentReceiptBucket();

    const { data: booking, error: bookingError } = await supabaseAdmin
      .from("bookings")
      .select("id, payment_method, payment_status")
      .eq("id", bookingId)
      .maybeSingle();

    if (bookingError || !booking) {
      return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    }

    if (booking.payment_method !== "bank_transfer") {
      return NextResponse.json({ error: "Receipt uploads are only available for bank transfer bookings" }, { status: 400 });
    }

    const safeFileName = `${bookingId}-${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const storagePath = `payment-receipts/${safeFileName}`;

    const { error: uploadError } = await supabaseAdmin.storage.from("payment-receipts").upload(storagePath, file, {
      cacheControl: "3600",
      upsert: true,
      contentType: file.type || "application/octet-stream",
    });

    if (uploadError) {
      return NextResponse.json({ error: uploadError.message }, { status: 500 });
    }

    const receiptUrl = await getPrivateReceiptUrl(storagePath, 60 * 60);

    const { error: paymentError } = await supabaseAdmin
      .from("payments")
      .upsert(
        [{
          booking_id: bookingId,
          provider: "manual",
          provider_payment_id: null,
          provider_reference: null,
          amount: 0,
          currency: "ZAR",
          status: "pending",
          refund_amount: 0,
          receipt_url: receiptUrl,
          receipt_file_name: file.name,
          review_status: "pending",
          reviewed_at: null,
          review_note: null,
          updated_at: new Date().toISOString(),
        }],
        { onConflict: "booking_id" },
      );

    if (paymentError) {
      return NextResponse.json({ error: paymentError.message }, { status: 500 });
    }

    await supabaseAdmin
      .from("bookings")
      .update({
        payment_status: "pending",
        updated_at: new Date().toISOString(),
      })
      .eq("id", bookingId);

    return NextResponse.json({
      success: true,
      message: "Receipt uploaded successfully and is pending review.",
      receiptUrl,
      fileName: file.name,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
