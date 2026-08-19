import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { hasBookingAccess } from "@/lib/auth/booking-access";

export async function GET(request: Request, { params }: { params: Promise<{ bookingId: string }> }) {
  try {
    const { bookingId } = await params;

    if (!bookingId) {
      return NextResponse.json({ error: "Booking ID is required" }, { status: 400 });
    }

    if (!(await hasBookingAccess(bookingId))) {
      return NextResponse.json({ error: "Booking access could not be verified." }, { status: 403 });
    }

    const supabaseAdmin = getSupabaseAdminClient();
    const { data: booking, error } = await supabaseAdmin
      .from("bookings")
      .select(
        "id, total_price, booking_status, payment_status, customer_name, email, phone_number, booking_date, booking_time, reservation_code, selected_area_id, selected_equipment_ids, selected_paid_activity_id, selected_tent_area_id, selected_photo_shoot_id, adults, children_3_plus, children_under_3",
      )
      .eq("id", bookingId)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!booking) {
      return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    }

    // Only allow access to own booking or admin users
    // For now, just return the booking - in production, verify user ownership or admin status

    return NextResponse.json(booking);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Internal server error" }, { status: 500 });
  }
}
